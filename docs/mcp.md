# minirag como servidor MCP

> **Última atualização:** 28/10/2026 · **Versão:** 3.35.1 · **Medido no ambiente de teste**

O minirag é **três coisas ao mesmo tempo**, e é bom que isso esteja escrito num lugar só:

| Papel | Quem usa | Como se fala com ele |
|---|---|---|
| **Agente** | a pessoa conversando na tela | chat (stream), com o modelo e as ferramentas ligadas |
| **Central de memória** | quem precisa guardar e buscar | REST (`/documents`, `/search`, `/gavetas`) e as ferramentas do MCP |
| **Provedor de conexões** | outros agentes (Hermes, Claude, Cursor, scripts) | **MCP** em `POST /mcp` — JSON-RPC 2.0 sobre HTTP, sem sessão e sem SSE |

Este documento é sobre o terceiro papel: **usar o minirag como servidor MCP**. O mecanismo de dentro
(camada `src/mcp.ts`, mesmo processo, sem HTTP interno) está descrito no README.

---

## 1. Quem pode se conectar

**Todo usuário ativo.** Não existe cadastro separado de "cliente MCP": o usuário **é** a identidade MCP.
A chave do usuário é a credencial, e o escopo das ferramentas é o tenant dele.

```
POST https://minirag.techupsistemas.com/mcp
Authorization: Bearer <chave do usuário>
Content-Type: application/json
```

Duas regras que confundem e por isso ficam ditas:

- **Chave de cliente não serve.** As chaves da aba *Chaves de cliente* (usadas por sistemas como o
  IA_GO) são credencial de aplicação: abrem REST de documentos, **nunca** painel, chat ou MCP (401).
- **Não há segunda autenticação.** A chave que abre a tela é a mesma que abre o MCP.

Para criar um usuário: painel → Usuários, ou, para o operador, a ferramenta `criar_usuario`
(a chave volta em claro **uma única vez**).

---

## 2. Fluxo de conversa (JSON-RPC 2.0)

```jsonc
// 1. initialize
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
// → { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "minirag", version: "3.35.1" } }

// 2. notifications/initialized  (aceito com 202, sem corpo)
{"jsonrpc":"2.0","method":"notifications/initialized"}

// 3. tools/list
{"jsonrpc":"2.0","id":2,"method":"tools/list"}

// 4. tools/call
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
  "name":"search","arguments":{"query":"que horas é a reunião","memoria":"empresa42"}}}
// → { content: [{ type: "text", text: "<JSON do retorno>" }] }
```

Erro de ferramenta vem como `result` com `isError: true` (linguagem do MCP). Erro de
autenticação/protocolo vem como JSON-RPC: `-32001` (auth), `-32601` (método), `-32700` (parse).

**Exemplo colável:**

```bash
curl -X POST https://minirag.techupsistemas.com/mcp \
  -H "Authorization: Bearer $MINIRAG_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health","arguments":{}}}'
```

---

## 3. As ferramentas — e o que cada conta recebe

Medido em 28/10/2026: **49 ferramentas** no `tools/list`.

| Grupo | Quantas | Observação |
|---|---|---|
| Documentos e gavetas | 12 | `search`, `ingest`, `ingest_status`, `list_docs`, `delete_doc`, `upload_file`, `get_file`, `edit_doc`, `rename_doc`, `archive_doc`, `list_gavetas`, `create_gaveta`, `delete_gaveta` |
| Operação e assistente | 7 | `health`, `list_jobs`, `chat`, `mostrar_tela`, `web_search`, `web_open`, `config_provider` |
| Usuários e MCP | 6 | `listar_usuarios`, `criar_usuario`, `apagar_usuario`, `esquecimento`, `listar_mcp`, `gerir_mcp` |
| Máquinas (túnel) | 20 | só existem com o **controle de máquinas** ligado pelo operador |
| Pareamento | 1 | `gerar_pareamento` |

**O que o operador controla (e vale para todo mundo):**

1. **Ferramentas internas** (`mcp_interno`) — desligado, o chat não recebe ferramenta nenhuma.
2. **Controle das máquinas** — desligado, as 20 ferramentas de máquina **desaparecem do `tools/list`**
   e a chamada é recusada (409).
3. **Servidores MCP externos** — cada um vira `<servidor>__<ferramenta>` no chat.

**O que é do papel, não do cadastro:** cinco ferramentas são só de operador e devolvem **403** para
usuário comum: `listar_usuarios`, `criar_usuario`, `apagar_usuario`, `esquecimento`, `gerir_mcp`.

> ⚠️ **Hoje o `tools/list` não filtra por papel**: um usuário comum vê as 49 na lista e descobre o
> limite só ao chamar (403). A lista diz a verdade sobre o *servidor*, não sobre a *conta*.

**O que cada conta vê dos próprios dados:** tudo é filtrado pelo tenant do usuário — as gavetas,
documentos e máquinas que ele enxerga são as dele. O operador pode apontar `tenant` em várias
ferramentas para agir na conta de outro; para usuário comum esse campo é ignorado.

---

## 4. O minirag como cliente MCP (o sentido inverso)

Em **Configurações → Ferramentas (MCP)** o operador cadastra servidores externos por URL. Cada
ferramenta deles entra no chat como `<nome-do-servidor>__<ferramenta>` (o nome do servidor não pode
conter `__`). A chave de acesso fica guardada no servidor e volta mascarada (`••••xy98`).

---

## 5. Limites conhecidos

- **Sem SSE e sem sessão**: cada POST é independente; não há notificação de progresso.
- **`get_file` devolve base64** dentro do JSON-RPC — 15 MB viram ~20 MB de texto. Em massa, use a REST
  (`GET /documents/{id}/arquivo`), que devolve o binário puro.
- **A ferramenta `chat` fica fora da lista injetada no próprio chat** (evita o modelo chamar a si
  mesmo); pelo MCP ela continua disponível.
- **Timeouts** contam no cliente: `upload_file` e `ingest` de arquivo grande podem passar de 30 s.

---

## 6. Receita rápida — Hermes Agent

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  minirag:
    url: https://minirag.techupsistemas.com/mcp
    headers:
      Authorization: Bearer ${MINIRAG_KEY}
    timeout: 120
```

Depois de reiniciar o agente, as ferramentas aparecem como `mcp_minirag_search`, `mcp_minirag_ingest`
etc. A chave sai do ambiente (`MINIRAG_KEY`), nunca do arquivo.
