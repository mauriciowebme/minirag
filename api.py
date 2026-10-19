"""Minirag — serviço RAG multi-tenant (ingest + search + memória inteligente).

Stack: FastAPI + Postgres (pgvector) + nomic-embed-text-v1.5 (sentence-transformers).

Acesso em DOIS niveis:
  1. LOGIN (cabecalho Authorization Bearer *** da lista MINIRAG_USERS
     ("nome:chave" separados por virgula). Chave fora da lista = 401.
  2. MEMORIA (campo "memoria" no corpo do pedido): gaveta dentro daquele
     login (ex.: id da empresa). Sem o campo, usa a memoria padrao do
     login (string vazia). Gavetas de logins diferentes NUNCA se encostam
     — nem quando tem o mesmo nome: "empresa42" do sistema e "empresa42" do
     operador sao memorias distintas.

Limites de seguranca (protegem o servidor; uso normal nunca estoura):
  - content: ate MINIRAG_MAX_CONTENT_CHARS chars (default 500.000; estourou = 422)
  - query:   ate MINIRAG_MAX_QUERY_CHARS chars (default 2.000; estourou = 422)
  - cota:    ate MINIRAG_MAX_CHUNKS_TENANT chunks por login (default 10.000;
             estourou = 413; regravar o MESMO doc_id nao conta dobrado)
  - gaveta:  nome de memoria com ate 128 chars

Modelo de documentos (v1.8):
  A fonte da verdade passou a ser a tabela `documents` (conteudo original
  inteiro, por (tenant, memoria, doc_id)). Os chunks sao INDICE DERIVADO:
  todo ingest/editao grava o documento e reembedding o indexa; editar um
  arquivo = PUT /documents/{doc_id} (volta pra fila, versão antiga no ar até
  o job concluir). Docs anteriores a v1.8 sao reconstruidos no boot pela
  concatenacao dos chunks (origem='reconstruido').

Memória inteligente (decay, v1.8 — por DOCUMENTO):
  Cada busca que devolve um chunk carimba uso no chunk; o decay agrega a
  soma de acessos e o ultimo acesso DOS CHUNKS DO DOCUMENTO e arquiva o
  documento INTEIRO (nunca mais "metade de uma nota" esfriada). Busca com
  include_archived acha arquivado e REVIVE o documento inteiro. Nada e
  apagado — arquivamento e reversivel. POST /decay agora so mexe no tenant
  de quem chama; a chave operador pode rodar global (?tenant vazio).
  Nota de performance: embedding e CPU-only (~6 s por chunk de 500 palavras);
  arquivo de 2.000 linhas (~69 chunks) demora ~6-7 min pra ingerir, e o teto
  de 500k chars (~218 chunks) pode levar ~20 min — o pedido segura a conexão
  nesse tempo (cliente: timeout alto).

Endpoints:
  GET  /health   -> publico
  POST /ingest   -> entra na FILA (202 + job_id; nao segura conexao). Operador
                    pode mirar outro tenant no campo "tenant" do corpo.
  GET  /ingest/{job_id} -> status do job (na_fila|processando|concluido|erro)
  POST /search   -> le apenas a (login, memoria) do chamador; ?include_archived
  GET  /docs     -> lista apenas a (login, memoria); ?memoria=...; ?include_archived
  DELETE /docs/{doc_id} -> apaga o doc (chunks + documents + jobs na fila)
  GET  /gavetas  -> mapa tenant x memoria x docs/chunks (tenant: so o seu;
                    operador: tudo, ou ?tenant=<nome>)
  GET  /jobs     -> fila de ingestao com status (?status=..., ?tenant=..., ?limit=)
  GET  /documents/{doc_id}       -> conteudo original do arquivo (fonte da verdade)
  GET  /documents/{doc_id}/raw   -> download com Content-Disposition
  PUT  /documents/{doc_id}       -> EDICAO: grava novo conteudo e reindexa (fila)
  POST /decay    -> arquivamento AGORA, no escopo de quem chama (operador: global)
  POST /mcp      -> servidor MCP (JSON-RPC 2.0, streamable HTTP stateless) —
                    mesma auth Bearer; tools: health/search/ingest/
                    ingest_status/list_docs/delete_doc (ver mcp_server.py)
  GET  /painel   -> interface web (login por chave; modo tenant ou operador)

Fila de ingestao: o texto e gravado no banco (tabela ingest_jobs) e um worker
de fundo faz os embeddings pedaco a pedaco (~6 s cada em CPU). O pedido volta
202 em milissegundos; busca e demais endpoints seguem respondendo durante o
processamento; se o container reiniciar no meio, o job volta pra fila
(durabilidade no proprio Postgres — sem Redis/Celery).
"""
import asyncio
import hmac
import json
import os
import re
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Optional

import psycopg
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer


# ---------------------------------------------------------------- config ---
@dataclass(frozen=True)
class Config:
    model: str
    model_dir: str
    db_host: str
    db_port: int
    db_user: str
    db_password: str
    db_name: str
    db_wait_tries: int
    db_wait_seconds: int
    max_chunk_words: int
    chunk_overlap: int
    top_k: int
    min_score: float
    max_content_chars: int
    max_query_chars: int
    max_chunks_tenant: int
    decay_ativo: bool
    decay_dias: int
    decay_min_acessos: int
    decay_intervalo_minutos: int


