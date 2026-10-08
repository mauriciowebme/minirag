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

Memória inteligente (decay):
  Cada busca que devolve um chunk carimba last_accessed_at e soma access_count.
  De MINIRAG_DECAY_INTERVALO_MINUTOS em MINIRAG_DECAY_INTERVALO_MINUTOS (e via
  POST /decay), vira ARQUIVADO o chunk com access_count < MIN_ACESSOS e sem
  acesso ha mais de DIAS. Busca normal nao ve arquivados; busca com
  include_archived=true acha E devolve o chunk pra ativa (esquece, mas lembra
  se precisarem de novo). Nada e apagado — arquivamento e reversivel.
  Nota de performance: embedding e CPU-only (~6 s por chunk de 500 palavras);
  arquivo de 2.000 linhas (~69 chunks) demora ~6-7 min pra ingerir, e o teto
  de 500k chars (~218 chunks) pode levar ~20 min — o pedido segura a conexão
  nesse tempo (cliente: timeout alto).

Endpoints:
  GET  /health   -> publico
  POST /ingest   -> entra na FILA (responde 202 + job_id na hora; nao segura conexão)
  GET  /ingest/{job_id} -> status do job (na_fila|processando|concluido|erro)
  POST /search   -> le apenas a (login, memoria) do chamador; ?include_archived
  GET  /docs     -> lista apenas a (login, memoria); ?memoria=...; ?include_archived
  POST /decay    -> roda o arquivamento AGORA (corpo opcional: dias, min_acessos)

