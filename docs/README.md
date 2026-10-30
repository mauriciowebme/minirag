# Mapa da documentação — Nexos

> **Última atualização:** 2026-10-30 · **Versão:** 3.47.1 · **Dono:** Mauricio

O que vai onde (lugares canônicos da casa — padrão `organizacao-documentacao`; a tabela da skill é a dona, este mapa só registra o estado do repo):

| Conteúdo | Lugar | Estado |
|---|---|---|
| Fila do que falta (T###) | `docs/proximos-passos.md` | ✅ existe |
| Prova de como se testa (contrato por rota) | `docs/testes.md` (dono do método: skill `suite-de-testes`) | ✅ existe |
| Planos de trabalho temporários | `docs/planos/NNN-assunto.md` | ✅ pasta criada na rodada do plano 001; o plano legado v3.4 (concluído) saiu do repo em 25/10 por ordem do dono — histórico fica no `git log` |
| Specs por módulo | `docs/specs/NN-modulo.md` | _nasce na primeira regra escrita_ (pasta sem primeiro doc não se cria) |
| Casos reais / análises / auditorias datadas | `docs/casos/`, `docs/analises/`, `docs/auditoria/` | _quando surgirem_ |
| Runbook de operação | `docs/runbook.md` | _quando houver operação manual repetida_ |
| Histórico do entregue | `CHANGELOG.md` na raiz | ⚠️ pendência declarada — o histórico hoje mora no `README.md` da raiz (seções `## v…`); migrar exige OK do dono |
| Guia de uso / API | `README.md` da raiz + seção de exemplos | ✅ existe (raiz) |

## Índice do estado atual (medido 2026-10-25)

| Arquivo | Assunto | Linhas |
|---|---|---|
| `proximos-passos.md` | 22 tarefas do chat (T001–T022), análise vs Open WebUI/Hermes — **lote em execução 25/10** | ~315 |
| `planos/001-basico-chat.md` | checklist vivo T001–T022 (o que está entregue a cada momento) | ~55 |
| `testes.md` | contrato da suíte do nexos (ponteiro para `suite-de-testes`) | 105 |

Nada neste mapa autoriza execução: tarefas viram código com OK explícito do dono (25/10, regra gravada no roadmap).