CONFIG = Config(
    model=os.environ.get("MINIRAG_MODEL", "nomic-ai/nomic-embed-text-v1.5"),
    model_dir=os.environ.get("MINIRAG_MODEL_DIR", "/app/models"),
    db_host=os.environ.get("MINIRAG_DB_HOST", "minirag-db"),
    db_port=int(os.environ.get("MINIRAG_DB_PORT", "5432")),
    db_user=os.environ.get("MINIRAG_DB_USER", "minirag"),
    db_password=os.environ.get("MINIRAG_DB_PASSWORD", "minirag"),
    db_name=os.environ.get("MINIRAG_DB_NAME", "minirag"),
    db_wait_tries=int(os.environ.get("MINIRAG_DB_WAIT_TRIES", "30")),
    db_wait_seconds=int(os.environ.get("MINIRAG_DB_WAIT_SECONDS", "2")),
    max_chunk_words=int(os.environ.get("MINIRAG_MAX_CHUNK_WORDS", "500")),
    chunk_overlap=int(os.environ.get("MINIRAG_CHUNK_OVERLAP", "80")),
    top_k=int(os.environ.get("MINIRAG_TOP_K", "5")),
    min_score=float(os.environ.get("MINIRAG_MIN_SCORE", "0.55")),
    max_content_chars=int(os.environ.get("MINIRAG_MAX_CONTENT_CHARS", "500000")),
    max_query_chars=int(os.environ.get("MINIRAG_MAX_QUERY_CHARS", "2000")),
    max_chunks_tenant=int(os.environ.get("MINIRAG_MAX_CHUNKS_TENANT", "10000")),
    decay_ativo=os.environ.get("MINIRAG_DECAY_ATIVO", "1").strip() in ("1", "true"),
    decay_dias=int(os.environ.get("MINIRAG_DECAY_DIAS", "30")),
    decay_min_acessos=int(os.environ.get("MINIRAG_DECAY_MIN_ACESSOS", "2")),
    decay_intervalo_minutos=int(os.environ.get("MINIRAG_DECAY_INTERVALO_MINUTOS", "60")),
)


def parse_users(raw: str):
    """'nome:chave, outro:outra' -> [(nome, chave), ...]"""
    users = []
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry or ":" not in entry:
            continue
        name, _, key = entry.partition(":")
        name, key = name.strip(), key.strip()
        if name and key:
            users.append((name, key))
    return users


# Lista de acesso lida UMA vez no boot (trocar = reiniciar o servico)
USERS = parse_users(os.environ.get("MINIRAG_USERS", ""))

# v1.8: chave(s) de OPERADOR (MINIRAG_OPERADOR="nome:chave,..."). Escopo novo:
# ve TODAS as gavetas e pode operar em tenant alheio (?tenant= / corpo).
# Login comum permanece rigorosamente por-tenant como sempre.
OPERADOR = parse_users(os.environ.get("MINIRAG_OPERADOR", ""))


def is_operador(user: dict) -> bool:
    return bool(user.get("operador"))


def tenant_for(user: dict, arg: Optional[str]) -> str:
    """Tenant ALVO de uma operacao especifica (docs, ingest, search...).

    Login comum: SEMPRE o proprio (arg ignorado — nao ha como escapar do
    proprio escopo). Operador: ?tenant=<nome> se dado, senao o proprio nome.
    """
    if is_operador(user):
        return (arg or "").strip() or user["tenant"]
    return user["tenant"]


def tenant_filter(user: dict, arg: Optional[str]):
    """Filtro para agregados (/gavetas, /jobs): None = ver tudo (operador)."""
    if is_operador(user):
        a = (arg or "").strip()
        return a if a else None  # None => sem filtro WHERE tenant
    return user["tenant"]


# ---------------------------------------------------------------- model ----
MODEL: Optional[SentenceTransformer] = None
MODEL_DIM: int = 0


def load_model() -> int:
    global MODEL, MODEL_DIM
    if MODEL is None:
        if os.path.exists(CONFIG.model_dir):
            MODEL = SentenceTransformer(CONFIG.model_dir)
        else:
            MODEL = SentenceTransformer(CONFIG.model)
        MODEL_DIM = int(MODEL.encode(["x"], show_progress_bar=False)[0].shape[0])
    return MODEL_DIM


def embed(text: str) -> str:
    # pgvector aceita literal text '[v1,v2,...]'; retornar string evita
    # psycopg tentar adaptar numpy/list como float[] (que nao casa com vector)
    vec = MODEL.encode([text], show_progress_bar=False)[0]
    return "[" + ",".join(f"{x:.7f}" for x in vec.tolist()) + "]"


# ------------------------------------------------------------------ db ----
def connect():
    return psycopg.connect(
        host=CONFIG.db_host,
        port=CONFIG.db_port,
        user=CONFIG.db_user,
        password=CONFIG.db_password,
        dbname=CONFIG.db_name,
    )


def wait_db() -> None:
    """Espera o Postgres aceitar conexao antes de subir o servico.

    Porque isso existe: no boot do servidor o Docker religa cada container por
    conta propria e NAO respeita o depends_on/healthcheck do compose, entao a
    API costumava chamar init_db() com o banco ainda frio e morrer. Container
    morto + a faxina de prune do painel = servico apagado sem rastro.

    Tenta db_wait_tries vezes, dorme db_wait_seconds entre tentativas (default
    30 x 2s = ate 60s). Esgotou: levanta erro e o container morre com mensagem
    clara — healthcheck nunca marca saudavel falso, e o restart: always tenta
    de novo do zero.
    """
    last = None
    for attempt in range(1, CONFIG.db_wait_tries + 1):
        try:
            with connect() as conn:
                conn.execute("SELECT 1")
            if attempt > 1:
                # flush: print sem flush fica no buffer quando stdout e um
                # pipe (docker logs) — o boot ficava sem registro visivel
                print("[minirag] Postgres respondeu na tentativa %d" % attempt,
                      flush=True)
            return
        except Exception as e:
            last = e
            print("[minirag] aguardando Postgres (%d/%d): %s"
                  % (attempt, CONFIG.db_wait_tries,
                     str(e).splitlines()[0][:160]), flush=True)
            time.sleep(CONFIG.db_wait_seconds)
    raise RuntimeError(
        "Postgres indisponivel apos %d tentativas de %ds: %s"
        % (CONFIG.db_wait_tries, CONFIG.db_wait_seconds, last))


