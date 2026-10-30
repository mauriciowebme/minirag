# Nexos — memória, máquinas e arquivos

Memória pesquisável e agentes nas suas máquinas. Você envia documentos, ele corta em pedaços,
cria uma "digital" numérica do significado de cada um (embedding) e guarda num
banco Postgres com pgvector. Quando você pergunta, ele devolve os pedaços mais
parecidos com a pergunta, com uma nota de 0 a 1.

**Stack:** Node 22 + TypeScript (Fastify) + Postgres (pgvector) + embedder Python
(nomic-embed-text-v1.5 via sentence-transformers), rodando no MESMO container.

> **Histórico de versões:** saiu deste arquivo na limpeza de 30/10 (eram 86 seções, ~107 KB).
> Continua inteiro no git: `git log --oneline` e `git show <commit>:README.md`.

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
(ex.: o LLM via gateway). O nexos é a **bibliotecária**: entrega
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

As variáveis `NEXOS_USERS` / `NEXOS_ADMIN` (o apelido antigo `NEXOS_OPERADOR` ainda é aceito) continuam existindo como
**semente**: no boot cada `nome:chave` é inserido **se ainda não existir** — não
sobrescreve quem já está no banco (nem reativa quem foi desativado pela tela).

```
NEXOS_USERS=sistema:abc123
NEXOS_ADMIN=admin:def456
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
| `content` | string | sim | o **texto puro** (extraído do arquivo antes, se for .md/.pdf/.docx); máx. `NEXOS_MAX_CONTENT_CHARS` (default 500.000) |
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
| `query` | string | — | a pergunta (texto); máx. `NEXOS_MAX_QUERY_CHARS` (default 2.000) |
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
| `GET /usuarios` | operador | lista com papel, ativo, `chave_hint`, gavetas, documentos e `agendado_exclusao_em` (v3.5) |
| `POST /usuarios` | operador | `{nome, papel}` → `201 {nome, papel, chave}` — **a chave aparece só nesta resposta**; recriar nome agendado **desfaz a exclusão** e devolve `aviso` (v3.5) |
| `PATCH /usuarios/{nome}` | operador | `{ativo?, papel?}` — não deixa desativar/rebaixar o último operador |
| `POST /usuarios/{nome}/chave` | operador (qualquer) ou o próprio | gera chave nova e devolve uma vez |
| `DELETE /usuarios/{nome}` | operador | v3.5: **agenda** a exclusão dos dados (`{agendado, carencia_dias}`); desliga o login na hora; `409` se for o último admin ativo |
| `PUT /config/esquecimento` | **admin** | v3.5: grava `dias_arquivar`, `dias_excluir_arquivado`, `dias_carencia` (0–36500; tela vence o ambiente; devolve `efetivos`) |
| `GET/PUT /config/provider` | qualquer login | provider do chat (`tipo`, `base_url`, `modelo`, `chave`, `temperatura`, `system_prompt`, `mcp_interno`, `max_rodadas`, `ativo`); `global: true` (só operador) grava o padrão de todos. Desde a v3.0 também `memoria_turnos`, `verbatim_turnos`, `reserva_tokens`, `contexto_tokens`, `contexto_detectado`, `janela_efetiva`, `origem_janela` e `escopo` (onde a chamada mexeu). Chave e cabeçalho voltam **mascarados** |
| `POST /config/provider/testar` | qualquer login | manda um "teste de conexao" ao modelo e devolve `{ok, ms, modelo, contexto_detectado}` — a janela anunciada pelo provedor vira a janela efetiva |
| `POST /chat` | qualquer login | `{pergunta, memoria}` → `{resposta, ferramentas[], rodadas, modelo, ms, aviso, compactacao}`; manda as últimas `memoria_turnos` rodadas da gaveta (compactadas se não couberem na janela) e roda as ferramentas do MCP ligado **direto**, sem confirmar; sem provider → `409` |
| `GET/DELETE /chat?memoria=` | qualquer login | histórico da conversa (com as ferramentas chamadas) / apagar a conversa |
| `GET /config/mcp` | qualquer login | servidores MCP cadastrados (endereço, ativo, nº de ferramentas, cabeçalho mascarado) |
| `POST /config/mcp` | operador | `{nome, url, cabecalho?}` — cadastra e já lista as ferramentas do servidor |
| `PATCH /config/mcp/{nome}` | operador | `{url?, cabecalho?, ativo?}` — campo omitido fica como está |
| `DELETE /config/mcp/{nome}` | operador | remove o servidor (`404` se não existe) |
| `POST /config/mcp/testar` | operador | `{nome}` → conversa MCP de verdade e devolve `{ferramentas, nomes[], servidor, ms}` |

**Exemplo de chat (v2.8 — MCP interno ligado, o modelo pediu a busca):**
```json
POST /chat
{ "pergunta": "qual o total da nota do fornecedor AC ME?", "memoria": "empresa42" }

