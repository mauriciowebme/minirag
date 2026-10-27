# Rodada de pendências — véu de toque (T024) + toast padronizado (T025)

> **Data:** 2026-10-27 · **Dono:** Mauricio · **Base:** minirag 3.24.1 (commit `8bc01e8`)
> **Status:** em execução — "já pode executar todas as pendências do roadmap" (ordem do dono, 27/10)
> **Rodada:** 002 · **Tarefas:** T024, T025

## Achados medidos (evidência real)

1. **T024-a — Véu de toque iOS.** O dono viu "transparência" ao tocar no ⚙ (print do iPhone, 27/10).
   Medido ao vivo no navegador: o botão é **100% opaco** nos dois estados (fundo `#161c25` fechado /
   `#1c2330` aberto, `opacity: 1`, sem alpha em cor) — a transparência **não vem do CSS do botão**,
   mas do **véu de toque do iOS**: `frontend/src/index.css` **não define `-webkit-tap-highlight-color`
   em lugar nenhum** (grep = 0 acertos), e o Safari do iPhone pinta um véu cinza semitransparente sobre
   o elemento no toque. Afeta **todos** os botões do app; o ⚙ é o mais visível (primeiro tocado).
2. **T024-b — Ícone ⚙ fino.** `Chat.tsx:1098`: engrenagem em contorno com `strokeWidth="1.8"`, e
   `.chat-ajustes-boto` em estado parado usa `text-txt2` (`#a8b3c3`) — ao lado de ícones cheios,
   lê como "fantasma".
3. **T025 — Toast neutro para tudo.** `Toast.tsx`: assinatura `toast(m: string, ms?: number)` —
   **sem tipo**; `index.css` `.toast`: cor única (`bg-sup3 border-bordaforte`). Sucesso e erro
   saem **idênticos no relance**. O padrão já existe e o app não segue:
   `arquiteto-sistema/references/notificacoes.md` → sucesso = **verde + ícone**, erro =
   **vermelho + ícone**, botão **X**, **empilhamento**. Medido 27/10: **104 call sites** em
   11 componentes (Gavetas, Painel, Editor, Jobs, Arquivos, Buscar, Maquinas, Config, Chat).
   O que o app **já cumpre** do gabarito: `alert()` ausente (grep 0) e `confirm()` só em ação
   destrutiva (13 usos, todos de apagar). Posição do toast mantida: flutua acima do pé da conversa
   (desvio documentado na v3.23.1 — medido: `bottom-5` caía dentro do pé).

## Checklist de correções

- [x] **C1** — T024-a: `-webkit-tap-highlight-color: transparent` global em `index.css`
  *(arquivo: `frontend/src/index.css` — validação: grep = 1 acerto; no iPhone, o dono confirma
  que o véu sumiu — emulador não pinta tap-highlight)*
- [x] **C2** — T024-b: afirmar o ícone ⚙ — `text-txt2`→`text-txt` em estado parado
  (`index.css` `.chat-ajustes-boto`) + `strokeWidth` 1.8→2 (`Chat.tsx:1098`)
  *(validação: screenshot de clique real, menu fechado e aberto)*
- [x] **C3** — T025: `Toast.tsx` com `tipo: "neutro" | "sucesso" | "erro"` (default `neutro`,
  comportamento de hoje), ícones (círculo+check / triângulo+! da paleta do app, verde `#3fb950` /
  vermelho `#f85149`), botão **X** e **empilhamento** vertical (máx. 3, cada um com auto-hide próprio)
  *(validação: typecheck + clique real disparando toast de sucesso E de erro + screenshot)*
- [x] **C4** — T025: classificar os **104 call sites** em `sucesso`/`erro` nos 11 componentes
  *(validação: typecheck verde + grep: nenhum catch sem tipo `erro`)*
- [x] **C5** — Suíte completa (`scripts/up-test.sh` + `npm test`), checagens contadas da saída real
  *(validação: X/Y verde + prova registrada)*
- [x] **C6** — Encerrar T024/T025 no roadmap (✅ + versão **3.25.0**) e atualizar header
  *(validação: 25/25 índice/seções por grep)*

## Validação final (valores medidos em 27/10)

- [x] typecheck + build:frontend — `npm run build` verde (tsc -b && vite build, 49 módulos, 4.95s)
- [x] Suíte: **26/26 tests pass, 0 fail** (scripts/up-test.sh + npm test, 334s, saídas contadas do log real)
- [x] Prova de tela (instância de teste 192.168.64.1:8002, front novo docker cp):
  - gear ⚙ presente no piso do chat (`#chatAjustes`, SVG, 48×48px, aria "ajustes da conversa")
  - toast de sucesso: classe `toast toast-sucesso` (verde `#3fb950` no CSS), com ícone SVG + botão X
  - toast de erro: "criar: usuario 'teste' ja existe" — classe `toast toast-erro` (vermelho `#f85149`), ícone + X
  - botão X fecha o toast (0 restantes após o clique)
  - 2 toasts disparados em sequência **empilham** na `.toast-pilha` (2 presentes)
- [x] Roadmap: **25/25** índice/seções (grep); T024 e T025 → ✅ v3.25.0; header 3.25.0; constante `src/config.ts` → 3.25.0
- [ ] Faltou: confirmação do véu de toque no iPhone físico (emulador não pinta tap-highlight)