def init_db():
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
            cur.execute(
                "CREATE TABLE IF NOT EXISTS chunks ("
                "id BIGSERIAL PRIMARY KEY, "
                "tenant TEXT NOT NULL, "
                "memoria TEXT NOT NULL DEFAULT '', "
                "doc_id TEXT NOT NULL, "
                "title TEXT, "
                "body TEXT NOT NULL, "
                "embedding VECTOR(%d) NOT NULL, "
                "ingested_at TIMESTAMPTZ NOT NULL DEFAULT now())" % MODEL_DIM
            )
            # banco ja existente (versao sem tenant/memoria): colunas vivas
            cur.execute(
                "ALTER TABLE chunks "
                "ADD COLUMN IF NOT EXISTS tenant TEXT NOT NULL DEFAULT 'default'"
            )
            cur.execute(
                "ALTER TABLE chunks "
                "ADD COLUMN IF NOT EXISTS memoria TEXT NOT NULL DEFAULT ''"
            )
            # memoria inteligente (decay): rastro de uso + arquivo reversivel
            cur.execute(
                "ALTER TABLE chunks "
                "ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ"
            )
            cur.execute(
                "ALTER TABLE chunks "
                "ADD COLUMN IF NOT EXISTS access_count INT NOT NULL DEFAULT 0"
            )
            cur.execute(
                "ALTER TABLE chunks "
                "ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS chunks_embedding_idx "
                "ON chunks USING hnsw(embedding vector_cosine_ops)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS chunks_scope_idx "
                "ON chunks (tenant, memoria)"
            )
            # fila de ingestao: job = um pedido POST /ingest enfileirado
            cur.execute(
                "CREATE TABLE IF NOT EXISTS ingest_jobs ("
                "id BIGSERIAL PRIMARY KEY, "
                "tenant TEXT NOT NULL, "
                "memoria TEXT NOT NULL DEFAULT '', "
                "doc_id TEXT NOT NULL, "
                "title TEXT, "
                "content TEXT NOT NULL, "
                "status TEXT NOT NULL DEFAULT 'na_fila', "  # na_fila|processando|concluido|erro|cancelado
                "chunks_total INT NOT NULL DEFAULT 0, "
                "chunks_feitos INT NOT NULL DEFAULT 0, "
                "erro TEXT, "
                "criado_em TIMESTAMPTZ NOT NULL DEFAULT now(), "
                "finalizado_em TIMESTAMPTZ)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS ingest_jobs_status_idx "
                "ON ingest_jobs (status, id)"
            )
            # v1.8: DOCUMENTS — a fonte da verdade (conteudo original inteiro).
            # chunks passou a ser indice DERIVADO: editar o doc reindexa tudo.
            cur.execute(
                "CREATE TABLE IF NOT EXISTS documents ("
                "tenant TEXT NOT NULL, "
                "memoria TEXT NOT NULL DEFAULT '', "
                "doc_id TEXT NOT NULL, "
                "title TEXT, "
                "content TEXT NOT NULL, "
                "size_bytes BIGINT NOT NULL DEFAULT 0, "
                "origem TEXT NOT NULL DEFAULT 'direto', "  # direto|reconstruido
                "criado_em TIMESTAMPTZ NOT NULL DEFAULT now(), "
                "atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(), "
                "PRIMARY KEY (tenant, memoria, doc_id))"
            )
    # container pode ter morrido no meio de um job: devolve pra fila no boot
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE ingest_jobs SET status = 'na_fila', chunks_feitos = 0 "
                "WHERE status = 'processando'"
            )
    # v1.8: migracao — reconstrói documents dos chunks pre-v1.8 (concatena na
    # ordem de insercao; origem='reconstruido' marca fonte aproximada).
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO documents (tenant, memoria, doc_id, title, "
                "content, size_bytes, origem, criado_em, atualizado_em) "
                "SELECT c.tenant, c.memoria, c.doc_id, max(c.title), "
                "string_agg(c.body, ' ' ORDER BY c.id), "
                "sum(octet_length(c.body)), 'reconstruido', "
                "min(c.ingested_at), max(c.ingested_at) "
                "FROM chunks c "
                "WHERE NOT EXISTS (SELECT 1 FROM documents d "
                "WHERE d.tenant = c.tenant AND d.memoria = c.memoria "
                "AND d.doc_id = c.doc_id) "
                "GROUP BY c.tenant, c.memoria, c.doc_id"
            )
            if cur.rowcount:
                print("[minirag] documents: %d doc(s) reconstruido(s) de chunks"
                      % cur.rowcount, flush=True)
    if not USERS:
        print("[minirag] AVISO: MINIRAG_USERS vazio — nenhum pedido entra")
    else:
        print(
            "[minirag] %d usuario(s) com acesso: %s"
            % (len(USERS), ", ".join(n for n, _ in USERS))
        )
        if OPERADOR:
            print("[minirag] operador ativo: %s (ve todas as gavetas)"
                  % ", ".join(n for n, _ in OPERADOR))
        print(
            "[minirag] limites: content<=%d chars, query<=%d chars, "
            "%d chunks/usuario; decay=%s (%d dias, min %d acessos, a cada %d min)"
            % (
                CONFIG.max_content_chars, CONFIG.max_query_chars,
                CONFIG.max_chunks_tenant, "ON" if CONFIG.decay_ativo else "OFF",
                CONFIG.decay_dias, CONFIG.decay_min_acessos,
                CONFIG.decay_intervalo_minutos,
            )
        )