200 {
  "resposta": "O total é R$ 1.234,56, com vencimento em 10/11/2026.",
  "ferramentas": [
    { "servidor": "nexos", "nome": "search", "args": { "query": "nota AC ME total" },
      "ok": true, "resumo": "[{\"doc_id\":\"nota-fiscal\" …", "ms": 120 }
  ],
  "rodadas": 2, "modelo": "claude-sonnet-4.5", "provider": "empresa42",
  "ferramentas_ligadas": 20, "tem_system_prompt": false, "aviso": null, "ms": 1840
}
```

Sem provider o chat devolve `409`. Com provider e nada de MCP ligado, `ferramentas_ligadas: 0`
e o modelo responde só com o que sabe (é a "conversa pura" pedida).

### `POST /decay` — rodar o "esquecimento" agora

> No painel, a ação aparece como **"arquivar esquecidos"** (nome de tela).
> O endereço `/decay`, o campo `decay` dos JSONs e as variáveis `NEXOS_DECAY_*`
> continuam como estão — só o texto que o usuário vê mudou.

O serviço já roda o decay sozinho a cada `NEXOS_DECAY_INTERVALO_MINUTOS`.
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
{ "arquivados_agora": 2, "ativos": 5, "arquivados": 3, "expurgo": { "usuarios_apagados": ["fulano"], "docs_expurgados": 1 } }
```

Desde a v3.5 o `/decay` também roda a **faxina**: contas com carência vencida são
apagadas de vez (dados inteiros) e documentos arquivados além de
`dias_excluir_arquivado` morrem. O campo `expurgo` mostra o que a faxina mexeu —
usuário comum só enxerga o próprio alcance.

---

### `GET /health` — verificação de saúde (público, sem chave)

**Response (200):**
```json
{ "status": "ok", "dim": 768, "usuarios": 2 }
```

---

## v1.8/v1.9 — documentos, decay POR DOCUMENTO, operador e painel (19/10/2026)

### Fonte da verdade: tabela `documents`
O nexos passou a guardar o **arquivo original inteiro**, não só os pedaços
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
`NEXOS_ADMIN="nome:chave"` (formato idêntico ao `NEXOS_USERS`).
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

**Freio de força bruta no login** (v1.10): `NEXOS_LOGIN_MAX_FALHAS` (default
10) falhas de chave por IP dentro de `NEXOS_LOGIN_JANELA_SEG` (default 300 s)
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

Além da REST, o nexos fala **MCP (Model Context Protocol)** em
`POST /mcp`: JSON-RPC 2.0 sobre HTTP, stateless (sem sessão, sem SSE),
mesma porta, mesma chave Bearer, mesmas gavetas (`memoria`). É a porta
que agentes de IA (ex.: o Hermes) usam; a REST continua intacta pro
IA_GO.

O guia completo — quem pode conectar, o que cada conta recebe, o que o
operador controla e a receita para cadastrar o nexos num cliente — está
em [`docs/mcp.md`](docs/mcp.md).

