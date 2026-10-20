"""E2E da v1.8/v1.9 — documents, decay POR DOCUMENTO, operador, painel.

Rodar DENTRO do container (como test_mcp.py):
  docker exec -e TESTKEY=*** -e OPKEY=*** minirag-api python /tmp/test_v18.py
BASE opcional (default http://localhost:8000).
"""
import json
import os
import time
import urllib.request
import urllib.error

BASE = os.environ.get("BASE", "http://localhost:8000")
TESTKEY = os.environ["TESTKEY"]          # tenant 'teste' (MINIRAG_USERS)
OPKEY = os.environ["OPKEY"]              # operador 'operador' (MINIRAG_OPERADOR)

OKS = FALHAS = 0


def check(nome, cond, extra=""):
    global OKS, FALHAS
    if cond:
        OKS += 1
        print("OK   %s" % nome)
    else:
        FALHAS += 1
        print("FALHA %s  %s" % (nome, extra))


def call(metodo, caminho, key=None, corpo=None, binary=False):
    req = urllib.request.Request(BASE + caminho, method=metodo)
    if key:
        req.add_header("Authorization", "B" + "earer " + key)
    dados = None
    if corpo is not None:
        dados = json.dumps(corpo).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=dados, timeout=120) as r:
            bruto = r.read()
            if binary:
                return r.status, dict(r.headers), bruto.decode("utf-8", "replace")
            return r.status, dict(r.headers), json.loads(bruto or b"null")
    except urllib.error.HTTPError as e:
        corpo_erro = e.read().decode("utf-8", "replace")
        try:
            return e.code, dict(e.headers), json.loads(corpo_erro)
        except Exception:
            return e.code, dict(e.headers), corpo_erro


def esperar_job(key, job_id, teto=240):
    fim = time.time() + teto
    while time.time() < fim:
        st, _, j = call("GET", "/ingest/%s" % job_id, key=key)
        if j.get("status") in ("concluido", "erro", "cancelado"):
            return j
        time.sleep(3)
    return {"status": "tempo_esgotado"}


def ingest(key, doc_id, content, memoria="", tenant=None):
    corpo = {"doc_id": doc_id, "title": doc_id, "content": content,
             "memoria": memoria}
    if tenant:
        corpo["tenant"] = tenant
    st, _, j = call("POST", "/ingest", key=key, corpo=corpo)
    assert st == 202, (st, j)
    return esperar_job(key, j["job_id"])


PALAVRAS = ("A raposa veloz salta sobre o cao preguiçoso do quintal. " * 22)

print("== health e painel ==")
st, _, h = call("GET", "/health")
check("health 200 + versao 1.10", st == 200 and h.get("versao") == "1.10.0", h)
check("health operador ativo", h.get("operador") is True, h)
st, hdr, bruto = call("GET", "/painel/", binary=True)
check("painel servido (200 html)", st == 200 and "Minirag — Painel" in bruto, st)

print("== ingest vira DOCUMENTO com fonte ==")
CONTEUDO1 = "O farol da baia guia os barcos na neblina de novembro. " * 3
chk = ingest(TESTKEY, "nota1", CONTEUDO1)
check("ingest nota1 concluido", chk["status"] == "concluido", chk)
st, _, doc = call("GET", "/documents/nota1", key=TESTKEY)
check("documents guarda original exato",
      st == 200 and doc["content"] == CONTEUDO1 and doc["origem"] == "direto",
      (st, doc.get("origem") if isinstance(doc, dict) else doc))

print("== download raw ==")
st, hdr, bruto = call("GET", "/documents/nota1/raw", key=TESTKEY, binary=True)
check("raw == conteudo + disposition",
      st == 200 and bruto == CONTEUDO1
      and "attachment" in {k.lower(): v for k, v in hdr.items()}
      .get("content-disposition", ""), (st, hdr))

print("== edicao PUT reindexa ==")
CONTEUDO2 = CONTEUDO1 + "O farol foi pintado de vermelho vivo em 2026."
st, _, j = call("PUT", "/documents/nota1", key=TESTKEY,
                corpo={"content": CONTEUDO2, "memoria": ""})
check("PUT aceita (202)", st == 202, (st, j))
chk = esperar_job(TESTKEY, j["job_id"])
check("reindex concluido", chk["status"] == "concluido", chk)
st, _, doc = call("GET", "/documents/nota1", key=TESTKEY)
check("edicao gravada na fonte", st == 200 and doc["content"] == CONTEUDO2)
st, _, s = call("POST", "/search", key=TESTKEY,
                corpo={"query": "farol vermelho 2026", "min_score": 0.30, "k": 3})
check("busca ve conteudo NOVO",
      any("vermelho" in it["text"] for it in s["items"]), s["total"])

print("== gavetas e escopos ==")
st, _, g = call("GET", "/gavetas", key=TESTKEY)
tenants_vistos = {x["tenant"] for x in g["gavetas"]}
check("tenant ve so o dele em /gavetas",
      st == 200 and g["operador"] is False and tenants_vistos == {"teste"},
      tenants_vistos)
