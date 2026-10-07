# Minirag — Serviço RAG (Retrieval-Augmented Generation)

Serviço de busca semântica em texto: você envia documentos, ele corta em pedaços,
cria uma "digital" numérica do significado de cada um (embedding) e guarda num
banco Postgres com pgvector. Quando você pergunta, ele devolve os pedaços mais
parecidos com a pergunta, com uma nota de 0 a 1.

**Stack:** FastAPI + Postgres (pgvector) + nomic-embed-text-v1.5 (sentence-transformers)

---

## Como funciona (sem jargão)

```
TEU TEXTO
   │  POST /ingest
   ▼
PEDAÇOS (chunks) — ~500 palavras cada, 80 de sobreposição
   │
   ▼
DIGITAL (embedding) — 768 números por pedaço
   │
   ▼
BANCO (Postgres/pgvector) — guarda pedaço + digital + dono

PERGUNTA
   │  POST /search
   ▼
Pergunta também vira digital → compara com as guardadas
   │
   ▼
MELEHORES PEDAÇOS + nota (0 a 1)
```

Quem **responde** a pergunta (redige em linguagem natural) é o modelo de LLM
(ex.: Clauricio via LiteLLM gateway). O minirag é a **bibliotecária**: entrega
os pedaços certos; o LLM é o **redator**.

---

## Acesso: dois níveis de isolamento

O serviço não tem "usuário" nem "senha" no banco. O acesso é controlado de
duas formas:

### Nível 1 — Login (quem entra)

A variável de ambiente `MINIRAG_USERS` é uma lista de pares `nome:chave`
separados por vírgula. Sem uma dessas chaves no cabeçalho `Authorization`,
nenhum pedido é atendido (401).

```
MINIRAG_USERS=ia_go:abc123,mauricio:def456
```

- `ia_go` — o backend do IA_GO (uma chave só, atende todas as empresas)
- `mauricio` — acesso manual do Mauricio

### Nível 2 — Gaveta / memória (qual memória usar)

Dentro de cada login, o campo `memoria` no corpo do pedido abre uma **gaveta
separada**. No cenário IA_GO, a gaveta é o `id da empresa`: o backend manda
`memoria: "empresa42"` e só enxerga os documentos daquela empresa.

**Regra de ouro:** o mesmo nome de gaveta em logins diferentes são memórias
que **nunca se encostam**. `empresa42` do `ia_go` ≠ `empresa42` do `mauricio`.

Sem o campo `memoria`, o pedido cai na gaveta padrão do login (string vazia).

---

## Endpoints

### `POST /ingest` — colocar texto na memória

**Request:**
```
POST /ingest
Authorization: Bearer ***
Content-Type: application/json

{
  "doc_id": "regras-reuniao",
  "title": "Regras da Reunião Semanal",
  "content": "Toda segunda-feira às 9h30, na sala do fundo...",
  "memoria": "empresa42"
}
```

**Campos:**

| campo | tipo | obrigatório | descrição |
|-------|------|-------------|-----------|
| `doc_id` | string | sim | id do documento (re-ingestão com mesmo `doc_id` **substitui**) |
| `title` | string | não | título (aparece nos resultados) |
| `content` | string | sim | o **texto puro** (extraído do arquivo antes, se for .md/.pdf/.docx) |
| `memoria` | string | não | gaveta (ex.: id da empresa); vazio = gaveta padrão do login |

**Response (200):**
```json
{
  "tenant": "ia_go",
  "memoria": "empresa42",
  "doc_id": "regras-reuniao",
  "chunks": 3
}
```

---

### `POST /search` — perguntar na memória

**Request:**
```
POST /search
Authorization: Bearer ***
Content-Type: application/json

{
  "query": "que horas começa a reunião?",
  "memoria": "empresa42",
  "k": 5,
  "min_score": 0.55
}
```

**Campos:**

| campo | tipo | default | descrição |
|-------|------|---------|-----------|
| `query` | string | — | a pergunta (texto) |
| `memoria` | string | `""` | gaveta (mesma regra do ingest) |
| `k` | int | `5` | quantos pedaços devolver (máx. 50) |
| `min_score` | float | `0.55` | nota mínima pra valer (0 a 1); itens abaixo são cortados |

**Response (200):**
```json
{
  "tenant": "ia_go",
  "memoria": "empresa42",
  "total": 2,
  "items": [
    {
      "rank": 1,
      "score": 0.71,
      "chunk_id": 12,
      "doc_id": "regras-reuniao",
      "title": "Regras da Reunião Semanal",
      "text": "Toda segunda-feira às 9h30, na sala do fundo. Dura no máximo 45 minutos."
    },
    {
      "rank": 2,
      "score": 0.62,
      "chunk_id": 15,
      "doc_id": "regras-reuniao",
      "title": "Regras da Reunião Semanal",
      "text": "Se alguém apresentar um bloqueio, marca follow-up de 15 minutos."
    }
  ]
}
```

Se a gaveta não existe ou não tem nada parecido → `"total": 0, "items": []`.

---

### `GET /docs` — listar o que está na memória

**Request:**
```
GET /docs?memoria=empresa42
Authorization: Bearer ***
```

**Response (200):**
```json
{
  "tenant": "ia_go",
  "memoria": "empresa42",
  "docs": [
    {
      "doc_id": "regras-reuniao",
      "title": "Regras da Reunião Semanal",
      "chunks": 3,
      "updated_at": "2026-10-07T15:52:25.864330+00:00"
    }
  ]
}
```

