"""Motor de embedding do minirag — processo filho do Node, só em 127.0.0.1.

Por que existe separado: o nomic-embed-text-v1.5 roda em torch/CPU e o
sentence-transformers e o caminho estavel para ele. Manter este pedaco em
Python garante que os VETORES sejam identicos aos da v1.x (nada reindexado).
O Node nunca fala com o modelo: manda textos, recebe as strings de vetor ja
formatadas no mesmo padrao do api.py antigo ("%.7f").
"""
import os
import time
from typing import List

from fastapi import FastAPI
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

MODEL_NAME = os.environ.get("MINIRAG_MODEL", "nomic-ai/nomic-embed-text-v1.5")
MODEL_DIR = os.environ.get("MINIRAG_MODEL_DIR", "/app/models")
MAX_TEXTS = int(os.environ.get("MINIRAG_EMBED_MAX_TEXTS", "256"))

app = FastAPI(title="minirag-embedder", docs_url=None, redoc_url=None)

_model = None
_dim = 0


def load():
    """Carrega o modelo uma vez e fixa a dimensao."""
    global _model, _dim
    if _model is None:
        if os.path.exists(MODEL_DIR):
            _model = SentenceTransformer(MODEL_DIR)
        else:
            _model = SentenceTransformer(MODEL_NAME)
        _dim = int(_model.encode(["x"], show_progress_bar=False)[0].shape[0])
    return _model


def vetor_str(vec) -> str:
    """MESMO formato do api.py v1.x — literal aceito pelo pgvector."""
    return "[" + ",".join(f"{x:.7f}" for x in vec.tolist()) + "]"


class EmbedBody(BaseModel):
    texts: List[str] = Field(..., min_length=1, max_length=MAX_TEXTS)


@app.get("/health")
def health():
    return {"status": "ok", "dim": _dim, "modelo": MODEL_NAME}


@app.post("/embed")
def embed(body: EmbedBody):
    m = load()
    t0 = time.time()
    # UM POR VEZ de propósito: encode([t]) é o que o api.py v1.x fazia.
    # Vetorizar em lote muda o resultado no 6º decimal (formas de matmul
    # diferentes) — e aí os vetores não seriam idênticos aos já gravados.
    vecs = [m.encode([t], show_progress_bar=False)[0] for t in body.texts]
    return {
        "dim": _dim,
        "vectors": [vetor_str(v) for v in vecs],
        "ms": int((time.time() - t0) * 1000),
    }


@app.on_event("startup")
def _startup():
    # Carrega ANTES de aceitar trafego: o Node espera /health responder e o
    # primeiro ingest nao paga os ~8s de carga.
    load()