# ------------------------------------------------------------- chunking ---
def chunk_text(text: str, max_words: int, overlap: int):
    """Sliding window of words; tries to break at sentence end when possible."""
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    words = text.split()
    if len(words) <= max_words:
        return [text]
    # word-index of the end of each sentence
    ends = []
    for m in re.finditer(r"\b\w+[.!?]+\b", text):
        ends.append(text[: m.end()].count(" "))
    chunks = []
    pos = 0
    while pos < len(words):
        cut = min(pos + max_words, len(words))
        for se in reversed(ends):
            if pos < se < cut and (se - pos) >= 20 and (len(words) - se) >= 10:
                cut = se + 1
                break
        chunks.append(" ".join(words[pos:cut]))
        pos = max(cut - overlap, cut + 1)
    if len(chunks) > 1 and len(chunks[-1].split()) < 15:
        chunks[-2] = chunks[-2] + " " + chunks[-1]
        chunks.pop()
    return [c.strip() for c in chunks if c.strip()]


# --------------------------------------------------------------- decay ----
def run_decay(dias: Optional[int] = None, min_acessos: Optional[int] = None,
              tenant: Optional[str] = None) -> dict:
    """Arquiva (sem apagar) documentos pouco usados ha muito tempo. v1.8: a
    DECISAO E POR DOCUMENTO — soma dos acessos dos chunks do doc; o doc inteiro
    vira arquivado (nunca mais metade de uma nota esfriada sozinha).

    dias/min_acessos None = usa o CONFIG. dias=0 arquiva tudo abaixo do minimo
    AGORA (util p/ teste e operacao manual). tenant=None = global (so operador
    chega aqui sem filtro; POST /decay passa o tenant de quem chama).
    """
    d = CONFIG.decay_dias if dias is None else dias
    m = CONFIG.decay_min_acessos if min_acessos is None else min_acessos
    escopo = " AND u.tenant = %s" if tenant is not None else ""
    params = (m, d, tenant) if tenant is not None else (m, d)
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "WITH uso AS ("
                "  SELECT tenant, memoria, doc_id, "
                "         sum(access_count) AS acessos, "
                "         max(COALESCE(last_accessed_at, ingested_at)) AS ultimo "
                "  FROM chunks GROUP BY tenant, memoria, doc_id"
                ") "
                "UPDATE chunks c SET archived_at = now() "
                "FROM uso u "
                "WHERE u.tenant = c.tenant AND u.memoria = c.memoria "
                "  AND u.doc_id = c.doc_id "
                "  AND c.archived_at IS NULL "
                "  AND u.acessos < %s "
                "  AND u.ultimo < now() - make_interval(days => %s)"
                + escopo.replace("u.tenant", "c.tenant")
                + " RETURNING c.tenant, c.memoria, c.doc_id",
                params,
            )
            atingidos = cur.fetchall()
            docs_afetados = {(r[0], r[1], r[2]) for r in atingidos}
            f = " WHERE tenant = %s" if tenant is not None else ""
            cur.execute(
                "SELECT count(*) FILTER (WHERE archived_at IS NULL), "
                "count(*) FILTER (WHERE archived_at IS NOT NULL) FROM chunks" + f,
                (tenant,) if tenant is not None else (),
            )
            ativos, arquivados = cur.fetchone()
    return {"arquivados_agora": len(atingidos),
            "docs_arquivados_agora": len(docs_afetados),
            "ativos": ativos, "arquivados": arquivados}


# --------------------------------------------------------------- auth ----
def authenticate(request: Request):
    """Nivel 1: quem esta logando. A memoria (nivel 2) vem no corpo do pedido.

    v1.8: chaves de MINIRAG_OPERADOR ganham escopo 'operador' (veem tudo);
    chaves de MINIRAG_USERS permanecem tenant puro (o proprio, sempre).
    """
    authz = request.headers.get("Authorization", "")
    token = authz[len("Bearer "):] if authz.startswith("Bearer ") else authz
    token = token.strip()
    if not token:
        raise HTTPException(401, "falta Authorization: Bearer ***")
    for name, key in USERS:
        if hmac.compare_digest(token, key):
            return {"tenant": name}
    for name, key in OPERADOR:
        if hmac.compare_digest(token, key):
            return {"tenant": name, "operador": True}
    raise HTTPException(401, "chave nao habilitada")


# ------------------------------------------------------------------ app ---
ORIGINS = [o.strip() for o in os.environ.get("MINIRAG_CORS_ORIGINS", "").split(",") if o.strip()]


@asynccontextmanager
async def lifespan(app: "FastAPI"):
    # boot: espera o banco, entao carrega o modelo de embedding e cria as
    # tabelas ANTES de o uvicorn comecar a servir; se o banco nunca aparecer,
    # o container morre com mensagem clara (healthcheck nao marca saudavel
    # falso) e o restart policy do Docker tenta de novo.
    wait_db()
    load_model()
    init_db()
    decay_task = None
    if CONFIG.decay_ativo:
        async def _decay_loop():
            while True:
                await asyncio.sleep(CONFIG.decay_intervalo_minutos * 60)
                try:
                    r = await asyncio.to_thread(run_decay)
                    if r["arquivados_agora"]:
                        print("[minirag] decay arquivou %d chunk(s)"
                              % r["arquivados_agora"])
                except Exception as e:  # nunca derruba o servidor por maintenance
                    print("[minirag] decay falhou:", e)
        decay_task = asyncio.create_task(_decay_loop())
    worker_task = asyncio.create_task(ingest_worker())
    yield
    worker_task.cancel()
    if decay_task is not None:
        decay_task.cancel()