**Fluxo do cliente MCP:**
1. `initialize` → servidor devolve `protocolVersion`, `capabilities.tools`, `serverInfo`.
2. `notifications/initialized` → aceito (202, sem corpo).
3. `tools/list` → **49 ferramentas** (medido em 28/10/2026), espelho das rotas REST (argumentos com os mesmos nomes dos corpos):
   - **documentos**: `search`, `ingest` (texto), `ingest_status`, `list_docs`, `delete_doc`
   - **arquivo original**: `upload_file` (`nome` + `conteudo_base64`, até 15 MB), `get_file` (devolve o binário em base64)
   - **edição**: `edit_doc` (texto novo + reindexação), `rename_doc` (doc_id/título/mover), `archive_doc`
   - **organização**: `list_gavetas`, `create_gaveta`, `delete_gaveta`
   - **operação**: `list_jobs`, `health`
   - **chat e configuração**: `chat` (a mesma conversa da tela, com as ferramentas ligadas),
     `config_provider`, `listar_usuarios`, `criar_usuario` (só operador)
   - **MCP do chat (v2.8)**: `listar_mcp`, `gerir_mcp` (ação `criar|atualizar|apagar|testar`, só operador)
4. `tools/call` → `{"name": "search", "arguments": {"query": "...", "memoria": "empresa42"}}` → resposta no formato MCP (`content: [{type: "text", text: "<JSON>"}]`).

**Exemplo (curl):**
```bash
curl -X POST https://nexos.techupsistemas.com/mcp \
  -H "Authorization: Bearer $CHAVE" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"query":"que horas é a reunião","memoria":"empresa42"}}}'
```

Erros de tool viram `result` com `isError: true` (linguagem do MCP); erro
de auth/protocolo segue o padrão JSON-RPC (`-32001`, `-32601`, `-32700`).

**O nexos também é cliente MCP (v2.8).** As ferramentas acima podem ser emprestadas ao
próprio Chat: com `mcp_interno` ligado o servidor chama `chamarToolInterna` — o mesmo
`switch`, no mesmo processo, com a sessão de quem perguntou (sem HTTP, sem segunda chave).
Servidores de fora entram por endereço em Configurações → Ferramentas (MCP); a chamada sai
como `nome-do-servidor__ferramenta`.
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
| `401` | chave não está na lista `NEXOS_USERS` (ou falta o header `Authorization`) |
| `400` | `content` com só espaços em ingest (nada pra cortar em pedaço) |
| `413` | cota de `NEXOS_MAX_CHUNKS_TENANT` atingida (medido: `limite de 10 chunks por usuario atingido (voce tem 2; este arquivo precisaria de 42)`) — a checagem é **na entrada da fila**, nada é gravado nem perdido |
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
export NEXOS_USERS="sistema:abc123,operador:def456"
export NEXOS_DB_PASSWORD="senha-forte"

# 2) Build e subida (primeira vez: ~15 min — assa o modelo de 768 dim na imagem)
docker-compose up -d --build

# 3) Conferir
docker ps --format '{{.Names}} {{.Status}}' | grep nexos
curl http://127.0.0.1:8000/health   # {"versao":"2.0.0", "embedder":"ok", ...}
```

### Desenvolvimento (fora do Docker)

Node e Python separados, para iterar rápido:

```bash
npm install
npm run build           # tsc (servidor, src/ → dist/)
(cd frontend && npm install && npm run build)   # React → frontend/dist

# terminal 1 — embedder (precisa de python com sentence-transformers + modelo)
NEXOS_EMBEDDER_MODO=externo \
  python3 -m uvicorn embedder.embed_server:app --port 8001

# terminal 2 — aplicação
NEXOS_EMBEDDER_MODO=externo NEXOS_DB_HOST=127.0.0.1 \
NEXOS_USERS="teste:chave" node dist/index.js
```

### Testes

```bash
# subida limpa do ambiente DESCARTÁVEL (derruba, apaga volume, reconstrói a imagem,
# gera chaves novas, espera /health e escreve o arquivo de ambiente da rodada)
scripts/up-test.sh
set -a; . /opt/data/cache/scratch/nexos_test_keys.env; set +a

