# RAG service — FastAPI + Postgres(pgvector) + nomic-embed-text
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

COPY api.py .

# Asa o modelo de embedding na imagem (custo de build; o boot fica instantaneo)
RUN python - <<'PY'
from sentence_transformers import SentenceTransformer
m = SentenceTransformer("nomic-ai/nomic-embed-text", show_progress_bar=False)
m.save_model("/app/models")
print("model saved, dim =", m.get_sentence_embedding_dimension())
PY

EXPOSE 8000

CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8000"]
