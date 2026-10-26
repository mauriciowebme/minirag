# Plano 001 — Básico de chat que faltava (T001–T022)

> **Última atualização:** 2026-10-25 · **Dono:** Mauricio · **Status:** 🔄 Em execução

**Origem**: ordem do dono em 25/10/2026 — "pode corrigir e executar todas as tarefas do roadmap". Análise completa (22 lacunas medidas contra Open WebUI/Hermes) em `docs/proximos-passos.md` T001–T022. Release alvo: **3.18.0**, ambiente de teste + suíte + visual ao vivo antes do push.

**Descoberta da execução (25/10, ANTES de codar)**: T011 (botão voltar ao fundo) **já estava entregue** — `chatIrAoFim` em Chat.tsx (~linhas 28450+, "↓ fim" + aviso de coisa nova); minha análise usou os termos de busca errados. Fecha com evidência, sem código novo.

## Correções (uma linha por tarefa; ✅ = entregue com validação medida)

| Item | Tarefa | Arquivos | Validação | Status |
|---|---|---|---|---|
| C1 | T001 Parar a geração | src/tarefa.ts, src/provider.ts, src/app.ts, front (conversa, Chat) | botão para no teste; parcial preservado; 404 id alheio | ☐ |
| C2 | T002 Regenerar | idem (rota truncar + reenvio) | pair some do histórico, resposta nova chega | ☐ |
| C3 | T003 Editar e reenviar | idem | editar k corta cauda, nova resposta | ☐ |
| C4 | T004 Fontes da resposta | src/provider.ts (grava fontes reais da `search`), front | chip "de onde veio" na tela e no reabrir | ☐ |
| C5 | T005 Guarda IME + enterKeyHint | front Chat.tsx | Enter em composição não envia | ☐ |
| C6 | T006 Estilo de tabela | index.css (.rola já existe no md!) | tabela com borda no viewport 390 | ☐ |
| C7 | T007 Imagem na resposta | lib/md.ts + css | ![x] vira <img>, scheme http/data só | ☐ |
| C8 | T008 Teclado come barra | App/Chat (dvh + scrollIntoView) | medir com viewport simulado | ☐ |
| C9 | T009 Copiar bloco de código | lib/md.ts + delegação em Chat | clique no botão do <pre> copia | ☐ |
| C10 | T010 Destaque de sintaxe | lib/md.ts (realce próprio, sem deps) + css | kw/string/comentário coloridos, sem quebras | ☐ |
| C11 | T011 Botão voltar ao fundo | — | **já existia** (chatIrAoFim) | ✅ 25/10 evidência Chat.tsx |
| C12 | T012 Hora por mensagem | front (payload `quando` já vinha!) | hh:mm nos balões reabertos e vivos | ☐ |
| C13 | T013 Erro com repetir | front (msg-falha + botão) | simular erro, botão reenvia | ☐ |
| C14 | T014 Rascunho por gaveta | front Chat.tsx (map por chave) | digitar, trocar, voltar — texto vivo | ☐ |
| C15 | T015 Renomear conversa | rota + tabela chat_gavetas + Gavetas.tsx | renomeia, persiste no reload | ☐ |
| C16 | T016 Título automático | src/tarefa.ts pós-resposta + chat_gavetas | primeira troca ganha título; manual vence | ☐ |
| C17 | T017 Exportar conversa | front (blob .md) | download com balões na ordem | ☐ |
| C18 | T018 Custo por resposta | provider (coluna custo) + front | tok in/out + ms no rodapé | ☐ |
| C19 | T019 Fixar/arquivar gaveta | chat_gavetas + rota + Gavetas.tsx | fixada no topo; arquivada some | ☐ |
| C20 | T020 Copiar pergunta | front Chat.tsx | balão do usuário tem copiar | ☐ |
| C21 | T021 Buscar no histórico | rota GET /chat/mensagens + Gavetas.tsx | ILIKE por tenant; clique abre gaveta | ☐ |
| C22 | T022 Voz no campo | front (Web Speech) | botão; sem suporte → aviso honesto | ☐ |

## Decisões de execução (registradas)
- **Regenerar/reenviar = truncar no servidor + reenvio pelo caminho normal do front** (evita segunda via de criação de tarefa e mantém fila/queue íntegras).
- **Gavetas ganham tabela `chat_gavetas` (tenant, memoria) com titulo/fixada/arquivada** — `memoria` nunca é renomeada no banco (evita varredura entre tabelas); renomear = `titulo` de exibição (fallback: nome original).
- Fontes: extrair dos resultados da ferramenta interna `search` (campos `nome` dos documentos achados), dedupe ≤8; grava em `fontes` (coluna morta → passa a viver).
- Voz: Web Speech API do navegador; sem suporte, aviso na tela (não finjo). STT local fica fora deste lote.

## Validação final (preencher ao rodar)
- tsc front + build: ☐ · suíte completa no ambiente de teste: ☐ · visual 390×844 ao vivo: ☐ · prova em produção pós-push: ☐
