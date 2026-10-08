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
MELHORES PEDAÇOS + nota (0 a 1)
```

Quem **responde** a pergunta (redige em linguagem natural) é o modelo de LLM
(ex.: o LLM via gateway). O minirag é a **bibliotecária**: entrega
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
MINIRAG_USERS=sistema:abc123,operador:def456
```

- `sistema` — o backend do sistema (uma chave só, atende todas as empresas)
- `operador` — acesso manual do administrador

### Nível 2 — Gaveta / memória (qual memória usar)

Dentro de cada login, o campo `memoria` no corpo do pedido abre uma **gaveta
separada**. No cenário, a gaveta é o `id da empresa`: o backend manda
`memoria: "empresa42"` e só enxerga os documentos daquela empresa.

**Regra de ouro:** o mesmo nome de gaveta em logins diferentes são memórias
que **nunca se encostam**. `empresa42` do `sistema` ≠ `empresa42` do `operador`.

Sem o campo `memoria`, o pedido cai na gaveta padrão do login (string vazia).

---

## Endpoints

### `POST /ingest` — colocar texto na memória (fila)

O ingest **não trava mais**: o pedido é validado e entra na fila; um worker de
fundo gera os embeddings pedaço a pedaço. Resposta sai em milissegundos.

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
| `doc_id` | string | sim | id do documento (re-ingestão com mesmo `doc_id` **substitui**, só quando o job termina) |
| `title` | string | não | título (aparece nos resultados) |
| `content` | string | sim | o **texto puro** (extraído do arquivo antes, se for .md/.pdf/.docx); máx. `MINIRAG_MAX_CONTENT_CHARS` (default 500.000) |
| `memoria` | string | não | gaveta (ex.: id da empresa); máx. 128 chars; vazio = gaveta padrão do login |

**Response (202 — aceito na fila):**
```json
{
  "job_id": 3,
  "status": "na_fila",
  "chunks_total": 69,
  "mensagem": "na fila; acompanhe em GET /ingest/3"
}
```

A rejeição acontece **na hora** (antes de enfileirar): `400` (nada pra cortar),
`413` (cota estourada), `422` (content > teto). Durante o processamento, a
busca continua respondendo com a **versão anterior** do `doc_id` — a
substituição é atômica no fim do job.

**Durabilidade:** se o container reiniciar no meio, o job volta pra fila no
boot (a fila vive no Postgres, não na RAM).

> **Performance:** o worker gera embeddings em CPU (~6 s por pedaço de 500
> palavras). Um texto de 2.000 linhas (~69 pedaços) fica pronto em ~7 min —
> mas o cliente NÃO espera: recebe 202 na hora e consulta `GET /ingest/{id}`
> quando quiser.

---

### `GET /ingest/{job_id}` — status do job

**Request:**
```
GET /ingest/3
Authorization: Bearer ***
```

**Response (200):**
```json
{
  "job_id": 3,
  "doc_id": "regras-reuniao",
  "title": "Regras da Reunião Semanal",
  "memoria": "empresa42",
  "status": "processando",
  "chunks_total": 69,
  "chunks_feitos": 12,
  "erro": null,
  "criado_em": "2026-10-08T15:52:25.864330+00:00",
  "finalizado_em": null
}
```

`status`: `na_fila` → `processando` → `concluido` | `erro`. Job só é visível
ao dono (outro login recebe `404`).

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
| `query` | string | — | a pergunta (texto); máx. `MINIRAG_MAX_QUERY_CHARS` (default 2.000) |
| `memoria` | string | `""` | gaveta (mesma regra do ingest) |
| `k` | int | `5` | quantos pedaços devolver (1 a 50) |
| `min_score` | float | `0.55` | nota mínima pra valer (0 a 1); itens abaixo são cortados |
| `include_archived` | bool | `false` | `true` = busca também nos arquivados (e o que achar **volta pra ativa**) |

**Response (200):**
```json
{
  "tenant": "sistema",
  "memoria": "empresa42",
  "total": 2,
  "items": [
    {
      "rank": 1,
      "score": 0.71,
      "chunk_id": 12,
      "doc_id": "regras-reuniao",
      "title": "Regras da Reunião Semanal",
      "text": "Toda segunda-feira às 9h30, na sala do fundo. Dura no máximo 45 minutos.",
      "arquivado": false
    },
    {
      "rank": 2,
      "score": 0.62,
      "chunk_id": 15,
      "doc_id": "regras-reuniao",
      "title": "Regras da Reunião Semanal",
      "text": "Se alguém apresentar um bloqueio, marca follow-up de 15 minutos.",
      "arquivado": false
    }
  ]
}
```

Se a gaveta não existe ou não tem nada parecido → `"total": 0, "items": []`.

> Toda busca que **devolve** um pedaço registra o uso dele (`last_accessed_at`
> e `access_count`) — é isso que alimenta a memória inteligente (ver Decay).

---

### `GET /docs` — listar o que está na memória

**Request:**
```
GET /docs?memoria=empresa42&include_archived=true
Authorization: Bearer ***
```

`include_archived` (default `false`): `true` inclui documentos arquivados pelo
decay na contagem (`chunks_arquivados`).

**Response (200):**
```json
{
  "tenant": "sistema",
  "memoria": "empresa42",
  "docs": [
    {
      "doc_id": "regras-reuniao",
      "title": "Regras da Reunião Semanal",
      "chunks": 3,
      "updated_at": "2026-10-07T15:52:25.864330+00:00",
      "chunks_arquivados": 0
    }
  ]
}
```

---

### `POST /decay` — rodar o "esquecimento" agora

