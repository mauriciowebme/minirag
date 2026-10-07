"""Minirag — RAG multi-tenant (ingest + search).

Stack: FastAPI + Postgres (pgvector) + nomic-embed-text-v1.5 (sentence-transformers).

Acesso: variavel de ambiente MINIRAG_USERS, lista "nome:chave" separada por
virgula. Sem chave na lista, nao ha entrada. Cada usuario ve e escreve APENAS
na propria memoria (tenant = nome) — nada vaza entre usuarios.

Endpoints:
  GET  /health   -> publico
  POST /ingest   -> chave valida; grava no tenant do usuario
  POST /search   -> chave valida; so le o tenant do usuario
  GET  /docs     -> chave valida; so lista o tenant do usuario
"""
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
                "doc_id TEXT NOT NULL, "
                "title TEXT, "
                "body TEXT NOT NULL, "
                "embedding VECTOR(%d) NOT NULL, "
                "ingested_at TIMESTAMPTZ NOT NULL DEFAULT now())" % MODEL_DIM
            )
            # banco ja existente (versao sem tenant): adiciona a coluna viva
            cur.execute(
                "ALTER TABLE chunks "
                "ADD COLUMN IF NOT EXISTS tenant TEXT NOT NULL DEFAULT 'default'"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS chunks_embedding_idx "
                "ON chunks USING hnsw(embedding vector_cosine_ops)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS chunks_tenant_idx ON chunks (tenant)"
            )
    if not USERS:
        print("[minirag] AVISO: MINIRAG_USERS vazio — nenhum pedido entra")
    else:
        print(
            "[minirag] %d usuario(s) com acesso: %s"
            % (len(USERS), ", ".join(n for n, _ in USERS))
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


# --------------------------------------------------------------- auth ----
def authenticate(request: Request):
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
    yield


# docs_url=None: o Swagger do FastAPI mora em /docs, que colidiria com o
# nosso GET /docs (listagem de documentos do tenant). Serviço interno,
# entao desligamos a UI de docs do framework.
app = FastAPI(title="Minirag", version="1.1.0", lifespan=lifespan,
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
    content: str = Field(..., min_length=1)


def do_ingest(doc_id: str, title: Optional[str], content: str, tenant: str) -> dict:
    chunks = chunk_text(content, CONFIG.max_chunk_words, CONFIG.chunk_overlap)
    if not chunks:
        raise HTTPException(400, "nada para ingerir")
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM chunks WHERE doc_id = %s AND tenant = %s",
                (doc_id, tenant),
            )
            cur.executemany(
                "INSERT INTO chunks (tenant, doc_id, title, body, embedding) "
                "VALUES (%s, %s, %s, %s, %s::vector)",
                [(tenant, doc_id, title, c, embed(c)) for c in chunks],
            )
    return {"tenant": tenant, "doc_id": doc_id, "chunks": len(chunks)}


@app.post("/ingest")
def ingest(body: IngestBody, user: dict = Depends(authenticate)):
    return do_ingest(body.doc_id, body.title, body.content, user["tenant"])


#---------------------------------------------------------- search ----------
class SearchBody(BaseModel):
    query: str = Field(..., min_length=1)
    k: int = Field(default=CONFIG.top_k, ge=1, le=50)
    min_score: float = Field(default=CONFIG.min_score, ge=0.0, le=1.0)


@app.post("/search")
def search(body: SearchBody, user: dict = Depends(authenticate)):
    vec = embed(body.query)
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, doc_id, coalesce(title, ''), body, "
                "embedding <=> %s::vector AS dist "
                "FROM chunks WHERE tenant = %s "
                "ORDER BY embedding <=> %s::vector LIMIT %s",
                (vec, user["tenant"], vec, body.k),
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
            }
        )
    return {"tenant": user["tenant"], "items": items, "total": len(items)}


@app.get("/docs")
def list_docs(user: dict = Depends(authenticate)):
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT doc_id, coalesce(max(title), ''), count(*), max(ingested_at) "
                "FROM chunks WHERE tenant = %s "
                "GROUP BY doc_id ORDER BY max(ingested_at) DESC",
                (user["tenant"],),
            )
            rows = cur.fetchall()
    return {
        "tenant": user["tenant"],
        "docs": [
            {
                "doc_id": r[0],
                "title": r[1],
                "chunks": r[2],
                "updated_at": r[3].isoformat() if r[3] else None,
            }
            for r in rows
        ],
    }
