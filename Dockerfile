# Minirag v2 — Node/TypeScript (aplicação) + Python (motor de embedding)
#
# 1 container de aplicação (Node como PID 1, Python como filho só em loopback)
# + 1 de banco. O modelo de embedding continua ASSADO na imagem, no MESMO
# caminho e com a MESMA biblioteca da v1.x: os vetores não mudam.

# ---------------------------------------------------------------- estágio 1
# Dependências Python + modelo (muda raramente; fica no topo de propósito)
FROM python:3.11-slim AS py

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/app/hf \
    HF_HUB_ENABLE_HF_INTERNET=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir \
         torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt

# Asa o modelo: boot instantâneo e sem download em produção
# (comando em uma linha só: o builder legado do Docker não entende heredoc)
RUN python -c "from sentence_transformers import SentenceTransformer; m = SentenceTransformer('nomic-ai/nomic-embed-text-v1.5'); m.save('/app/models'); print('model saved, dim =', m.get_embedding_dimension())" \
    && test -f /app/models/config.json

# ---------------------------------------------------------------- estágio 2
# Build do TypeScript e do painel
FROM node:22-bookworm-slim AS build

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------- frontend
# React + Vite + Tailwind (o painel deixou de ser JS solto)
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci --no-audit --no-fund
COPY frontend ./frontend
RUN cd frontend && npm run build

# ---------------------------------------------------------------- estágio 3
# Imagem final: Node + Python no MESMO container (2 containers no total)
FROM python:3.11-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    MINIRAG_MODEL_DIR=/app/models \
    MINIRAG_APP_DIR=/app \
    MINIRAG_EMBEDDER_MODO=filho

WORKDIR /app

# deps Python + modelo vindos do estágio 1 (mesmas camadas, sem reinstalar)
COPY --from=py /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=py /usr/local/bin/uvicorn /usr/local/bin/uvicorn
COPY --from=py /app/models /app/models

# binário do Node (autocontido) — sem npm em produção
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node

COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/package.json ./
COPY embedder ./embedder
COPY --from=build /build/frontend/dist ./frontend/dist

EXPOSE 8000

# Node é o processo principal: ele sobe o uvicorn do embedder em 127.0.0.1:8001,
# vigia e reinicia se cair; SIGTERM derruba os dois.
CMD ["node", "dist/index.js"]