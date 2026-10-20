"""E2E v1.10 — renomear/mover, arquivar manual, zip, apagar gaveta, jobs, docs q,
e o freio de força bruta. Roda DENTRO do container (como test_mcp.py).
ATENÇÃO: o teste do freio bloqueia o IP por 5 min — é o ÚLTIMO.
"""
import io
import json
import os
import time
import urllib.request
import urllib.error
import zipfile

BASE = os.environ.get("BASE", "http://localhost:8000")
TESTKEY = os.environ["TESTKEY"]
OPKEY = os.environ["OPKEY"]
OKS = FALHAS = 0


def check(nome, cond, extra=""):
    global OKS, FALHAS
    if cond:
        OKS += 1; print("OK   %s" % nome)
    else:
        FALHAS += 1; print("FALHA %s  %s" % (nome, str(extra)[:200]))


def call(metodo, caminho, key=None, corpo=None, bruto=False):
    req = urllib.request.Request(BASE + caminho, method=metodo)
    if key:
        req.add_header("Authorization", "B" + "earer " + key)
    dados = None
    if corpo is not None:
        dados = json.dumps(corpo).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=dados, timeout=120) as r:
            b = r.read()
            if bruto:
                return r.status, dict(r.headers), b
            return r.status, dict(r.headers), (json.loads(b) if b else None)
    except urllib.error.HTTPError as e:
        b = e.read().decode("utf-8", "replace")
        try:
            return e.code, dict(e.headers), json.loads(b)
        except Exception:
            return e.code, dict(e.headers), b


def esperar(job_id, teto=240):
    fim = time.time() + teto
    while time.time() < fim:
        st, _, j = call("GET", "/ingest/%s" % job_id, key=TESTKEY)
        if j.get("status") in ("concluido", "erro", "cancelado"):
            return j
        time.sleep(3)
    return {"status": "tempo_esgotado"}


def ingerir(doc_id, content, memoria):
    st, _, j = call("POST", "/ingest", key=TESTKEY,
                    corpo={"doc_id": doc_id, "title": doc_id,
                           "content": content, "memoria": memoria})
    assert st == 202, (st, j)
    return j["job_id"]


TEXTO = "Relatório de campo sobre marés e ventos do litoral norte. " * 4

print("== renomear ==")
esperar(ingerir("r1", TEXTO, "g1"))
st, _, r = call("PATCH", "/documents/r1?memoria=g1", key=TESTKEY,
                corpo={"novo_doc_id": "r1-b"})
check("PATCH renomeia", st == 200 and r["renomeado"] and r["doc_id"] == "r1-b", r)
st, _, d = call("GET", "/documents/r1-b?memoria=g1", key=TESTKEY)
check("fonte segue no novo id", st == 200 and d["content"] == TEXTO, st)
st, _, d = call("GET", "/documents/r1?memoria=g1", key=TESTKEY)
check("id antigo sumiu", st == 404, st)

print("== mover de gaveta ==")
st, _, r = call("PATCH", "/documents/r1-b?memoria=g1", key=TESTKEY,
                corpo={"destino_memoria": "g2"})
check("PATCH move", st == 200 and r["movido"] and r["memoria"] == "g2", r)
st, _, d = call("GET", "/docs?memoria=g1", key=TESTKEY)
check("saiu de g1", st == 200 and d["total"] == 0, d)
st, _, d = call("GET", "/docs?memoria=g2", key=TESTKEY)
check("entrou em g2", st == 200 and d["total"] == 1, d)

print("== título ==")
st, _, r = call("PATCH", "/documents/r1-b?memoria=g2", key=TESTKEY,
                corpo={"title": "Novo Título"})
check("PATCH título", st == 200 and r["titulo"] == "Novo Título", r)
st, _, d = call("GET", "/docs?memoria=g2", key=TESTKEY)
check("título na lista", d["docs"][0]["title"] == "Novo Título", d)

print("== arquivar manual ==")
st, _, r = call("PATCH", "/documents/r1-b/arquivado?memoria=g2", key=TESTKEY,
                corpo={"arquivado": True})
check("arquiva", st == 200 and r["arquivado"], r)
st, _, d = call("GET", "/docs?memoria=g2", key=TESTKEY)
check("arquivado some da lista padrão", d["total"] == 0, d)
st, _, d = call("GET", "/docs?memoria=g2&include_archived=true", key=TESTKEY)
check("include_archived mostra inteiro arquivado",
      d["docs"] and d["docs"][0]["chunks_arquivados"] == d["docs"][0]["chunks"], d)
