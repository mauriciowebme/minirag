# Lista de Tarefas de Teste E2E — minirag (camada VISUAL: clique real na tela)

> **Legenda**: `[ ]` pendente | `[x]` concluído | `[!]` falhou | `[-]` em progresso
> **Última atualização**: 21/10/2026 10:50
> **Escopo deste arquivo**: só o que exige **olho na tela** (render, ordem dos botões, clique que salva).
> Rota, papel, isolamento e protocolo do provedor são da suíte de contrato (`tests/e2e.test.ts`,
> alvo/modo em `docs/testes.md`) — não se repetem aqui.
> **Método**: skill canônica `suite-de-testes` → anexo da camada visual (inicialização, ledger,
> credenciais) → mecânica de navegador na canônica `e2e-cdp-browser-harness`.

---

## Pré-condição reutilizável (a semente desta camada — criar UMA vez, não redesenhar o mundo)

| Item | Valor |
|---|---|
| Alvo | instância **descartável** de teste, nunca produção (`scripts/up-test.sh`) |
| Tela | `http://<ip-da-ponte>:8002/painel/` — Chromium dirigido por CDP |
| Login | papel `usuario` (chave no header; a chave **não** mora neste repo: fica no arquivo de ambiente da rodada) |
| Provedor | falso do tipo **lento** (responde em ~4 s) para ter janela de "pensando" onde a rolagem é testável |
| Histórico | uma gaveta com 24 parágrafos de `conteúdo suficiente para empurrar a barra de rolagem` — garante barra de rolagem de verdade |
| Chaves | `TESTKEY`/`OPKEY` geradas a cada subida (o `up-test.sh` regrava); **nenhuma credencial no chat e nenhuma no repo** |

---

## G1 - Chat > rolagem e botões (v3.1)

| Código | Status | Teste | Descrição | Última Execução | Resultado |
|--------|--------|-------|-----------|-----------------|-----------|
| G1T01 | [x] | Rolar livre e digitar durante o "pensando" | subir a conversa enquanto o modelo responde e escrever por cima | 21/10/2026 09:40 | **antes**: `scrollTo(0,0)` voltava a **989** e travava nos 4 s. **depois**: ficou em **60** por **3,7 s** com a resposta crescendo (folga 3104 → 3687) e o texto `escrevendo em cima` + o foco seguraram no campo. Print: `G1T01-rolar-livre-digitando.png` |
| G1T02 | [x] | Botão `↓ fim` | aparece quando o usuário sobe e leva ao fim da conversa | 21/10/2026 09:44 | clique medido: `scrollTop` **120 → 3747**, folga **0**, botão some depois |
| G1T03 | [x] | `nova conversa` no pé | botão mudou para a linha do campo de digitação; nada de ação no topo | 21/10/2026 09:46 | `y=496` do botão == `y=496` do campo; barra do topo em `y=64` sem botão; sem corte horizontal (`scrollWidth <= clientWidth`). Visível no print de G1T01 |
| G1T04 | [ ] | Selo `chegou coisa nova` | etiqueta no `↓ fim` quando chega conteúdo enquanto o usuário está lendo no meio | - | não disparado ao vivo (a suíte prova a chegada do conteúdo, não o selo) |
| G1T05 | [ ] | Rolagem no celular | viewport estreita: rolar, botão de fim e campo sem cortar nada | - | testado só em 1280×720 |

## G2 - Configurações > Modelo (v3.2, o conserto do timeout)

| Código | Status | Teste | Descrição | Última Execução | Resultado |
|--------|--------|-------|-----------|-----------------|-----------|
| G2T01 | [ ] | Campo *espera sem sinal do modelo (segundos)* | renderiza na tela, salva por clique e volta preenchido no `F5` | - | provado **só por contrato** (`PUT`/`GET` na suíte, inclusive round-trip e `0` → volta ao padrão). Clique real ainda não feito |
| G2T02 | [ ] | Etiqueta da queda na bolha | quando o provedor para de responder, a tela mostra frase em português (nunca a frase crua em inglês) | - | provado com falso travado (corta em ~4 s com `ficou sem mandar nada por 4s`); **com o seu gateway nunca foi visto** |
| G2T03 | [ ] | `testar conexão` anuncia a janela real | o teste de conexão mostra a janela de contexto lida do modelo | - | não exercitado na tela contra provedor real |

## G3 - Chat > chamada de ferramenta (o que a suíte NÃO garante)

| Código | Status | Teste | Descrição | Última Execução | Resultado |
|--------|--------|-------|-----------|-----------------|-----------|
| G3T01 | [ ] | Ferramenta de escrita repetida | o modelo chamar `criar_usuario` duas vezes na mesma rodada não deve virar dois usuários | - | **aberto por decisão do dono**, sem bloqueio implementado. O print dele (21/10, 07:52) mostra a linha `ferramentas chamadas · 2 (criar_usuario, criar_usuario)`; quantos usuários aquilo criou **não foi verificado** |

---

## Resumo de Execução

| Métrica | Valor |
|---------|-------|
| Total de Testes | 10 |
| Concluídos | 3 |
| Pendentes | 7 |
| Falharam | 0 |
| Taxa de Sucesso | 30% (dos rodados: 3/3) |

---

## Notas e Observações

| Data | Teste | Nota |
|------|-------|------|
| 21/10 | G1T01–T03 | causa do defeito medido no bundle no ar: a caixa de mensagens crescia (`flex-1 overflow-auto` sem `min-h-0`, `scrollHeight == clientHeight`) e o `scrollIntoView` rodava a cada tique de 500 ms do cronômetro do "pensando" |
| 21/10 | todos | sem `credenciais-teste.json` neste repo de propósito: a camada visual do minirag autentica por **chave gerada na subida** (`scripts/up-test.sh`), não por usuário/senha fixos |
| 21/10 | G2T01–T02 | rodada visual é camada **à parte**: roda quando o dono pedir (canônica, escopo de 21/10) |
