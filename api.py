"""Minirag service — ingest, search and API keys.

Stack: FastAPI + Postgres (pgvector) + nomic-embed-text (sentence-transformers).

Endpoints:
  GET  /health        -> public
  POST /ingest        -> scope=ingest
  POST /search        -> scope=search
  GET  /docs          -> scope=search
  POST /keys          -> scope=ingest
  GET  /keys          -> scope=ingest

On first start it creates a bootstrap key (scope=ingest) and prints its
secret once. Keep it; from then on you create scoped keys via /keys.
"""
import hashlib
import os
import re
import secrets
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
    model=os.environ.get("MINIRAG_MODEL", "nomic-ai/nomic-embed-text"),
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


# ---------------------------------------------------------------- model ----
MODEL: Optional[SentenceTransformer] = None
MODEL_DIM: int = 0


def load_model() -> int:
    global MODEL, MODEL_DIM
    if MODEL is None:
        if os.path.exists(CONFIG.model_dir):
            MODEL = SentenceTransformer(CONFIG.model_dir, show_progress_bar=False)
        else:
            MODEL = SentenceTransformer(CONFIG.model, show_progress_bar=False)
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
                "doc_id TEXT NOT NULL, "
                "title TEXT, "
                "body TEXT NOT NULL, "
                "embedding VECTOR(%d) NOT NULL, "
                "ingested_at TIMESTAMPTZ NOT NULL DEFAULT now())" % MODEL_DIM
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS chunks_embedding_idx "
                "ON chunks USING ivfflat(embedding vector_cosine_ops) WITH (lists = 10)"
            )
            cur.execute(
                "CREATE TABLE IF NOT EXISTS api_keys ("
                "id BIGSERIAL PRIMARY KEY, "
                "name TEXT NOT NULL, "
                "scope TEXT NOT NULL CHECK (scope IN ('search', 'ingest')), "
                "secret_hash TEXT NOT NULL UNIQUE, "
                "secret_prefix TEXT NOT NULL, "
                "created_at TIMESTAMPTZ NOT NULL DEFAULT now())"
            )
            cur.execute("SELECT count(*) FROM api_keys")
            if cur.fetchone()[0] == 0:
                secret = secrets.token_urlsafe(32)
                cur.execute(
                    "INSERT INTO api_keys (name, scope, secret_hash, secret_prefix) "
                    "VALUES (%s, %s, %s, %s)",
                    (
                        "bootstrap",
                        "ingest",
                        hashlib.sha256(secret.encode()).hexdigest(),
                        secret[:8],
                    ),
                )
                print(f"[minirag] CHAVE INICIAL: {secret}")
                print("[minirag] guarde esta chave; crie mais via POST /keys")


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
    h = hashlib.sha256(token.encode()).hexdigest()
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, name, scope FROM api_keys WHERE secret_hash = %s", (h,)
            )
            row = cur.fetchone()
    if row is None:
        raise HTTPException(401, "API key invalida")
    return {"id": row[0], "name": row[1], "scope": row[2]}


def requires(scope: str):
    def checker(user: dict = Depends(authenticate)):
        if user["scope"] != scope:
            raise HTTPException(403, f"chave sem escopo {scope}")
        return user

    return checker


# ------------------------------------------------------------------ app ---
ORIGINS = [o.strip() for o in os.environ.get("MINIRAG_CORS_ORIGINS", "").split(",") if o.strip()]


@asynccontextmanager
async def lifespan(app: "FastAPI"):
    # boot: carrega o modelo de embedding e cria tabelas/chave inicial
    # ANTES de o uvicorn comecar a servir; se falhar, container morre
    # (healthcheck nao marca saudavel falso).
    load_model()
    init_db()
    yield


app = FastAPI(title="Minirag", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/health")
def health():
    return {"status": "ok", "dim": MODEL_DIM}


# ---------------------------------------------------------- ingest ---------
class IngestBody(BaseModel):
    doc_id: str
    title: Optional[str] = None
    content: str = Field(..., min_length=1)


def do_ingest(doc_id: str, title: Optional[str], content: str) -> dict:
    chunks = chunk_text(content, CONFIG.max_chunk_words, CONFIG.chunk_overlap)
    if not chunks:
        raise HTTPException(400, "nada para ingerir")
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM chunks WHERE doc_id = %s", (doc_id,))
            cur.executemany(
                "INSERT INTO chunks (doc_id, title, body, embedding) "
                "VALUES (%s, %s, %s, %s::vector)",
                [(doc_id, title, c, embed(c)) for c in chunks],
            )
    return {"doc_id": doc_id, "chunks": len(chunks)}


@app.post("/ingest")
def ingest(body: IngestBody, user: dict = Depends(requires("ingest"))):
    return do_ingest(body.doc_id, body.title, body.content)


#---------------------------------------------------------- search ----------
class SearchBody(BaseModel):
    query: str = Field(..., min_length=1)
    k: int = Field(default=CONFIG.top_k, ge=1, le=50)
    min_score: float = Field(default=CONFIG.min_score, ge=0.0, le=1.0)


@app.post("/search")
def search(body: SearchBody, user: dict = Depends(requires("search"))):
    vec = embed(body.query)
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, doc_id, coalesce(title, ''), body, "
                "embedding <=> %s::vector AS dist "
                "FROM chunks "
                "ORDER BY embedding <=> %s::vector LIMIT %d",
                (vec, vec, body.k),
            )
            rows = cur.fetchall()
    items = []
    for i, r in enumerate(rows, 1):
        score = 1.0 - float(r[4])  # <=> with vector_cosine_ops = 1 - cos
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
    return {"items": items, "total": len(items)}


@app.get("/docs")
def list_docs(user: dict = Depends(requires("search"))):
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT doc_id, coalesce(max(title), ''), count(*), max(ingested_at) "
                "FROM chunks GROUP BY doc_id ORDER BY max(ingested_at) DESC"
            )
            rows = cur.fetchall()
    return {
        "docs": [
            {
                "doc_id": r[0],
                "title": r[1],
                "chunks": r[2],
                "updated_at": r[3].isoformat() if r[3] else None,
            }
            for r in rows
        ]
    }


#------------------------------------------------------------------ keys ---
class CreateKeyBody(BaseModel):
    name: str = Field(..., max_length=64)
    scope: str = Field(..., pattern="^(search|ingest)$")


@app.post("/keys")
def create_key(body: CreateKeyBody, user: dict = Depends(requires("ingest"))):
    secret = secrets.token_urlsafe(32)
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO api_keys (name, scope, secret_hash, secret_prefix) "
                "VALUES (%s, %s, %s, %s)",
                (
                    body.name,
                    body.scope,
                    hashlib.sha256(secret.encode()).hexdigest(),
                    secret[:8],
                ),
            )
            cur.execute("SELECT lastval()")
            key_id = cur.fetchone()[0]
    return {
        "id": key_id,
        "name": body.name,
        "scope": body.scope,
        "prefix": secret[:8],
        "secret": secret,
        "note": "guarde esta chave; ela so aparece uma vez",
    }


@app.get("/keys")
def list_keys(user: dict = Depends(requires("ingest"))):
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, name, scope, secret_prefix, created_at "
                "FROM api_keys ORDER BY created_at DESC"
            )
            rows = cur.fetchall()
    return {
        "keys": [
            {
                "id": r[0],
                "name": r[1],
                "scope": r[2],
                "prefix": r[3],
                "created_at": r[4].isoformat(),
            }
            for r in rows
        ]
    }