SO_BLOCOS="v3.2" npm test    # só os blocos afetados, antes de pedir OK do deploy
npm test                     # suíte COMPLETA, uma vez antes do push
```

A suíte (`tests/e2e.test.ts`, **260 checagens em 12 blocos**) roda por HTTP contra a instância de
teste: é juiz de **contrato**, não de implementação, e imprime no fim a tabela de cobertura da
rodada (blocos pulados por `SO_BLOCOS` aparecem nominalmente). O último bloco testa o freio de
força bruta e bloqueia o IP por 5 minutos — por isso ele é o último, e fica fora do portão de CI.
Modo/alvo, papéis reais, prova de versão e como fechar cada lacuna: **`docs/testes.md`**
(método na skill canônica `suite-de-testes`).

### Produção (qualquer plataforma Docker)

O nexos roda em qualquer ambiente com Docker. Segue um exemplo prático
(usando o Dokploy, mas vale pra qualquer orquestrador / host):

1. Crie um **projeto tipo "docker"**, aponte para a pasta do repo.
2. Na aba **Environment** (ou `.env`), preencha:
   - `NEXOS_USERS` — lista `nome:chave` (ex.: `sistema:abc123`)
   - `NEXOS_DB_USER` / `NEXOS_DB_PASSWORD` — usuário e senha do Postgres
   - `NEXOS_CORS_ORIGINS` — origens que podem chamar **a partir de navegador**
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
> **Produção atual:** Dokploy do Contabo, serviço `nexos` (fonte github,
> branch `main`, **autoDeploy ligado** — todo push em `main` reimplanta),
> domínio `https://nexos.techupsistemas.com`. O `docker-compose.yml` é a
> receita; as chaves (`NEXOS_USERS`) ficam na aba Environment do painel.

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
> (`NEXOS_DB_WAIT_TRIES` × `NEXOS_DB_WAIT_SECONDS`, padrão 30 × 2s = 60s) e
> o serviço usa `restart: always`. Se o banco nunca aparecer, o processo morre
> com `RuntimeError` no log — nunca finge saúde — e o Docker tenta o boot de
> novo. Recuperar um serviço já apagado: qualquer push em `main` reimplanta (o
> primeiro build volta a baixar torch + modelo, ~500 MB).

---

## Variáveis de ambiente

> **Nome novo e nome antigo valem.** O app lê `NEXOS_*` e, no boot, copia qualquer
> `MINIRAG_*` que ainda exista para o nome novo — então env antigo continua
> funcionando e `NEXOS_*` tem precedência quando os dois estão definidos.