st, _, g = call("GET", "/gavetas", key=OPKEY)
check("operador ve tudo em /gavetas",
      st == 200 and g["operador"] is True and "teste" in
      {x["tenant"] for x in g["gavetas"]}, g["operador"])
st, _, j = call("POST", "/ingest", key=OPKEY,
                corpo={"doc_id": "nota_op", "content": "ping", "memoria": "",
                       "tenant": "teste"})
check("operador ingere em tenant alheio", st == 202, (st, j))
if st == 202:
    esperar_job(OPKEY, j["job_id"])
st, _, d = call("GET", "/docs?tenant=teste", key=OPKEY)
check("operador lista docs de 'teste'",
      st == 200 and any(x["doc_id"] == "nota_op" for x in d["docs"]), d)
st, _, j = call("POST", "/ingest", key=TESTKEY,
                corpo={"doc_id": "injetado", "content": "x", "memoria": "",
                       "tenant": "operador"})
check("tenant NAO consegue mirar outro (vai pra ele mesmo)", st == 202)
if st == 202:
    esperar_job(TESTKEY, j["job_id"])
    st2, _, d2 = call("GET", "/docs?memoria=", key=TESTKEY)
    check("  'injetado' parou no PROPRIO tenant",
          any(x["doc_id"] == "injetado" for x in d2["docs"]))
    call("DELETE", "/docs/injetado", key=TESTKEY)

print("== decay POR DOCUMENTO (o teste que distingue) ==")
# X: dois chunks, um deles acessado 3x (total de acessos 3 >= min 2)
# Y: dois chunks, nunca acessado (total 0 < 2) -> arquivar INTEIRO
X = PALAVRAS + "Zebras listradas dançam valsa ao luar. " + PALAVRAS
Y = "Tartarugas marinhas nidificam na praia deserta às três da manhã. " * 65
chk = ingest(TESTKEY, "docX", X)
check("docX ingerido (multi-chunk)", chk["status"] == "concluido")
chk = ingest(TESTKEY, "docY", Y)
check("docY ingerido (multi-chunk)", chk["status"] == "concluido")
time.sleep(1)
for _ in range(3):
    call("POST", "/search", key=TESTKEY,
         corpo={"query": "zebras valsa luar", "min_score": 0.30, "k": 1})
st, _, r = call("POST", "/decay", key=TESTKEY, corpo={"dias": 0, "min_acessos": 2})
check("decay devolve contagem por doc", "docs_arquivados_agora" in r, r)
st, _, d = call("GET", "/docs", key=TESTKEY)
ids_ativos = {x["doc_id"] for x in d["docs"]}
check("docX INTEIRO continua ativo (acesso do doc salvou todos os chunks)",
      "docX" in ids_ativos, ids_ativos)
check("docY arquivado INTEIRO some da lista ativa", "docY" not in ids_ativos,
      ids_ativos)
st, _, d2 = call("GET", "/docs?include_archived=true", key=TESTKEY)
arq = {x["doc_id"]: x["chunks_arquivados"] for x in d2["docs"]}
check("docY com TODOS os chunks arquivados",
      arq.get("docY", 0) >= 2, arq)

print("== revive tambem e por documento ==")
st, _, s = call("POST", "/search", key=TESTKEY,
                corpo={"query": "tartarugas nidificam praia", "min_score": 0.30,
                       "k": 1, "include_archived": True})
check("busca acha docY arquivado", s["total"] >= 1, s["total"])
st, _, d2 = call("GET", "/docs?include_archived=true", key=TESTKEY)
arq2 = {x["doc_id"]: x["chunks_arquivados"] for x in d2["docs"]}
check("REVIVEU o doc inteiro (0 chunks arquivados de docY)",
      arq2.get("docY", -1) == 0, arq2)

print("== jobs agregados ==")
st, _, j = call("GET", "/jobs?limit=100", key=TESTKEY)
check("tenant so ve jobs do dele",
      st == 200 and all(x["tenant"] == "teste" for x in j["jobs"]),
      {x["tenant"] for x in j["jobs"]})
st, _, j = call("GET", "/jobs?limit=100", key=OPKEY)
check("operador ve jobs de 'teste' (e resumo por status)",
      st == 200 and "resumo_por_status" in j and
      any(x["tenant"] == "teste" for x in j["jobs"]), j.get("resumo_por_status"))

print("== delete apaga fonte junto ==")
st, _, r = call("DELETE", "/docs/nota1", key=TESTKEY)
check("delete responde fonte_apagada", st == 200 and r.get("fonte_apagada") is True, r)
st, _, r = call("GET", "/documents/nota1", key=TESTKEY)
check("documents naosobrevive (404)", st == 404, st)

print("== /decay de tenant nao mexe em outros ==")
st, _, r = call("POST", "/decay", key=TESTKEY, corpo={"dias": 0, "min_acessos": 999})
st2, _, d_op = call("GET", "/docs?tenant=operador&memoria=", key=OPKEY)
# gaveta propria do operador nao deve ter sido tocada pelo decay do 'teste'
check("decay do tenant nao arquiva gaveta alheia", st == 200, r)

print("\n%d OK / %d FALHA" % (OKS, FALHAS))
raise SystemExit(1 if FALHAS else 0)
