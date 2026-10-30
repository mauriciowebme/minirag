# Próximos passos — minirag

> **Última atualização:** 2026-10-28 · **Versão/Dono:** minirag 3.37.0 · Mauricio
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
| T024 | Véu de toque iOS nos botões (⚙ "com transparência") | chat-ui | 🟢 Baixa | ✅ v3.25.0 | [#t024](#t024) |
| T025 | Padronizar toast (sucesso verde / erro vermelho) | chat-ui | 🟡 Média | ✅ v3.25.0 | [#t025](#t025) |
| T026 | Botão ⚙ "transparente" — fill sólido + borda forte | chat-ui | 🟢 Baixa | ✅ v3.25.1 | [#t026](#t026) |
| T027 | Popover de ajustes "transparente" — tokens `:root` ausentes | chat-ui | 🟢 Baixa | ✅ v3.25.2 | [#t027](#t027) |
| T028 | Tela inicial passa a ser o Chat (não o Painel) | chat-ui | 🟢 Baixa | ✅ v3.26.0 | [#t028](#t028) |
| T029 | Chat como item principal do menu (primeiro da lista) | chat-ui | 🟢 Baixa | ✅ v3.26.1 | [#t029](#t029) |
| T030 | Rota reflete a tela — app na raiz + `#/tela`, fim do `/painel/` fixo | chat-ui + http | 🟡 Média | ✅ v3.27.0 | [#t030](#t030) |
| T031 | Acabamentos do chat: parar vermelho, rastro até a conclusão, caixa única da tela | chat-ui | 🟡 Média | ✅ v3.28.0 | [#t031](#t031) |
| T032 | Toast no canto superior direito, conforme o gabarito do arquiteto | chat-ui | 🟢 Baixa | ✅ v3.28.1 | [#t032](#t032) |
| T033 | Ordem do turno: tela gerada aparece ANTES da conclusão | chat-ui | 🟡 Média | ✅ v3.29.0 | [#t033](#t033) |
| T034 | Rolagem da caixa da tela: acompanha a escrita só se o usuário está no fim | chat-ui | 🟢 Baixa | ✅ v3.30.0 | [#t034](#t034) |
| T035 | Rolagem do CHAT durante a escrita da tela (a conversa acompanha a caixa) | chat-ui | 🟡 Média | ✅ v3.30.1 | [#t035](#t035) |
| T036 | A tela gerada é CONCLUSÃO: o rastro fecha quando o código começa | chat-ui | 🟢 Baixa | ✅ v3.30.2 | [#t036](#t036) |
| T037 | Piso com "nova conversa"; exportar no popover "ferramentas" | chat-ui | 🟢 Baixa | ✅ v3.31.1 | [#t037](#t037) |
| T038 | Respiro entre a tela gerada e a conclusão | chat-ui | 🟢 Baixa | ✅ v3.31.2 | [#t038](#t038) |
| T039 | Busca na web (`web_search`) e leitura de página (`web_open`) | ferramentas | 🟡 Média | ✅ v3.32.0 | [#t039](#t039) |
| T040 | Renderizar JavaScript no `web_open` (chromium/CDP, sem npm) | ferramentas | 🟡 Média | ✅ v3.33.0 | [#t040](#t040) |
| T041 | Rastro cronológico, narração obrigatória e instruções editáveis | chat-srv + chat-ui | 🟠 Alta | ✅ v3.34.0 | [#t041](#t041) |
| T042 | Ferramentas de máquina erram o SO do Windows (`win32 …` × `windows`) | maquinas-tools + cliente | 🔴 Crítica | ✅ v3.37.0 | [#t042](#t042) |
| T043 | Ferramentas de máquina: varredura das 20 (o que quebrou e o que ficou torto) | maquinas-tools | 🟠 Alta | ✅ v3.38.1 | [#t043](#t043) |
| T044 | `rodar_lote` recusa 3 comandos curtos: limite de 4000 medido no comando JÁ codificado | maquinas-tools | 🟠 Alta | ✅ v3.38.1 | [#t044](#t044) |

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

<a id="t024"></a>
### T024 — Véu de toque iOS nos botões (⚙ "com transparência")
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟢 Baixa — cosmético; medido ao vivo em 27/10 |
| **Status** | ✅ v3.25.0 (executado em 27/10, suíte 26/26 verde) |
| **Spec/Plano** | [docs/planos/002-rodada-pendencias-toque-toast.md](planos/002-rodada-pendencias-toque-toast.md) |
| **Descrição** | Relato do dono (27/10, print do iPhone): "quando clico no botão de ajuste de conversa o botão vem com uma transparência". Medido ao vivo: o botão é 100% opaco nos dois estados (fundo `#161c25` fechado / `#1c2330` aberto, `opacity: 1`, sem alpha em cor). A causa é o **véu de toque do iOS**: o CSS não define `-webkit-tap-highlight-color` e o Safari do iPhone pinta um véu cinza semitransparente sobre o elemento no toque (afeta todos os botões; o ⚙ é o mais visível por ser o primeiro tocado). Fator secundário: o ícone da engrenagem (`Chat.tsx:1098`) é contorno fino `strokeWidth="1.8"`, que lê como "fantasma" ao lado dos ícones cheios. |
| **Escopo** | Feito (27/10): (1) `-webkit-tap-highlight-color: transparent` global em `index.css`; (2) ícone ⚙ afirmado — `text-txt` no estado parado + `strokeWidth` 2. Validação: build verde + prova de tela (gear 48×48px, SVG no piso do chat). Faltou: confirmação no iPhone físico (emulador não pinta tap-highlight). |
| **Arquivos afetados** | frontend/src/index.css, frontend/src/components/Chat.tsx (botão ⚙ em 1089–1102) |
| **Dependências** | Nenhuma. |
| **Riscos** | (1) muda o feedback de toque de TODO o app no iOS — validar no aparelho físico (emulador não pinta tap-highlight); (2) ícone mais grosso pode desalinhar visualmente com os demais ícones — conferir menu aberto e fechado. |

<a id="t025"></a>
### T025 — Padronizar toast (sucesso verde / erro vermelho)
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟡 Média — o dono aponta em 27/10; padrão já existe na skill do arquiteto |
| **Status** | ✅ v3.25.0 (executado em 27/10; suíte 26/26 verde; **cores medidas ao vivo após corrigir o purge do Tailwind** — ver Escopo) |
| **Spec/Plano** | [docs/planos/002-rodada-pendencias-toque-toast.md](planos/002-rodada-pendencias-toque-toast.md) |
| **Descrição** | O toast do minirag é **cinza neutro para tudo** (medido: `Toast.tsx` tem só `toast(msg, ms?)`, sem tipo; `index.css` `.toast` tem cor única). Sucesso e erro se leem idênticos no relance. O padrão já existe e não é seguido: `arquiteto-sistema/references/notificacoes.md` (sucesso = verde + ícone; erro = vermelho + ícone; botão X; empilhamento). Medido 27/10: **104 call sites** em 11 componentes; `alert()` ausente ✓; `confirm()` só em ação destrutiva ✓ (regras que o app já cumpre). |
| **Escopo** | Feito (27/10): parâmetro `tipo` (`neutro`/`sucesso`/`erro`, default `neutro`); cores/ícones da paleta do app (verde `#3fb950` / vermelho `#f85149`); botão **X**; **empilhamento** vertical; classificação dos 104 call sites. **Bug de render encontrado na validação final (27/10):** as classes `.toast-sucesso`/`.toast-erro`/`.toast-neutro` **sumiam do CSS compilado** — o Tailwind v3 faz purge das regras de `@layer components` cujo nome não aparece como literal no scan de conteúdo, e o `Toast.tsx` montava o nome por interpolação (`toast-${tipo}`), então as 3 variantes ficavam **sem cor** (só o `.toast` base, que é literal, sobrevivía). Medido: build limpo do Tailwind emitia `.toast`/`.toast-pilha`/`.toast-x` mas não as 3 variantes; ao vivo, `getComputedStyle` do toast dava bg/borda transparentes. **Correção:** mapa `CLASSE_TIPO` com os 3 nomes como literal em `Toast.tsx` (o scan os encontra e o Tailwind emite as regras). **Validação final (medida ao vivo):** toast de sucesso bg `rgba(63,185,80,.12)` + borda `rgba(63,185,80,.35)` + ícone ✓; toast de erro bg `rgba(248,81,73,.12)` + borda `rgba(248,81,73,.35)` + ícone ✓. Posição mantida (flutua acima do pé — desvio documentado na v3.23.1, medido). |
| **Arquivos afetados** | frontend/src/components/Toast.tsx, frontend/src/index.css, 11 componentes (Gavetas, Painel, Editor, Jobs, Arquivos, Buscar, Maquinas, Config, Chat) |
| **Dependências** | Nenhuma. |
| **Riscos** | Muda o visual do feedback em TODO o app — validar com clique real (toast de sucesso e de erro) antes de publicar; call site sem tipo fica `neutro` (comportamento de hoje). |

<a id="t026"></a>
### T026 — Botão ⚙ "transparente" — fill sólido + borda forte
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟢 Baixa — cosmético; medido ao vivo em 27/10 |
| **Status** | ✅ v3.25.1 (executado em 27/10; build verde; regra medida no CSS compilado) |
| **Spec/Plano** | Segue a mesma rodada de toque/toast ([002](planos/002-rodada-pendencias-toque-toast.md)) |
| **Descrição** | Relato do dono (27/10, print do iPhone): "o botão de ajuste de conversa ainda está com o fundo com transparência". **Correção do diagnóstico de T024:** não era (só) o véu de toque — era o **fundo do botão em si**. O `.chat-ajustes-boto` usava fill `sup2` (`#161c25`), quase idêntico ao fundo da página (`bg` `#0b0e13`), + **borda fraca** (`borda` `#232b38`): o par fill-escuro-borda-fraca "desmorona" contra o fundo e lê como transparente/fantasma, enquanto os botões que seguram (`.btn`) usam borda forte (`bordaforte` `#313b4b`) + fill presente. Medido no CSS: `sup2`/`borda` sem alpha (opacos), mas o baixo contraste relativo é o problema. |
| **Escopo** | Feito (27/10): `.chat-ajustes-boto` com **fill sólido claro** `#2a3344` (visível contra o fundo) + **borda forte** `bordaforte`; hover `#333d51`/`#43506a`; estado aberto ganha borda azul (`azul/60`) + mesmo fill. Só o botão ⚙ mudou (mic/enviar já têm peso próprio). Validação: build verde + regra medida no CSS compilado (`bg rgb(42 51 68)` + `border rgb(49 59 75)`). |
| **Arquivos afetados** | frontend/src/index.css (`.chat-ajustes-boto`) |
| **Dependências** | Nenhuma. |
| **Riscos** | Cosmético; confirmar no iPhone físico que o ⚙ agora lê sólido (emulador serve o CSS mas não o toque). |

---

<a id="t027"></a>
### T027 — Popover de ajustes "transparente" — tokens `:root` ausentes
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟢 Baixa — cosmético; medido ao vivo em 27/10 |
| **Status** | ✅ v3.25.2 (executado em 27/10; build verde; varredura: nenhuma `var(--x)` usada sem definição) |
| **Spec/Plano** | Correção do **alvo** de T026: o elemento transparente era o **popover** (`.chat-ajustes-pop`), não o botão ⚙ |
| **Descrição** | Relato do dono (27/10, print com o inspector do DevTools em `div.chat-ajustes-pop`): o **painel** de ajustes (exportar/nova) é que "afundava" transparente, não o botão. **Causa raiz real:** o popover (e a seta `::after` e o filete `.chat-ajustes-botoes`) usam `background: var(--sup)` / `border: var(--bordaforte)` / `border-top: var(--borda)`, mas **ninguma** dessas variáveis estava definida no `:root` (só `--verde-suave`/`--azul-suave`/`--vermelho-suave`). `var()` indefinida → `background-color`/`border-color` caem no valor inicial = **transparente**. O `:root` também faltava `--txt`/`--txt2`/`--txt3`/`--verde` (usados em textos e 2 fundos). |
| **Escopo** | Feito (27/10): `:root` completado com a paleta exata do `tailwind.config.js` — `--sup #11151c`, `--borda #232b38`, `--bordaforte #313b4b`, `--txt #e7edf6`, `--txt2 #a8b3c3`, `--txt3 #7d8899`, `--verde #3fb950`, `--vermelho #f85149`. Isso cura o popover (fundo `#11151c` + borda `#313b4b`), a seta, o filete e os textos/fundos de status de uma vez, sem tocar nas regras individuais. Validação: build verde + varredura do CSS compilado → **nenhuma** `var(--x)` usada sem definição no `:root`. |
| **Arquivos afetados** | frontend/src/index.css (`:root`) |
| **Dependências** | Nenhuma. |
| **Riscos** | Cosmético; confirmar no iPhone físico que o popover agora lê sólido. |

---

<a id="t028"></a>
### T028 — Tela inicial passa a ser o Chat (não o Painel)
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟢 Baixa — mudança de comportamento pedida pelo dono em 27/10 |
| **Status** | ✅ v3.26.0 (executado em 27/10; build verde) |
| **Spec/Plano** | Pedido direto do dono: "hoje o minirag inicia com a tela de painel mas quero que passe a iniciar com a tela de chat" |
| **Descrição** | O app abria com `vista = "painel"` como estado inicial e, depois do login, mandava o **operador** pro Painel e o comum pro Chat (`setVista(operador ? "painel" : "chat")`). Resultado: quem é operador sempre aterrissava na visão geral do acervo, tendo que clicar em Chat pra conversar. |
| **Escopo** | Feito (27/10): estado inicial `useState<Vista>("chat")` e pós-login `setVista("chat")` para **todo mundo** (operador incluso). O Painel continua no menu lateral como tela normal — só deixou de ser a porta de entrada. Sem mudança de rota/URL (a navegação é estado React, não hash). |
| **Arquivos afetados** | frontend/src/App.tsx (estado inicial + efeito pós-login) |
| **Dependências** | Nenhuma. |
| **Riscos** | Cosmético/comportamental; operador pode estranhar perder o Painel como home, mas o menu resolve em 1 clique. |

---

<a id="t029"></a>
### T029 — Chat como item principal do menu (primeiro da lista)
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟢 Baixa — pedido direto do dono (27/10) |
| **Status** | ✅ v3.26.1 (executado em 27/10; build verde; clique real conferido no browser) |
| **Spec/Plano** | Pedido do dono junto do T028: "no menu o chat — deixe ele no principal" |
| **Descrição** | O menu lateral abria com **Painel** em primeiro (herança da v3.2.2, quando o Painel era a home). Com o Chat virando a porta de entrada (T028), o item principal do menu tinha de ser o Chat. |
| **Escopo** | Feito (27/10): `MENU` reordenado — `chat` passa a ser o primeiro item (ícone 💬), `painel` logo abaixo. Resto da ordem intacta (Máquinas, Buscar, Fila, Gavetas, Configurações). |
| **Arquivos afetados** | frontend/src/App.tsx (`MENU`) |
| **Dependências** | T028 (mesma rodada). |
| **Riscos** | Nenhum; só ordem visual. |

---

<a id="t030"></a>
### T030 — Rota reflete a tela (app na raiz + `#/tela`)
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui + http |
| **Prioridade** | 🟡 Média — o endereço mentia sobre a tela (relato do dono, print de 27/10) |
| **Status** | ✅ v3.27.0 (executado em 27/10; tsc verde, build verde, rotas conferidas ao vivo no browser) |
| **Spec/Plano** | Relato do dono: "olha aí o problema na rota" — print com `/painel/` na barra de endereço e o **Chat** na tela |
| **Descrição** | O app só era servido em `/painel/` (e `/` fazia 302 pra lá). Como a navegação é estado React, o endereço ficava `/painel/` **em qualquer tela** — abrir no Chat mostrava `/painel/`. A URL não dizia onde o usuário estava e o F5 sempre caía na tela inicial. |
| **Escopo** | Feito (27/10): (a) **servidor** — `GET /` serve a SPA direto (sem 302) e `/painel/` + `/painel` viram atalho 302 → `/#/painel`; assets seguem em `/painel/assets/` (base fixa do vite, funciona de qualquer path). (b) **front** — a tela mora no hash (`#/chat`, `#/painel`, `#/buscar`, `#/jobs`, `#/gavetas`, `#/config`, `#/maquinas`): lida no boot, `replaceState` a cada navegação (sem encher o histórico) e `hashchange` pra link direto/voltar. Sem hash, cai no Chat (T028). Tela do endereço só vale se o papel do usuário permitir (comum não entra em tela de admin). (c) **teste** — e2e checa `GET /` 200 com HTML da SPA e `/painel/` 302 → `/#/painel` (antes checava a raiz 302 → `/painel/`). |
| **Arquivos afetados** | src/app.ts (raiz + atalho `/painel/`), frontend/src/App.tsx (hash router), tests/e2e.test.ts |
| **Dependências** | T028 (Chat como tela inicial). |
| **Riscos** | Links antigos `/painel/` continuam válidos (302 → `/#/painel`); `#/tela` é fragmento, não chega ao servidor — nenhuma rota de API conflita. |

---

---

<a id="t031"></a>
### T031 — Acabamentos do chat: parar vermelho, rastro até a conclusão, caixa única da tela
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟡 Média — três correções pedidas pelo dono em 27/10 |
| **Status** | ✅ v3.28.0 (executado em 27/10; build verde; conferido no browser com turno simulado) |
| **Spec/Plano** | Pedido do dono: (1) enviar verde / parar vermelho; (2) "o rastro fica sempre aberto até que comece a conclusão"; (3) "não precisa gerar muitos frames pra isso, basta uma caixa que vai escrever nela" |
| **Descrição** | (1) O JSX já aplicava `chat-enviar-parando`, mas **não existia regra no CSS** — o botão ficava verde no estado parar. (2) `rastroAberto` respeitava a preferência do usuário **até durante o processamento**: quem tinha recolhido uma vez nunca via o rastro aberto enquanto pensava. (3) A tela gerada saía em DOIS blocos (`CodigoAoVivo` + `TelaGerada`), além do rastro — e o card do preview não tinha "ver código". |
| **Escopo** | Feito (27/10): (1) `.chat-enviar.chat-enviar-parando` com fundo vermelho + hover, mantendo o ícone claro; (2) rastro **sempre aberto enquanto processa e ainda não há texto** (`vivo && !texto`), com o cabeçalho travado nessa fase e a preferência valendo a partir da conclusão — vale para todas as mensagens; (3) `TelaGerada` virou UMA caixa: enquanto o HTML chega (evento `codigo`) ela mostra o código nascendo com cursor e contador de linhas; ao receber o evento `tela`, a MESMA caixa vira o iframe renderizado, sem bloco extra, com ações **ver código**, **baixar .html** e **expandir**. `CodigoAoVivo` foi removido (absorvido). |
| **Arquivos afetados** | frontend/src/index.css, frontend/src/components/Chat.tsx, frontend/src/components/TelaGerada.tsx (CodigoAoVivo.tsx removido) |
| **Dependências** | T028/T030 (mesma rodada de ajustes de entrada do chat). |
| **Riscos** | Cosmético; o estado "código incompleto" (turno abortado) mostra a caixa em modo código, sem ações de download. |

---

<a id="t032"></a>
### T032 — Toast no canto superior direito, conforme o gabarito do arquiteto
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui (transversal: todas as telas usam o mesmo `ToastProvider`) |
| **Prioridade** | 🟢 Baixa — incômodo do dono com o aviso caindo sobre a conversa |
| **Status** | ✅ v3.28.1 (build verde; posição/z-index medidos no browser) |
| **Spec/Plano** | `arquiteto-sistema/references/notificacoes.md`: toast no canto superior direito (`fixed top-4 right-4`), acima de modais (`z-[100]`), auto-hide ~5s, sucesso verde + ícone, erro vermelho + ícone, X fecha, empilhamento vertical. |
| **Descrição** | O minirag divergia do gabarito: `.toast-pilha` ficava em `bottom:160px`, centralizado (`left-1/2 -translate-x-1/2`), `z-[60]`, 3,5s — o aviso caía em cima da conversa e do campo de digitação. |
| **Escopo** | Feito: `.toast-pilha` passou a `fixed right-4 top-[1rem+safe-area]`, `z-[100]`, itens alinhados à direita, largura máx. 420px; auto-hide padrão 5s (`Toast.tsx`). Cores, ícones, X e empilhamento (máx. 3) mantidos. |
| **Arquivos afetados** | frontend/src/index.css, frontend/src/components/Toast.tsx |
| **Dependências** | T025 (variantes de toast) e T026/T027 (popover de ajustes, que ocupa o topo direito quando aberto — toast fica acima por ser z-100). |
| **Riscos** | Em tela pequena o toast cobre o topo da conversa por 5s; é o preço do padrão (não bloqueia clique). |

---

<a id="t033"></a>
### T033 — Ordem do turno: a tela gerada aparece ANTES da conclusão
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟡 Média — o dono viu a conclusão acima do gráfico que a originou |
| **Status** | ✅ v3.29.0 (build verde; ordem medida no DOM e na tela) |
| **Spec/Plano** | Relato do dono (27/10): "o gráfico foi gerado antes mas a conclusão foi colocada antes dele, a ordem está incorreta". |
| **Descrição** | O servidor emite `tela` na execução da ferramenta e o texto da rodada final DEPOIS (`src/provider.ts`: `emitir({tipo:"tela"})` antes do próximo round). O JSX do chat renderizava `texto` e só então `tela-area` — o card caía abaixo de uma conclusão que veio depois dele. |
| **Escopo** | O bloco `tela-area` subiu para antes do texto da mensagem (ordem real do turno: rastro → tela → conclusão). O aviso "pensando…" deixou de aparecer quando já existe caixa de tela. Nada mudou no servidor nem no formato gravado. |
| **Arquivos afetados** | frontend/src/components/Chat.tsx |
| **Dependências** | T031 (caixa única da tela). |
| **Riscos** | Turno com mais de uma tela: todas ficam acima do texto final (é a ordem em que o servidor as produziu). |

---

<a id="t034"></a>
### T034 — Rolagem da caixa da tela: acompanha a escrita só se o usuário está no fim
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟢 Baixa — incomôdo do dono ao tentar reler o código durante a escrita |
| **Status** | ✅ v3.30.0 (build verde; comportamento medido com escrita simulada) |
| **Spec/Plano** | Pedido do dono (27/10): "quando vai digitando ele deveria ir rolando, a não ser que o usuário scrolle para cima, o que cria o botão de ir até embaixo". |
| **Descrição** | O efeito de acompanhamento fazia `scrollTop = scrollHeight` a CADA pedaço de HTML, sem consultar a posição do usuário — quem subia para reler era puxado de volta ao fim no pedaço seguinte, e não havia botão de voltar. |
| **Escopo** | Feito: estado `colado` (folga < 24px do fim) atualizado no `onScroll` do `<pre>`; o efeito só desce quando `colado`. Botão **↓ fim** (`.tela-fim`, canto inferior direito da caixa) aparece quando o usuário sobe e volta a colar ao ser clicado. Mesmo padrão do chat (`colado`/`irParaOFim`/botão "↓ fim"). Ao ficar pronta, a caixa volta a `colado = true`. |
| **Arquivos afetados** | frontend/src/components/TelaGerada.tsx, frontend/src/index.css |
| **Dependências** | T031 (caixa única da tela). |
| **Riscos** | Nenhum de dados; só apresentação. |

---

<a id="t035"></a>
### T035 — Rolagem do CHAT durante a escrita da tela
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟡 Média — a caixa crescia para fora da tela e a conversa ficava parada |
| **Status** | ✅ v3.30.1 (build verde; medido no browser com escrita contínua) |
| **Spec/Plano** | Dono (27/10): "quando vai digitando deveria ir rolando, a não ser que o usuário scrolle para cima, o que cria o botão de ir até embaixo". |
| **Descrição** | A chave que dispara o auto-scroll do chat (`rastro`) somava só `msgs.length`, `texto.length` e `raciocinio.length`. O evento `codigo` (HTML nascendo) não entrava — a caixa crescia e a conversa NÃO descia; a escrita saía por baixo da tela. O T034 resolveu a rolagem INTERNA da caixa; faltava esta, a da conversa. |
| **Escopo** | `rastro` passou a incluir `codigo.length` e `telas.length` da última mensagem. Com isso `irParaOFim()` roda a cada pedaço de HTML e, se o usuário subir, `colado=false` → para de puxar e o botão "↓ fim" do chat aparece (comportamento que já existia). |
| **Arquivos afetados** | frontend/src/components/Chat.tsx |
| **Dependências** | T031/T034 (caixa da tela e rolagem interna). |
| **Riscos** | Nenhum de dados; se o usuário estiver lendo mais acima, nada é puxado. |

---

<a id="t036"></a>
### T036 — A tela gerada é CONCLUSÃO: o rastro fecha quando o código começa
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟢 Baixa — confusão visual: a caixa parecia mais um passo do rastro |
| **Status** | ✅ v3.30.2 (build verde; medido no browser com escrita contínua) |
| **Spec/Plano** | Dono (27/10): "quando está digitando parece que a tela montagem do html faz parte do rastro mas não faz, acho que ela faz parte da conclusão ou não?" — decisão: é conclusão. |
| **Descrição** | `emProcesso` considerava só `vivo && !texto`: o rastro ficava aberto durante toda a escrita do HTML e a linha do tempo do rastro encostava na caixa, que parecia o próximo passo. |
| **Escopo** | `produzindo(m)` (código da tela já começou ou tela pronta) entra na regra: com produto na tela, o rastro deixa de ser "em processo" e passa a seguir a preferência do usuário (recolhe por padrão). Vale também para o `<details>` de pensamento quando não há trilha. |
| **Arquivos afetados** | frontend/src/components/Chat.tsx |
| **Dependências** | T028/T031/T033 (rastro até a conclusão e caixa única). |
| **Riscos** | Se o modelo gerar tela e continuar pensando depois, o rastro já estará recolhido — um clique reabre. |

---

<a id="t037"></a>
### T037 — Piso com "nova conversa"; exportar dentro do popover "ferramentas"
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟢 Baixa — o dono não gostou de "exportar" ao lado de "nova" no popover |
| **Status** | ✅ v3.31.1 (build verde; medido no browser) |
| **Spec/Plano** | Dono (27/10): "apenas um botão de nova conversa aqui e colocar esse de exportação em outro lugar" → depois: "era pra você ter colocado o botão de nova conversa no lugar de exportar e o exportar coloca dentro desse popover chamado de ferramentas". |
| **Descrição** | O popover tinha exportar + nova (misturava ajuste com ação do dia a dia). Na primeira tentativa o exportar foi para o piso; o dono corrigiu a posição: o piso é da **nova conversa** e o exportar pertence ao popover, agora chamado **ferramentas**. |
| **Escopo** | Estado final: piso `[⚙] [＋ nova conversa] [campo] [mic] [↑]` com `.chat-nova` (no celular vira quadrado de 44px, rótulo escondido por `.chat-nova-rotulo`); popover renomeado para **⚙ ferramentas** (title/aria/cabeçalho) guardando provider/modelo e o botão **⤓ exportar**. Ids preservados (`chatExportar`, `chatNovaConversa`). "nova conversa" continua pedindo confirmação (é destrutiva). |
| **Arquivos afetados** | frontend/src/components/Chat.tsx |
| **Dependências** | T017 (exportar markdown), T022 (popover). |
| **Riscos** | Dois botões de 48px antes do campo; medido no celular, o campo mantém folga (o rótulo da nova conversa some e sobra o ＋). |

---

<a id="t038"></a>
### T038 — Respiro entre a tela gerada e a conclusão
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-ui |
| **Prioridade** | 🟢 Baixa — ajuste fino de leitura |
| **Status** | ✅ v3.31.2 (build verde; medido no browser) |
| **Spec/Plano** | Dono (27/10): "a conclusão está muito coladinha, acho que pode ter um pequeno espaço". |
| **Descrição** | O card da tela encostava no parágrafo da conclusão: a única folga era o `margin-top` de 8px do `.md p`, e a margem do `.md` colapsava com a do card. |
| **Escopo** | `.tela-area` ganhou `margin-bottom: 12px` (`mb-3`); a folga visível entre o card e a conclusão passou a ser de 12px (as margens colapsam para a maior). Nada mudou no topo do card (`mt-2`). |
| **Arquivos afetados** | frontend/src/index.css |
| **Dependências** | T031/T033 (caixa única e ordem da tela). |
| **Riscos** | Nenhum; só espaçamento. |

---

<a id="t039"></a>
### T039 — Busca na web (`web_search`) e leitura de página (`web_open`)
| Campo | Conteúdo |
|---|---|
| **Módulo** | ferramentas (MCP) |
| **Prioridade** | 🟡 Média — o chat só sabia a memória; faltava o mundo lá fora |
| **Status** | ✅ v3.32.0 (build verde; medido no browser) |
| **Spec/Plano** | Dono (27/10): "preciso de uma ferramenta estilo a daqui do Hermes que consiga fazer busca na web". |
| **Descrição** | Duas ferramentas novas no MCP interno, disponíveis ao chat sem configuração: `web_search` (título, link e trecho dos resultados) e `web_open` (texto limpo de uma página, até 12k chars). Sem chave de API. |
| **Escopo** | `src/web.ts`: busca com cadeia de fontes — Brave (HTML público) → Bing News RSS → Google News RSS, e o resultado diz de onde veio; `site:` para restringir domínio; `k` de 1 a 10. `web_open` bloqueia endereço interno (localhost, 10/8, 172.16/12, 192.168/16, 169.254, ::1, fc00, fe80) antes e depois do DNS — leitura de arquivo binário é recusada com erro honesto. Rótulos no rastro: "a busca na web" / "a leitura da página". |
| **Arquivos afetados** | src/web.ts (novo), src/mcp.ts (2 tools + dispatch + instructions), frontend/src/components/Chat.tsx (rótulos), Dockerfile (curl no estágio final) |
| **Dependências** | T001 (MCP interno). |
| **Riscos** | **429**: o Brave aceita curl e recusa o TLS do Node (fetch, node:https e http/2 levaram 429 com o mesmo user-agent) — por isso a imagem final instala curl e o `baixar()` usa curl, com fetch só de reserva. Sem curl o Brave falha e sobram os RSS de notícia. **Sem JS**: página que monta o conteúdo por JavaScript vem vazia em `web_open` — nesse caso diga que não deu, não invente. **Limite de uso**: raspagem de buscador público não tem contrato; se um dia bloquear de vez, trocar por chave (Brave/Tavily) é trocar o primeiro elo da cadeia. |

---

<a id="t040"></a>
### T040 — Renderizar JavaScript no `web_open` (chromium headless via CDP)
| Campo | Conteúdo |
|---|---|
| **Módulo** | ferramentas (MCP) |
| **Prioridade** | 🟡 Média — site que monta conteúdo por JS vinha oco |
| **Status** | ✅ v3.33.1 (build verde; medido no container) |
| **Spec/Plano** | Dono (27/10): "acho que o 2 seria melhor porque não depende de externos. Dá pra testar pra ver se funciona bem?" — opção 2 = chromium no próprio container. |
| **Descrição** | O `web_open` tenta o curl; se o texto vier com menos de 400 chars (ou se vier `js:true`), abre a mesma URL no chromium headless e fica com o texto maior. O navegador é único, reaproveitado entre chamadas e desligado quando para. |
| **Escopo** | `src/navegador.ts`: CDP na mão sobre o WebSocket nativo do Node (nenhum pacote npm), fila de uma página por vez, teto de 20s por página (devolve o que já carregou), reinício ao passar de 40 páginas ou 800 MB de RSS, desligamento após 3 min ocioso, perfil em /tmp. SSRF: host interno barrado na URL **e** em cada requisição da página (sub-recurso e redirecionamento) via `Fetch.requestPaused`. `MINIRAG_NAVEGADOR=0` desliga sem rebuild; `MINIRAG_CHROMIUM` troca o binário. |
| **Arquivos afetados** | src/navegador.ts (novo), src/web.ts (fallback), src/mcp.ts (param `js`), Dockerfile (chromium + fonts-liberation) |
| **Dependências** | T039 (web_search/web_open). |
| **Riscos** | **Bloqueio de IP**: portal grande (investing, UOL) devolve 403/"Access Denied" para IP de datacenter no curl **e** no chromium, por mais tempo que se espere — o `web_open` tenta o navegador e, se nem ele passar, responde erro honesto em vez de devolver 3 caracteres. **Peso**: +381 MB de imagem e ~270 MB de RSS parado, 350-620 MB navegando. **Tempo**: 3-4s por página comum; portal cheio de anúncio estoura o teto e volta com o que carregou (medido: g1, 15,6s). **Estabilidade**: `--single-process` é mais leve, mas uma página que trava derruba o navegador — o cliente reinicia na chamada seguinte. **Sem interação**: não clica nem rola; site que exige clique continua fora do alcance. |

<a id="t041"></a>
### T041 — Rastro na ordem cronológica, narração obrigatória e instruções editáveis
| Campo | Conteúdo |
|---|---|
| **Módulo** | chat-srv + chat-ui |
| **Prioridade** | 🟠 Alta — o dono comparou com o IA_GO em 27/10: "no nosso não tem no rastro a narração igual no rastro do IAGO" e "quero que fique na ordem cronológica" |
| **Status** | ✅ v3.34.0 · v3.34.1 grava a duração do turno no custo da mensagem (o cabeçalho mantém o tempo real ao reabrir a conversa) |
| **Spec/Plano** | Pedido do dono (27/10), confirmado item a item antes de começar: "Pode fazer e publicar quando acabar". |
| **Descrição** | (1) Cada linha do rastro leva `em` = ms desde o início do turno; a tela ordena por ele (nunca pela ordem de chegada), então pensamento → narração → ferramenta nunca invertem. (2) A ferramenta ganha linha VIVA: o servidor avisa `ferramenta_inicio` antes de executar e a tela mostra "Consultando X… Ns" enquanto ela roda. (3) O cabeçalho passa a mostrar o tempo do TURNO (medido pelo servidor), não a soma dos trechos. (4) O aviso solto vira "Preparando…" e só existe antes do primeiro sinal; com rastro na tela não aparece nada solto. (5) Cabeçalho com 40px de toque no celular (medido 29px a 390px na v3.33). (6) As instruções da casa (raciocínio em português + narração obrigatória de até 12 palavras antes de cada ferramenta, no FIM do prompt) passam a viver no campo editável de Configurações, com botão "restaurar instruções padrão" — o servidor não acrescenta nada por trás. |
| **Escopo** | `src/provider.ts` (tipo `SegmentoRastro` com `em`, evento `ferramenta_inicio`, seed das instruções), `src/provedores.ts` (editar sem reenviar o prompt não zera mais), `src/regras.ts` (novo: texto padrão), `frontend/src/lib/conversa.ts` (linha viva + ordenação por `em` + `ms` do turno), `frontend/src/components/Chat.tsx` (trilha ordenada, linha viva, "Preparando…", tempo do turno), `frontend/src/index.css` (40px no celular), `frontend/src/components/Config.tsx` (contagem + restaurar padrão), `frontend/src/types.ts`. |
| **Dependências** | T184 do IA_GO (fonte do bloco de instrução final). |
| **Riscos** | **Idioma**: a regra de raciocínio em português é instrução de prompt, não garantia — modelo pequeno pode escorregar; a medição é o rastro. **Narração**: regra obrigatória reduz, mas o modelo pode narrar em toda rodada (ruído) ou esquecer; se virar ruído, encurtar o exemplo. **Prompt editável**: quem apagar o campo perde narração e idioma — o botão de restaurar existe para isso. |

<a id="t042"></a>
### T042 — Ferramentas de máquina erram o SO do Windows (`win32 …` × `windows`)
| Campo | Conteúdo |
|---|---|
| **Módulo** | maquinas-tools + cliente |
| **Prioridade** | 🔴 Crítica — nenhuma das 20 ferramentas de máquina funciona num PC Windows |
| **Status** | ✅ v3.37.0 — `plataforma()` normaliza o SO num ponto só; bloco `v3.37` prova com PC falso anunciando `win32 10.0.19045` |
| **Descrição** | O cliente anuncia o sistema como `process.platform + " " + os.release()` (`agente/cliente.js:561`), ou seja **`win32 10.0.26200`**. O servidor decide o ramo comparando `ctx.so === "windows"` em ~20 pontos (`src/maquinas_tools.ts`), e `soDaMaquina()` devolve a string viva **sem normalizar** — logo a comparação nunca é verdadeira e toda ferramenta de máquina em Windows cai no ramo Unix. Medido pelos dois lados: `janelas` → 422 "janelas so em Windows (host JPPCINFODEV01 e win32 10.0.26200)"; `rede info` → "'ifconfig' não é reconhecido"; `estado_maquina` e `processos` → 502 "exit=255: O sistema não pode encontrar o caminho especificado"; `listar_arquivos` em `C:\`, `C:/`, `C:/Users` e `C:\Windows` → `{"ok":true,"total":0,"itens":[]}` (sempre vazio, sem erro). As máquinas estavam online (`maquinas_online`: DESKTOP-0NTAOUP e JPPCINFODEV01), então não é conexão: é o ramo de plataforma. |
| **Escopo** | Normalizar num lugar só: `plataforma(so)` em `src/maquinas_tools.ts` (ou em `maquinas.ts`) mapeando `/^win/` → `windows`, `/^linux/` → `linux`, `/^darwin/` → `macos`, aplicada onde o `ctx.so` é montado (~linha 855) — o valor cru de `maquinas.so` continua como está para exibição. Teste: bloco com hub falso anunciando `win32 10.0.19045` provando que `janelas`, `rede info` e `processos` pegam o ramo PowerShell (e que `linux` continua pegando o ramo shell). |
| **Riscos** | Baixo para o código; **médio para o parque**: clientes antigos podem anunciar outras formas (`Windows`, `win32`), então o normalizador tem de ser tolerante (prefixo, caixa). Enquanto não subir, qualquer automação que dependa de ferramenta de máquina em Windows falha calada (`listar_arquivos` devolve vazio **com ok:true**). |

<a id="t043"></a>
### T043 — Ferramentas de máquina: varredura das 20 (o que quebrou e o que ficou torto)
| Campo | Conteúdo |
|---|---|
| **Módulo** | maquinas-tools |
| **Prioridade** | 🟠 Alta — 15 de 20 respondem; 5 têm defeito (2 quebrados, 3 tortos) |
| **Status** | ✅ Corrigido na v3.38.1 (28/10) — os 5 achados, provados ao vivo: caminho sem `\r` nas duas máquinas, `rede info` filtrando por Tailscale, `git_remoto` em C:/IA devolvendo 422 limpo, clipboard do DESKTOP lendo e o do JPPC recusando com 422 explicativo (RustDesk), queda do cliente devolvendo 503 |
| **Contexto** | Varredura pedida pelo dono depois do T042: todas as ferramentas de máquina chamadas de verdade pelas duas máquinas. Resultado: `listar_arquivos`, `ler_arquivo`, `buscar_arquivos`, `grep_remoto`, `processos`, `janelas`, `servicos`, `eventos`, `rede info/dns/portas/ping`, `estado_maquina`, `rodar_lote`, `sessao abrir/listar/fechar` e `git_remoto` (quando o repo existe) **funcionam**. |
| **Achados** | **1) `area_transferencia` quebrado no JPPCINFODEV01** — 502 "clipboard bloqueado por sessao remota (RustDesk/AnyDesk costumam travar)". No DESKTOP funcionou (veio vazio). Correção: ler por `Get-Clipboard -Raw` com fallback Win32/`[System.Windows.Forms.Clipboard]`, e mensagem clara em vez de 502 com stack do PowerShell. **2) `git_remoto` em pasta que não é repo** — 502 com o CLIXML cru do git ("fatal: not a git repository") e o `&amp;` escapado do XML vazando na mensagem. Correção: detectar `.git` antes e devolver 422 curto ("C:/IA não é repositório"), sem CLIXML. **3) `rede info` ignora o campo `alvo`** — passei `minirag.techupsistemas.com` e ele devolveu a mesma lista de IPs de com `alvo` vazio; ou o alvo deveria filtrar a interface, ou o campo não deveria existir nessa ação (ficou confuso). **4) `listar_arquivos`/`buscar_arquivos` devolvem caminho com `\r` no fim** (`C:\Windows\r`) — sujeira do `ConvertTo-Json`/`Out-String` no ramo Windows; quebra quem for abrir o arquivo com o valor recebido. **5) `estado_maquina` no DESKTOP falhou 1x com "máquina caiu no meio do comando" (exit=-1)** e passou na tentativa seguinte — coincide com a troca do `.exe` do cliente (21:34); investigar timeout do `run` quando o cliente reconecta (a chamada é descartada, mas a mensagem confunde: parece defeito da máquina, não reconexão). |
| **Escopo** | `src/maquinas_tools.ts` (clipboard, mensagem de erro do git, filtro do `alvo` em `rede info`, `TrimEnd`/`-NoNewline` nos nomes de arquivo) e `src/maquinas.ts` (código de retorno quando o cliente cai no meio: erro 503 "reconectando" em vez de 502 exit=-1). Teste: bloco com hub falso no Windows cobrindo clipboard (sucesso e recusa), git fora de repo (422) e caminho sem `\r`. |
| **Riscos** | Baixo. O clipboard depende de sessão interativa: em sessão RDP/RustDesk pode continuar falhando mesmo com o fallback — o teste tem de aceitar "bloqueado" como resposta legítima e não como verde forçado. |

<a id="t044"></a>
### T044 — `rodar_lote` recusa 3 comandos curtos: o limite de 4000 é medido no comando JÁ codificado
| Campo | Conteúdo |
|---|---|
| **Módulo** | maquinas-tools |
| **Prioridade** | 🟠 Alta — bloqueia lotes pequenos e o erro não diz o motivo nem o teto |
| **Status** | ✅ Corrigido na v3.38.1 (28/10) — provado ao vivo: lote de 3 comandos PowerShell rodou no DESKTOP (antes dava 422); envelope em 60.000 e texto do usuário em 4.000 com o número na mensagem |
| **Sintoma** | `rodar_lote` com **3** comandos PowerShell de ~120 chars cada devolve `422 cmd longo demais`. O dono escreveu **367 caracteres**; o limite documentado é 4000. O mesmo lote com **2** comandos passa. |
| **Causa medida** | `maquinas.ts:242` compara `cmd.length > 4000`, mas o `cmd` ali é o script inteiro **já passado por `psOut` → `psEncoded`**: PowerShell `-EncodedCommand` em base64 UTF-16LE. Cada comando vira ~300 chars e o envelope base64 infla 2,67× de novo no script todo. Reprodução exata da montagem: 1 comando = **1838**, 2 = **2870**, 3 = **4038** chars — reprova por 38. Ou seja, o teto real é ~1.500 chars de texto do usuário, não 4000. |
| **Correção** | (a) medir o limite sobre o texto **antes** da codificação (somar `comandos` + prefixo), deixando o teto de 4000 significando o que aparenta; e/ou (b) subir o teto do caminho MCP para 60000 (o mesmo das origens `tool `), já que o envelope é nosso e não do usuário. (c) mensagem explícita: `lote grande demais: N chars codificados (teto 4000)`. Teste: bloco com 3 comandos PowerShell curtos tem de passar. |
| **Riscos** | Baixo. Subir o teto aumenta o payload do WebSocket até o cliente; 60k já é aceito em outras origens, então é o mesmo caminho já exercitado. |

<a id="t045"></a>
### T045 — Túnel: resposta acima de ~39 KB nunca voltava (o cliente matava a árvore e não resolvia a Promise)
| Campo | Conteúdo |
|---|---|
| **Módulo** | maquinas / cliente |
| **Prioridade** | 🔴 Crítica — `ler_arquivo` binário (padrão 200 KB) falhava SEMPRE; o agente lia como máquina muda e repetia a chamada |
| **Status** | ✅ Corrigido na v3.43.0 (29/10) — provado ao vivo em produção nas duas máquinas |
| **Sintoma** | `ler_arquivo` de print/foto não volta; `rodar_comando` com saída de 40.000 chars morre em 38 s com `exit=-124`; 38.000 volta em 0,7 s. A mensagem manda "aumente timeout", campo que o `ler_arquivo` não tem. Foi o que travou a conversa do dono com o print de 1,08 MB. |
| **Causa medida** | `agente/cliente.js`, handler de `stdout`: `if (stdout.length > 40000) matarArvore()`. `matarArvore()` marca `morto = true` e o handler de `close` faz `if (morto) return;` — a Promise do comando NUNCA resolve. O servidor só vê silêncio até `espera+8`. Nada a ver com WebSocket (`maxPayload` é o default de 100 MiB) nem com PowerShell. |
| **Correção** | Cliente trunca a coleta em 8 MB (`truncado: true`) em vez de matar; `RespostaMaquina.truncado` propagado em `src/maquinas.ts`; `ler_arquivo` com `-124` vira **504** explicando `limite`/`offset`; `comandos_log.exit` virou **BIGINT** (0x8004100C estourava a auditoria); `git_remoto` sem git instalado virou **422**; `ok` do rastro passou a considerar `exit != 0`. Bloco `v3.43` da suíte sobe o **binário real** e lê 200 KB / padrão / 800 KB. |
| **Riscos** | Baixo. 8 MB de coleta por comando no cliente; resposta maior continua sendo caminho de LAN/download, não de túnel. |

### T046 — Caminho de volta: print de tela e arquivo da máquina na conversa
| Campo | Conteúdo |
|---|---|
| **Módulo** | maquinas / anexos / chat (front) |
| **Prioridade** | 🟠 Alta — era a metade que faltava do agente remoto: ele via a máquina, mas não conseguia MOSTRAR nada nem trazer arquivo |
| **Status** | ✅ Entregue na v3.44.0 (29/10) — 10 checks no bloco `v3.44` com o cliente real |
| **Antes** | Túnel só ia servidor → máquina. Chat desenhava imagem apenas na bolha do usuário; print/arquivo não tinha como chegar ao dono, e `ler_arquivo` devolvia base64 ao MODELO (gastando a janela). |
| **Como ficou** | `capturar_tela` (Windows 1..4; Linux com sessão gráfica), `baixar_arquivo` (máquina → conversa, 32 MB) e `copiar_arquivo` (máquina → servidor → outra máquina, 16 MB). Caminho: POST binário em `/maquina/r` com chave one-time presa ao host → linha em `anexos` → `GET /anexos/:id` com a chave do usuário; o front desenha miniatura + baixar. O modelo recebe só a meta (`id`, `nome`, `mime`, `bytes`). |
| **Prova** | Bloco `v3.44` da suíte: 300 KB aleatórios por `baixar_arquivo`, sha256 do `GET /anexos/:id` igual ao da máquina, 401 sem chave, cópia máquina→máquina com sha256 idêntico, e `capturar_tela` sem X devolvendo erro claro. |
| **Limite honesto** | GB continua na LAN entre as máquinas; túnel de WebSocket não é canal para isso. |

### T048 — Arquivo grande nos DOIS sentidos: navegador → servidor → máquina
| Campo | Conteúdo |
|---|---|
| **Módulo** | anexos / app / provider / tarefa / mcp / frontend (Chat + api) |
| **Prioridade** | 🟠 Alta — pedido do dono: "falta então enviar e receber arquivos pelo chat" |
| **Status** | ✅ Entregue na v3.46.0 (30/10) — 11 checks com o cliente real |
| **Antes** | Receber já funcionava (v3.45); enviar não existia: o compositor só aceitava imagem em base64 e não havia caminho do navegador para a máquina |
| **Como ficou** | Botão de anexar arquivo + upload em blocos de 8 MB com retomada (`POST /anexos/enviar`, `GET /anexos/enviar/status`); id preso ao arquivo no navegador; `enviar_para_maquina` leva o anexo à máquina por stream com `Range`, `curl -C -` e `sha256` conferido dos dois lados; a mensagem leva só o id (o conteúdo não entra no prompt); bolha do usuário mostra o arquivo com botão de baixar |
| **Prova** | Bloco `v3.46`: 20 MB em três blocos, 409 fora de ordem, status completo, arquivo no volume, sha256 do destino igual ao do navegador |
| **Limite honesto** | 10 GB por arquivo, 5 arquivos por mensagem; chave de saída vale 30 min e 5 acessos |

### T047 — Arquivo grande (10 GB): volume por usuário, envio em blocos e retomada
| Campo | Conteúdo |
|---|---|
| **Módulo** | anexos / maquinas / app / compose |
| **Prioridade** | 🟠 Alta — pedido do dono: "isso é um agente remoto", arquivo de 10 GB com streaming |
| **Status** | ✅ Entregue na v3.45.0 (29/10) — 11 checks com o cliente real (70 MB, três blocos) |
| **Antes** | Arquivo em `bytea` no Postgres (teto 32 MB), envio de uma vez (`--data-binary @arquivo`), download inteiro em memória e cópia máquina→máquina lendo o Buffer todo — 10 GB era impossível por três motivos independentes |
| **Como ficou** | Volume `minirag_arquivos:/app/dados` no compose; pasta `/app/dados/anexos/<usuario>/<id>/<nome>`; ficha em `anexos_maquina` (a tabela `arquivos` JÁ EXISTIA desde a v1 com o original dos documentos — foi o erro que derrubou o boot no primeiro teste). Envio em blocos de 32 MB com `offset` e chave HMAC assinada; `GET /maquina/r/status` diz de onde continuar; id determinístico faz o reenvio retomar; download por stream com `Range` (206); `/maquina/u` também virou stream |
| **Prova** | Bloco `v3.45`: 70 MB, sha256 igual, arquivo no volume, `completo=true` no banco, 206 com pedaço idêntico, reenvio instantâneo, bloco sem chave 401 |
| **Limite honesto** | 10 GB por arquivo e 7 dias de retenção (ambos por env). Espaço: 127 GB livres no disco da VPS |

## Lotes recomendados (executados — saíram na v3.18)

- **Lote 1 — celular e erros bobos (quase tudo barato)**: T005, T001, T006, T007, T009, T011, T012, T013, T014, T020
- **Lote 2 — osso de servidor**: T002 + T003 juntos (corte de histórico único), T004, T018
- **Lote 3 — superfície de gaveta**: T015, T016, T019, T017, T010
- **Depois / a decidir**: T008 (validar no aparelho físico — emulador já passou); T021 e T022 saíram na v3.18 (linha corrigida em 26/10)