| variável | default | o que controla |
|----------|---------|----------------|
| `NEXOS_USERS` | `""` | lista `nome:chave` de logins (obrigatório) |
| `NEXOS_MODEL` | `nomic-ai/nomic-embed-text-v1.5` | modelo de embedding |
| `NEXOS_MODEL_DIR` | `/app/models` | onde o modelo está assado na imagem |
| `NEXOS_EMBEDDER_MODO` | `filho` | `filho` = Node sobe o Python; `externo` = já está no ar |
| `NEXOS_EMBEDDER_PORT` | `8001` | porta local (loopback) do embedder |
| `NEXOS_OCR_PAGINAS_MAX` | `6` | máximo de páginas de PDF escaneado lidas por arquivo |
| `NEXOS_OCR_DPI` | `150` | resolução da rasterização do PDF escaneado (mais dpi = mais lento) |
| `NEXOS_OCR_LARGURA_MIN` | `900` | imagem mais estreita que isso é ampliada 2× antes do OCR |
| `NEXOS_EMBEDDER_URL` | `http://127.0.0.1:8001` | URL usada pelo Node |
| `NEXOS_PYTHON` | `python3` | binário do Python no container |
| `NEXOS_WORKER_ATIVO` | `1` | liga o worker da fila (desligue em réplica só-API) |
| `NEXOS_DB_HOST` | `minirag-db` | host do Postgres |
| `NEXOS_DB_PORT` | `5432` | porta do Postgres |
| `NEXOS_DB_USER` | `minirag` | usuário do Postgres (o volume já foi criado com esse nome) |
| `NEXOS_DB_PASSWORD` | `minirag` | senha do Postgres (idem: o volume manda) |
| `NEXOS_DB_NAME` | `minirag` | nome do banco (idem) |
| `NEXOS_DB_WAIT_TRIES` | `30` | tentativas de esperar o Postgres no boot |
| `NEXOS_DB_WAIT_SECONDS` | `2` | pausa entre tentativas (30x2 = ate 60s) |
| `NEXOS_MAX_CHUNK_WORDS` | `500` | palavras por pedaço |
| `NEXOS_CHUNK_OVERLAP` | `80` | palavras de sobreposição entre pedaços |
| `NEXOS_TOP_K` | `5` | quantos resultados por busca |
| `NEXOS_MIN_SCORE` | `0.55` | nota mínima pra devolver |
| `NEXOS_MAX_CONTENT_CHARS` | `500000` | teto de `content` por ingest (~5.000 linhas; estourou = 422) |
| `NEXOS_MAX_QUERY_CHARS` | `2000` | teto da `query` de busca (estourou = 422) |
| `NEXOS_MAX_CHUNKS_TENANT` | `10000` | cota de chunks por login (estourou = 413) |
| `NEXOS_DECAY_ATIVO` | `1` | `0` desliga o esquecimento automático |
| `NEXOS_DECAY_DIAS` | `180` | sem acesso por N dias → arquiva (v3.5: o valor salvo na tela vence) |
| `NEXOS_DECAY_MIN_ACESSOS` | `2` | usado N+ vezes nunca é arquivado |
| `NEXOS_DECAY_INTERVALO_MINUTOS` | `60` | de quanto em quanto o loop roda (decay + faxina) |
| `NEXOS_EXPURGO_ARQUIVADO_DIAS` | `365` | arquivado por N dias ou mais é apagado de vez (tela vence) |
| `NEXOS_CARENCIA_DIAS` | `30` | janela entre apagar usuário e a exclusão dos dados dele (tela vence) |
| `NEXOS_CORS_ORIGINS` | `""` | origens de navegador que podem chamar; em uso servidor-para-servidor pode ficar vazio |
| `NEXOS_ADMIN` | `""` | login do admin, escopo total (`nome:chave`), vê todas as gavetas. Desde a v3.4; o nome antigo `NEXOS_OPERADOR` ainda vale como apelido |
| `NEXOS_LOGIN_MAX_FALHAS` | `10` | falhas de chave por IP antes de bloquear (429) |
| `NEXOS_LOGIN_JANELA_SEG` | `300` | janela (segundos) do freio de força bruta |

---

## Como um sistema usa o nexos

O backend do **sistema** guarda **uma** `chaveapi` por ambiente (ex.: `abc123`
para o backend em produção). Em cada operação:

- **Ingestão:** o usuário da empresa 42 envia um documento → o backend
  chama `POST /ingest` com `memoria: "empresa42"`.
- **Busca:** o usuário pergunta → o backend chama `POST /search` com
  `memoria: "empresa42"` → pega os pedaços → manda pro LLM (via
  gateway) com a pergunta + os pedaços → o LLM responde.

O nexos **não sabe** que o sistema existe. Ele só obedece à chave e à gaveta.
Quem decide qual empresa existe e qual usuário pertence a qual é o sistema.

---

## O que o nexos NÃO faz

- **Não lê arquivos** (PDF, .docx, .md) — quem extrai o texto é o cliente.
- **Não responde perguntas em linguagem natural** — entrega pedaços; o LLM
  redige a resposta.
- **Não gerencia empresas/usuários** — a lista `NEXOS_USERS` é fixa no
  ambiente; criar/alterar logins = editar variável + reiniciar.
