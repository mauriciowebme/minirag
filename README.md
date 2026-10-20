# Minirag — Serviço RAG (Retrieval-Augmented Generation)

Serviço de busca semântica em texto: você envia documentos, ele corta em pedaços,
cria uma "digital" numérica do significado de cada um (embedding) e guarda num
banco Postgres com pgvector. Quando você pergunta, ele devolve os pedaços mais
parecidos com a pergunta, com uma nota de 0 a 1.

**Stack:** Node 22 + TypeScript (Fastify) + Postgres (pgvector) + embedder Python
(nomic-embed-text-v1.5 via sentence-transformers), rodando no MESMO container.

---

## v2.7 — menu lateral, Painel, Chat, Configurações e usuários no banco (20/10/2026)

O painel deixou de ser "abas no topo" e virou um sistema com **menu lateral**:
`Painel · Usuários · Chat · Buscar · Fila · Configurações`. `Arquivos` e `Editor`
não são itens de menu — são passos do caminho `usuários → gavetas → arquivos → nota`
(antes dava para cair em "Arquivos" sem gaveta escolhida).

- **Painel (`GET /dashboard`)**: usuários, gavetas, documentos, trechos, fila,
  buscas/chats do dia, documentos por usuário, saúde (embedder, OCR, provider) e
  últimos envios — tudo em **uma** chamada. O contador do dia fica em `metricas_dia`.
- **Chat (`POST /chat`)**: busca os trechos da gaveta e manda ao modelo com a regra
  "responda só com o que está nos trechos"; devolve `resposta` + `fontes`
  (`doc_id`, `trecho`, `score`). Histórico em `chat_mensagens` (`GET`/`DELETE /chat`).
  **Sem provider configurado o Chat responde `409`** e a Busca continua normal.
- **Provider configurável na tela (`/config/provider`)**: `litellm` (OpenAI
  compatível), `openai` ou `ollama`. Campos: `base_url`, `modelo`, `temperatura`,
  `trechos`, `ativo`. A **chave nunca volta em claro** — a API devolve
  `chave_mascarada` (`••••4f2a`) e `tem_chave`. `POST /config/provider/testar`
  mede a latência e falha com mensagem legível. Cada usuário tem a sua configuração;
  o operador pode gravar o padrão de todos (`global: true`, escopo `*`).
- **Usuários no banco (`/usuarios`)**: tabela `usuarios` (nome, `chave_hash`
  sha256, `chave_hint`, `papel`, `ativo`). `MINIRAG_USERS`/`MINIRAG_OPERADOR`
  passam a ser **semente** do boot (entram uma vez, sem sobrescrever). Criar pela
  tela devolve a chave **uma única vez**; desativar vale na hora; o último operador
  ativo não pode ser rebaixado/desativado; usuário com documentos não pode ser
  removido (apague as gavetas antes). Quem não é operador recebe `403`.
- **Configurações (`GET /config`)**: limites em vigor e política de esquecimento,
  sem expor segredo.
- **MCP**: 19 tools — as 15 anteriores + `chat`, `listar_usuarios`,
  `criar_usuario`, `config_provider`.
- Versão do produto: **2.7.0**.

## v2.5 — imagem e PDF escaneado entram por OCR (20/10/2026)

Antes, foto/print (`png`, `jpg`) era recusada e PDF digitalizado respondia `422`.
Agora os dois entram: o texto é **lido da imagem** e indexado como qualquer documento.

