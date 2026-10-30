# Minirag v2 — Node/TypeScript (aplicação) + Python (motor de embedding)
#
# 1 container de aplicação (Node como PID 1, Python como filho só em loopback)
# + 1 de banco. O modelo de embedding continua ASSADO na imagem, no MESMO
# caminho e com a MESMA biblioteca da v1.x: os vetores não mudam.

# ---------------------------------------------------------------- estágio 1
# Dependências Python + modelo (muda raramente; fica no topo de propósito)
FROM python:3.12-slim AS py

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/app/hf \
    HF_HUB_ENABLE_HF_INTERNET=1

WORKDIR /app

# poppler: rasteriza PDF escaneado (pdftoppm/pdfinfo) para o OCR
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir \
         torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt

# Asa o modelo: boot instantâneo e sem download em produção
# (comando em uma linha só: o builder legado do Docker não entende heredoc)
RUN python -c "from sentence_transformers import SentenceTransformer; m = SentenceTransformer('nomic-ai/nomic-embed-text-v1.5'); m.save('/app/models'); print('model saved, dim =', m.get_embedding_dimension())" \
    && test -f /app/models/config.json

# Asa TAMBÉM os modelos do OCR (PP-OCRv6): a primeira leitura em produção não
# pode depender de internet. Construir o motor já baixa os modelos.
COPY embedder ./embedder
RUN cd /app/embedder \
    && python -c "import ocr; ocr._motor(); print('motor OCR ok')" \
    && ls /usr/local/lib/python3.12/site-packages/rapidocr/models/*.onnx

# ---------------------------------------------------------------- estágio 2
# Build do TypeScript e do painel
FROM node:22-bookworm-slim AS build

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --omit=optional

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------- frontend
# React + Vite + Tailwind (o painel deixou de ser JS solto)
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci --no-audit --no-fund
COPY frontend ./frontend
RUN cd frontend && npm run build

# ---------------------------------------------------------------- cliente (v3.6)
# Binários Node SEA do cliente de máquina, ASSADOS na imagem (auto-update e
# download partem do próprio container). O estágio usa o node daqui para gerar
# o blob e baixa o node.exe oficial da MESMA versão para o alvo Windows.
FROM node:22-bookworm-slim AS cliente
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json ./
COPY src/config.ts ./src/
COPY agente/ ./agente/
COPY scripts/ ./scripts/
RUN bash scripts/build-cliente.sh \
    && test -f agente/bin/nexos-cliente-win.exe && test -f agente/bin/nexos-cliente-linux

# ---------------------------------------------------------------- estágio 3
# Imagem final: Node + Python no MESMO container (2 containers no total)
FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    NEXOS_MODEL_DIR=/app/models \
    NEXOS_APP_DIR=/app \
    NEXOS_EMBEDDER_MODO=filho

WORKDIR /app

# poppler roda o PDF escaneado (o Python do embedder chama pdftoppm).
# curl é o cliente HTTP da busca web: o Brave recusa o handshake TLS do Node (429),
# mas aceita o do curl — ver src/web.ts.
# chromium (+381 MB) é o navegador do web_open para site que só existe com JavaScript;
# fonts-liberation evita texto invisível. NEXOS_NAVEGADOR=0 desliga sem rebuild.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        poppler-utils curl ca-certificates chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# deps Python + modelo vindos do estágio 1 (mesmas camadas, sem reinstalar)
COPY --from=py /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=py /usr/local/bin/uvicorn /usr/local/bin/uvicorn
COPY --from=py /app/models /app/models

# binário do Node (autocontido) — sem npm em produção
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node

COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/package.json ./
COPY embedder ./embedder
COPY --from=build /build/frontend/dist ./frontend/dist
COPY --from=cliente /build/agente/bin ./agente/bin

EXPOSE 8000

# Node é o processo principal: ele sobe o uvicorn do embedder em 127.0.0.1:8001,
# vigia e reinicia se cair; SIGTERM derruba os dois.
CMD ["node", "dist/index.js"]