# docs_url=None: o Swagger do FastAPI mora em /docs, que colidiria com o
# nosso GET /docs (listagem de documentos do tenant). Serviço interno,
# entao desligamos a UI de docs do framework.
app = FastAPI(title="Minirag", version="1.9.0", lifespan=lifespan,
              docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

# Servidor MCP (JSON-RPC sobre POST /mcp) — mesma app, mesma auth, chama as
# funcoes deste modulo direto (sem HTTP interno). Ver mcp_server.py.
from mcp_server import mcp_endpoint  # noqa: E402  (import apos `app`)

app.post("/mcp")(mcp_endpoint)

# v1.9 — PAINEL: front-end estatico servido pela propria API (pasta painel/).
# Separacao logica FE/BE sem segundo container: a pagina usa exatamente as
# mesmas rotas REST + Bearer do resto do servico. Sem a pasta (dev solto),
# o servico segue normal — so nao ha painel.
PAINEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "painel")
if os.path.isdir(PAINEL_DIR):
    app.mount("/painel", StaticFiles(directory=PAINEL_DIR, html=True),
              name="painel")


@app.get("/health")
def health():
    return {"status": "ok", "dim": MODEL_DIM, "usuarios": len(USERS),
            "operador": bool(OPERADOR), "versao": "1.9.0"}


# ---------------------------------------------------------- ingest ---------
class IngestBody(BaseModel):
    doc_id: str
    title: Optional[str] = None
    content: str = Field(..., min_length=1, max_length=CONFIG.max_content_chars)
    memoria: str = Field(default="", max_length=128)
    tenant: Optional[str] = None  # v1.8: SÓ a chave operador consegue mirar aqui


@app.post("/ingest", status_code=202)
def ingest(body: IngestBody, user: dict = Depends(authenticate)):
    return enqueue_ingest(body, tenant_for(user, body.tenant))


def enqueue_ingest(body: IngestBody, tenant: str) -> dict:
    """Valida, estima chunks, checa cota e ENFILEIRA. Nao gera embedding aqui."""
    memoria = body.memoria.strip()
    chunks = chunk_text(body.content, CONFIG.max_chunk_words, CONFIG.chunk_overlap)
    if not chunks:
        raise HTTPException(400, "nada para ingerir")
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM chunks WHERE tenant = %s", (tenant,))
            total = cur.fetchone()[0]
            if total + len(chunks) > CONFIG.max_chunks_tenant:
                raise HTTPException(
                    413,
                    "limite de %d chunks por usuario atingido (voce tem %d; "
                    "este arquivo precisaria de %d)"
                    % (CONFIG.max_chunks_tenant, total, len(chunks)),
                )
            cur.execute(
                "INSERT INTO ingest_jobs (tenant, memoria, doc_id, title, content, chunks_total) "
                "VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
                (tenant, memoria, body.doc_id, body.title, body.content, len(chunks)),
            )
            job_id = cur.fetchone()[0]
    return {"job_id": job_id, "status": "na_fila", "chunks_total": len(chunks),
            "mensagem": "na fila; acompanhe em GET /ingest/%s" % job_id}


def job_status(cur, job_id: int, tenant: Optional[str]):
    filtro = ""
    params = (job_id,)
    if tenant is not None:
        filtro = " AND tenant = %s"
        params = (job_id, tenant)
    cur.execute(
        "SELECT id, doc_id, coalesce(title,''), memoria, status, chunks_total, "
        "chunks_feitos, erro, criado_em, finalizado_em FROM ingest_jobs "
        "WHERE id = %s" + filtro,
        params,
    )
    r = cur.fetchone()
    if not r:
        return None
    return {"job_id": r[0], "doc_id": r[1], "title": r[2], "memoria": r[3],
            "status": r[4], "chunks_total": r[5], "chunks_feitos": r[6],
            "erro": r[7], "criado_em": r[8].isoformat() if r[8] else None,
            "finalizado_em": r[9].isoformat() if r[9] else None}


@app.get("/ingest/{job_id}")
def get_job(job_id: int, tenant: str = "", user: dict = Depends(authenticate)):
    # tenant=None = operador sem filtro (acha job de qualquer um); comum so ve o seu
    alvo = tenant_filter(user, tenant)
    with connect() as conn:
        with conn.cursor() as cur:
            st = job_status(cur, job_id, alvo)
    if st is None:
        raise HTTPException(404, "job nao existe (ou e de outro usuario)")
    return st


# ------------------------------------------------------------------ worker ---
async def ingest_worker():
    """Consome ingest_jobs 1 por 1. Embed em thread separada (nao trava a API).

    O doc ANTIGO permanece no ar durante o processamento (busca continua
    respondendo com a versao anterior); so no fim os chunks novos substituem
    os antigos (DELETE por id < primeiro id novo — worker e serial, entao
    nenhum outro job insere chunks no meio).
    """
    while True:
        try:
            job = await asyncio.to_thread(claim_next_job)
            if job is None:
                await asyncio.sleep(2)
                continue
            resumo = await asyncio.to_thread(process_job, *job)
            print("[minirag] job %s concluido: %s" % (job[0], resumo))
        except asyncio.CancelledError:
            raise
        except Exception as e:  # nunca derruba o worker
            print("[minirag] worker erro:", e)
            await asyncio.sleep(5)