Fila de ingestao: o texto e gravado no banco (tabela ingest_jobs) e um worker
de fundo faz os embeddings pedaco a pedaco (~6 s cada em CPU). O pedido volta
202 em milissegundos; busca e demais endpoints seguem respondendo durante o
processamento; se o container reiniciar no meio, o job volta pra fila
(durabilidade no proprio Postgres — sem Redis/Celery).
"""
import asyncio
import hmac
import os
import re
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Optional

import psycopg
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
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
                "status TEXT NOT NULL DEFAULT 'na_fila', "  # na_fila|processando|concluido|erro
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
    # container pode ter morrido no meio de um job: devolve pra fila no boot
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE ingest_jobs SET status = 'na_fila', chunks_feitos = 0 "
                "WHERE status = 'processando'"
            )
    if not USERS:
        print("[minirag] AVISO: MINIRAG_USERS vazio — nenhum pedido entra")
    else:
        print(
            "[minirag] %d usuario(s) com acesso: %s"
            % (len(USERS), ", ".join(n for n, _ in USERS))
        )
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
def run_decay(dias: Optional[int] = None, min_acessos: Optional[int] = None) -> dict:
    """Arquiva (sem apagar) chunks pouco usados ha muito tempo. Global.

    dias/min_acessos None = usa o CONFIG. dias=0 arquiva tudo abaixo do
    minimo de acessos AGORA (util p/ teste e operacao manual).
    """
    d = CONFIG.decay_dias if dias is None else dias
    m = CONFIG.decay_min_acessos if min_acessos is None else min_acessos
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE chunks SET archived_at = now() "
                "WHERE archived_at IS NULL "
                "AND access_count < %s "
                "AND COALESCE(last_accessed_at, ingested_at) "
                "< now() - make_interval(days => %s)",
                (m, d),
            )
            agora = cur.rowcount
            cur.execute(
                "SELECT count(*) FILTER (WHERE archived_at IS NULL), "
                "count(*) FILTER (WHERE archived_at IS NOT NULL) FROM chunks"
            )
            ativos, arquivados = cur.fetchone()
    return {"arquivados_agora": agora, "ativos": ativos, "arquivados": arquivados}


# --------------------------------------------------------------- auth ----
def authenticate(request: Request):
    """Nivel 1: quem esta logando. A memoria (nivel 2) vem no corpo do pedido."""
    authz = request.headers.get("Authorization", "")
    token = authz[len("Bearer "):] if authz.startswith("Bearer ") else authz
    token = token.strip()
    if not token:
        raise HTTPException(401, "falta Authorization: Bearer ***")
    for name, key in USERS:
        if hmac.compare_digest(token, key):
            return {"tenant": name}
    raise HTTPException(401, "chave nao habilitada")


# ------------------------------------------------------------------ app ---
ORIGINS = [o.strip() for o in os.environ.get("MINIRAG_CORS_ORIGINS", "").split(",") if o.strip()]


@asynccontextmanager
async def lifespan(app: "FastAPI"):
    # boot: carrega o modelo de embedding e cria tabelas ANTES de o uvicorn
    # comecar a servir; se falhar, container morre (healthcheck nao marca
    # saudavel falso).
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
app = FastAPI(title="Minirag", version="1.4.0", lifespan=lifespan,
              docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/health")
def health():
    return {"status": "ok", "dim": MODEL_DIM, "usuarios": len(USERS)}


# ---------------------------------------------------------- ingest ---------
class IngestBody(BaseModel):
    doc_id: str
    title: Optional[str] = None
    content: str = Field(..., min_length=1, max_length=CONFIG.max_content_chars)
    memoria: str = Field(default="", max_length=128)


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


@app.post("/ingest", status_code=202)
def ingest(body: IngestBody, user: dict = Depends(authenticate)):
    return enqueue_ingest(body, user["tenant"])


def job_status(cur, job_id: int, tenant: str):
    cur.execute(
        "SELECT id, doc_id, coalesce(title,''), memoria, status, chunks_total, "
        "chunks_feitos, erro, criado_em, finalizado_em FROM ingest_jobs "
        "WHERE id = %s AND tenant = %s",
        (job_id, tenant),
    )
    r = cur.fetchone()
    if not r:
        return None
    return {"job_id": r[0], "doc_id": r[1], "title": r[2], "memoria": r[3],
            "status": r[4], "chunks_total": r[5], "chunks_feitos": r[6],
            "erro": r[7], "criado_em": r[8].isoformat() if r[8] else None,
            "finalizado_em": r[9].isoformat() if r[9] else None}


@app.get("/ingest/{job_id}")
def get_job(job_id: int, user: dict = Depends(authenticate)):
    with connect() as conn:
        with conn.cursor() as cur:
            st = job_status(cur, job_id, user["tenant"])
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


@app.post("/search")
def search(body: SearchBody, user: dict = Depends(authenticate)):
    vec = embed(body.query)
    memoria = body.memoria.strip()
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
                (vec, user["tenant"], memoria, vec, body.k),
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
    # memoria inteligente: o que foi devolvido ganha carimbo de uso; chunk
    # arquivado achado por include_archived VOLTA para a ativa (revive)
    if items:
        ids = [it["chunk_id"] for it in items]
        with connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE chunks SET last_accessed_at = now(), "
                    "access_count = access_count + 1 WHERE id = ANY(%s)",
                    (ids,),
                )
                if body.include_archived:
                    cur.execute(
                        "UPDATE chunks SET archived_at = NULL "
                        "WHERE id = ANY(%s) AND archived_at IS NOT NULL",
                        (ids,),
                    )
    return {"tenant": user["tenant"], "memoria": memoria,
            "items": items, "total": len(items)}


# ---------------------------------------------------------- docs -----------
@app.get("/docs")
def list_docs(memoria: str = "", include_archived: bool = False,
              user: dict = Depends(authenticate)):
    memoria = memoria.strip()
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
                (user["tenant"], memoria),
            )
            rows = cur.fetchall()
    return {
        "tenant": user["tenant"],
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


# ---------------------------------------------------------- decay ----------
class DecayBody(BaseModel):
    dias: Optional[int] = Field(default=None, ge=0)
    min_acessos: Optional[int] = Field(default=None, ge=0)


@app.post("/decay")
def decay(body: DecayBody, user: dict = Depends(authenticate)):
    """Roda o decay AGORA (o loop de fundo tambem roda sozinho). Global.

    Corpo opcional: {"dias": 0, "min_acessos": 2} sobrepoe o CONFIG
    (dias=0 arquiva imediatamente tudo abaixo do minimo de acessos).
    """
    return run_decay(dias=body.dias, min_acessos=body.min_acessos)