st, _, r = call("PATCH", "/documents/r1-b/arquivado?memoria=g2", key=TESTKEY,
                corpo={"arquivado": False})
check("revive", st == 200 and r["chunks_afetados"] >= 1, r)

print("== colisão de nome ==")
esperar(ingerir("r1-c", "outro texto qualquer de teste de colisao", "g2"))
st, _, r = call("PATCH", "/documents/r1-b?memoria=g2", key=TESTKEY,
                corpo={"novo_doc_id": "r1-c"})
check("id ocupado no destino -> 409", st == 409, r)

print("== filtro e paginação ==")
for i in (1, 2):
    esperar(ingerir("extra-%d" % i, "conteudo de apoio numero %d" % i, "g2"))
st, _, d = call("GET", "/docs?memoria=g2&q=extra", key=TESTKEY)
check("?q= filtra", d["total"] == 2 and all("extra" in x["doc_id"] for x in d["docs"]), d)
st, _, d = call("GET", "/docs?memoria=g2&limit=1&offset=1", key=TESTKEY)
check("limit+offset devolvem 1 e total estável", len(d["docs"]) == 1 and d["total"] >= 3, d)

print("== export zip ==")
st, hdr, b = call("GET", "/gavetas/g2/export.zip", key=TESTKEY, bruto=True)
okzip = st == 200 and "zip" in (hdr.get("content-type") or "")
conteudo_zip = ""
if okzip:
    with zipfile.ZipFile(io.BytesIO(b)) as z:
        nomes = z.namelist()
        manifest = json.loads(z.read("manifest.json"))
        conteudo_zip = z.read("r1-b.txt").decode("utf-8")
check("zip válido com manifest e fontes",
      okzip and "manifest.json" in nomes and conteudo_zip == TEXTO, nomes if okzip else st)

print("== jobs cancel/retry ==")
grande = ".".join(["Frase de enchimento para ocupar a fila"] * 60)
j1 = ingerir("fila-grande", grande, "g2")
j2 = ingerir("fila-pequena", "texto pequeno que vai esperar na fila", "g2")
st, _, r = call("POST", "/jobs/%s/cancel" % j2, key=TESTKEY)
check("cancelar na_fila", st == 200 and r["status"] == "cancelado", (st, r))
st, _, r = call("POST", "/jobs/%s/retry" % j2, key=TESTKEY)
check("retry reenfileira", st == 200 and r["status"] == "na_fila", (st, r))
check("fila pequena concluída", esperar(j2)["status"] == "concluido")
esperar(j1)
st, _, r = call("POST", "/jobs/%s/cancel" % j1, key=TESTKEY)
check("cancelar concluído -> 409", st == 409, (st, r))

print("== apagar gaveta ==")
st, _, r = call("DELETE", "/gavetas/g2", key=TESTKEY)
check("apaga gaveta", st == 200 and r["chunks_apagados"] >= 1 and r["fontes_apagadas"] >= 1, r)
st, _, g = call("GET", "/gavetas", key=TESTKEY)
check("gaveta sumiu do mapa", all(x["memoria"] != "g2" for x in g["gavetas"]), g)
st, _, r = call("DELETE", "/gavetas/g2", key=TESTKEY)
check("apagar de novo -> 404", st == 404, st)

print("== escopo operador (checagem rápida) ==")
st, _, r = call("PATCH", "/documents/x-nao-existe?memoria=g1", key=OPKEY,
                corpo={"title": "x", "tenant": "teste"})
check("operador respeita tenant alvo (404 correto = rota ok)", st == 404, st)

print("== freio de força bruta (último teste) ==")
for i in range(10):
    call("GET", "/gavetas", key="chave-errada-%02d" % i)
st, _, r = call("GET", "/gavetas", key="chave-errada-final")
check("11ª tentativa errada -> 429", st == 429, (st, r))
st, _, r = call("GET", "/gavetas", key=TESTKEY)
check("chave BOA também barrada enquanto bloqueado", st == 429, st)

print("\n%d OK / %d FALHA" % (OKS, FALHAS))
raise SystemExit(1 if FALHAS else 0)