def claim_next_job():
    """Pega o proximo job da fila (garante 1 claim — UPDATE ... WHERE na_fila)."""
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE ingest_jobs SET status='processando' "
                "WHERE id = (SELECT id FROM ingest_jobs WHERE status='na_fila' "
                "ORDER BY id LIMIT 1) "
                "RETURNING id, tenant, memoria, doc_id, title, content, chunks_total"
            )
            return cur.fetchone()


def process_job(job_id, tenant, memoria, doc_id, title, content, chunks_total):
    first_new_id = None
    try:
        chunks = chunk_text(content, CONFIG.max_chunk_words, CONFIG.chunk_overlap)
        for i, c in enumerate(chunks):
            with connect() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "INSERT INTO chunks (tenant, memoria, doc_id, title, body, embedding) "
                        "VALUES (%s, %s, %s, %s, %s, %s::vector) RETURNING id",
                        (tenant, memoria, doc_id, title, c, embed(c)),
                    )
                    rid = cur.fetchone()[0]
                    if first_new_id is None:
                        first_new_id = rid
                    cur.execute(
                        "UPDATE ingest_jobs SET chunks_feitos = %s WHERE id = %s",
                        (i + 1, job_id),
                    )
        # substitui o doc antigo SO agora que todos os novos estao gravados
        with connect() as conn:
            with conn.cursor() as cur:
                if first_new_id is not None:
                    cur.execute(
                        "DELETE FROM chunks WHERE tenant=%s AND memoria=%s "
                        "AND doc_id=%s AND id < %s",
                        (tenant, memoria, doc_id, first_new_id),
                    )
                # v1.8: a fonte da verdade — documento original (re)gravado.
                cur.execute(
                    "INSERT INTO documents (tenant, memoria, doc_id, title, "
                    "content, size_bytes, origem) "
                    "VALUES (%s, %s, %s, %s, %s, %s, 'direto') "
                    "ON CONFLICT (tenant, memoria, doc_id) DO UPDATE SET "
                    "title = EXCLUDED.title, content = EXCLUDED.content, "
                    "size_bytes = EXCLUDED.size_bytes, origem = 'direto', "
                    "atualizado_em = now()",
                    (tenant, memoria, doc_id, title, content,
                     len(content.encode("utf-8"))),
                )
                cur.execute(
                    "UPDATE ingest_jobs SET status='concluido', finalizado_em=now() "
                    "WHERE id = %s",
                    (job_id,),
                )
        return "%d chunks" % len(chunks)
    except Exception as e:
        # limpa insercoes parciais deste job; doc antigo permanece intacto
        if first_new_id is not None:
            with connect() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "DELETE FROM chunks WHERE tenant=%s AND memoria=%s "
                        "AND doc_id=%s AND id >= %s",
                        (tenant, memoria, doc_id, first_new_id),
                    )
        with connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE ingest_jobs SET status='erro', erro=%s, "
                    "finalizado_em=now() WHERE id = %s",
                    (str(e)[:500], job_id),
                )
        raise


#---------------------------------------------------------- search ----------
class SearchBody(BaseModel):
    query: str = Field(..., min_length=1, max_length=CONFIG.max_query_chars)
    k: int = Field(default=CONFIG.top_k, ge=1, le=50)
    min_score: float = Field(default=CONFIG.min_score, ge=0.0, le=1.0)
    memoria: str = Field(default="", max_length=128)
    include_archived: bool = False
    tenant: Optional[str] = None  # v1.8: ignorado por login comum; operador mira


@app.post("/search")
def search(body: SearchBody, user: dict = Depends(authenticate)):
    vec = embed(body.query)
    memoria = body.memoria.strip()
    tenant = tenant_for(user, body.tenant)
    where = "tenant = %s AND memoria = %s"
    if not body.include_archived:
        where += " AND archived_at IS NULL"
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, doc_id, coalesce(title, ''), body, "
                "embedding <=> %s::vector AS dist, "
                "archived_at IS NOT NULL AS arquivado "
                f"FROM chunks WHERE {where} "
                "ORDER BY embedding <=> %s::vector LIMIT %s",
                (vec, tenant, memoria, vec, body.k),
            )
            rows = cur.fetchall()
    items = []
    for i, r in enumerate(rows, 1):
        score = 1.0 - float(r[4])  # <=> com vector_cosine_ops = 1 - cos
        if score < body.min_score:
            break
        items.append(
            {
                "rank": i,
                "score": round(score, 4),
                "chunk_id": r[0],
                "doc_id": r[1],
                "title": r[2],
                "text": r[3],
                "arquivado": bool(r[5]),
            }
        )
    # memoria inteligente: o que foi devolvido ganha carimbo de uso; em v1.8
    # incluir arquivado REVIVE O DOCUMENTO INTEIRO do chunk achado (simetria
    # com o decay, que tambem decide por documento — nunca meias notas ativas)
    if items:
        ids = [it["chunk_id"] for it in items]
        docs_reviver = sorted({it["doc_id"] for it in items if it["arquivado"]})
        with connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE chunks SET last_accessed_at = now(), "
                    "access_count = access_count + 1 WHERE id = ANY(%s)",
                    (ids,),
                )
                if docs_reviver:
                    cur.execute(
                        "UPDATE chunks SET archived_at = NULL "
                        "WHERE tenant = %s AND memoria = %s "
                        "AND doc_id = ANY(%s) AND archived_at IS NOT NULL",
                        (tenant, memoria, docs_reviver),
                    )
    return {"tenant": tenant, "memoria": memoria,
            "items": items, "total": len(items)}


