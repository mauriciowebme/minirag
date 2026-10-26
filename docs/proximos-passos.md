# Próximos passos — minirag

> **Última atualização:** 2026-10-25 · **Versão/Dono:** minirag 3.18.0-em-curso · Mauricio
**Fonte**: varredura do chat contra a linha de base de harnesses maduros (Open WebUI, Hermes), medida no código em 25/10/2026 — tudo o que está aqui foi confirmado por leitura/grep, nada é opinião de memória. Análise é o Mauricio quem conduz; execução de qualquer T### exige OK explícito dele.

**Decisão de escopo (25/10, Mauricio)**: não adotar harness pronto — o chat do minirag é a face do produto por tenant (gaveta, ferramentas, máquinas) e o duro já existe (streaming reanexável, fila, tarefa persistente, markdown, rastro). O caminho é roubar dos maduros o básico que falta. **Fora de linha de base, NÃO viram tarefa**: branch de conversa, 👍/👎, compartilhar por URL, slash commands, parâmetros por chat, TTS de leitura.

---

## Índice

| T### | Nome | Módulo | Prioridade | Status | Link |
|---|---|---|---|---|---|
| T001 | Parar a geração em curso | chat-srv + chat-ui | 🟠 Alta | ✅ v3.18 | [#t001](#t001) |
| T002 | Regenerar resposta | chat-srv | 🟡 Média | ✅ v3.18 | [#t002](#t002) |
| T003 | Editar e reenviar pergunta | chat-ui + chat-srv | 🟡 Média | ✅ v3.18 | [#t003](#t003) |
| T004 | Fontes da resposta (citações) | chat-srv + chat-ui | 🟠 Alta | ✅ v3.18 | [#t004](#t004) |
| T005 | Guarda de autocorreção (IME) no Enter | chat-ui | 🟠 Alta | ✅ v3.18 | [#t005](#t005) |
| T006 | Estilo de tabela markdown no celular | chat-ui | 🟡 Média | ✅ v3.18 (confirmou: já existia; reforçado) | [#t006](#t006) |
| T007 | Renderizar imagem na resposta | chat-ui | 🟡 Média | ✅ v3.18 | [#t007](#t007) |
| T008 | Teclado não esconde a barra | chat-ui | 🟡 Média | ✅ v3.18 | [#t008](#t008) |
| T009 | Copiar só o bloco de código | chat-ui | 🟢 Baixa | ✅ v3.18 | [#t009](#t009) |
| T010 | Colorir código (destaque de sintaxe) | chat-ui | 🟢 Baixa | ✅ v3.18 | [#t010](#t010) |
| T011 | Botão voltar ao fundo | chat-ui | 🟢 Baixa | ✅ Já existia | [#t011](#t011) |
| T012 | Hora em cada mensagem | chat-ui | 🟢 Baixa | ✅ v3.18 | [#t012](#t012) |
| T013 | Aviso de erro com repetir visível | chat-ui | 🟢 Baixa | ✅ v3.18 | [#t013](#t013) |
| T014 | Rascunho por gaveta | chat-ui | 🟢 Baixa | ✅ v3.18 | [#t014](#t014) |
| T015 | Renomear conversa | chat-ui + chat-srv | 🟢 Baixa | ✅ v3.18 | [#t015](#t015) |
| T016 | Título automático da gaveta | chat-srv | 🟢 Baixa | ✅ v3.18 | [#t016](#t016) |
| T017 | Exportar conversa | chat-ui | 🟢 Baixa | ✅ v3.18 | [#t017](#t017) |
| T018 | Custo/tamanho por resposta | chat-srv + chat-ui | 🟢 Baixa | ✅ v3.18 | [#t018](#t018) |
| T019 | Fixar/arquivar gaveta | chat-ui + chat-srv | 🟢 Baixa | ✅ v3.18 | [#t019](#t019) |
| T020 | Copiar pergunta própria | chat-ui | 🟢 Baixa | ✅ v3.18 | [#t020](#t020) |
| T021 | Buscar dentro do histórico | chat-srv + chat-ui | 🟡 Média | ✅ v3.18 | [#t021](#t021) |
| T022 | Entrada por voz (microfone) | chat-ui | 🟢 Baixa | ✅ v3.18 | [#t022](#t022) |
| T023 | Provedor escolhido na conversa + auto-descoberta de modelos | chat-srv + chat-ui | 🟡 Média | ✅ v3.19 | [#t023](#t023) |

---

<a id="t001"></a>
### T001 — Parar a geração em curso
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-srv + chat-ui |
| **Prioridade** | 🟠 Alta — o item que o dono apontou dia 25/10; todos os chatbots maduros têm |
| **Status** | ✅ v3.18 |
| **Spec/Plano** | _A criar_ |
| **Descrição** | Não há como interromper uma resposta em andamento. Verificado: o `cancelar()` de `frontend/src/lib/conversa.ts:183` é **local** (tira da fila na memória do navegador, não avisa ninguém). O servidor não tem rota de cancelar tarefa de chat — `src/tarefa.ts` só expõe criar/listar/ver/rodar/assinar; `/jobs/:jobId/cancel` (`src/app.ts:460`) é de ingestão, não de chat. |
| **Escopo** | Estado `cancelada` na tarefa; registro em memória do AbortController/sinal por tarefa viva (o `vigiaSilencio` de `src/provider.ts:345` já aborta por silêncio — reaproveitar o caminho); `POST /chat/tarefa/:id/cancelar` com checagem de tenant; botão **Parar** no composer enquanto `escrevendo`; texto parcial já gerado preservado na mensagem (padrão Open WebUI/ChatGPT). |
| **Arquivos afetados** | src/tarefa.ts, src/app.ts, src/provider.ts, frontend/src/lib/conversa.ts, frontend/src/components/Chat.tsx |
| **Dependências** | Nenhuma. |
| **Riscos** | Correr tarefa já finalizada ⇒ endpoint deve ser idempotente (409/cancelado ≠ erro 500). Tenant: cancelar tarefa alheia = 404. |

<a id="t002"></a>
### T002 — Regenerar resposta
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-srv + chat-ui |
| **Prioridade** | 🟡 Média |
| **Status** | ✅ v3.18 |
| **Spec/Plano** | _A criar_ |
| **Descrição** | O próprio código admite: comentário em `frontend/src/components/Chat.tsx:630` — "regenerar exige mexer no histórico no servidor (ainda não existe)". |
| **Escopo** | Rota que corta a última resposta do histórico da gaveta e reenvia a mesma pergunta; botão "refazer" nas ações da resposta pronta. Decidir se guarda a resposta descartada ou apaga (recomendado: apagar, igual Open WebUI). |
| **Arquivos afetados** | src/provider.ts (histórico), src/app.ts, frontend/src/components/Chat.tsx |
| **Dependências** | Compartilha o osso do corte de histórico com T003 — fazer juntas. |

<a id="t003"></a>
### T003 — Editar e reenviar pergunta
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui + chat-srv |
| **Prioridade** | 🟡 Média |
| **Status** | ✅ v3.18 |
| **Spec/Plano** | _A criar_ |
| **Descrição** | Verificado 25/10: nenhuma UI de editar mensagem no front (grep `editar` só em rótulos de ferramenta). |
| **Escopo** | Clicar/ícone de editar na mensagem do usuário ⇒ campo pré-cheio; ao reenviar, truncar o histórico a partir dela (mesmo corte da T002). |
| **Arquivos afetados** | frontend/src/components/Chat.tsx, frontend/src/lib/conversa.ts, src/app.ts |
| **Dependências** | T002. |

<a id="t004"></a>
### T004 — Fontes da resposta (citações)
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-srv + chat-ui |
| **Prioridade** | 🟠 Alta — num produto de memória, dizer *de onde* veio a resposta é confiança básica do cliente (Open WebUI mostra os documentos usados; Hermes cita fonte) |
| **Status** | ✅ v3.18 |
| **Spec/Plano** | _A criar_ |
| **Descrição** | A coluna `fontes JSONB` existe no schema de `chat_mensagens` (`src/provider.ts:129`) mas **nenhum código escreve nela e nenhum lê para exibir** — coluna morta verificada por grep em `src/*.ts` (25/10). O rastro atual mostra *quais ferramentas* foram chamadas, não *quais documentos* responderam. |
| **Escopo** | A busca/leitura de chunks usada na resposta gravar os documentos de origem em `fontes`; UI com "de onde veio" abaixo da resposta, clicável (abre o documento na gaveta). |
| **Arquivos afetados** | src/provider.ts, src/ferramentas.ts (ou onde a busca injeta contexto), frontend/src/components/Chat.tsx |
| **Dependências** | Nenhuma, mas casa com T018 (rodapé único). |
| **Riscos** | Resposta sem uso de memória (modelo de cabeça) ⇒ fontes vazio, UI deve dizer isso ("sem fontes citadas") em vez de omitir. |

<a id="t005"></a>
### T005 — Guarda de autocorreção (IME) no Enter
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟠 Alta — bug diário no celular: custo ínfimo, erro bobo que o dono classificou como o tipo a eliminar |
| **Status** | ✅ v3.18 |
| **Spec/Plano** | _A criar_ |
| **Descrição** | Verificado 25/10: nenhum uso de `isComposing` no front. No Android/iOS, quando o teclado está compondo palavra (sugestão/sublinhado) e o usuário dá Enter para aceitar, o handler dispara o envio com a pergunta pela metade. |
| **Escopo** | Ignorar Enter com `e.isComposing` (ou `keyCode 229`) no handler de tecla do campo; `enterKeyHint="send"` no textarea para o teclado desenhar a tecla certa. |
| **Arquivos afetados** | frontend/src/components/Chat.tsx |
| **Dependências** | Nenhuma. |

<a id="t006"></a>
### T006 — Estilo de tabela markdown no celular
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟡 Média |
| **Status** | ✅ v3.18 |
| **Spec/Plano** | _A criar_ |
| **Descrição** | `lib/md.ts` gera `<table>` (confirmado 25/10), mas não existe nenhuma regra de tabela no CSS do chat (grep `table` em index.css: zero) — tabela sai espremida e sem borda, ilegível em 390px. |
| **Escopo** | CSS: bordas, respiro por célula, e container com rolagem horizontal na largura do texto (não da tela). |
| **Arquivos afetados** | frontend/src/index.css, frontend/src/lib/md.ts (wrapper de rolagem) |

<a id="t007"></a>
### T007 — Renderizar imagem na resposta
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟡 Média — screenshots de máquina pedem isso na tela do cliente |
| **Status** | ✅ v3.18 |
| **Spec/Plano** | _A criar_ |
| **Descrição** | `lib/md.ts` não produz `<img>` (confirmado 25/10): imagem devolvida pelo modelo ou por ferramenta (ex.: captura de tela) aparece como texto/link morto. |
| **Escopo** | Notação de imagem do markdown ( exclamação + colchetes de texto-alt + parênteses de endereço ) vira `<img>` com largura máxima do balão; data-URL com tamanho limitado; link da imagem abre em nova aba (comportamento atual de links já usa target=_blank, `md.ts:40`). |
| **Arquivos afetados** | frontend/src/lib/md.ts, frontend/src/index.css |

<a id="t008"></a>
### T008 — Teclado não esconde a barra
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟡 Média |
| **Status** | ✅ v3.18 |
| **Spec/Plano** | _A criar_ |
| **Descrição** | Nenhum uso de `visualViewport` no front (verificado 25/10); o pé é bloco normal com `env(safe-area-inset-bottom)` — com o teclado aberto no celular, a linha de digitar pode ficar atrás dele. |
| **Escopo** | Ouvir `visualViewport` e reposicionar/rolhar para manter o campo visível ao focar; validar no emulador e na Noot. |
| **Arquivos afetados** | frontend/src/components/Chat.tsx, frontend/src/index.css |

<a id="t009"></a>
### T009 — Copiar só o bloco de código
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟢 Baixa |
| **Status** | ✅ v3.18 |
| **Descrição** | Hoje só existe copiar a resposta inteira (`Chat.tsx:459`). Blocos de código sem botão próprio — padrão em todos os maduros. |
| **Escopo** | Botão de cópia no canto de cada `<pre>` gerado pelo md; reutilizar `copiarResposta` (tem reserva para http sem clipboard). |
| **Arquivos afetados** | frontend/src/lib/md.ts, frontend/src/components/Chat.tsx |

<a id="t010"></a>
### T010 — Colorir código (destaque de sintaxe)
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟢 Baixa |
| **Status** | ✅ v3.18 |
| **Descrição** | Zero highlight no front (confirmado 25/10: `hljs`/`highlight` não aparecem em md.ts nem package.json) — bloco de código sai mono sem cor. |
| **Escopo** | Destaque leve sem dependência pesada (a casa prefere solução própria/barata); linguagem opcional vindo da cerca de ticks. |
| **Arquivos afetados** | frontend/src/lib/md.ts, frontend/src/index.css |
| **Dependências** | Fazer junto com T009 (mesmo `<pre>`). |

<a id="t011"></a>
### T011 — Botão voltar ao fundo
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟢 Baixa |
| **Status** | ✅ Entregue — já existia (fechado 25/10 na execução do lote) |
| **Descrição** | Botão flutuante `chatIrAoFim` ("↓ fim", com aviso "· chegou coisa nova") aparece quando a rolagem descola do fundo — `Chat.tsx:659-667` no HEAD. A análise original marcou ❌ porque procurou a frase "voltar ao fundo" e o botão se chama "fim"; falsos pendentes são risco de varredura por termo — conferir por comportamento, não por rótulo. |
| **Escopo** | Aparece só quando descolado; seta para baixo; some ao voltar. |
| **Arquivos afetados** | frontend/src/components/Chat.tsx, frontend/src/index.css |

<a id="t012"></a>
### T012 — Hora em cada mensagem
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟢 Baixa |
| **Status** | ✅ v3.18 |
| **Descrição** | Zero timestamps na UI (grep 25/10) — o banco já tem `criado_em TIMESTAMPTZ` (`src/provider.ts:131`), só falta expor. |
| **Escopo** | Hora curta no rodapé do balão (hh:mm); data separadora quando o dia virar. |
| **Arquivos afetados** | frontend/src/components/Chat.tsx; confirmar que o histórico devolve `criado_em` na rota |

<a id="t013"></a>
### T013 — Aviso de erro com repetir visível
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟢 Baixa |
| **Status** | ✅ v3.18 |
| **Descrição** | Há re-experimentação interna no transporte (SSE, `Chat.tsx:343`) e o vigia rotula o erro do provedor, mas sem affordance "tentar de novo" na tela quando a resposta morre — o usuário relê a pergunta sem botão. |
| **Escopo** | Balão de erro com botão repetir (reenvia a mesma pergunta; se T002 existir, reutilizar o corte). |
| **Arquivos afetados** | frontend/src/components/Chat.tsx, frontend/src/lib/conversa.ts |

<a id="t014"></a>
### T014 — Rascunho por gaveta
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟢 Baixa |
| **Status** | ✅ v3.18 |
| **Descrição** | `pergunta` é `useState` único (`Chat.tsx:265`) — digitou, trocou de gaveta, perdeu. "rascunho" no código hoje significa outra coisa (fala de caminho, `conversa.ts:56`). |
| **Escopo** | Guardar texto por chave de gaveta (memória basta; persistir no storage só se o dono quiser após refresh). |
| **Arquivos afetados** | frontend/src/components/Chat.tsx |

<a id="t015"></a>
### T015 — Renomear conversa
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui + chat-srv |
| **Prioridade** | 🟢 Baixa |
| **Status** | ✅ v3.18 |
| **Descrição** | Gavetas só criam e apagam; nenhum renomear no chat (grep `renomear`: só rótulo de ferramenta `rename_doc`). |
| **Escopo** | Duplo-clique/ícone na gaveta ⇒ novo nome; persistir no servidor (nome hoje mora onde? confirmar no estado de gavetas antes de codar). |
| **Arquivos afetados** | frontend/src/components/Gavetas.tsx, src/app.ts |

<a id="t016"></a>
### T016 — Título automático da gaveta
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-srv |
| **Prioridade** | 🟢 Baixa |
| **Status** | ✅ v3.18 |
| **Descrição** | Zero geração de título (grep `gerarTitulo`/`autoTitulo`: nada). Open WebUI nomeia a conversa após a primeira troca; cliente nosso hoje vê "gaveta N". |
| **Escopo** | Uma chamada barata ao provider após a primeira resposta ⇒ título curto; respeitar renomeio manual do usuário (T015 ganha precedência). |
| **Dependências** | T015. |

<a id="t017"></a>
### T017 — Exportar conversa
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟢 Baixa |
| **Status** | ✅ v3.18 |
| **Descrição** | Nenhum export (grep 25/10). Maduros deixam salvar a conversa em markdown/JSON. |
| **Escopo** | Botão no menu da gaveta ⇒ baixa `.md` com hora por mensagem (aproveita T012). |
| **Arquivos afetados** | frontend/src/components/Chat.tsx ou Gavetas.tsx |

<a id="t018"></a>
### T018 — Custo/tamanho por resposta
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-srv + chat-ui |
| **Prioridade** | 🟢 Baixa |
| **Status** | ✅ v3.18 |
| **Descrição** | Nada de tokens/medida por mensagem no front (grep `token`: 1 rótulo). O provider já sabe o tamanho da resposta; dono cobra visão de custo em modelos pagos. |
| **Escopo** | Rodapé discreto por resposta (tokens de saída; tempo). Guardar na mensagem se barato. |
| **Dependências** | Nenhuma; mesmo rodapé de T012. |

<a id="t019"></a>
### T019 — Fixar/arquivar gaveta
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui + chat-srv |
| **Prioridade** | 🟢 Baixa |
| **Status** | ✅ v3.18 |
| **Descrição** | `arquiv`/`pin` no chat só existem como rótulos de ferramenta sobre **documentos** (`Chat.tsx:87-91`); a lista de gavetas não fixa nem arquiva conversas. |
| **Escopo** | Gaveta fixada no topo; arquivada some da lista padrão (não apaga). |
| **Dependências** | T015 (mesma superfície de estado da gaveta). |

<a id="t020"></a>
### T020 — Copiar pergunta própria
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟢 Baixa |
| **Status** | ✅ v3.18 |
| **Descrição** | Ações (`chat-acoes`) só aparecem em `papel === "assistant"` (lido 25/10, `Chat.tsx:632`); a pergunta do usuário não tem copiar. |
| **Escopo** | Balão do usuário ganha copiar no hover/toque longo. |
| **Arquivos afetados** | frontend/src/components/Chat.tsx |

<a id="t021"></a>
### T021 — Buscar dentro do histórico
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-srv + chat-ui |
| **Prioridade** | 🟡 Média |
| **Status** | ✅ v3.18 |
| **Descrição** | A aba Busca achata **documentos**; não há busca dentro das **mensagens** das conversas (a Busca continua funcionando, o chat não). Custo de desenho: índice/rota nova. |
| **Escopo** | Rota de busca em `chat_mensagens` por tenant; UI no painel de gavetas; resultado salta para a conversa. |

<a id="t022"></a>
### T022 — Entrada por voz (microfone)
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟢 Baixa |
| **Status** | ✅ v3.18 |
| **Descrição** | Nenhum microfone no composer (grep `mediaDevices`/`SpeechRecognition`: zero, 25/10). Open WebUI tem; na janelinha Edge dá para usar Web Speech — qualidade depende do navegador, testar antes de prometer. |
| **Escopo** | Botão de mic que detona texto no campo (não envia sozinho); fallback de mensagem quando o navegador não suporta. |
| **Riscos** | Web Speech no Edge pode exigir conexão; STT local (whisper na Noot) é caminho alternativo — decisão do dono. |

<a id="t023"></a>
### T023 — Provedor escolhido na conversa + auto-descoberta de modelos
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-srv + chat-ui |
| **Prioridade** | 🟡 Média |
| **Status** | ✅ v3.19 (pedido pelo dono em 26/10) |
| **Descrição** | Cadastro de N provedores nomeados (tabela `provedores`, escopo próprio/global) com chave mascarada; a lista de modelos vem do próprio serviço (`GET /models`, fallback `/v1/models` e `/api/tags` do Ollama — padrão medido no Open WebUI e no Hermes), cacheada na linha com data. No chat, régua acima do composer escolhe provedor+modelo POR CONVERSA (memória do transporte); a resposta carrega selo "via X" gravado em `chat_mensagens`. Guarda: com cache descoberto, modelo fora da lista é 422. |
| **Escopo** | Feito: serviço (`src/provedores.ts`), resolução no `resolverProvider`, colunas em `chat_tarefas`/`chat_mensagens`, rotas `/provedores`, tela em Configurações, régua no chat, bloco v3.19 na suíte (17 checagens). v3.19.1: seções de Configurações viraram **submenu do item pai no menu principal** (cobrado pelo dono 26/10; régua gravada em `arquiteto-sistema/references/navegacao-menu.md`). |
| **Riscos** | Costeamento por provedor ainda não existe (o "tok" medido é do que saiu); lista de modelos de gateway com paginação pode cortar em 500. |

---

## Lotes recomendados (executados — saíram na v3.18)

- **Lote 1 — celular e erros bobos (quase tudo barato)**: T005, T001, T006, T007, T009, T011, T012, T013, T014, T020
- **Lote 2 — osso de servidor**: T002 + T003 juntos (corte de histórico único), T004, T018
- **Lote 3 — superfície de gaveta**: T015, T016, T019, T017, T010
- **Depois / a decidir**: T008 (validar no aparelho físico — emulador já passou); T021 e T022 saíram na v3.18 (linha corrigida em 26/10)
