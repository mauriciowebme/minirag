# Próximos passos — Nexos

> **Última atualização:** 2026-10-30 · **Versão:** 3.49.3 · **Dono:** Mauricio

As tarefas **entregues** saíram daqui e vivem em [`concluidos.md`](./concluidos.md) — este arquivo
tem só o que está em aberto. Execução de qualquer T### exige OK explícito do Mauricio.

## Índice

| T### | Nome | Módulo | Prioridade | Status | Link |
|---|---|---|---|---|---|
| T052 | Sandbox Python com as ferramentas do nexos + biblioteca + agenda | sandbox + ferramentas | 🟠 Alta | 📋 Planejada | [#t052](#t052) |

---

### T052 — Sandbox Python com as ferramentas do nexos

| Campo | Conteúdo |
|---|---|
| **Módulo** | sandbox (novo) + ferramentas + agenda |
| **Prioridade** | 🟠 Alta — é o que separa "assistente que conversa" de "assistente que constrói" |
| **Status** | 📋 Planejada (pedido do dono em 30/10) |
| **Pedido** | "a ideia seria ter tipo um sandbox pra poder o usuário pedir 'faz tal coisa' que você não consiga, aí você poderia usar o Python que conseguiria usar as ferramentas — por exemplo, faz uma busca programada na web, aí vai lá e cria um script e roda isso" |
| **Problema que resolve** | Hoje o modelo só tem `rodar_comando` (shell cru) e uma ferramenta por vez. Quando o pedido exige repetir, comparar, testar condição ou juntar resultados, ele improvisa PowerShell/bash a cada resposta, gasta contexto e erra. Foi exatamente o que aconteceu em 30/10: para contornar o upload quebrado, o modelo tentou base64, HttpListener e certutil em vez de resolver. |
| **Desenho** | Quatro peças. (1) **Executor**: processo separado por execução, pasta própria, teto de tempo, memória e saída; stdlib por padrão. (2) **Ponte**: dentro do sandbox existe `import nexos`, com as ferramentas do servidor e da máquina como funções (`web_search`, `web_open`, `search`, `rodar_comando`, `baixar_arquivo`, `ler_arquivo`...). Cada função checa a permissão **do usuário que pediu** — o script nunca herda mais poder que quem pediu. (3) **Biblioteca**: script aprovado vira ferramenta nomeada (descrição + parâmetros) e entra no `tools/list`; roda de novo sem gastar modelo. (4) **Agenda**: rodar sozinho (de hora em hora, todo dia) e entregar o resultado no chat. |
| **Limites de segurança** | Sem rede direta: a internet só é alcançada pelas ferramentas, então tudo continua passando pelo mesmo controle e pelo mesmo log. `pip install` só com confirmação do operador. Sandbox liberado primeiro só para operador; liberação por usuário depois. Nada de acesso à pasta de dados do servidor. |
| **Por que Python** | Já existe dos dois lados: servidor 3.11.18 (roda embedder e OCR) e a máquina do trabalho com 3.12.10. Se a máquina não tiver, usar o *embeddable* (zip ~11 MB) dentro da pasta de trabalho, sem admin e sem instalar no sistema. |
| **Ganho colateral** | As ferramentas de arquivo que quebraram em 30/10 (upload em PowerShell) podem passar a usar o caminho Python, que não depende do .NET da máquina. |
| **Prova exigida na execução** | Um pedido real que hoje falha ("busca programada na web sobre X, junta e salva"): o modelo escreve o script, roda no sandbox, o arquivo aparece e o resumo volta no chat. Depois o mesmo script vira ferramenta e roda por agenda, sem modelo. Suíte completa verde e o sandbox recusando script de usuário sem permissão. |

## Ideias ainda não numeradas

- **Suíte testar o caminho Windows**: hoje a suíte roda em Linux e nunca exercita o upload por
  PowerShell — foi por isso que os três defeitos de 30/10 passaram. Um teste que rode na máquina
  real (ou um duplo do cliente Windows) fecha essa lacuna.
