# RAG service — FastAPI + Postgres(pgvector) + nomic-embed-text-v1.5
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/app/hf \
    HF_HUB_ENABLE_HF_INTERNET=1

WORKDIR /app

# torch CPU-only primeiro (VPS sem GPU, imagem menor e mais rápida);
# depois as dependências: sentence-transformers detecta o torch ja presente e nao baixa de novo
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir \
         torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt

# Asa o modelo de embedding na imagem (custo de build; o boot fica instantaneo)
# Fica ANTES do COPY do codigo: mudar api.py nao invalida esta camada
# (senao cada commit rebaixaria ~500 MB de modelo).
RUN python - <<'PY'
from sentence_transformers import SentenceTransformer
m = SentenceTransformer("nomic-ai/nomic-embed-text-v1.5")
m.save("/app/models")
print("model saved, dim =", m.get_embedding_dimension())
PY

COPY api.py .

EXPOSE 8000

CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8000"]