# ---------------------------------------------------------- docs -----------
@app.get("/docs")
def list_docs(memoria: str = "", include_archived: bool = False,
              tenant: str = "", user: dict = Depends(authenticate)):
    memoria = memoria.strip()
    tenant = tenant_for(user, tenant)
    where = "tenant = %s AND memoria = %s"
    if not include_archived:
        where += " AND archived_at IS NULL"
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT doc_id, coalesce(max(title), ''), count(*), max(ingested_at), "
                "count(*) FILTER (WHERE archived_at IS NOT NULL) "
                f"FROM chunks WHERE {where} "
                "GROUP BY doc_id ORDER BY max(ingested_at) DESC",
                (tenant, memoria),
            )
            rows = cur.fetchall()
    return {
        "tenant": tenant,
        "memoria": memoria,
        "docs": [
            {
                "doc_id": r[0],
                "title": r[1],
                "chunks": r[2],
                "updated_at": r[3].isoformat() if r[3] else None,
                "chunks_arquivados": r[4],
            }
            for r in rows
        ],
    }


# --------------------------------------------------- agregados (v1.8) ------
@app.get("/gavetas")
def list_gavetas(tenant: str = "", user: dict = Depends(authenticate)):
    """Mapa da memoria: tenant x gaveta x docs x chunks (vivos/arquivados).

    Login comum ve so o dele; chave operador ve TUDO (ou ?tenant=<nome>).
    """
    alvo = tenant_filter(user, tenant)
    where = ""
    params = ()
    if alvo is not None:
        where = "WHERE tenant = %s"
        params = (alvo,)
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT tenant, memoria, count(*), count(DISTINCT doc_id), "
                "count(*) FILTER (WHERE archived_at IS NOT NULL), "
                "min(ingested_at), max(ingested_at) "
                "FROM chunks " + where + " "
                "GROUP BY tenant, memoria ORDER BY tenant, memoria",
                params,
            )
            rows = cur.fetchall()
            cur.execute(
                "SELECT count(*) FROM documents"
                + (" WHERE tenant = %s" if alvo is not None else ""),
                params,
            )
            n_docs_fonte = cur.fetchone()[0]
    return {
        "operador": is_operador(user),
        "gavetas": [
            {
                "tenant": r[0],
                "memoria": r[1],
                "chunks": r[2],
                "docs": r[3],
                "chunks_arquivados": r[4],
                "primeiro_ingress": r[5].isoformat() if r[5] else None,
                "ultimo_ingress": r[6].isoformat() if r[6] else None,
            }
            for r in rows
        ],
        "documentos_fonte": n_docs_fonte,
    }


@app.get("/jobs")
def list_jobs(status: str = "", tenant: str = "", limit: int = 50,
              user: dict = Depends(authenticate)):
    """Fila de ingestao com status (?status=na_fila|processando|concluido|
    erro|cancelado). Login comum: so os jobs dele; operador: todos."""
    alvo = tenant_filter(user, tenant)
    conds, params = [], []
    if alvo is not None:
        conds.append("tenant = %s")
        params.append(alvo)
    if status.strip():
        conds.append("status = %s")
        params.append(status.strip())
    where = ("WHERE " + " AND ".join(conds) + " ") if conds else ""
    lim = max(1, min(int(limit), 200))
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, tenant, memoria, doc_id, coalesce(title,''), status, "
                "chunks_total, chunks_feitos, erro, criado_em, finalizado_em "
                "FROM ingest_jobs " + where +
                "ORDER BY id DESC LIMIT %s",
                tuple(params + [lim]),
            )
            rows = cur.fetchall()
            cur.execute(
                "SELECT status, count(*) FROM ingest_jobs "
                + where.rstrip() + " GROUP BY status",
                tuple(params),
            )
            resumo = {r[0]: r[1] for r in cur.fetchall()}
    return {
        "resumo_por_status": resumo,
        "jobs": [
            {"job_id": r[0], "tenant": r[1], "memoria": r[2], "doc_id": r[3],
             "title": r[4], "status": r[5], "chunks_total": r[6],
             "chunks_feitos": r[7], "erro": r[8],
             "criado_em": r[9].isoformat() if r[9] else None,
             "finalizado_em": r[10].isoformat() if r[10] else None}
            for r in rows
        ],
    }


# ------------------------------------------------ documents (v1.8) ----------
def get_document_row(cur, tenant: str, memoria: str, doc_id: str):
    cur.execute(
        "SELECT title, content, size_bytes, origem, criado_em, atualizado_em "
        "FROM documents WHERE tenant = %s AND memoria = %s AND doc_id = %s",
        (tenant, memoria, doc_id),
    )
    return cur.fetchone()


@app.get("/documents/{doc_id}")
def get_document(doc_id: str, memoria: str = "", tenant: str = "",
                 user: dict = Depends(authenticate)):
    """Conteudo ORIGINAL do arquivo (a fonte da verdade — nao os chunks)."""
    t = tenant_for(user, tenant)
    with connect() as conn:
        with conn.cursor() as cur:
            r = get_document_row(cur, t, memoria.strip(), doc_id)
    if not r:
        raise HTTPException(404, "documento nao encontrado nesta memoria")
    return {"tenant": t, "memoria": memoria.strip(), "doc_id": doc_id,
            "title": r[0], "content": r[1], "size_bytes": r[2], "origem": r[3],
            "criado_em": r[4].isoformat(), "atualizado_em": r[5].isoformat()}