- **Motor**: [rapidocr](https://github.com/RapidAI/RapidOCR) 3.10 com modelos **PP-OCRv6**
  (detecção + leitura) em onnxruntime — CPU, offline, sem GPU e sem tesseract.
  Roda no **processo Python do embedder** (`POST /ocr` interno), não no Node.
- **Tipos novos**: `png`, `jpg`, `jpeg`, `webp`, `tif`, `tiff` → `tipo_detectado: "imagem"`.
- **PDF escaneado**: quando a camada de texto tem menos de 20 caracteres, o PDF é
  rasterizado com `pdftoppm` (poppler) a 150 dpi e cada página passa pelo OCR.
- **Limite**: 6 páginas de PDF escaneado por arquivo (`MINIRAG_OCR_PAGINAS_MAX`) —
  medido ~4 s por foto/print e ~12 s por página A4 nesta VPS. Acima disso o envio é
  recusado com orientação para dividir o arquivo.
- **Aviso honesto**: OCR erra **número** e embaralha tabela/coluna. O original fica
  guardado e o `/docs` marca `arquivo.ocr: true` (chip `OCR` no painel) para conferência.
- Imagem **sem texto** (paisagem, foto de produto) → `422` com mensagem clara;
  para esse caso o caminho é descrever no nome/nota.

Resposta do `POST /arquivos` ganhou `lido_por_ocr` e `paginas_ocr`; `/health` ganhou
`ocr: "ok" | "fora"`; o MCP (`upload_file`) aceita imagem sem mudança de assinatura.

## v2.0 — aplicação em TypeScript, embedding em Python (20/10/2026)

O serviço foi reescrito em **Node/TypeScript**. O contrato HTTP é o mesmo da
v1.11 — mesmas rotas, mesmos corpos, mesmos códigos de erro —, então nenhum
cliente precisou mudar.

```
app (1 container)
├─ node  → rotas REST, fila/worker, MCP, painel     (PID 1)
└─ python → embedder em 127.0.0.1:8001 (filho; só loopback)
db → Postgres/pgvector (schema idêntico)
```

**Por que o embedding continua em Python:** o nomic roda em torch/CPU e o
sentence-transformers é o caminho estável. Mantendo o mesmo código e o mesmo
modelo assado na imagem, os **vetores são idênticos** aos da v1.x — nada foi
reindexado e o recall não mudou. O Node nunca fala com o modelo: envia textos
para `POST /embed` e recebe as strings de vetor já formatadas.

O Node sobe o Python como processo filho, vigia e reinicia se ele cair; se o
embedder estiver fora, `/health` reporta `embedder: "fora"` e a fila pausa
(em vez de fingir saúde).

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

**v2.7:** os usuários vivem na tabela `usuarios` do banco (criados pela tela ou
pela tool MCP `criar_usuario`); a chave é gravada como **sha256** + os 4 últimos
caracteres para exibição. Sem uma chave válida de usuário **ativo** no cabeçalho
`Authorization`, nenhum pedido é atendido (401).

As variáveis `MINIRAG_USERS` / `MINIRAG_OPERADOR` continuam existindo como
**semente**: no boot cada `nome:chave` é inserido **se ainda não existir** — não
sobrescreve quem já está no banco (nem reativa quem foi desativado pela tela).

```
MINIRAG_USERS=sistema:abc123
MINIRAG_OPERADOR=admin:def456
```

- `sistema` — o backend do sistema (uma chave só, atende todas as empresas)
- `admin` — operador: vê tudo, cria/desativa usuários e define o provider global

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
| `tenant` | string | não | **v1.8**: só a chave operador consegue mirar outro tenant; login comum tem o campo ignorado (sempre cai no próprio) |

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
decay na contagem (`chunks_arquivados`). Paginação e filtro (v1.10):

| query | efeito |
|---|---|
| `q=texto` | filtra por título OU `doc_id` (ILIKE, sem acento não resolve acento) |
| `limit=50&offset=0` | página; `limit=0` (default) = tudo, teto de 2000 |
| resposta | ganhou `total` = quantos docs batem no filtro (independe da página) |

**Response (200):**
```json
{
  "tenant": "sistema",
  "memoria": "empresa42",
  "total": 1,
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

### `DELETE /docs/{doc_id}` — apagar um documento

**Request:**
```
DELETE /docs/regras-reuniao?memoria=empresa42
Authorization: Bearer ***
```

Apaga DEFINITIVAMENTE os chunks do doc naquela (login, memória) — inclusive
arquivados — e cancela jobs `na_fila` do mesmo doc. Não toca em docs de
outros logins nem de outras gavetas.

**Respostas:** `200` com `{"chunks_apagados": 3, "jobs_cancelados": 0}` ·
`404` doc não existe na gaveta · `409` doc está `processando` agora
(esperar a ingestão terminar, senão o worker recriaria os chunks).

---

### v2.7 — painel, usuários, provider e chat

| rota | quem | o que faz |
|---|---|---|
| `GET /dashboard` | qualquer login | números do acervo em uma chamada (usuários, gavetas, documentos, trechos, fila, buscas/chats do dia, por usuário, saúde, últimos envios) |
| `GET /config` | qualquer login | limites e política de esquecimento (sem segredo) |
| `GET /usuarios` | operador | lista com papel, ativo, `chave_hint`, gavetas e documentos |
| `POST /usuarios` | operador | `{nome, papel}` → `201 {nome, papel, chave}` — **a chave aparece só nesta resposta** |
| `PATCH /usuarios/{nome}` | operador | `{ativo?, papel?}` — não deixa desativar/rebaixar o último operador |
| `POST /usuarios/{nome}/chave` | operador (qualquer) ou o próprio | gera chave nova e devolve uma vez |
| `DELETE /usuarios/{nome}` | operador | só sem documentos (`409` se tiver) |
| `GET/PUT /config/provider` | qualquer login | provider do chat; `global: true` (só operador) grava o padrão de todos. A chave volta **mascarada** |
| `POST /config/provider/testar` | qualquer login | manda um "teste de conexao" ao modelo e devolve `{ok, ms, modelo}` |
| `POST /chat` | qualquer login | `{pergunta, memoria}` → `{resposta, fontes[], modelo, ms}`; sem provider → `409` |
| `GET/DELETE /chat?memoria=` | qualquer login | histórico da conversa / apagar a conversa |

**Exemplo de chat:**
```json
POST /chat
{ "pergunta": "qual o total da nota do fornecedor AC ME?", "memoria": "empresa42" }

200 {
  "resposta": "O total é R$ 1.234,56, com vencimento em 10/11/2026 [nota-fiscal].",
  "fontes": [{ "doc_id": "nota-fiscal", "title": "nota-fiscal", "score": 0.78, "trecho": "NOTA FISCAL 4471 ..." }],
  "modelo": "claude-sonnet-4.5", "provider": "empresa42", "buscou": 1, "ms": 640
}
```

### `POST /decay` — rodar o "esquecimento" agora

> No painel, a ação aparece como **"arquivar esquecidos"** (nome de tela).
> O endereço `/decay`, o campo `decay` dos JSONs e as variáveis `MINIRAG_DECAY_*`
> continuam como estão — só o texto que o usuário vê mudou.

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

## v1.8/v1.9 — documentos, decay POR DOCUMENTO, operador e painel (19/10/2026)

### Fonte da verdade: tabela `documents`
O minirag passou a guardar o **arquivo original inteiro**, não só os pedaços
embedados. `documents (tenant, memoria, doc_id, title, content, size_bytes,
origem, criado_em, atualizado_em)` — PK = (tenant, memoria, doc_id). Os
`chunks` agora são **índice derivado**: editar a fonte reindexa tudo.

- **`GET /documents/{doc_id}?memoria=&tenant=`** — devolve o conteúdo original
  (`origem`: `direto` = texto que entrou; `reconstruido` = migrado dos chunks
  no boot, concatenação aproximada).
- **`GET /documents/{doc_id}/raw`** — download com `Content-Disposition`.
- **`PUT /documents/{doc_id}`** — edição: corpo `{content, title?, memoria?,
  tenant?}` → 202 + job_id; entra na MESMA fila do ingest; busca responde a
  versão antiga até o job concluir; 404 se o doc não existe (criar é /ingest).
- **`DELETE /docs/{doc_id}`** — agora apaga chunks **+ jobs + documento fonte**
  (resposta ganha `fonte_apagada`).
- Docs pré-v1.8 são reconstruídos automaticamente no boot.

### Decay por DOCUMENTO (correção semântica)
Antes: cada chunk esfriava sozinho → metade de um arquivo podia ser arquivada
com a outra metade ativa. Agora o uso é **agregado por documento** (soma de
`access_count`, último acesso mais recente): ou o documento inteiro esfria,
ou fica inteiro. A busca com `include_archived` revive o **documento inteiro**.
`POST /decay` mudou de escopo: login comum só arquiva o PRÓPRIO tenant
(segurança); chave operador roda global. O loop de fundo segue global.

### Chave operador (nível novo, opcional)
`MINIRAG_OPERADOR="nome:chave"` (formato idêntico ao `MINIRAG_USERS`).
A mesma rota, alcance decidido pela credencial:

| endpoint | login comum | operador |
|---|---|---|
| `GET /gavetas` | só as gavetas dele | **todas**, de todos os tenants (`?tenant=` filtra) |
| `GET /jobs?status=&limit=` | só os jobs dele | todos os jobs + resumo por status |
| `?tenant=` em docs/search/ingest/documents/delete | **ignorado** (nunca escapa do próprio) | mira o tenant escolhido |

Nada do isolamento atual enfraquece: a visibilidade extra vive só na chave
nova. `/health` passa a reportar `operador: true|false` e `versao`.

### Painel — `GET /painel`
Front-end servido pela própria API (pasta `frontend/`: **React 18 + Vite +
Tailwind**, compilado para `frontend/dist` e servido em `/painel/`; sem segundo
container, sem CORS extra). Tela de login: nome da
chave + segredo (sessão só em `sessionStorage` — fecha a aba, sumiu). Quem
loga com chave comum vê só as próprias gavetas; com a operador vê o mapa
inteiro. Telas: **Gavetas** (usuário → gavetas + botão "arquivar esquecidos"; no painel: usuário = tenant/chave de login, gaveta = memoria) → **Arquivos** (lista,
upload .txt/.md, download, apagar) → **Editor** (abre a fonte, salva →
reindexa com progresso ao vivo) → **Buscar** (teste de score, incluir
arquivados) → **Fila** (jobs por status).

### Testes
`test_v18.py` (29 checagens): fonte exata, raw, PUT reindexa, escopos
tenant×operador, **injeção de tenant ignorada para chave comum**, decay por
doc com discriminador anti-meia-noite, revive inteiro, jobs agregados, delete
com fonte. `test_mcp.py` segue 17/17 (tools MCP corrigidas para chamar a REST
**por nome** — assinaturas mudaram).

---

## v2.4 — processador de documentos: original guardado, conversão e substituição (20/10/2026)

O painel deixou de aceitar só `.txt`/`.md`. Agora ele recebe o **arquivo original**,
guarda o binário e indexa o texto extraído dele.

| rota | o que faz |
|---|---|
| `POST /arquivos` (multipart, campo `arquivo`) | recebe o arquivo (+ campos `memoria`, `tenant` só p/ operador, `doc_id?`, `title?`), **guarda o original**, converte em texto e enfileira. `201` documento novo · `200` quando **substituiu** (`substituiu:true`) · `422` tipo não aceito/arquivo sem texto · `413` acima de 15 MB |
| `GET /documents/{doc_id}/arquivo?memoria=` | devolve o **binário original** com `content-type` e nome certos (`404` se o doc foi criado como texto no painel) |

**Tipos aceitos**: pdf, docx, xlsx, csv, html, txt, md e imagem (png, jpg, webp, tiff) — 15 MB por arquivo.

- **pdf** → `pdfjs-dist` (legacy) por página. O `pdf-parse@1.1.1` foi removido: o pdf.js
  embutido nele (2016) recusa PDFs atuais com `bad XRef entry` (medido com fpdf2, Word e
  LibreOffice). PDF **sem texto** (digitalizado) → OCR por página (v2.5).
- **imagem** (png/jpg/webp/tiff) → OCR direto; imagem menor que 900 px de largura é
  ampliada 2× antes de ler (medido: recupera linha que se perdia).
- **docx** → `mammoth` para HTML e daí texto (o markdown do mammoth escapa pontuação:
  `\.`, `\-` e suja o índice).
- **xlsx** → `exceljs`; cada aba vira `## Planilha: nome`, com `colunas: a | b` e uma
  linha por registro no formato `coluna: valor | coluna: valor` (até 20 mil linhas por aba).
- **csv** → separador detectado (`,` `;` tab), respeita aspas e quebra dentro de aspas.
- **html** → remove script/style, transforma títulos em `#` e itens em `- `.
- `.xls`, `.doc`, `.ppt` (Office antigo) → `422` dizendo para salvar como `.xlsx`/`.docx`.

**"Mesmo nome substitui"**: o `doc_id` sai do nome do arquivo normalizado
(minúsculo, sem acento, sem extensão) ou do campo `doc_id` quando enviado. Subir
`contrato.pdf` de novo na mesma gaveta substitui **chunks + fonte + original** e volta
para a fila (reindexação automática). Outra gaveta = documento novo.

**Fluxo de edição**: `.md`/`.txt`/`.csv` → edita na tela (`PUT /documents/{id}`) e
reindexa — o **original guardado acompanha a edição** (senão o download devolveria a
versão velha); pdf/docx/xlsx → baixa o original, edita na máquina e sobe de novo (ou
usa "⬆ versão" no painel, que mantém o mesmo `doc_id`).

No `/docs`, cada item traz `arquivo.nome`, `arquivo.tipo` (texto, pdf, docx, planilha,
imagem), `arquivo.ext` (md, pdf, xlsx, png… — é o que o painel mostra no chip),
`arquivo.editavel`, `arquivo.ocr` (texto veio de OCR) e `arquivo.tamanho`; o painel
decide entre "abrir no editor" e "baixar original" por `editavel`, nunca pelo tipo bruto.

**Onde mora o binário**: tabela `arquivos (tenant, memoria, doc_id, nome, mime, tipo,
tamanho, conteudo BYTEA)`, separada de `documents` de propósito — o worker recria a
linha de `documents` a cada reindexação e não pode encostar no original. `DELETE /docs`
e `DELETE /gavetas` apagam o binário junto; `PATCH` que move/renomeia leva o binário.

## v2.3 — navegação em 3 telas: usuários › gavetas › arquivos (20/10/2026)

## v1.10 — conforto de uso: organizar arquivos sem sair do painel (20/10/2026)

Rotas novas (todas com o mesmo login; `?tenant=` só vale para a chave operador):

| rota | o que faz |
|---|---|
| `PATCH /documents/{doc_id}?memoria=` | corpo `{novo_doc_id?, destino_memoria?, title?}` — renomeia, **move de gaveta** e/ou troca título. É UPDATE de metadados (chunks + fonte na mesma transação): **instantâneo, sem reembedding**. Move jobs `na_fila` junto. `409` se já existe doc com esse id no destino; `409` se o doc está `processando` |
| `PATCH /documents/{doc_id}/arquivado?memoria=` | corpo `{arquivado: true|false}` — arquiva/revive o documento inteiro **manualmente** (sem depender do decay nem de buscar). Resposta: `chunks_afetados` |
| `GET /gavetas/{memoria}/export.zip` | backup da gaveta: `.zip` com um `.txt` por documento (conteúdo original) + `manifest.json` (tenant, memória, data, lista). `404` se a gaveta não tem fonte guardada |
| `DELETE /gavetas/{memoria}` | apaga a gaveta INTEIRA (chunks + fontes + jobs `na_fila` cancelados). `409` se há job `processando`; `404` se já estava vazia |
| `POST /jobs/{id}/cancel` | cancela job `na_fila`; `409` em qualquer outro status |
| `POST /jobs/{id}/retry` | reenfileira job `erro` ou `cancelado` (zera progresso e erro) |
| `GET /docs?q=&limit=&offset=` | filtro por título/doc_id + paginação (ver acima) |

**Freio de força bruta no login** (v1.10): `MINIRAG_LOGIN_MAX_FALHAS` (default
10) falhas de chave por IP dentro de `MINIRAG_LOGIN_JANELA_SEG` (default 300 s)
→ todas as tentativas daquele IP recebem `429` até a janela passar, inclusive
com chave certa. Um login bem-sucedido zera o contador do IP. O IP vem de
`X-Forwarded-For` (primeiro valor) ou do socket.

**Painel v1.10** (mesma rota `/painel`, sem build):
- Arquivos: **nova nota em branco** (form inline), **upload múltiplo** e
  **arrastar-e-soltar**, **filtrar** por título/doc_id, **mostrar arquivados**,
  contador `total`, **exportar zip**, **apagar gaveta** (confirmação dupla),
  por linha: abrir, baixar, copiar `doc_id`, arquivar/reviver, apagar.
- Editor: contador de palavras, **prévia markdown**, **renomear / mover** de
  gaveta, e aviso de **edição não salva** ao fechar a aba ou sair (`beforeunload`).
- Buscar: `k` ajustável, **score mínimo** (slider), incluir arquivados, e dica
  explícita quando 0 resultados (em vez de parecer defeito).
- Fila: **cancelar** e **retentar** por linha.
- Sessão com **prazo de 12 h** no `sessionStorage`; assets versionados
  (`?v=`) para deploy novo não cair em cache velho.

**Testes:** `test_v110.py` (26 checagens) — renomear/mover/título, arquivar e
reviver manual, colisão 409, filtro+paginação, zip válido (manifest e
conteúdo), cancelar/retentar job, apagar gaveta (e 404 na segunda), e o freio
de força bruta (11ª tentativa = 429, inclusive com a chave boa). Roda por
último: ele bloqueia o IP de teste por 5 min.

---

## v1.11 — design do painel: hierarquia, estado e celular (20/10/2026)

Trabalho de UI/UX, sem mudança de rota ou regra:

- **Escala e cor com papel definido**: verde = ação primária e "ativo"; azul =
  link/ação de abrir; âmbar = arquivar/arquivado; vermelho = destrutivo. Antes
  todo botão tinha o mesmo peso.
- **Ações agrupadas**: primária (`nova nota`) → secundárias com contorno
  (`upload`, `exportar`) → separador → destrutiva (`apagar gaveta`).
- **Estado por linha**: coluna `estado` com etiqueta `ativo`/`arquivado`; linha
  arquivada fica esmaecida (antes só existia um número de chunks arquivados).
- **Celular**: a tabela vira cartões e cada campo ganha rótulo
  (`doc_id · …`, `chunks · …`), com alvo de toque de 38 px.
- **Feedback**: "carregando…" nas listas, estado vazio com instrução, toast com
  `aria-live`, foco visível em tudo (`:focus-visible`).
- **Teclado**: `Ctrl+S` salva, `Esc` fecha o editor; `ver/ocultar` no segredo.
- **Datas relativas** (`hoje 21:58`, `ontem`, `há 3 dias`) em vez de `19/10`.
- Rodapé com versão do serviço e atalhos; assets sempre versionados (`?v=`)
  para deploy novo não bater em cache velho.

---

## MCP — acesso por agentes (POST /mcp)

Além da REST, o minirag fala **MCP (Model Context Protocol)** em
`POST /mcp`: JSON-RPC 2.0 sobre HTTP, stateless (sem sessão, sem SSE),
mesma porta, mesma chave Bearer, mesmas gavetas (`memoria`). É a porta
que agentes de IA (ex.: o Hermes) usam; a REST continua intacta pro
IA_GO.

**Fluxo do cliente MCP:**
1. `initialize` → servidor devolve `protocolVersion`, `capabilities.tools`, `serverInfo`.
2. `notifications/initialized` → aceito (202, sem corpo).
3. `tools/list` → **15 ferramentas**, espelho das rotas REST (argumentos com os mesmos nomes dos corpos):
   - **documentos**: `search`, `ingest` (texto), `ingest_status`, `list_docs`, `delete_doc`
   - **arquivo original**: `upload_file` (`nome` + `conteudo_base64`, até 15 MB), `get_file` (devolve o binário em base64)
   - **edição**: `edit_doc` (texto novo + reindexação), `rename_doc` (doc_id/título/mover), `archive_doc`
   - **organização**: `list_gavetas`, `create_gaveta`, `delete_gaveta`
   - **operação**: `list_jobs`, `health`
4. `tools/call` → `{"name": "search", "arguments": {"query": "...", "memoria": "empresa42"}}` → resposta no formato MCP (`content: [{type: "text", text: "<JSON>"}]`).

**Exemplo (curl):**
```bash
curl -X POST https://minirag.techupsistemas.com/mcp \
  -H "Authorization: Bearer $CHAVE" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"query":"que horas é a reunião","memoria":"empresa42"}}}'
```

Erros de tool viram `result` com `isError: true` (linguagem do MCP); erro
de auth/protocolo segue o padrão JSON-RPC (`-32001`, `-32601`, `-32700`).
O código da camada está em `src/mcp.ts` (~380 linhas; chama as funções de
negócio direto, sem HTTP interno, sem duplicar regra). Agente que fala MCP
fecha o ciclo inteiro: sobe o PDF (`upload_file`), espera a fila
(`ingest_status`), baixa o original para editar (`get_file`), sobe de novo com o
mesmo nome (substitui) ou edita texto (`edit_doc`).

`get_file` devolve base64 dentro do JSON-RPC — arquivo grande infla a resposta
(15 MB ≈ 20 MB de texto); para uso em massa, prefira a REST
(`GET /documents/{id}/arquivo`), que devolve o binário puro.

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
curl http://127.0.0.1:8000/health   # {"versao":"2.0.0", "embedder":"ok", ...}
```

### Desenvolvimento (fora do Docker)

Node e Python separados, para iterar rápido:

```bash
npm install
npm run build           # tsc (servidor, src/ → dist/)
(cd frontend && npm install && npm run build)   # React → frontend/dist

# terminal 1 — embedder (precisa de python com sentence-transformers + modelo)
MINIRAG_EMBEDDER_MODO=externo \
  python3 -m uvicorn embedder.embed_server:app --port 8001

# terminal 2 — aplicação
MINIRAG_EMBEDDER_MODO=externo MINIRAG_DB_HOST=127.0.0.1 \
MINIRAG_USERS="teste:chave" node dist/index.js
```

### Testes

```bash
# com a stack de teste no ar (porta 8002 no exemplo)
BASE=http://127.0.0.1:8002 TESTKEY=... OPKEY=... npm test
```

A suíte (`tests/e2e.test.ts`, ~72 checagens) roda por HTTP: é juiz de
**contrato**, não de implementação. O último bloco testa o freio de força
bruta e bloqueia o IP por 5 minutos — por isso ele é o último.

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
3. Suba os dois containers pelo painel (Dokploy) ou `docker compose up -d` e exponha a porta via seu proxy.

> **Nota:** a porta 8000 fica exposta só no host (`127.0.0.1:8000`) e na
> tailnet (`100.64.0.5:8000`); a publicação pra internet é pelo Traefik com o
> domínio — **nunca `0.0.0.0`** (a API só tem chave, sem login).
> Cuidado medido no boot de 18/10: o dockerd tentou abrir `100.64.0.5:8000` 6s
> antes de a interface `tailscale0` existir e falhou com *cannot assign requested
> address* — publicar porta num IP de VPN depende da VPN já estar de pé.
>
> **Produção atual:** Dokploy do Contabo, serviço `minirag` (fonte github,
> branch `main`, **autoDeploy ligado** — todo push em `main` reimplanta),
> domínio `https://minirag.techupsistemas.com`. O `docker-compose.yml` é a
> receita; as chaves (`MINIRAG_USERS`) ficam na aba Environment do painel.

> **Persistência:** o Postgres guarda os dados num volume nomeado
> (`minirag_data`). O volume sobrevive a reinícios e redeploys; pra zerar
> tudo (banco + memórias), use `docker-compose down -v`.

> **O serviço sumiu depois de um reboot do host?** No boot, o daemon religa os
> containers por conta própria, **sem** respeitar o `depends_on` — e um container
> que fique **parado** é apagado pela faxina agendada do Dokploy ("Docker
> Cleanup": `docker container prune --force`, que pega todo container parado, e
> em seguida `docker image prune -a --force`, que pega a imagem já órfã; volume é
> o único passo excluído). Sinais: `docker ps -a` sem o `minirag-api`, `GET
> /health` respondendo 404 pelo domínio, banco continuando `Up`.
> **Corrigido na v1.7:** a API espera o banco aceitar conexão antes de servir
> (`MINIRAG_DB_WAIT_TRIES` × `MINIRAG_DB_WAIT_SECONDS`, padrão 30 × 2s = 60s) e
> o serviço usa `restart: always`. Se o banco nunca aparecer, o processo morre
> com `RuntimeError` no log — nunca finge saúde — e o Docker tenta o boot de
> novo. Recuperar um serviço já apagado: qualquer push em `main` reimplanta (o
> primeiro build volta a baixar torch + modelo, ~500 MB).

---

## Variáveis de ambiente

| variável | default | o que controla |
|----------|---------|----------------|
| `MINIRAG_USERS` | `""` | lista `nome:chave` de logins (obrigatório) |
| `MINIRAG_MODEL` | `nomic-ai/nomic-embed-text-v1.5` | modelo de embedding |
| `MINIRAG_MODEL_DIR` | `/app/models` | onde o modelo está assado na imagem |
| `MINIRAG_EMBEDDER_MODO` | `filho` | `filho` = Node sobe o Python; `externo` = já está no ar |
| `MINIRAG_EMBEDDER_PORT` | `8001` | porta local (loopback) do embedder |
| `MINIRAG_OCR_PAGINAS_MAX` | `6` | máximo de páginas de PDF escaneado lidas por arquivo |
| `MINIRAG_OCR_DPI` | `150` | resolução da rasterização do PDF escaneado (mais dpi = mais lento) |
| `MINIRAG_OCR_LARGURA_MIN` | `900` | imagem mais estreita que isso é ampliada 2× antes do OCR |
| `MINIRAG_EMBEDDER_URL` | `http://127.0.0.1:8001` | URL usada pelo Node |
| `MINIRAG_PYTHON` | `python3` | binário do Python no container |
| `MINIRAG_WORKER_ATIVO` | `1` | liga o worker da fila (desligue em réplica só-API) |
| `MINIRAG_DB_HOST` | `minirag-db` | host do Postgres |
| `MINIRAG_DB_PORT` | `5432` | porta do Postgres |
| `MINIRAG_DB_USER` | `minirag` | usuário do Postgres |
| `MINIRAG_DB_PASSWORD` | `minirag` | senha do Postgres |
| `MINIRAG_DB_NAME` | `minirag` | nome do banco |
| `MINIRAG_DB_WAIT_TRIES` | `30` | tentativas de esperar o Postgres no boot |
| `MINIRAG_DB_WAIT_SECONDS` | `2` | pausa entre tentativas (30x2 = ate 60s) |
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
| `MINIRAG_OPERADOR` | `""` | login com escopo total (`nome:chave`), vê todas as gavetas |
| `MINIRAG_LOGIN_MAX_FALHAS` | `10` | falhas de chave por IP antes de bloquear (429) |
| `MINIRAG_LOGIN_JANELA_SEG` | `300` | janela (segundos) do freio de força bruta |

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