O serviço já roda o decay sozinho a cada `MINIRAG_DECAY_INTERVALO_MINUTOS`.
Este endpoint força a execução na hora (útil pra teste/operação manual).

**Request:**
```
POST /decay
Authorization: Bearer ***

{ "dias": 0, "min_acessos": 2 }
```

Os dois campos são **opcionais** — sem corpo, usa os defaults do servidor.
`dias: 0` arquiva imediatamente tudo abaixo do mínimo de acessos.

**Response (200):**
```json
{ "arquivados_agora": 2, "ativos": 5, "arquivados": 3 }
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
| `400` | `content` com só espaços em ingest (nada pra cortar em pedaço) |
| `413` | cota de `MINIRAG_MAX_CHUNKS_TENANT` atingida (medido: `limite de 10 chunks por usuario atingido (voce tem 2; este arquivo precisaria de 42)`) — a checagem é **na entrada da fila**, nada é gravado nem perdido |
| `422` | JSON malformado, `content` vazio **ou > 500.000 chars**, `query` > 2.000 chars, `doc_id` ausente, `memoria` > 128 chars, `k` fora de 1–50 |

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
MEMORIA = "empresa42"     # id da empresa no sistema

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

# 1) Ingerir um documento (entra na fila; retorna em ms)
texto = open("politica-senhas.md").read()  # extração do arquivo é do cliente
job = chamar("/ingest", {
    "doc_id": "politica-senhas",
    "title": "Política de Senhas",
    "content": texto,
    "memoria": MEMORIA,
})

# 1b) acompanhar até concluir (worker gera embeddings em background)
import time
while True:
    st = chamar(f"/ingest/{job['job_id']}")
    if st["status"] in ("concluido", "erro"):
        break
    time.sleep(5)
assert st["status"] == "concluido", st["erro"]

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
export MINIRAG_USERS="sistema:abc123,operador:def456"
export MINIRAG_DB_PASSWORD="senha-forte"

# 2) Build e subida (primeira vez: ~15 min — assa o modelo de 768 dim na imagem)
docker-compose up -d --build

# 3) Conferir
docker ps --format '{{.Names}} {{.Status}}' | grep minirag
curl http://127.0.0.1:8000/health
```

### Produção (qualquer plataforma Docker)

O minirag roda em qualquer ambiente com Docker. Segue um exemplo prático
(usando o Dokploy, mas vale pra qualquer orquestrador / host):

1. Crie um **projeto tipo "docker"**, aponte para a pasta do repo.
2. Na aba **Environment** (ou `.env`), preencha:
   - `MINIRAG_USERS` — lista `nome:chave` (ex.: `sistema:abc123`)
   - `MINIRAG_DB_USER` / `MINIRAG_DB_PASSWORD` — usuário e senha do Postgres
   - `MINIRAG_CORS_ORIGINS` — origens que podem chamar **a partir de navegador**
     (ex.: `https://seusite.com`). Só importa pra chamada de JavaScript no
     navegador; em uso servidor-para-servidor (o padrão) pode ficar vazio
3. Faça o build, suba os dois containers e exponha a porta via seu proxy.

> **Nota:** a porta 8000 fica exposta só no host (`127.0.0.1:8000`).
> A publicação pra internet é feita pelo **seu proxy** (Dokploy, nginx, Caddy
> ou o que usar).

> **Persistência:** o Postgres guarda os dados num volume nomeado
> (`minirag_data`). O volume sobrevive a reinícios e redeploys; pra zerar
> tudo (banco + memórias), use `docker-compose down -v`.

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
| `MINIRAG_MAX_CONTENT_CHARS` | `500000` | teto de `content` por ingest (~5.000 linhas; estourou = 422) |
| `MINIRAG_MAX_QUERY_CHARS` | `2000` | teto da `query` de busca (estourou = 422) |
| `MINIRAG_MAX_CHUNKS_TENANT` | `10000` | cota de chunks por login (estourou = 413) |
| `MINIRAG_DECAY_ATIVO` | `1` | `0` desliga o esquecimento automático |
| `MINIRAG_DECAY_DIAS` | `30` | sem acesso por N dias → arquiva |
| `MINIRAG_DECAY_MIN_ACESSOS` | `2` | usado N+ vezes nunca é arquivado |
| `MINIRAG_DECAY_INTERVALO_MINUTOS` | `60` | de quanto em quanto o loop roda |
| `MINIRAG_CORS_ORIGINS` | `""` | origens de navegador que podem chamar; em uso servidor-para-servidor pode ficar vazio |

---

## Como um sistema usa o minirag

O backend do **sistema** guarda **uma** `chaveapi` por ambiente (ex.: `abc123`
para o backend em produção). Em cada operação:

- **Ingestão:** o usuário da empresa 42 envia um documento → o backend
  chama `POST /ingest` com `memoria: "empresa42"`.
- **Busca:** o usuário pergunta → o backend chama `POST /search` com
  `memoria: "empresa42"` → pega os pedaços → manda pro LLM (via
  gateway) com a pergunta + os pedaços → o LLM responde.

O minirag **não sabe** que o sistema existe. Ele só obedece à chave e à gaveta.
Quem decide qual empresa existe e qual usuário pertence a qual é o sistema.

---

## O que o minirag NÃO faz

- **Não lê arquivos** (PDF, .docx, .md) — quem extrai o texto é o cliente.
- **Não responde perguntas em linguagem natural** — entrega pedaços; o LLM
  redige a resposta.
- **Não gerencia empresas/usuários** — a lista `MINIRAG_USERS` é fixa no
  ambiente; criar/alterar logins = editar variável + reiniciar.