@app.get("/documents/{doc_id}/raw")
def download_document(doc_id: str, memoria: str = "", tenant: str = "",
                      user: dict = Depends(authenticate)):
    """Download do arquivo original (Content-Disposition anexo)."""
    t = tenant_for(user, tenant)
    with connect() as conn:
        with conn.cursor() as cur:
            r = get_document_row(cur, t, memoria.strip(), doc_id)
    if not r:
        raise HTTPException(404, "documento nao encontrado nesta memoria")
    nome = re.sub(r"[^A-Za-z0-9._-]", "_", (r[0] or doc_id))[:80] or "documento"
    return Response(
        content=r[1], media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="%s.txt"' % nome},
    )


class EditBody(BaseModel):
    content: str = Field(..., min_length=1, max_length=CONFIG.max_content_chars)
    title: Optional[str] = None
    memoria: str = Field(default="", max_length=128)
    tenant: Optional[str] = None


@app.put("/documents/{doc_id}")
def put_document(doc_id: str, body: EditBody,
                 user: dict = Depends(authenticate)):
    """EDICAO do arquivo: grava conteudo novo e REINDEXA (volta pra fila).

    A busca continua respondendo com a versao anterior ate o job concluir —
    a mesma garantia do ingest original. Responde 202 + job_id.
    """
    t = tenant_for(user, body.tenant)
    memoria = body.memoria.strip()
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM chunks WHERE tenant=%s AND memoria=%s AND doc_id=%s "
                "LIMIT 1",
                (t, memoria, doc_id),
            )
            if not cur.fetchone():
                raise HTTPException(404, "documento nao existe nesta memoria "
                                         "(para criar, use POST /ingest)")
    ing = IngestBody(doc_id=doc_id, title=body.title, content=body.content,
                     memoria=body.memoria)
    r = enqueue_ingest(ing, t)
    r["doc_id"] = doc_id
    r["mensagem"] = "edicao na fila; reindexando — versao antiga no ar ate concluir"
    return Response(status_code=202, content=json.dumps(r, ensure_ascii=False))


# ---------------------------------------------------------- decay ----------
class DecayBody(BaseModel):
    dias: Optional[int] = Field(default=None, ge=0)
    min_acessos: Optional[int] = Field(default=None, ge=0)


# ------------------------------------------------------------ delete doc ---
@app.delete("/docs/{doc_id}")
def delete_doc(doc_id: str, memoria: str = "", tenant: str = "",
               user: dict = Depends(authenticate)):
    """Apaga DEFINITIVAMENTE um documento do chamador (chunks + documents +
    jobs pendentes). v1.8: a FONTE (documents) vai junto — nao fica 'orfao'
    editavel de indice apagado.

    Escopo: só (login, memoria) de quem chama — mesmo isolamento da busca.
    Regras:
      - job 'processando' deste doc -> 409 (esperar a ingestao terminar;
        assim o worker nao recria chunks depois do DELETE);
      - jobs 'na_fila' deste doc    -> viram 'cancelado' (nunca rodam);
      - chunks do doc (inclusive arquivados) -> apagados;
      - doc inexistente no escopo   -> 404.
    """
    memoria = memoria.strip()
    tenant = tenant_for(user, tenant)
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM chunks "
                "WHERE tenant = %s AND memoria = %s AND doc_id = %s",
                (tenant, memoria, doc_id),
            )
            n_chunks = cur.fetchone()[0]
            cur.execute(
                "SELECT count(*) FROM ingest_jobs "
                "WHERE tenant = %s AND memoria = %s AND doc_id = %s "
                "AND status = 'processando'",
                (tenant, memoria, doc_id),
            )
            processandos = cur.fetchone()[0]
            if processandos:
                raise HTTPException(
                    409, "documento em processamento agora; "
                    "acompanhe o job e apague quando terminar")
            cur.execute(
                "SELECT count(*) FROM documents "
                "WHERE tenant = %s AND memoria = %s AND doc_id = %s",
                (tenant, memoria, doc_id),
            )
            n_fonte = cur.fetchone()[0]
            if n_chunks == 0 and n_fonte == 0:
                raise HTTPException(404, "documento nao encontrado nesta memoria")
            cur.execute(
                "UPDATE ingest_jobs SET status = 'cancelado', finalizado_em = now() "
                "WHERE tenant = %s AND memoria = %s AND doc_id = %s "
                "AND status = 'na_fila'",
                (tenant, memoria, doc_id),
            )
            cancelados = cur.rowcount
            cur.execute(
                "DELETE FROM chunks "
                "WHERE tenant = %s AND memoria = %s AND doc_id = %s",
                (tenant, memoria, doc_id),
            )
            apagados = cur.rowcount
            cur.execute(
                "DELETE FROM documents "
                "WHERE tenant = %s AND memoria = %s AND doc_id = %s",
                (tenant, memoria, doc_id),
            )
            fonte_apagada = cur.rowcount
    return {"tenant": tenant, "memoria": memoria, "doc_id": doc_id,
            "chunks_apagados": apagados, "jobs_cancelados": cancelados,
            "fonte_apagada": bool(fonte_apagada)}


@app.post("/decay")
def decay(body: DecayBody, user: dict = Depends(authenticate)):
    """Roda o arquivamento AGORA (o loop de fundo tambem roda sozinho).

    v1.8: escopo POR SEGURANCA — login comum so arquiva o PROPRIO tenant
    (antes qualquer chave mexia no mundo inteiro). Chave operador sem
    ?tenant roda global. Corpo: {"dias": 0, "min_acessos": 2} sobrepoe o
    CONFIG (dias=0 arquiva imediatamente tudo abaixo do minimo de acessos).
    O loop de fundo continua global (e o mesmo processo, nao ha chamador).
    """
    alvo = None if is_operador(user) else user["tenant"]
    return run_decay(dias=body.dias, min_acessos=body.min_acessos, tenant=alvo)