---

### `GET /health` — verificação de saúde (público, sem chave)

**Response (200):**
```json
{ "status": "ok", "dim": 768, "usuarios": 2 }
```

---

## Erros

| código | situação |
|--------|----------|
| `401` | chave não está na lista `MINIRAG_USERS` (ou falta o header `Authorization`) |
| `400` | `content` vazio em ingest |
| `422` | JSON malformado ou campo obrigatório ausente |

Exemplo de 401:
```json
{ "detail": "chave nao habilitada" }
```

---

## Exemplo em Python (cliente)

```python
import json, urllib.request

BASE = "http://127.0.0.1:8000"
CHAVE = "abc123"          # sua chaveapi
MEMORIA = "empresa42"     # id da empresa no IA_GO

def chamar(path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        headers={
            "Authorization": f"Bearer {CHAVE}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode())

# 1) Ingerir um documento
texto = open("politica-senhas.md").read()  # extração do arquivo é do cliente
chamar("/ingest", {
    "doc_id": "politica-senhas",
    "title": "Política de Senhas",
    "content": texto,
    "memoria": MEMORIA,
})

# 2) Perguntar
res = chamar("/search", {
    "query": "quantos caracteres precisa ter uma senha?",
    "memoria": MEMORIA,
})
for item in res["items"]:
    print(f"[{item['score']:.3f}] {item['text']}")

# 3) Listar documentos na gaveta
docs = chamar(f"/docs?memoria={MEMORIA}")
for d in docs["docs"]:
    print(d["doc_id"], d["chunks"], "pedaços")
```

---

## Subindo o serviço

### Local (teste)

```bash
# 1) Defina as variáveis
export MINIRAG_USERS="ia_go:abc123,mauricio:def456"
export MINIRAG_DB_PASSWORD="senha-forte"

# 2) Build e subida (primeira vez: ~15 min — assa o modelo de 768 dim na imagem)
docker-compose up -d --build

# 3) Conferir
docker ps --format '{{.Names}} {{.Status}}' | grep minirag
curl http://127.0.0.1:8000/health
```

### Produção (Dokploy)

1. No Dokploy: crie um **projeto tipo "docker"**, aponte para a pasta do repo.
2. Na aba **Environment**, preencha:
   - `MINIRAG_USERS` — lista `nome:chave` (ex.: `ia_go:abc123`)
   - `MINIRAG_DB_USER` / `MINIRAG_DB_PASSWORD` — usuário e senha do Postgres
   - `MINIRAG_CORS_ORIGINS` — origens que podem chamar (ex.: `https://seusite.com`)
3. O Dokploy faz o build, sobe os dois containers e expõe a porta via proxy.

> **Nota:** a porta 8000 fica exposta só no host (`127.0.0.1:8000`).
> A publicação pra internet é feita pelo proxy do Dokploy.

---

## Variáveis de ambiente

| variável | default | o que controla |
|----------|---------|----------------|
| `MINIRAG_USERS` | `""` | lista `nome:chave` de logins (obrigatório) |
| `MINIRAG_MODEL` | `nomic-ai/nomic-embed-text-v1.5` | modelo de embedding |
| `MINIRAG_MODEL_DIR` | `/app/models` | onde o modelo está assado na imagem |
| `MINIRAG_DB_HOST` | `minirag-db` | host do Postgres |
| `MINIRAG_DB_PORT` | `5432` | porta do Postgres |
| `MINIRAG_DB_USER` | `minirag` | usuário do Postgres |
| `MINIRAG_DB_PASSWORD` | `minirag` | senha do Postgres |
| `MINIRAG_DB_NAME` | `minirag` | nome do banco |
| `MINIRAG_MAX_CHUNK_WORDS` | `500` | palavras por pedaço |
| `MINIRAG_CHUNK_OVERLAP` | `80` | palavras de sobreposição entre pedaços |
| `MINIRAG_TOP_K` | `5` | quantos resultados por busca |
| `MINIRAG_MIN_SCORE` | `0.55` | nota mínima pra devolver |
| `MINIRAG_CORS_ORIGINS` | `""` | origens que podem chamar (CORS) |

---

## Como o IA_GO usa o minirag

O backend do IA_GO guarda **uma** `chaveapi` por ambiente (ex.: `abc123`
para o backend em produção). Em cada operação:

- **Ingestão:** o usuário da empresa 42 envia um documento → o backend
  chama `POST /ingest` com `memoria: "empresa42"`.
- **Busca:** o usuário pergunta → o backend chama `POST /search` com
  `memoria: "empresa42"` → pega os pedaços → manda pro LLM (Clauricio via
  gateway) com a pergunta + os pedaços → o LLM responde.

O minirag **não sabe** que o IA_GO existe. Ele só obedece à chave e à gaveta.
Quem decide qual empresa existe e qual usuário pertence a qual é o IA_GO.

---

## O que o minirag NÃO faz

- **Não lê arquivos** (PDF, .docx, .md) — quem extrai o texto é o cliente.
- **Não responde perguntas em linguagem natural** — entrega pedaços; o LLM
  redige a resposta.
- **Não gerencia empresas/usuários** — a lista `MINIRAG_USERS` é fixa no
  ambiente; criar/alterar logins = editar variável + reiniciar.
