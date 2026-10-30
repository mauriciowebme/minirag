# Nexos — memória, máquinas e arquivos

Memória pesquisável e agentes nas suas máquinas. Você envia documentos, ele corta em pedaços,
cria uma "digital" numérica do significado de cada um (embedding) e guarda num
banco Postgres com pgvector. Quando você pergunta, ele devolve os pedaços mais
parecidos com a pergunta, com uma nota de 0 a 1.

**Stack:** Node 22 + TypeScript (Fastify) + Postgres (pgvector) + embedder Python
(nomic-embed-text-v1.5 via sentence-transformers), rodando no MESMO container.

---

---

---

---

---

---

---
---
## v3.48.0 (30/10) — Arquivos: uma tela para o RAG e para a pasta do usuário

**O que você vê:** o menu ficou menor — Buscar e Fila sumiram e entrou **Arquivos**, com duas abas.
Na aba **RAG** estão os documentos de sempre (subir, nova versão, nota, arquivar, apagar) agora com o
andamento do processamento na própria linha e um "tentar de novo" quando falha. Na aba **Meus arquivos**
está a pasta física do usuário: o que chegou pelo chat e pelas máquinas, com tamanho, data, origem,
baixar e apagar. No chat, os dois botões de anexo viraram **um só**.

**Por que:** eram dois botões para a mesma intenção ("quero mandar um arquivo") e três telas de menu para
assuntos que o usuário vive no mesmo lugar — o arquivo. A pasta física existia no servidor e não tinha
nenhuma porta na tela.

**Como funciona:** um único seletor de arquivo decide o caminho pelo tipo e pelo tamanho — imagem
pequena vai junto da pergunta (o modelo enxerga), o resto sobe em blocos com retomada. A aba Meus
arquivos lê a ficha dos anexos (`GET /anexos`) e apaga um por vez (`DELETE /anexos/:id`), sempre presa
ao dono. Os links antigos `#/buscar` e `#/fila` abrem Arquivos e a URL se corrige sozinha.

**Como é provado:** no ambiente de teste, clique real nas duas abas; um txt subiu pelo seletor único e
virou chip de arquivo, um png virou miniatura; o anexo apareceu em Meus arquivos, foi baixado e apagado
(sumiu da lista e do disco); um job forçado a erro mostrou "erro" e o "tentar de novo" devolveu a linha
para a fila; suíte completa **32 pass / 0 fail**.

## v3.47.2 (30/10) — o nome novo agora vale também na infraestrutura

A 3.47.1 trocou o que se vê. Esta troca o que fica por baixo:

- **Containers**: `nexos` e `nexos-db` (antes `minirag-*`). Rede e volumes acompanham.
- **Volumes**: `nexos_data` (Postgres) e `nexos_arquivos` (anexos das máquinas), com os
  dados copiados do volume antigo — nada de banco vazio.
- **Banco e papel**: database e usuário `nexos`, com todas as 23 tabelas e as mesmas linhas.
- **Cliente de máquina**: o binário passou a se chamar `nexos-cliente-win.exe` /
  `nexos-cliente-linux`; a rota `/maquina/cliente/:plataforma` aceita os dois nomes, então
  máquina antiga que pedir o arquivo continua recebendo.
- **Na máquina do usuário**: a config virou `.nexos-maquina.json` e o log
  `nexos-cliente.log` — o cliente renomeia os antigos na primeira subida, sem perder
  pareamento nem histórico.
- **Variáveis**: `NEXOS_*` é o nome oficial; o fallback para `MINIRAG_*` continua no compose.

## v3.47.1 (30/10) — o produto agora se chama Nexos

O nome antigo descrevia só a busca; a ferramenta hoje guarda memória, conversa, executa
nas suas máquinas, fabrica telas e transfere arquivos. **Nexos** diz o que ela faz: liga
tudo isso.

O que muda na prática:

- **Na tela**: login (`◆ Nexos`), título da aba, autor das mensagens e conversa exportada.
- **Endereço novo**: `https://nexos.techupsistemas.com`. O domínio antigo respondeu por
  algumas horas só para as máquinas que ainda tinham o endereço velho salvo e depois saiu.
- **Cliente de máquina**: o binário novo usa o endereço novo e reescreve sozinho a
  configuração antiga na primeira subida — a máquina não precisa ser reconfigurada.
- **Variáveis**: `NEXOS_*` é o nome oficial; `MINIRAG_*` continua aceito e o boot copia
  automaticamente para o nome novo, então env antigo não quebra.
- **O que ficou com o nome antigo de propósito**: os volumes (`minirag_data`,
  `minirag_arquivos`), os nomes dos serviços no Docker e os binários do cliente — renomear
  cada um exige copiar dados ou uma versão intermediária, e nada disso aparece para quem usa.

## v3.46.0 (30/10) — arquivo grande nos dois sentidos: do navegador para a máquina

O que você vê: o compositor do chat ganhou o botão de **anexar arquivo** (ao lado do de
imagem). Você escolhe um arquivo de até 10 GB, uma barra mostra o envio e, se a conexão
cair, ele **continua de onde parou** em vez de recomeçar. O arquivo aparece na sua
mensagem e o assistente pode levá-lo para qualquer máquina com `enviar_para_maquina`
— que baixa por stream, retoma e confere o `sha256` no destino.

Por que: até a 3.45 o ciclo era só de ida (máquina → conversa). O caminho do navegador
para a máquina não existia: o compositor aceitava apenas imagem colada em base64, e o
upload de documentos lia o corpo inteiro na memória — 10 GB derrubaria o servidor.

Como funciona:

- **Upload do navegador** (`POST /anexos/enviar`): blocos de 8 MB com `offset`, autenticado
  pela chave do usuário (o tenant vem da sessão, nunca da query). O id do envio fica preso
  ao arquivo (nome + tamanho + data) no navegador, então reenviar o mesmo arquivo retoma.
  `GET /anexos/enviar/status` diz de onde continuar.
- **Envio para a máquina** (`enviar_para_maquina`): o servidor abre o anexo no disco, entrega
  por `GET /maquina/u` (agora com `Range`) e a máquina baixa com `curl -C -`. No fim, compara
  tamanho e `sha256` dos dois lados; divergência é erro, não sucesso silencioso.
- **A mensagem leva só o id**: o conteúdo não entra no prompt. O modelo recebe uma nota com
  nome, tamanho e id do arquivo, e é esse id que a ferramenta usa.
- **Histórico**: o arquivo anexado pela pessoa aparece na bolha dela, com nome, tamanho e
  botão de baixar (o `GET /anexos/:id` continua autenticado por header).

Como é provado: bloco `v3.46` da suíte, com o cliente real — 20 MB enviados em três blocos
de 8 MB, bloco fora de ordem recusado com 409, status dizendo 20 MB/completo, arquivo no
volume em pasta do usuário, `enviar_para_maquina` levando o anexo para a máquina e o
`sha256` do destino igual ao do navegador (11 checks).

Limites: 10 GB por arquivo; 5 arquivos por mensagem; a chave do canal de saída vale 30 min
e até 5 acessos (é o que permite o `curl --retry` retomar).

## v3.45.0 (29/10) — arquivo grande: 10 GB em blocos, com retomada

O que você vê: a máquina manda arquivo de qualquer tamanho (até 10 GB) para a conversa,
mesmo que a internet caia no meio — ele **continua de onde parou** em vez de recomeçar.
Vídeo e áudio tocam direto no chat, sem baixar antes, e o download retoma de qualquer ponto.

Por que: a 3.44 guardava o arquivo **dentro do Postgres** (coluna `bytea`, teto de 32 MB) e
enviava de uma vez. Com 10 GB isso seria banco inchado, backup gigante e, numa queda,
começar tudo de novo.

Como funciona: o arquivo saiu do banco e foi para o **volume** do container, em pasta por
usuário — `/app/dados/anexos/<usuario>/<id>/<nome>`. O banco guarda só a ficha (`anexos_maquina`:
nome, tipo, tamanho, completo). A máquina envia em **blocos de 32 MB** com `offset`; se cair,
ela pergunta `GET /maquina/r/status` e continua do byte atual. O envio do mesmo arquivo usa um
id determinístico (usuário + máquina + caminho + tamanho + data), então repetir o comando
**retoma** em vez de reenviar. O download sai por stream com `Range` (206), e a cópia
máquina→máquina também passou a mandar o arquivo do disco, nunca da memória. O volume está
declarado no `docker-compose.yml` do projeto (`minirag_arquivos:/app/dados`).

Como é provado: bloco `v3.45` da suíte, com o **cliente real** — 70 MB (três blocos) enviados,
sha256 igual ao da máquina, arquivo confirmado no volume em pasta do usuário, ficha no banco
com `completo=true`, `Range` devolvendo 206 com o pedaço byte-a-byte igual, reenvio do mesmo
arquivo instantâneo (retomada) e bloco sem chave assinada recusado com 401 (11 checks).

Limites: 10 GB por arquivo (`NEXOS_MAX_ARQUIVO_MB`), faxina em 7 dias (`NEXOS_ARQUIVOS_DIAS`),
e o tempo depende do upload da sua internet (10 GB a 100 Mbps ≈ 14 min).

## v3.44.0 (29/10) — a máquina manda arquivo para a conversa (print, imagem, log)

O que você vê: o agente tira **print da tela do PC** e a imagem aparece na conversa, com
miniatura e botão de baixar. Um arquivo da máquina (log, XML, PDF) também vem para o chat
do mesmo jeito, até 32 MB. E `copiar_arquivo` leva um arquivo de uma máquina para outra.

Por que: até a 3.43 o túnel só ia **servidor → máquina**. Não existia caminho de volta:
o chat desenhava imagem apenas na bolha do usuário, e `ler_arquivo` devolvia base64 ao
MODELO (gastando a janela) sem nunca mostrar nada ao dono.

Como funciona: três ferramentas novas — `capturar_tela` (Windows: tela 1..4; Linux: precisa
de sessão gráfica), `baixar_arquivo` (máquina → conversa) e `copiar_arquivo` (máquina →
servidor → outra máquina). O arquivo **não passa em base64 pelo WebSocket**: a máquina faz
POST binário em `/maquina/r` com chave one-time presa ao host (TTL 5 min), o servidor grava
em `anexos` e o front busca por `GET /anexos/:id` com a chave no header. O modelo recebe só
a meta (`id`, `nome`, `mime`, `bytes`) — o conteúdo nunca entra no contexto.

Como é provado: bloco `v3.44` da suíte sobe o **cliente real** do container, envia 300 KB
de bytes aleatórios por `baixar_arquivo`, confere que `GET /anexos/:id` devolve o **mesmo
sha256** do arquivo na máquina, que sem chave dá 401, que a cópia máquina→máquina no destino
tem o mesmo sha256, e que `capturar_tela` num Linux sem X responde erro claro (10 checks).

Limite honesto: 32 MB por anexo e 16 MB na cópia entre máquinas. Para GB, a LAN entre as
máquinas (medido 107 MB/s) — túnel de WebSocket não é canal para isso.

## v3.43.0 (29/10) — o túnel passou a entregar o que promete (e o ✓ parou de mentir)

O que você vê: `ler_arquivo` de print/foto/log volta a funcionar (até os 800 KB do
contrato), o rastro mostra ✗ em comando que falhou e o erro de máquina sem git é uma
frase curta em vez do XML do PowerShell.

Por que: o "teto de ~39 KB do túnel" não era o WebSocket — era o CLIENTE. Ele matava a
árvore do processo ao passar de 40.000 caracteres de stdout e, com `morto=true`, o
`close` retornava sem resolver a Promise: o servidor esperava e estourava em -124,
lendo como máquina muda. Quem lia 200 KB (padrão do `ler_arquivo`) falhava sempre.

Como funciona: o cliente agora **trunca** a coleta em 8 MB (e diz `truncado: true`),
nunca mata por tamanho; o servidor propaga o campo. `ok` passou a considerar `exit != 0`,
`git` ausente vira 422 curto, `ler_arquivo` sem resposta vira 504 explicando que
`timeout` não existe ali, e `comandos_log.exit` virou BIGINT (exit grande do Windows
não derruba mais a auditoria).

Como é provado: sonda ao vivo depois do deploy e do auto-update do cliente —
`Write-Output ('x'*40000)` volta em ~1 s, `ler_arquivo` binário de 200 KB volta com
`lidos=200000`, e o mesmo comando com `exit 1` aparece ✗ no rastro.

## v3.42.1 (29/10) — fala no meio: a tarefa achada pelo tenant certo

O steering da 3.42.0 devolvia `404 tarefa não encontrada` com a resposta rodando na tela
(print do dono). A rota lia `tenant` do CORPO; a tela manda na QUERY, como nas outras
rotas de tarefa (cancelar, stream) — sem o tenant, `verTarefa` procurava a tarefa no
tenant do usuário e não achava a que estava em foco.

- `POST /chat/tarefa/:id/fala` aceita `?tenant=` (query) e o corpo como reserva
- prova nova no bloco v3.42: operador com tarefa em outro tenant → sem tenant 404,
  com `?tenant=` 200 (11 checks)
- conferido também no clique real: painel de teste, "oi", fala no meio, resposta
  `Mudei o rumo: …` na mesma conversa, sem toast de erro

## v3.42.0 (29/10) — fala no MEIO do turno (steering)

O que o Hermes faz e o nexos não fazia: você manda uma mensagem enquanto a resposta
está sendo produzida e ela **entra no turno em curso**, em vez de esperar na fila.

- `POST /chat/tarefa/:id/fala` — guarda a fala na tarefa viva (409 se já encerrou, 422 se vazia)
- o loop de rodadas drena essa fila no topo de cada rodada e injeta como mensagem de usuário:
  o modelo vê antes de pensar e ajusta o rumo sem perder o fio
- se ele já tinha concluído, abre **mais uma rodada** para encaixar (o que já disse fica guardado
  e a resposta final sai como a soma das partes)
- na tela: Enter com resposta rodando chama a rota em vez de enfileirar; a bolha entra na conversa
- limite honesto: não corta a palavra que já está saindo — a fala entra na rodada seguinte

## v3.41.1 (29/10) — a foto aparece na bolha e entra por três caminhos
- **O que você vê:** ao mandar uma imagem, ela fica **dentro da bolha da sua pergunta** (clique abre inteira) — igual ao assistente do IA_GO. E dá para trazer imagem de três jeitos: colar (Ctrl+V), arrastar e soltar no campo, ou o botão de clipe ao lado do microfone.
- **Por que:** a v3.41.0 mandava a imagem para o modelo, mas a bolha só renderizava texto — a pessoa mandava e "não aparecia nada" na conversa. O `onPaste` também estava só no `textarea`, então colar com o foco fora dele não fazia nada.
- **Como funciona:** `Linha` ganhou `imagens` (só na tela; o servidor continua gravando texto), `enviar` guarda os anexos na linha e a bolha desenha as miniaturas. O compositor inteiro ouve `paste` e `drop`, e o clipe abre um `input[type=file]` — os três chamam o mesmo `lerImagens`.
- **Como é provado:** colar um print, arrastar outro e usar o clipe: os três mostram miniatura no campo, a bolha mostra a foto, e o turno chega ao provedor com `image_url`.

## v3.41.0 (29/10) — imagem no chat (colar e o modelo ver), ferramenta `analisar_imagem` e rastro sem nome cru
- **O que você vê:** cola um print no campo do chat (Ctrl+V) e ele aparece como miniatura; a pergunta vai com a imagem e o modelo **olha** — descreve, compara, lê o que está na tela. Até 3 imagens por mensagem, 4 MB cada. E o rastro deixou de mostrar `Consultando rodar_comando`: agora lê "Rodando o comando na máquina", "Lendo o arquivo na máquina", "Escrevendo o arquivo na máquina".
- **Por que:** o chat não tinha entrada de imagem nenhuma — o modelo só recebia texto; e o mapa de rótulos do rastro cobria as ferramentas do RAG mas nenhuma das 22 de máquina, então o nome técnico em snake_case vazava para a tela. O verbo era sempre "Consultando", mentindo em escrever/rodar/apagar.
- **Como funciona:** o front lê o clipboard (`onPaste`), guarda `{mime, base64}` e envia o turno pelo `/chat/stream` (a imagem não passa pelo banco da tarefa). No servidor, `validarImagens` aplica teto e formatos (png/jpeg/webp) e `comVisao` transforma **só a última mensagem do usuário** em partes `[texto, image_url...]` no payload do provider — o histórico, a memória e a compactação continuam texto puro. A ferramenta `analisar_imagem` (url ou base64) roda o OCR local e devolve o texto, para print/foto onde o que importa é o texto.
- **Como é provado:** provedor falso registrando o corpo recebido — a mensagem do usuário chega como array com `image_url` e o texto; `analisar_imagem` devolve o texto reconhecido de uma imagem de teste; e o CSS/bundle servidos trazem `chat-anexos`.

## v3.40.0 (29/10) — `editar_no_local` sem teto de 4000 e botões de mensagem sempre visíveis
- **O que você vê:** o agente edita arquivos grandes no PC sem trocar de ferramenta no meio do caminho; e os botões de copiar/regenerar/editar ficam sempre à vista em cada mensagem, sem precisar passar o mouse.
- **Por que:** a busca e a substituição viajavam **dentro do comando** remoto. O transporte aplica teto de 4000 chars quando a origem não é "envelope", e `chat:editar_no_local` não era — o modelo via o 422 e improvisava com `rodar_comando`. Os botões, desde a v3.22, ficavam com `opacity: 0` e só apareciam no hover: quem não passava o mouse nunca descobria.
- **Como funciona:** o texto da edição vai num pacote JSON pelo canal de upload (o mesmo do `escrever_arquivo`, teto 16MB) com `curl`; o comando remoto fica curto e fixo (baixa o pacote e aplica a troca com a mesma regra: `NAO ENCONTRADO`, `MULTIPLOS`, `replace_all`, `seca`, EOL LF↔CRLF, UTF-8 sem BOM). `editar_no_local` também entrou na lista de envelope do transporte, como rede de segurança. A API da tool não mudou.
- **Como é provado:** busca de mais de 4000 chars aplicada por `editar_no_local` numa máquina real, com o resumo `EDITADO local ocorrencias=N bytes=...`; e o CSS servido sem `opacity: 0` na regra de `.msg .chat-acoes`.

## v3.39.4 (29/10) — Chat: a rolagem acompanha a escrita até o último pixel
- **O que você vê:** com a resposta sendo escrita e você no fim, a tela desce o tempo todo; nada de sobrar um pedaço escondido embaixo. Se você subir para reler, ela para de puxar e só volta quando você voltar ao fim.
- **Por que:** o auto-scroll só era disparado quando o TEXTO mudava de tamanho. Mudanças de altura que não mexem no texto (campo de digitação crescendo, rastro abrindo/fechando, tela entrando) não puxavam nada; e o `scrollTo` do próprio app gerava evento de `scroll` que podia ser lido como "o usuário saiu do fim", desligando o acompanhamento.
- **Como funciona:** uma marca `programando` faz o app ignorar o scroll que ele mesmo disparou; um `ResizeObserver` no conteúdo e na área reagenda o salto em `requestAnimationFrame` sempre que a altura muda, mas só quando você está no fim (`colado`). Subir continua mandando: nada é puxado.
- **Como é provado:** resposta longa em streaming com a janela no fim — a última linha fica visível do começo ao fim, inclusive quando o campo cresce; subir no meio da escrita para a rolagem e mostra o botão "↓ fim"; clicar nele volta a acompanhar.

## v3.39.3 (29/10) — Lateral: "sair" e "versão" vazavam para fora da coluna
- **O que você vê:** o menu lateral mantém o fundo e a borda até o fim; o bloco do usuário, "sair" e "versão" ficam dentro da coluna. Antes, com a janela baixa, o conteúdo passava da altura e o rodapé aparecia solto sobre o fundo da página, sem bg nem divisor.
- **Por que:** o `aside` tinha altura fixa (`h-full` dentro de `h-screen`) e nenhuma rolagem — o que passava de 100vh transbordava para fora da caixa, e o fundo não acompanhava o conteúdo.
- **Como funciona:** o `aside` ganhou `min-h-0 overflow-y-auto` (a coluna rola dentro dela mesma; o `mt-auto` continua empurrando o rodapé para baixo quando sobra espaço) e o wrapper passou de `h-screen` para `h-[100dvh]`, o mesmo padrão do resto do app.
- **Como é provado:** janela com pouca altura — bloco do usuário, "sair" e "versão" seguem sobre o fundo da coluna, com a borda descendo até a base, e a rolagem acontece dentro do menu.

## v3.39.2 (29/10) — Chat do operador: a leitura da tarefa ia sem o tenant do foco
- **O que você vê:** a resposta volta na hora, em vez de "não consegui responder: tarefa não encontrada". Antes, com operador em foco de um tenant, a bolha mostrava o erro e a resposta só aparecia ao recarregar a página.
- **Por que:** o `POST /chat/tarefa` grava a linha com o tenant do foco, mas a leitura (`GET /chat/tarefa/:id/stream` e `GET /chat/tarefa/:id`) ia SEM `?tenant=`. `verTarefa` filtra por tenant e resolvia o tenant do próprio usuário, então a tarefa existia e terminava, mas a leitura devolvia 404.
- **Como funciona:** `bombearTarefa` recebe o tenant e o repassa nas duas rotas de leitura; o `transportar` usa o mesmo `tenant` que foi no POST e o `reativar` usa o `tenantParam` da tela. O servidor não mudou.
- **Como é provado:** em produção, `GET /chat/tarefa/<id>` sem tenant devolvia 404 e com `?tenant=operador` devolvia 200 com a resposta; depois do deploy, mensagem enviada no painel com operador em foco responde sem erro e sem refresh.

## v3.39.1 (29/10) — `rodar_comando` de volta ao ar: o Node reescrevia a linha do `cmd.exe`
- **O que você vê:** comando volta a rodar nas máquinas Windows. Antes desta correção, qualquer chamada respondia `'"echo oi"' não é reconhecido como um comando interno` — a ferramenta estava fora do ar em todas as máquinas.
- **Por que:** a 3.39.0 tentou preservar aspas de caminho com espaço chamando `cmd.exe /d /s /c "…"`. Só que o Node também embrulha em aspas o argumento que tem espaço, e a linha final chegava ao `cmd` com as aspas duplicadas e as internas escapadas com `\` — que o `cmd` não entende como escape.
- **Como funciona:** `windowsVerbatimArguments: true` no `spawn` e o comando vai **cru**, sem aspas acrescentadas por nós: a linha chega ao `cmd.exe` exatamente como foi escrita. Caminho com espaço continua funcionando (`type "C:\Pasta com espaço\x.bat"`) porque a aspa que o `cmd` lê é a original, não uma reescrita.
- **Como é provado:** chamada ao vivo nas duas máquinas Windows depois do deploy (`echo`, `metricas`, `processos`, `background`).

## v3.39.0 (29/10) — Ferramentas de máquina: teto de 15 min, processo em background, `metricas` e matar por porta
- **O que você vê:** (1) `rodar_comando` aceita `timeout` até **900 s** — antes o teto era 120 s e cortava carregar modelo, build e varredura; (2) `background: true` sobe o processo solto e devolve `INICIADO_PID=…` — o servidor termina a chamada sem matar o que ficou rodando; (3) tool nova **`metricas`** traz CPU%, RAM, uptime, disco, top 5 por memória e GPU (VRAM, uso, temperatura) numa chamada só; (4) `processos` com `acao=matar` aceita **pid** e **porta** além do nome; (5) caminho com espaço deixou de quebrar no Windows (`type "C:\Pasta com espaço\x.bat"` funciona); (6) quando estoura o tempo, a mensagem diz que estourou e o que fazer, em vez de devolver `-124` seco.
- **Por que:** sessão de trabalho real em 29/10 — dois comandos legítimos morreram em 122 s e 62 s; subir um servidor exigiu WMI (`Invoke-CimMethod Win32_Process Create`) porque o processo morria junto com o comando; ver GPU custava três chamadas (`estado_maquina` + `processos` + `nvidia-smi` na mão); matar quem ocupava a 8080 custava `rede portas` + `processos listar` + `taskkill`; e o `type` num caminho com espaço falhava por perda de aspas.
- **Como funciona:** `TIMEOUT_MAX` foi de 120 para 900 em `src/maquinas.ts` e o cliente acompanha (era `Math.min(600, …)`, agora 3600). `background` é um campo **opcional** no envelope do túnel — cliente antigo ignora e roda como antes, as tags do wire (`oi`/`cmd`/`stdout`/`ack`/`host`) não mudaram. No PC o processo nasce com `detached` + `stdio: ignore` + `unref()`. O `cmd.exe` chega com a linha crua e `windowsVerbatimArguments`, para o Node não reescrever as aspas (a primeira tentativa nesta versão usava `/s /c "…"` e derrubou a ferramenta — ver 3.39.1). `metricas` entra no mesmo lote que a REST por ser tool de máquina (MCP é espelho da REST) e nasce liberada pela regra de permissões. `processos` valida que veio **um** alvo (nome OU pid OU porta) e usa `Get-NetTCPConnection`/`ss` para achar o dono da porta.
- **Como é provado:** suíte completa em ambiente limpo (`scripts/up-test.sh`) — **28 testes / 27 blocos / 338 s / fail 0**, com a lista de 50 tools cravada no bloco MCP e a soma das 22 ferramentas de máquina conferida no bloco v3.6. Depois do deploy, as tools novas são chamadas **ao vivo** no DESKTOP e no JPPC (a regra do projeto é que auditoria de ferramenta de máquina é chamada real, não leitura de código).

## v3.38.1 (28/10) — `git_remoto` fora de repositório responde 422, sem o XML do PowerShell
- **O que você vê:** apontar `git_remoto` para uma pasta que não é repositório devolve uma linha — *"'C:/IA' não é repositório git (nenhum .git encontrado) — nada foi executado"* — em vez de 502 com `No linha:`, `CategoryInfo` e o `&amp;` escapado.
- **Por que:** a correção da 3.38.0 tratava o erro depois do `EXIT=`, mas nesse caso o próprio PowerShell sai com código diferente de zero por causa do `NativeCommandError` — o 502 disparava antes. Medido ao vivo no JPPCINFODEV01 logo após o deploy da 3.38.0.
- **Como funciona:** a detecção ("not a git repository") passou a rodar **antes** do 502, sobre o texto já sem a moldura do PowerShell; e o limpador de ruído agora corta no primeiro marcador (`No linha:`, `CategoryInfo`, `FullyQualifiedErrorId`) porque o erro chega colado numa linha só quando atravessa o `2>&1`.
- **Como é provado:** chamada ao vivo em `C:/IA` nas duas máquinas após o deploy.

## v3.38.0 (28/10) — Ferramentas de máquina: o que estava torto, medido e corrigido
- **O que você vê:** (1) caminho de arquivo vem limpo — `C:\Windows`, sem o `\r` grudado no fim; (2) `rede info` respeita o `alvo` e filtra IP/interface/gateway/DNS em vez de devolver tudo; (3) `git_remoto` numa pasta que não é repositório responde em uma linha ("não é repositório git") em vez de despejar o XML do PowerShell; (4) `area_transferencia` no Windows cai para o modo alternativo quando a sessão remota trava o clipboard, e a recusa vem como **422** explicando, não como 502 com stack; (5) máquina que reconecta no meio do comando responde **503 "reconectando"** — antes parecia defeito do PC; (6) `rodar_lote` deixou de recusar lote pequeno: 3 comandos de 367 caracteres batiam num teto de 4.000 que era medido **depois** da codificação.
- **Por que:** varredura das 20 ferramentas nas duas máquinas (T043) e um lote recusado sem motivo aparente (T044). Quinze funcionavam; cinco tinham defeito, todos medidos em produção antes de mexer.
- **Como funciona:** o texto que sai das ferramentas de Windows passa por uma normalização única de CRLF; o ruído do PowerShell (`No linha:`, `CategoryInfo`, `FullyQualifiedErrorId`) é removido do erro; o teto do comando passou a olhar o envelope (base64) para as ferramentas que montam o comando, e o texto do usuário continua limitado a 4.000 com a mensagem dizendo o número real; queda do cliente no meio da chamada virou 503 com auditoria preservada.
- **Como é provado:** blocos `MCP`, `v3.37`, `v3.6` e `v3.8` rodados em 49 s — **5/5 verde, 0 falha**, com os 23 blocos pulados listados nominalmente. Depois do deploy, as cinco correções são chamadas ao vivo nas duas máquinas Windows.

## v3.37.0 (28/10) — As ferramentas de máquina voltam a funcionar em PC Windows
- **O que você vê:** listar pasta, processos, janelas, rede e estado das máquinas Windows passa a responder de verdade. Antes, tudo isso ficava mudo ou voltava vazio — e a lista vazia vinha com "ok", como se a pasta não tivesse nada.
- **Por que:** o programa que roda no PC anuncia o sistema como **win32 10.0.26200**, mas o servidor só reconhecia a palavra **windows**. Nenhuma das 20 ferramentas de máquina achava que era Windows, então mandava comando de Linux para o PC (`ifconfig`), recusava janelas e devolvia listagem vazia.
- **Como funciona:** um único ponto passou a traduzir o nome do sistema (`win32 …` vira Windows, `linux …` vira Linux, `darwin …` vira Mac) antes de escolher o caminho de comando. O nome cru continua guardado para exibição.
- **Como é provado:** bloco novo `v3.37` com 4 checagens num PC falso que anuncia `win32 10.0.19045` — a máquina aparece online, o lote de comandos sai embrulhado em PowerShell (o caminho de Windows) e a ferramenta de janelas deixa de responder "só em Windows"; uma máquina Linux na mesma rodada continua no caminho de Linux. Suíte completa roda em seguida.

## v3.36.0 (28/10) — Cada conta decide o que ela oferece como servidor MCP
- **O que você vê:** item novo no menu, **MCP** (🔌), disponível para todo usuário. A página mostra o endereço do serviço, o cabeçalho de autorização, **a lista do que aquela conta pode usar** — com um interruptor por ferramenta — e o bloco pronto para colar no agente (JSON do `mcpServers`).
- **Por que:** pedido do dono (28/10) — "se o usuário quiser usar como servidor MCP ele pode, e as ferramentas que o admin colocou como permitidas é o que ele vai conseguir usar", e isso não podia ficar escondido no chat.
- **Como funciona:** duas camadas novas (`src/mcp_acesso.ts`). (1) **Interruptor do admin** em Configurações → Ferramentas: "contas liberadas para usar o MCP", nasce ligado para não calar os agentes que já conversam; desligado, só o operador usa o MCP. (2) **Lista do próprio usuário**, que guarda apenas o que está **desligado** — ferramenta nova nasce liberada, sem migração nem aprovação. O papel continua acima de tudo: as 5 ferramentas de operador nunca são liberadas por interruptor, e as 20 de máquina continuam dependendo do controle de máquinas. O `tools/list`, o pacote de ferramentas do chat e a recusa no ato da chamada passam a respeitar as duas camadas, e a recusa diz qual delas barrou.
- **Como é provado:** suíte completa **27/27 verde** (26 blocos rodados, 0 pulados), com o bloco novo `v3.36` em 15 checagens: as 5 de operador marcadas como `papel` no catálogo da conta comum, ferramenta desligada some do `tools/list` e a chamada é recusada com o motivo, religar devolve, comum não desliga o MCP de todos (403), operador desliga para todos e a conta comum fica sem ferramentas (403 na chamada) enquanto o operador continua entrando. De quebra, `v3.13.1` trocou 45 s de espera fixa por verificação em laço: **68,9 s → 39,2 s**.

## v3.35.1 (28/10) — O campo das instruções mostra o texto que está em uso
- **O que você vê:** ao abrir Configurações → Providers, o cartão de instruções já aparece **com o texto que está valendo** (antes abria vazio, mesmo com as regras gravadas). E o que você apaga fica apagado: o sistema não volta a preencher o campo sozinho.
- **Por que:** o dono viu o campo vazio e o modelo respondendo o nome — "de onde ele está tirando isso?". O texto existia (552 caracteres), mas a tela não o mostrava; e havia um preenchimento automático a cada subida do container que regravava as regras em todo campo vazio, quebrando a regra "vazio = conversa pura".
- **Como funciona:** o carregamento da seção agora alimenta o campo com o que o servidor devolve (`setPrompt` saiu do caminho do formulário e passou a rodar sempre); o `UPDATE` do boot foi removido de `initProvider`. `src/regras.ts` continua existindo só como semente do botão "restaurar instruções padrão" — nada entra no campo por baixo.
- **Como é provado:** typecheck + build limpos; suíte completa verde; e o teste visual com texto gravado: abrir a tela e ver os 552 caracteres no campo, apagar, salvar, recarregar e continuar vazio.

## v3.35.0 (28/10) — As instruções são da conta, e a narração nasce dentro do rastro
- **O que você vê:** (1) o submenu virou **Providers** — plural, porque a seção gerencia vários; (2) o campo "instruções do modelo (system prompt)" saiu do formulário de cada provider e virou um **card próprio no topo da seção**, avisando que vale para todos os providers e modelos da conta; (3) a **narração** do agente passou a ser escrita **dentro do rastro do turno**, ao lado do "Pensou por Ns" — ela nunca mais aparece na bolha de resposta e depois "pula" para o rastro.
- **Por que:** pedido do dono (28/10) — o system prompt é a voz do assistente, não do modelo, então não pode morar dentro da linha de um provider; e o print do turno mostrou a fala nascendo na bolha e só depois sendo jogada para dentro do rastro ("o ideal era ele já escrever direto dentro do rastro, assim como já faz com o pensamento").
- **Como funciona:** as instruções moram numa linha só por conta (`provider_config.system_prompt` do escopo, com a global de reserva para conta sem linha), com rota própria `PUT /config/instrucoes`; o chat lê **sempre** `lerInstrucoes(tenant)`, inclusive quando o provider escolhido é um nomeado — antes, escolher um nomeado zerava as regras. No stream, o começo da rodada fica **retido** no servidor: se a rodada pede ferramenta, aquele texto é narração e sai como evento `fala` (linha do rastro); se não pede, é resposta e é liberado como `delta`. O limite de 140 caracteres e a espera de 1,2 s cobrem a narração fora do padrão (a regra manda ≤12 palavras).
- **Como é provado:** typecheck + build limpos; suíte com blocos novos em `v3.15` (a narração não passa por nenhum `delta`, chega como `fala` antes da ferramenta e a resposta final continua digitando), `v3.19` (instruções gravadas na conta, comum recebe 403, e o provider **nomeado** recebe o system da conta) e `v2.8` ajustado para gravar as instruções no escopo de quem conversa; blocos `v2.7`, `v3.0`, `v3.8`, `v3.18`, `v3.23`, `v3.24`, `v3.2`, `MCP` e `v1.8` rodados sem regressão.

## v3.24.1 (27/10) — Expandir ocupa a tela inteira, como uma página web de verdade
- **O que você vê:** o botão ⤢ do card de tela aberta **de borda a borda**: a tela gerada ocupa 100% da altura e da largura, sem moldura escura, sem margem e sem cantos arredondados. Sobram só a barra fina de cima (título, download, fechar) e o Esc continua fechando.
- **Por que:** pedido do dono (27/10) — "quando clicar em expandir tinha que literalmente ocupar a tela inteira, sabe como se fosse uma página web mesmo". Antes, o "tela cheia" era um quadro centralizado (92% da altura, largura máxima e fundo escuro ao redor).
- **Como funciona:** mudança só no visual do overlay do card (duas classes de estilo); o iframe sandboxizado, o download e o Esc não mudaram.
- **Como é provado:** typecheck + build limpos; suíte completa sem falhas; medição na tela (o overlay cobre 0,0 até a largura e a altura completas do viewport) e foto.

## v3.24.0 (27/10) — O código da tela aparece sendo digitado
- **O que você vê:** quando o agente escreve uma tela, a página nasce **à vista**: um bloco logo abaixo da conversa mostra o HTML sendo digitado, com o cursor piscando no fim e o contador de linhas e caracteres crescendo. Quando fica pronta, o bloco recolhe e o card com a prévia funcional assume; "código da tela" reabre para conferir o que foi escrito.
- **Por que:** pedido do dono (27/10) — "queria muito poder ver o streaming digitando o código do preview, do jeito que está eu não vejo". Antes, o código só existia dentro do card, depois de pronto.
- **Como funciona:** o servidor passou a repassar os pedaços dos argumentos da ferramenta de tela (`onArgs`) e a extrair dali o campo `html` já desescapado (`htmlParcial`), emitindo o evento `codigo` no stream com só o que ainda não foi mostrado. A tela acompanha e vai emendando os pedaços na bolha; nada disso volta para o modelo.
- **Como é provado:** typecheck + build limpos; suíte completa com bloco novo `v3.24` (provedor falso em SSE escrevendo os argumentos em 7 pedaços: o código chega em pedaços, o texto remontado é **exatamente** o HTML escrito, o código nasce antes do card, a resposta final não repete o HTML e a tela chega pronta no fim).

## v3.23.0 (26/10) — O agente desenha a tela e ela funciona no chat
- **O que você vê:** quando o pedido é visual — gráfico, painel, comparativo, tabela, formulário, simulador — o agente escreve a página e ela aparece na conversa como um **card com prévia que funciona**: botão clica, campo digita, conta e desenho acontecem ali mesmo. Cada card tem título, botão de **tela cheia** (⤢), **download do arquivo .html** (↓) e fecha no Esc.
- **Por que:** pedido do dono (26/10) — "o agente gera o HTML e eu vejo o resultado funcionando, clicando". Antes, só dava para ler o código.
- **Como funciona:** nova ferramenta `mostrar_tela` (HTML + CSS + JS numa página só, sem internet, teto de 3 telas por resposta). O modelo recebe de volta só uma linha dizendo que a tela apareceu — o HTML não volta para ele, então a conversa não gasta a janela à toa. As telas ficam gravadas junto da mensagem: reabrir a conversa devolve os mesmos cards.
- **Segurança:** a prévia roda isolada, sem acesso ao painel, ao login ou aos dados da sessão; só o desenho e os cliques dela funcionam.
- **Como é provado:** typecheck + build limpos; suíte completa com bloco novo `v3.23` (ferramenta na porta MCP, página montada a partir de fragmento, página inteira não duplicada, recusa de HTML vazio/sem marcação, teto de 3 telas com aviso e telas gravadas lidas de volta no histórico).

## v3.22.0 (26/10) — O chat ficou mais enxuto: exemplos prontos, ajustes num menu e ações no hover/toque
- **O que você vê:** a conversa vazia agora abre com boas-vindas + 4 exemplos prontos (um clique preenche a pergunta e foca o campo); o rodapé ficou só com engrenagem + campo + microfone + enviar; provider, modelo, exportar e nova conversa moram no menu "⚙ ajustes da conversa" (abre no toque, fecha fora dele ou no Esc); as ações da mensagem (copiar/regenerar/editar) ficam invisíveis e aparecem no hover (mouse) ou no toque (celular).
- **Por que:** maquete de UX aprovada em 26/10 (`sketches/chat-ux`) — a tela tinha 4 controles no rodapé competindo com o campo e as ações da mensagem sempre visíveis; o pedido era piso enxuto e ações sob demanda.
- **Como é provado:** typecheck + build limpos; suíte e2e completa 24/24; hover e toque validados ao vivo no browser (regra CSS ativa + toggle `data-acao` no clique).

## v3.21.2 (26/10) — O tipo de conexão ficou só com duas opções: OpenAI compatível e Ollama
- **O que você vê:** no cadastro/edição de provider, o menu "tipo" agora tem só duas opções — **OpenAI compatível (llama.cpp, LiteLLM, vLLM...)** e **Ollama local**. A opção "LiteLLM" saiu: era a mesma conexão que "OpenAI", só com nome que confundia. A tabela de providers também passa a mostrar "openai" no lugar de "litellm" nas linhas já cadastradas.
- **Por que:** o dono viu o menu e achou estranho/redundante — "LiteLLM" não descrevia a conexão (qualquer API no padrão OpenAI funciona ali), e o dono mandou manter só Ollama + OpenAI compatível (decisão de 26/10).
- **Como é provado:** typecheck + build limpos; suíte e2e completa 24/24 (o contrato REST não mudou — só o rótulo do menu).

## v3.21.1 (26/10) — Provider virou uma seção só: tabela com o padrão da casa na linha 1
- **O que você vê:** as abas "Provider do chat" e "Provedores nomeados" viraram **uma seção — Provider**: uma tabela onde a linha 1 é o **padrão da casa** (o ex-provider do chat, com o form completo dele: modelo, URL, chave, system prompt, memória, janela, silêncio...) e as linhas seguintes são os providers nomeados. Cada linha tem **editar** (o form abre embaixo da tabela, com **cancelar**), os nomeados ganham **apagar**, e o botão virou **+ novo provider**. No chat nada muda: a régua provider+modelo do rodapé (v3.19) já escolhia entre todos.
- **Por que:** o dono viu os dois lugares lado a lado e achou melhor UMA visão — criar, editar e apagar provider num lugar só, com o padrão da casa como linha de primeira classe (decisão do preview estático aprovado em 26/10).
- **Como é provado:** typecheck + build limpos; suíte e2e na sequência (o contrato REST não mudou — só o front foi unificado).

## v3.21.0 (26/10) — As seções de Configurações moraram no menu lateral
- **O que você vê:** ⚙ Configurações no menu lateral agora **abre as seções logo abaixo** (Provider do chat, Limites, etc.) — um toque e você está na seção que precisa, com a seção aberta destacada no menu. A tela de Configurações ficou mais limpa: a faixa de botões que trocava de seção no topo saiu, e o subtítulo do título mostra em qual seção você está.
- **Por que:** as seções eram alcançadas por botões dentro da própria tela — o menu lateral virou a navegação única, como a política de 26/10 já previa para seção de uso direto.
- **Como é provado:** suíte completa 24/24 verde no ambiente limpo; cliques reais em desktop 1440 (abrir/fechar o submenu, destaque da seção ativa) e no celular 390 (submenu dentro da gaveta, Esc fecha a gaveta).

## v3.20.0 (26/10) — A página inteira olhada com olhos de 1920
- **O que você vê:** no desktop largo, Configurações parou de ter "títulos órfãos" — a coluna de seções é uma lista com superfície própria; os campos do formulário ficaram em grade honesta (pares com a mesma largura, linha tripla de tokens com três colunas iguais, campo solo ocupa a largura toda); o menu lateral mostra **um verde por vez** (ou o pai, ou o filho marcado) e os filhos ganharam a linha-guia da árvore sem sair do alinhamento.
- **O que acontecia:** o dono mandou um print em 1920×1080 e viu o que minhas medições não viam — eu media o componente isolado em janela padrão; composição de página inteira, no estado rolado, não estava no meu ciclo.
- **Como é provado:** medição agora nas três larguras (1920, 1440, 390) com a seção rolada: lista de larguras de campo uniforme, uma barra ativa por nível, zero estouro. A etapa virou regra permanente da skill do arquiteto (referência nova `composicao-pagina.md`).

## v3.19.2 (26/10) — Lateral calibrada no pixel
- **O que você vê:** o menu ficou uma coisa só — o texto dos itens do submenu começa exatamente na mesma linha do texto dos itens de cima (antes: 6px de desvio), pais e filhos têm a mesma altura de toque (44px; antes: o filho era mais alto que o pai), o submenu deixou de ser cinza "fantasma" e usou a mesma cor dos itens do topo, e a seta de expandir virou um chevron que gira ao abrir. As legendas do cartão de gaveta/modelo subiram de tamanho (eram quase ilegíveis no escuro).
- **Por que:** o dono olhou o print e chamou de "menu horroroso" — nenhum teste numérico antigo capturia desalinhamento óptico; a medição agora é x por x, altura por altura, antes de publicar.

## v3.19.1 (26/10) — Configurações ganhou submenu no menu principal
- **O que você vê:** o item ⚙ Configurações do menu principal agora tem seta e **abre as seções como filhas indentadas** (Provedores, Ferramentas, Conta, Limites...); cada filho leva direto à seção, com a marca de qual está aberta. O acordeon dentro da tela continua e fica sincronizado com o menu.
- **Por que:** o serviço novo de provedores tinha entrado só como aba interna — a política do dono (26/10) é seção de uso direto nascer no menu, não escondida. Alvos de toque medidos: 44px no desktop e no celular, sem estouro horizontal na gaveta.

## v3.19.0 (26/10) — Você escolhe QUAL serviço responde, e os modelos aparecem sozinhos
- **O que você vê:** no chat, acima da linha de digitar, uma régua com o **seletor do provedor** ("padrão da casa" ou qualquer serviço cadastrado) e, ao escolher, o **seletor do modelo** já preenchido com a lista que o próprio serviço devolve. Cada resposta ganha no rodapé o selo **"via <provedor>"** — e o selo sobrevive ao reabrir a conversa. Em Configurações entrou a aba **Provedores nomeados**: cadastre nome + URL + chave uma vez (a chave mascarada volta, nunca em claro), toque em **descobrir modelos** e o painel monta a lista — igual ao Open WebUI e ao Hermes, que leem `GET /models` do serviço (com fallback `/v1/models` e `/api/tags` do Ollama). O botão **padrão** elege quem responde quando ninguém escolhe; **servir para todos** publica global, desmarcado fica no teu escopo. No celular os seletores têm 44px de alvo de toque e a régua rola na horizontal sem quebrar a página.
- **O que acontecia:** dava para cadastrar vários provedores, mas a conversa sempre usava UM — trocar de modelo era entrar em Configurações, mexer três campos e voltar. A lista de modelos era digitada na mão e ficava velha.
- **Como é provado:** bloco próprio na suíte (17 checagens: comum lê, só operador escreve, chave nunca em claro, descoberta grava cache datado, resposta vem do modelo pedido, histórico guarda provedor+modelo, inexistente/desligado/modelo fora da lista são recusados, tarefa carrega a escolha até o fim). Tela medida: régua com os dois seletores, "eco-ui:gpt-grande" respondido pelo escolhido, selo "via ui-sonda", 44px no 390×844.

## v3.18.1 (25/10) — Configurações no celular pararam de exigir peregrinação
- **O que você vê:** a lista de categorias de Configurações virou **acordeon no celular** — toca em "Ferramentas (MCP)" e ela abre embaixo de si mesma, com seta girando; na tela larga continua menu à esquerda e conteúdo à direita. A fileira **testar conexão / salvar** do provider agora **cola no pé da tela** enquanto você preenche (antes ficava a duas telas de rolagem dos campos). Itens da lista ganharam altura de dedo (44px) e o cabeçalho do provider não deixa mais um "·" solto quando a linha quebra.

## v3.18.0 (25/10) — O chat aprende o básico que todo assistente já fazia
- **O que você vê:** apareceu botão **parar** (quadrado) na linha de digitar enquanto a resposta sai — aperta, corta no servidor, e o texto que já veio fica na tela e na gaveta. A última resposta ganhou **↻ regenerar**; cada pergunta ganhou **copiar** e **✎ editar e reenviar** (editar corta o histórico dali para frente, como nos assistentes maduros). Respostas que a busca ajudou mostram **chips com os documentos de origem**; cada balão agora tem **hora**, as respostas trazem **~N tok**, bloco de código ganhou **barra com idioma + botão copiar + cores**, tabela markdown chegou **com borda e rolagem no celular**, imagem na resposta **vira figura**, e há botões novos: **🎤 ditar** (Chrome/Edge), **⤓ exportar** a conversa em markdown, e a barra lateral de gavetas ganhou **rótulo renomeável, 📌 fixar e 🗄 arquivar** — com a primeira conversa de cada gaveta ganhando **título automático**. Na página Gavetas, um campo **"buscar dentro das conversas"** acha frases que você já escreveu na história, não só documentos.
- **O que acontecia:** faltar tudo isso. A varredura contra Open WebUI/Hermes (docs/proximos-passos.md, T001–T022) mediu 22 lacunas; este lote fechou 21 no código — e revelou 2 falsos pendentes (o botão "↓ fim" e o CSS de tabela já existiam; a análise antiga procurou por rótulo, não por comportamento). O Enter que aceitava sugestão do teclado e **enviava a pergunta pela metade** no celular foi a correção mais barata e mais diária do lote. O erro de envio agora tem botão **↻ tentar de novo**, o texto digitado **sobrevive à troca de gaveta**, e com o teclado aberto a barra de digitar **sobe junto** em vez de sumir.
- **Embrulho técnico:** tarefa de servidor ganha `POST /chat/tarefa/:id/cancelar` (o AbortController que faltava entre a tarefa e o provedor — o parcial já existia); `POST /chat/regenerar` e `POST /chat/reenviar-corte` cortam histórico e a tela reenvia pelo caminho normal (uma via de tarefa só); `GET /chat/mensagens?q=` (ILIKE, trecho ±80, dono respeitado); `PUT /gavetas/meta` com `titulo/fixada/arquivada` na tabela que já existia; coluna `custo` + coluna `fontes` (esta morta desde o 2.0) passam a ser escritas pela busca interna; título automático roda pós-tarefa sem nunca atrasar a resposta (erro engolido); realce de sintaxe é heurística de 1 passada sem dependência nova; ditado é Web Speech do próprio navegador.

## v3.17.0 (25/10) — O pé do chat no celular vira uma régua só
- **O que você vê:** no celular, a linha de digitar fica alinhada: campo, botão de enviar e "nova conversa" vivem no mesmo centro de 48px — sem o degrau entre as alturas, e o texto do campo não nasce mais meio comido pela borda de baixo.
- **O que acontecia:** cada peça tinha sua altura (campo 35, enviar 40, nova 44) e a barra alinhava tudo por BAIXO; o placeholder do estado "trabalhando" era longo demais para a tela estreita, quebrava em duas linhas dentro de uma caixa de uma linha só, e a segunda linha era cortada no meio dos caracteres. Agora: barra e botões centrados; placeholder em linha única com reticências quando não cabe, e a frase da fila encurtada ("próxima pergunta… (fila)").

## v3.16.9 (24/10) — A raiz FINAL da tela preta: ninguém sai com matador solto
- **O que você vê:** a janela abre viva em toda troca e em todo dois-cliques — o preto intermitente que sobreviveu a todas as correções anteriores tinha uma briga de tempo como causa.
- **O que acontecia (provado por print na Noot):** ao sair para dar lugar ao cliente novo, o velho mandava matar as janelas do perfil **sem esperar**. A varredura lenta chegava atrasada e matava os processos de desenho do navegador **recém-nascido do sucessor**: quadro de janela vivo, corpo preto. Agora a limpeza é synchronous e só toca em processos com mais de 5 segundos de vida — o browser novo é intocável por construção.

## v3.16.8 (24/10) — Testa o ciclo completo de atualização automática
- **O que você vê:** nada muda na tela; esta versão existe para provar o ciclo inteiro — o servidor anuncia, a máquina baixa, se troca, relança e **abre a janela nova sozinha**, com os tempos cronometrados pelo log dela.

## v3.16.7 (24/10) — Cabeçalho da janela não mostra mais "porta undefined"
- **O que você vê:** o canto superior direito da janela mostra `v3.16.7` e, junto, a porta local — sem o texto "undefined" quando o aviso chega sem esse dado.

## v3.16.6 (24/10) — A causa final da tela preta: a janela não nasce mais escondida
- **O que você vê:** a janela do painel abre viva, sempre. Teste lado a lado na Noot: a MESMA janela com os mesmos ajustes — aberta por um processo visível, renderiza; aberta por processo que a esconde no nascimento, fica preta.
- **O que acontecia:** o cliente escondia a janela no momento de criar (herança de época em que havia console). Janela que nasce escondida é "mostrada" pelo navegador sem nunca ter pintado o primeiro quadro — e aí fica o retângulo preto para sempre. Removido o esconder: sem console, sem motivo para esconder.
- **v3.16.5 (mesma noite)** adicionou desenho por software (`--disable-gpu`), que fica como seguro extra; a leitura do A/B apontou que o preto vinha do esconder, não da placa de vídeo.

## v3.16.4 (24/10) — A janela abre sempre nova, e no tamanho compacto
- **O que você vê:** ao abrir o cliente, a janela do painel é menor (700×560, do jeito que ficou aprovado no teste) e **nunca mais abre preta**.
- **O que acontecia:** reabrir o cliente entrava no MESMO processo de janela da vez anterior — se ele já estava com o desenho quebrado (tela preta), a janela nova nascia dentro do quebrado e herda o preto. Agora o cliente descarta o processo de janela antigo do seu próprio perfil antes de abrir a nova; janelas normais do seu navegador não são tocadas.

## v3.16.3 (24/10) — Uma janela só: o cliente velho fecha a própria tela ao se trocar
- **O que você vê:** depois de uma atualização automática, continua existindo **uma** janela do cliente — antes ficava aberta também a tela velha, congelada, do processo que saiu.
- **O que acontecia:** a janela é um processo separado do programa; quando o programa antigo saía para dar lugar ao novo, a tela antiga ficava viva na barra.

## v3.16.2 (24/10) — O servidor passa a registrar a versão do seu cliente
- **O que você vê:** nada muda na sua tela; o cliente apenas informa a própria versão quando conecta.
- **Por que este envio existe:** para provar, do lado do servidor, que a troca automática terminou — quando a máquina aparecer no log com `vers=3.16.2`, é prova de que ela se atualizou sozinha.

## v3.16.1 (24/10) — A janela do cliente parou de ficar em branco
- **O que você vê agora:** ao abrir o cliente, a janela mostra a conexão, a máquina, as atualizações, os comandos recebidos e o log — tudo se mexendo ao vivo.
- **O que acontecia:** a janela ficava parada em "carregando…" e o log vazio, mesmo com o programa funcionando e recebendo os comandos por trás.
- Causa: um `;` esquecido no código da janela. Efeito: o navegador não conseguia executar o script da página e a tela congelava. Correção: ponto e vírgula de volta; janela validada (script compila, todos os elementos existem).

## v3.16.0 (24/10) — A tela do chat virou só conversa; o resto foi para a lateral

- **O que doía**: para ler uma resposta, competiam na tela o cabeçalho ("Chat" + chip ◉ que repetia o "foco" da lateral), a pílula de topo (modelo + gaveta), o botão de reset no canto, a dica "Enter envia", a linha "› ver detalhes" do provider e o rodapé técnico (versão, atalhos de outro lugar, frase de marketing). O pedido do dono: "tira as coisas que estão na tela" — aprovado em preview (variante A + botão de conversa nova no pé, lado oposto ao enviar).
- **Como ficou**: a **lateral** ganhou o bloco *conversa* (gaveta seletora + modelo em uso + "› ver detalhes" com provider/chave/MCP — a única fonte dessas info para o usuário comum) e passou a ser a **casa única da versão**. A **tela do chat**: sem cabeçalho, sem pílula, sem rodapé; a conversa começa no topo. No **pé**, uma linha: `[nova conversa] [campo…………] [↑]` — a ação de recomeçar mudou de lado e desceu para perto do dedo (checklist G1T03, de 21/10, já pedia "nova conversa no pé, nada de ação no topo"). A dica de teclado vive no título (hover) do campo; "trabalhando em segundo plano" desceu para o piso.
- **No celular**: a linha do topo só existe como porta ☰; "nova conversa" vira ícone de **44×44** ao lado do campo; gaveta/modelo moram dentro da gaveta ☰. Sem overflow horizontal (medido a 390).
- **Portão**: `tsc` dos dois lados + `vite build` sem erro; suíte completa no ambiente de testes (exit 0); telas medidas em 1440 e 390 antes da publicação.

---
## v3.15.1 (24/10) — A caixa de digitação deixou de ser cápsula gorda

- **O que doía**: o campo de escrita media **60 px de altura para uma linha de 14,5 px** (o texto ocupava 24% da caixa), com **raio 26 px** — metade exata da altura, então virava cápsula fechada nas duas pontas — e botão circular de **42 px** lá dentro, brigando com o texto por peso visual. Foi o Mauricio que apontou no print ("desproporcional, feio"); medi no ambiente de testes em vez de chutar.
- **Como ficou**: **48 px de altura (medido 50 com o padding), raio 12 px, botão 34×34 com canto de 10 px e glifo de 16 px, texto 15 px**. A linha de texto passa de 24% para **44% da altura interna** — a mesma proporção do IA_GO, que é a referência da casa (campo com `minHeight: 48`, `text-sm` de 21 px = 44%, raio `rounded-xl` de 12 px — lido no `ChatInput.tsx` dele, não estimado).
- **No celular**: caixa de 62→**54 px**, raio 22→12, botão 44→**40 px** (mantendo o alvo de toque acima de 40; a pílula inteira é clicável para focar o campo, então quem toca não depende só do botão).
- **O que NÃO mudei de propósito**: a largura. A pílula faz **780 px, a mesma da coluna da conversa** (medido em 2560, 1920 e 1440) — encolher ela desalinharia do balão da resposta. O "vão" que sobra para uma frase curta é o campo crescendo junto com o rascunho, como sempre.
- **Conferido por medida (não por print)**: centro do campo vs centro do botão = **1 px** com uma linha; com três linhas de rascunho a caixa cresce para 72 px e o botão **fica colado embaixo** (mesmo comportamento de antes). O modelo de visão, olhando o recorte, apontou "texto no topo, botão centralizado" — a medição diz que é 1 px, então deixei como está e registre aqui que discordei do olho com número.
- **Testes**: mudança de tela e CSS; nenhum contrato toca geometria. Rodada a **suíte completa no ambiente de testes** (não filtrada) com os totais do log inteiro, e o portão `tsc` + `vite build` dos dois lados com zero erro.

## v3.15.0 (24/10) — O chat ganhou o Rastro do turno do jeito do IA_GO

- **O que doía**: o pensamento, as falas de caminho e as ferramentas viviam em três lugares diferentes (o bloco "Pensou por Ns", balões soltos no meio da conversa e a linha dobrada "ferramentas chamadas"). Não dava para ver o turno como uma história: o que ele pensou, o que disse no caminho, o que consultou e quanto cada passo demorou — e, ao reabrir a conversa, a ordem entre as rodadas estava perdida (o banco guardava um `raciocinio` único, sem posição no tempo).
- **O que muda**: uma trilha só por turno, na ordem real — `Rastro do turno · N etapas · Ns` — com bolinha e cor por tipo: pensamento em roxo com o tempo dele, fala de caminho em cinza, ferramenta em azul ("Consultando a busca semântica · 2s ✓"), cada linha abrindo o detalhe (argumento e resumo) da ferramenta. Aberto enquanto o turno vive, recolhido quando acaba; clicar na etiqueta grava a preferência (`nexos:rastro-expandido`) e ela vale para todas as mensagens, igual ao IA_GO. O bloco de pensamento continua colado na última linha que chega (v3.14.2) e para de puxar se você subir lá dentro.
- **Como**: o servidor agora grava a trilha na mensagem (`chat_mensagens.rastro JSONB`, coluna aditiva criada com `ALTER TABLE ... IF NOT EXISTS` no mesmo molde de `falas`), no formato `[{tipo:"pensamento",texto,ms},{tipo:"narracao",texto},{tipo:"ferramenta",servidor,nome,ok,ms}]`, e devolve no `fim` e no `GET /chat`. O tempo do pensamento para de contar quando a rodada DECIDE (fala, chama ferramenta ou responde) — senão o "Pensou por Ns" engoliria o tempo da ferramenta. A fala de caminho deixou de ser balão solto e passou a viver dentro da trilha (era esse o jeito do IA_GO); a linha dobrada de ferramentas saiu quando existe trilha, porque a trilha já mostra cada passo.
- **Degradação honesta**: conversa antiga não ganha rastro inventado — mensagem sem `rastro` continua desenhando o bloco "Pensou por Ns" de antes e a linha dobrada de ferramentas. Turno sem streaming (superfície MCP) grava trilha vazia, porque sem stream não há como medir o tempo de cada passo.
- **Como conferir**: pergunte algo que use ferramenta e deixe o bloco aberto: a trilha cresce na ordem (pensando… → fala → Consultando … → pensando de novo) e fecha sozinha no fim. Clique na etiqueta, recarregue a página: continua aberta. Reabra a conversa no dia seguinte: a trilha está lá, com o tempo de cada passo.
- **Testes**: **`v3.15` (novo, 10 OK)** na suíte de contrato com provedor falso de duas rodadas em streaming: ordem `pensamento>narracao>ferramenta>pensamento`; blocos de pensamento com tempo MEDIDO (837 ms e 604 ms); ferramenta `list_gavetas` com `ok=true` e `ms`; a fala de caminho está na trilha e NÃO engoliu a resposta; `GET /chat` devolve a mesma trilha; os campos antigos (`ferramentas`, `falas`, `raciocinio`) continuam vindo; turno sem streaming pelo MCP fica com trilha VAZIA e a resposta intacta. Tela (Playwright, 390×844, provedor falso de 30+ passos): etiqueta `Rastro do turno · 4 etapas · 3s` crescendo durante o turno, `folga 0` no bloco de pensamento com 311 px de texto numa caixa de 160 (acompanha a escrita), um único balão de IA (a fala não virou balão solto), ponto roxo realmente pintado (`rgba(163, 113, 247, .8)`), linha `Consultando a busca semântica · 1s ✓ · detalhe` abrindo `{"k":3,"query":"nota fiscal setembro"}` + o retorno, e a preferência sobrevive ao recarregar (`localStorage=1`). Portão: `tsc` backend/frente/testes com zero erro e **suíte completa no ambiente de testes: exit 0 — 22 testes, 0 falhas, 21 blocos somando 388 checagens**. Correção honesta: as publicações v3.14.1/v3.14.2 anunciaram 316/319 checagens porque a soma foi feita só nos blocos `v2./v3.` visíveis no log recortado; a suíte inteira (com v1.8, MCP, arquivos, imagem/OCR e rate-limit) soma 378/388 — testes e falhas sempre corretos.

## v3.14.2 (24/10) — O pensamento acompanha a escrita no celular

- **O que doía**: o painel de raciocínio tem altura própria (160px com rolagem). Enquanto o modelo pensava, o texto novo entrava por baixo e ficava fora de vista: o painel parava no começo do pensamento em vez de mostrar a linha que estava nascendo — em celular, onde só dá para ver o painel, isso virava "travou".
- **O que muda**: enquanto escreve, o painel fica colado na última linha que chegou. Se você subir lá dentro para reler, ele para de puxar e te deixa em paz; volta a colar quando começa uma resposta nova. E a conversa agora desce junto durante o pensamento (antes ela só acompanhava o texto da resposta, ignorando o raciocínio que cresce por dentro do painel).
- **Como conferir**: no celular, pergunte algo que faça o modelo pensar longo e deixe o painel aberto — a última linha visível é sempre a que acabou de chegar. Suba com o dedo dentro do painel: ele para de seguir.
- **Testes**: 1 arquivo tocado; **`provedor_longo` (novo)**: raciocínio em 35 pedaços num painel de 158px — amostras a cada 300ms: enquanto colado, a folga do painel fica em 0 (162→535px de conteúdo, `scrollTop` 4→377 acompanhando); aos 4s, um scroll para o topo dentro do painel → folga 415→508 e ele **para** de puxar; no fim, painel fecha. Amostra do meio do pensamento: `folga_painel=0`, última linha visível "linha 22 do raciocinio…", base do painel em 721px duma tela de 844 e campo de escrita a 766 (tudo dentro da tela), `folga_area=0`. Portão: `tsc` dos dois lados zero erro, `/health` 3.14.2, blocos v3.1 (3 OK) e v3.13.1 (9 OK). Suíte completa refeita antes do publish: exit 0, 21 testes, 0 falhas (o contrato não cobre CSS; a tela foi medida à parte, como acima).

## v3.14.1 (24/10) — O chat do celular vira a tela inteira

- **O que doía**: a conversa ainda morava dentro do casaco do app — o cabeçalho do app em cima, um cartão com borda e canto arredondado por volta, e embaixo a faixa com "versão", os atalhos do editor e a assinatura. Num celular de 390 isso comia ~85 px de altura e 32 px de largura, com duas linhas de topo disputando espaço.
- **Uma linha de topo só**: no celular o cabeçalho do app sai e o menu ☰ passa a viver na própria linha do chat (medido 44×44, abre a gaveta de navegação com o usuário em foco dentro; Esc fecha a gaveta — antes só fechava clicando no escuro). Medido em 390×844: topo do chat em y=0, 53 px de altura.
- **A conversa deixa de ser cartão**: borda 0px, fundo transparente, raio 0px — de ponta a ponta, com 12 px de respiro, mesma coluna de antes.
- **Sobrou largura para escrever**: o campo foi de **266 px a 300 px** no celular de 390 (saíram as margens do palco) e continua dentro da pílula de 62 px que cresce até 5 linhas. `scrollWidth == 390` (nada estoura para o lado) e o campo termina a 799 px de uma tela de 844 (nada passa do fim).
- **A faixa de baixo do app some no chat**: versão, "Ctrl+S salva · Esc fecha o editor" e assinatura ficam só nas outras telas — no celular. O desktop não mudou (medido: cartão com borda 1px, raio 18px, campo de 704 px, cabeçalho e rodapé no lugar).
- **Ficou de fora de propósito**: o chip de usuário do topo não foi apagado — mudou de lugar (vira a linha "foco: ..." dentro do menu ☰), porque no celular o topo agora é uma linha só.

## v3.14.0 (23/10) — o chat cabe no celular

- **O que doía**: na tela do celular a barra de escrita dividia a MESMA linha com os botões "nova conversa" e "enviar" — sobravam uns 120 px para digitar (o placeholder aparecia cortado em "pergunte qualq") e o rodapé técnico, com 8 informações numa linha só, saía da borda direita.
- **O campo agora é a linha inteira**: pílula de escrita de ponta a ponta — medido no painel rodando, **266 px de campo** num celular de 390 (antes ~120) — e ela cresce sozinha até 5 linhas em vez de esconder o que você digitou. No celular o clique em qualquer ponto da pílula coloca o cursor dentro (o alvo de toque é a pílula de 62 px, não a linha de 34 px).
- **Altura honesta, não chutada**: a conversa vivia num cartão de altura fixa (`68vh`), que no navegador do celular ficava maior que a tela e empurrava o campo para fora. Agora a caixa pega exatamente o que sobra da janela (`100dvh`, com folga para a barra de gestos). Medido em 390×844: nada passa do fim da tela e `scrollWidth == 390` (nada estoura para o lado).
- **Resposta sem moldura**: o texto do assistente é texto solto na coluna (balão só na sua fala), o raciocínio virou a pílula "Pensou por 2s ›" que abre ao toque, e cada resposta pronta ganhou um botão **copiar** (com reserva para o painel servido em http, onde a área de transferência do navegador pode não existir).
- **Cabeçalho enxuto**: o seletor de gaveta virou uma pílula com o modelo em uso dentro dela; "nova conversa" subiu para o cabeçalho e no celular é só ícone; o subtítulo "— conversa com o modelo e as ferramentas do MCP" saiu (o topo do app já diz "Chat").
- **Rodapé técnico dobrado**: uma linha com o essencial ("modelo · global · › ver detalhes"); o resto abre ao toque. No celular a máscara de chave sai da linha — continua dentro do detalhe.
- **Ficou de fora de propósito**: microfone e botão "+" (no nexos nenhum dos dois teria o que fazer, e controle mudo não vai para a tela) e "refazer a resposta" (regenerar exige mexer no histórico lá no servidor, o que ainda não existe).


## v3.13.1 (23/10) — o cliente para de ficar mudo quando o servidor reinicia

- **O defeito, do jeito que tu viste**: publiquei uma versão nova, o servidor reiniciou no meio do pedido de conexão e o programa ficou com a janela aberta, escrito "desconectado", **sem nunca mais tentar**. Baixar o cliente novo também não adiantava: o arquivo novo via o programa travado na porta, abria a janela *daquele* e se fechava.
- **Por que travava**: a ordem de tentar de novo estava pendurada num único aviso (o de conexão fechada). Quando o pedido de conexão é abandonado no meio, o motor do executável entrega o aviso de *erro* e nunca entrega o de fechamento — e o laço morria ali. A janela continuava aí, viva, fingindo que estava tudo certo.
- **Agora o laço não depende de sorte**: qualquer saída (erro, conexão que fecha, o relógio dos 15 segundos) já remarca a tentativa seguinte na mesma escada (0,4 s até 30 s), e um vigia acorda a cada 30 segundos: se a hora marcada passou e ninguém tentou, ele recomeça. Medido com um servidor que engole a conexão: a versão antiga fez **1 tentativa em 45 segundos**; esta fez **3** e seguiu tentando.
- **Dois cliques no arquivo novo voltam a resolver**: ele pergunta ao outro programa da máquina se aquele está *conectado*. Se está, abre a janela dele e sai (como antes). Se está vivo mas sem conexão, pede para ele sair e **assume** o lugar.
- **A janela conta a verdade**: enquanto estiver desconectado mostra "última tentativa há Ns — o programa continua tentando sozinho", em vez da tela parada que não dizia se estava vivo.
- **Do lado do servidor**: cada conexão de máquina que cai agora registra o código do fechamento e por quanto tempo viveu, e as recusas que antes eram mudas passam a aparecer no log. Na próxima vez o motivo sai do servidor, sem depender do arquivo de log da máquina.

## v3.13.0 (23/10) — o chat mostra o que o modelo está pensando

- **Bloco de raciocínio ao vivo**: enquanto o modelo pensa, aparece `🧠 Pensando… Ns` com o texto do raciocínio; quando a resposta começa, recolhe em `🧠 Pensou por Ns` (clicável para reabrir) — o mesmo desenho do Open WebUI ("Thinking…" → "Thought for Ns").
- **O raciocínio não vem mais misturado com a resposta**: o servidor lê o campo próprio do modelo (`reasoning_content`, `reasoning` ou `thinking`) e manda num evento separado; modelos que não expõem raciocínio seguem como antes, sem bloco nenhum.
- **Fica gravado**: o raciocínio é salvo junto da mensagem, então ao reabrir a conversa o bloco continua lá, recolhido. Nada dele entra no contexto enviado ao modelo nas próximas mensagens.

## v3.12.2 (23/10) — a janela acompanha o programa ao vivo e não fica presa

- **A janela se atualiza sozinha**: quando o programa conectava, a janela continuava escrita "desconectado" até alguém recarregar — ela só entendia avisos que traziam tudo de uma vez e ignorava os avisos de "conectou", "baixando atualização" e "comando recebido". Agora ela acompanha os três ao vivo (provado num navegador de verdade: abre em "desconectado" e vira "ONLINE" sem recarregar).
- **Fim da espera eterna**: se o pedido de conexão ficar pendurado (acontece no reinício do servidor durante uma publicação), o programa desiste em 15 segundos e tenta de novo, em vez de ficar parado para sempre como ficou hoje.

## v3.12.1 (23/10) — a janela do cliente voltou a mostrar dados

- **Causa raiz**: o script da página da janela tinha um `;` faltando e uma `}` não fechada, então o navegador **não executava nada**: a janela ficava em "carregando…" para sempre, sem pedir os dados ao programa e sem abrir conexão com o painel local. Corrigido e validado (o script compila e todos os elementos que ele usa existem na página).
- **Página sem cache**: o servidor manda a página com `no-store` e a janela abre com endereço novo a cada vez, para nunca reaproveitar uma página velha.
- **Nunca fica muda**: se o estado não vier, a página tenta de novo a cada 2 s e mostra "sem resposta do programa local — tentando de novo…" em vez de ficar parada; os eventos também reconectam sozinhos.

## v3.12 (23/10) — máquina apagada não volta sozinha e o cliente para de insistir

- **Apagar é definitivo**: a máquina removida no painel fica marcada, e o cliente que já está instalado **não** reativa com a chave antiga — ele avisa "máquina removida do painel — baixe um cliente novo". Cliente gerado depois da remoção entra normalmente.
- **Token morto não trava mais o programa**: se o servidor não reconhece o token guardado (máquina apagada por engano, banco restaurado), o cliente esquece esse token e tenta de novo com a chave do próprio arquivo, em vez de repetir o erro.
- **Fim do log gigante**: o log passou a girar por tamanho (2 MB) além dos 30 dias. Antes, uma recusa a cada 15 segundos enchia o arquivo em minutos.
- **Uma instância só**: abrir o programa de novo não cria outro cliente — ele abre a janela do que já está rodando.

## v3.11 (23/10) — o cliente abre a própria janela

- **Uma janela só**: o programa deixou de ser "janela preta + aba de navegador". O executável no Windows abre em modo aplicativo — janela própria, sem abas e sem barra de endereço — e é compilado **sem console**, então não aparece nenhuma janela preta.
- Se o Edge não existir na máquina, ele tenta o Chrome e, por último, o navegador padrão; o programa funciona igual.
- O painel local (status, máquina, atualização, comandos e log) continua o mesmo, agora dentro dessa janela.

## v3.10.2 (23/10) — a tela não fala mais de chave

- **Saiu o cartão "clientes gerados"**: gerar o cliente agora é só clicar e receber o arquivo. A chave que vai dentro do exe é detalhe interno — máquina nova aparece sozinha na tabela.
- **Bloquear ou cortar é por máquina**: o interruptor bloqueia sem apagar; "apagar" remove a máquina e o acesso dela, e voltar exige cliente novo.
- O arquivo baixado vale por um ano (antes, 24 horas): com a tela sem renovação, o instalador guardado não vence no dia seguinte. A API de chaves continua existindo para CLI e suíte.

## v3.10.1 (23/10) — o download do cliente virou link de verdade

- **Fim do "Precisa de autorização para transferir"**: a tela baixava por `fetch`+blob e o Edge/Chrome passou a bloquear os downloads seguintes da mesma página. Agora o botão pede um **bilhete** de uso único (2 min, preso ao usuário) e abre o download por navegação comum — sem blob, sem prompt de permissão.
- O bilhete não carrega a chave do painel: quem tem o endereço só consegue aquele download, uma vez. A rota com `Authorization` continua valendo para CLI e suíte.

## v3.10 (23/10) — um cliente para várias máquinas; bloquear é por máquina

- **A chave do cliente deixou de queimar na primeira máquina**: o mesmo arquivo baixado ativa quantas máquinas você quiser. A validade da chave passou a ser a **janela de ativação** (o cliente antigo, de uso único, recusava a segunda cópia com "chave já usada").
- **Cada máquina recebe token próprio** na primeira conexão: bloquear (interruptor) ou apagar uma não toca nas outras, e o nome da linha é o nome real do computador.
- **"Cancelar novas ativações"** substitui o antigo "cortar chave": apaga a chave, some com a possibilidade de ativar máquinas novas e **mantém** as que já ativaram. Apagar a máquina em si continua sendo ação da tabela.
- **Tela única**: a segunda tabela de chaves saiu; os clientes gerados viraram linhas compactas no cartão de binários, e a tabela de máquinas passou a mostrar o estado **bloqueada** (antes era um "desativada" solto embaixo do offline).

## v3.9 (23/10) — painel local do cliente + auto-update que não queima banda

- **Painel local no cliente**: com o cliente rodando, `http://127.0.0.1:48123` mostra numa página (sem internet, sem login) conexão/servidor/máquina, versão, atualização com barra de progresso, comandos executados e log ao vivo por SSE — a janela preta deixa de ser a única cara do programa. `--sem-janela` mantém só o painel.
- **Update: nada de sobrescrever o exe em uso** — o jeito limpo renomeia o vivo e põe o novo no lugar; se o Windows/antivírus negar (`EPERM`), a versão nova roda com **nome versionado** ao lado e o arquivo velho fica intacto. Acompanha rollback se a troca falhar no meio.
- **Sem loop de download**: versão que falhou fica em carência de 30 min (grava `tentou` na conf, que agora é mesclada, não sobrescrita) e o `.novo` é apagado na falha. Antes, cada reconexão rebaixava o exe inteiro.

---

## v3.8.2 (23/10) — um log só, 30 dias; progresso de download só na tela

- **Log único com memória de 30 dias**: no boot o cliente apaga linhas mais velhas que 30 dias, corta o topo se passar de 2 MB e **não cria mais o `.old` de log** (se o fósforo antigo existir, ele é removido). Um arquivo só para tomar conta de tudo.
- **Progresso não polui o log**: as linhas de porcentagem aparecem só na janela; o arquivo guarda apenas início da atualização, conclusão (MB/tempo) e a reabertura — três linhas por update.

---

## v3.8.1 (23/10) — auto-update do cliente: progresso visível e reabertura de verdade

- **Progresso no download**: `baixar()` mostra MB, % (a cada 5%), velocidade e a linha final com tempo na janela do duplo clique (a v3.8.2 depois tirou essas linhas do log — só a tela).
- **Reabrir como o Go fazia**: o sucessor nasce em JANELA PRÓPRIA minimizada (`start /min`, sem roubar a tela; Linux: sessão destacada). Antes o filho herdava o console do pai: o pai saía e a janela fechava com o agente vivo por trás.
- **Re-checagem em toda conexão** (herança Go v1.11): a novidade é consultada na primeira conexão e em cada reconexão, não só no boot.

---

## v3.8 (23/10) — o túnel inteiro na boca do agente + falas que ficam na tela

- **Vocabulário do túnel como ferramentas**: 20 nomes (`listar_arquivos`, `ler_arquivo`, `escrever_arquivo`, `buscar_arquivos`, `grep_remoto`, `editar_no_local`, `estado_maquina`, `processos`, `janelas`, `area_transferencia`, `falar`, `abrir`, `servicos`, `eventos`, `rede`, `esperar_arquivo`, `power`, `rodar_lote`, `sessao`, `git_remoto`) montados no servidor (`src/maquinas_tools.ts`: tabela nome→comando, PowerShell/sh por SO) e expostos no MCP, no chat e no REST da mesma porta — 46 tools no `tools/list` naquela versão (**49** hoje); o cliente Node não muda por verbo novo.
- **Governança**: `power` (qualquer ação) e `git_remoto` (commit, push, checkout) exigem `confirmar=true` — sem isso a chamada morre em 409 sem nada executar; serial por host; `sessao` abre/lista/fecha processo em segundo plano na máquina; `falar` fala texto (máx. 600 chars) via SAPI no Windows ou espeak no Linux.
- **Escrita de arquivo na máquina**: canal `GET /maquina/u?k=…` — os bytes ficam no servidor no máximo 5 minutos; a chave só serve para a máquina cujo host casa com ela e vale enquanto não expira (não é de uso único).
- **Chat**: as falas de caminho da rodada viram balões próprios na tela, voltam no histórico (`chat_mensagens.falas`); teto de `max_rodadas` subiu de 10 para **60** (validação, MCP e Configurações).
- **Auditoria**: `comandos_log.origem` alargada (16→64) e gravada como `canal:ferramenta` — o insert de ferramenta morria em silêncio no schema antigo.

---

## v3.7 (22/10) — cliente pronto do painel (chave assada, um arquivo, dois cliques)

- **`GET /maquinas/cliente/win|linux?nome=&tenant=`** (autenticado, mesmo escopo das rotas de
  máquina): gera o binário do **usuário que baixou** — o exe mestre da imagem ganha um trailer
  `JSON{v,k} + uint32BE(len) + "MRQK"` com a **chave única** (24 h de validade, uso único).
- **Ativação**: primeiro `oi` do cliente com a chave embutida cria a máquina (`chaves_cliente` →
  `usada, host_ativado`), o cliente **adota a chave definitiva** (arquivo de conf ao lado do usuário)
  e a chave do arquivo queima — cópia levada a outra máquina é recusada e a tentativa fica no log.
- **Corte no painel**: `DELETE /maquinas/chave/:id` — chave virgem some; chave ativada **apaga a
  máquina junto** e derruba a conexão na hora. A lista de chaves vem em `GET /maquinas` (`chaves[]`).
- **A chave de cliente NÃO é credencial de usuário**: jamais abre painel, chat, API ou MCP (401).
- **Sem autostart no boot** (decisão explícita do dono): conecta quando rodado e se reconecta
  enquanto aberto. O pareamento com comando continua como porta secundária.
- **Tela**: botão *⬓ gerar meu cliente* (Windows e Linux) no cartão Binários + carta "Chaves de
  cliente geradas" com estado (aguardando/ativada) e *cortar*. A carta "Conectar máquina nova"
  (comando com token) **saiu da tela por ordem do dono** — o cliente gerado é a única porta dele;
  o endpoint de pareamento continua no servidor para o MCP, discreto. (3.7.1)

## v3.6 — Máquinas por usuário: o túnel virou recurso do nexos (22/10/2026)

Cada usuário pode ter máquinas suas conectadas (o seu PC, o servidor dele), e o
chat / API / MCP executam comandos **apenas nas máquinas daquele usuário**.
Mesmo código, três portas — igual ao resto da casa.

- **Hub WebSocket**: `/maquina/ws` no MESMO servidor da app (Traefik com a
  receita de heartbeat 25s provada no agent-tunel; tags do wire intactas:
  `oi`, `cmd/{cmd,rotulo,espera}`, resposta `{exit,stdout,stderr}`).
- **Tabelas**: `maquinas` (dono = tenant; token em hash), `pareamentos`
  (uso único, ~15 min), `comandos_log` (auditoria SEM máscara — shell exige
  rastro completo). Apagar o usuário (carência v3.5) derruba as três.
- **REST** (chave do usuário; admin mira com `?tenant=`):
  `GET /maquinas` · `POST /maquinas {nome}` → token uma-vez ·
  `PATCH /maquinas/:host {ativo}` · `DELETE /maquinas/:host` ·
  `POST /maquinas/:host/run {cmd,timeout}` · `GET /maquinas/log`.
- **MCP**: 23 → 26 tools (`maquinas_online`, `rodar_comando`,
  `gerar_pareamento`) — o chat herda as três pelo pacote interno.
- **Cliente** (Go e PyInstaller ficaram para trás — antivírus): Node SEA,
  um arquivo sem instalação (`minirag-cliente-win.exe` / `minirag-cliente-linux`),
  assado na própria imagem (estágio `cliente` do Dockerfile, `scripts/build-cliente.sh`).
  Adota e guarda o token de máquina (`~/.nexos-maquina.json`), reconecta com
  backoff, mata ÁRVORE no timeout e se auto-atualiza comparando a versão do
  build com `GET /maquina/atualizacao`. Download na tela (`GET /maquina/cliente/win`).
- **Tela**: aba **Máquinas** (também para o usuário comum — é o "cada usuário
  com seu cliente" do dono): chip online, ＋ token uma-vez com copiar, botão de
  download, interruptor ativa/desativa e histórico de execução.
- **Honestidade antivírus**: exe não assinado que abre WebSocket de saída e
  espelha comandos é o comportamento que o heuristic marca, em qualquer
  linguagem. A cura definitiva é certificado de assinatura de código
  (decisão de orçamento); até lá, vale o caminho do túnel — exceção na
  máquina que confiar no cliente.

### Interruptor global de controle (3.6.1)

Configurações → Ferramentas (MCP) → cartão **Controle das máquinas**. Desligado pelo
operador, NINGUÉM executa comandos: o chat perde a ferramenta da lista, o MCP externo
esconde `rodar_comando` no `tools/list` e recusa a chamada (409), e a rota REST
`POST /maquinas/<host>/run` devolve 409 apontando o cartão. As máquinas continuam
conectadas e online na tela, listagem e histórico seguem lendo; o estado vive na tabela
`maquinas_cfg` (`controle_ativo`) com cache em memória relido no boot.

## v3.5 — Esquecimento com régua na tela e apagar usuário com carência (22/10/2026)

- **Três números, todos configuráveis** (antes só existia o primeiro, preso em 30 dias e
  só mexível no ambiente):
  - `dias_arquivar` — documento sem uso por N dias (e menos de `min_acessos` acessos) é
    **arquivado**: sai da busca padrão, **revive ao ser usado**. Padrão novo: **180 dias (6 meses)**.
  - `dias_excluir_arquivado` — arquivado encostado por mais que isto é **apagado de vez**
    (chunks, `documents`, original em `arquivos`). Padrão: **365 dias (1 ano)** — o "morrer
    depois de 1 ano, também configurável" que você pediu. Nunca toca documento vivo:
    exige `archived_at` preenchido em **todos** os pedaços.
  - `dias_carencia` — janela entre pedir o apagar de um usuário e a morte dos dados dele.
    Padrão: **30 dias**.
- **Editável na tela**: Configurações → **Esquecimento** ganhou os três campos + botão
  salvar. O que você salva ali **vence** o ambiente (gravado na tabela `esquecimento_cfg`;
  as variáveis viraram o default do boot). `GET /config` mostra os valores efetivos e a
  origem de cada um (tela/ambiente).
- **Apagar usuário agora funciona** (o botão existia só para gaveta, por isso o seu
  "apagar" do `teste` não fazia nada). `DELETE /usuarios/:nome`:
  - **desliga o login na hora** (chave do agendado devolve 401; o usuário some do chat e
    das listas de busca do painel, a linha fica visível com `agendado_exclusao_em`);
  - **agenda a exclusão dos dados** (gavetas, documentos, chunks, originais, jobs,
    chats e provider da pessoa) para o fim da carência;
  - **recriar o mesmo nome dentro da janela DESFAZ tudo** — o acervo inteiro volta com o
    login novo (`aviso` no 201 diz que a exclusão foi cancelada);
  - a **faxina** roda junto do loop do decay (e no `POST /decay` manual): estourou o prazo,
    apaga de vez. A resposta do `/decay` ganha `expurgo: {usuarios_apagados, docs_expurgados}`.
  - Guarda antiga mantida: não se apaga o último admin ativo (`409`).
- **Tela**: cada card de usuário (Gavetas) ganhou botão **apagar** em duas fases (um clique
  arma, o segundo "apagar de verdade?" executa) — quem tem exclusão agendada mostra o chip
  **⏳ some em DD/MM/AAAA — recriar desfaz** no lugar do botão.
- **MCP**: 23 tools — as 21 da v2.8 + `apagar_usuario` (admin) e `esquecimento`
  (`acao: "ver" | "definir"`, escrever é só do admin).
- **Contrato que mudou**: `DELETE /usuarios/:nome` responde `{agendado, carencia_dias}`
  (não responde mais `removido` — nada é apagado fisicamente ali); `POST /usuarios` em nome
  agendado volta `201` com `aviso`; `GET /usuarios` traz `agendado_exclusao_em`;
  `PUT /config/esquecimento` (admin) grava os três números; `POST /decay` expõe `expurgo`.
- Testes: bloco **v3.5** (19 checagens: efetivos, 403/422 da escrita, ciclo
  apagar→401→recriar→acervo vivo, faxina vencida zero-sobra (usuário, chunks, fonte,
  jobs), arquivado fora-da-janela morre / dentro fica, MCP espelho). Os dois checks
  velhos do `removido` migraram para `agendado`.

---

## v3.4 — Dois perfis de verdade: o comum só vive em Chat, Buscar e Fila (21/10/2026)

- **A política do dono**: Painel, Usuários/Gavetas e Configurações passam a ser **módulos
  do admin**. O usuário comum entra e vê três coisas: conversar (Chat), buscar (Buscar) e
  acompanhar a ingestão (Fila).
- **Parede na porta, não só na tela**: `GET /dashboard`, `PUT /config/provider` e
  `POST /config/provider/testar` agora exigem operador (403). O menu filtrado é a
  consequência visual; a segurança mora na API (esconder botão não esconde rota).
- **Provider virou decisão de admin**: o comum **lê** o seu próprio estado (o Chat precisa
  saber se está ligado e mostra "peça ao administrador" quando não está), mas quem
  **escreve** é o operador — para si, para um usuário específico (`tenant` no corpo, rota
  que já existia) ou como padrão global. Menos um lugar para o comum se perder.
- Chaves continuam trocáveis por quem é dono delas (`POST /usuarios/:nome/chave` aceita o
  próprio), sem tela para isso por enquanto — a rota existe para quando a política mudar.

## v3.3 — A resposta agora vive no servidor; fechar a aba não mata mais nada (21/10/2026)

- **O defeito**: a resposta do chat morria com a aba. Wi-fi que caiu, aba que fechou,
  deploy no meio — `não consegui responder` na volta, e o trabalho pago em token perdido.
- **O que fizemos**: a pergunta virou **tarefa no servidor** (`POST /chat/tarefa`): o
  agente roda sozinho, independente de conexão, gravando o texto acumulado (`parcial`)
  no banco a cada pedaço. A tela assina `GET /chat/tarefa/:id/stream` — um SSE
  **reanexável**: abrir de novo replay do que já foi escrito + o resto ao vivo; tarefa
  que terminou sem ninguém olhando devolve replay + `fim` e fecha (nada pendurado).
- **Fechar a aba ≠ falha**: o trabalho continua; voltar readota a bolha (a pergunta,
  que ainda não está no histórico, entra; o parcial vira base). Queda de conexão no
  meio do stream: reanexa até 3× com backoff antes de reclamar.
- **Higiene**: boot limpa órfãs (`rodando` de processo morto vira `falhou`; terminadas
  com 10min+ saem). Duplicata de evento entre snapshot e ouvinte é descartada no client
  pela base (delta que não passa a última fotografia do servidor não entra).
- **Fallback**: servidor antigo (sem `/chat/tarefa`) → front cai no `/chat/stream` de
  sempre; deploy pode vir em qualquer ordem.
- **Decisões registradas**: o modelo continua gastando token sem cliente olhando (é o
  que "sobreviver" significa); as mensagens só entram no histórico no fim (o `parcial`
  fica na tarefa enquanto ela vive); a fila do navegador ainda é local (próximo degrau).

## v3.2 — A resposta longa parou de ser morta no meio (21/10/2026)

- **O defeito**: depois de uma rodada de ferramentas, a tela mostrava
  `não consegui responder: The operation was aborted due to timeout`. Não era o modelo
  travado: o pedido ao provider tinha um teto de **90 s para a requisição inteira** e esse
  teto continuava armado enquanto o corpo da resposta chegava. Com a memória ligada (12
  turnos) mais os resultados de ferramenta, a conta passa de 90 s escrevendo — e era cortada
  no meio da frase.
- **Por que a etiqueta era aquela**: o `try/catch` que traduz o erro para português envolvia
  só o `fetch`; a leitura do corpo (o stream) estava fora, então o abort cru vazava para a
  bolha do chat.
- **A regra nova**: o que corta a conversa é **silêncio**, não duração. Cada pedaço que chega
  renova o relógio; paro se o provider ficar 180 s sem mandar nada (padrão) ou se a resposta
  passar de 20 min escrevendo sem parar. Resposta longa e constante tem quanto tempo quiser.
- **Na tela** (Configurações → Modelo): campo *espera sem sinal do modelo (segundos)*, aceitando
  0–1800; `0` = padrão do sistema (180 s). É o número para quem usa modelo local lento.
- **Ferramentas MCP**: mesmo vazamento corrigido — se o servidor MCP morre no meio do corpo,
  a etiqueta agora é `o servidor MCP não respondeu: ...`, nunca a frase crua do fetch.
- **Versão**: `3.2.0`.
- **Testes**: bloco novo na suíte (`v3.2`, 9 checagens) com dois provedores falsos dentro do
  container — um que **goteja** 1 pedaço por segundo por ~15 s (tem que sobreviver com orçamento
  de silêncio de 4 s: duração não é defeito) e um que **trava** depois do primeiro pedaço (tem que
  ser cortado em ~4 s com a etiqueta `ficou sem mandar nada por 4s`, nunca a frase crua do fetch).
  Mais 3 checagens de limites do campo no bloco `v3.0` (fora da faixa → 422, round-trip pela tela,
  `0` volta ao padrão e aparece como efetivo).

### v3.2.1 — menu do painel sem títulos de grupo

- Saem do lado esquerdo os rótulos **"visão geral"** e **"memória"**: a divisão não ajudava a achar
  nada. O menu vira uma lista só, na ordem do caminho (Painel · Gavetas/Usuários · Chat · Buscar ·
  Fila · Configurações), e o item destacado continua seguindo a navegação real (dentro de
  usuário → arquivos → editor, "Gavetas" permanece acesa).
- **Versão**: `3.2.1`.

### v3.2.2 — ordem do menu (Chat em cima, Usuários perto de Configurações)

- Nova ordem do menu lateral, pedida pelo dono: **Painel · Chat · Buscar · Fila ·
  Gavetas/Usuários · Configurações** — o Chat passa a ser o 2º item e Usuários fica
  logo acima de Configurações.
- Nada muda de rota: só a ordem dos botões. O destaque do item da tela aberta continua
  seguindo a navegação (usuário → arquivos → editor mantém "Usuários/Gavetas" aceso).
- **Versão**: `3.2.2`.

### v3.2.3 — cadastro de usuário: só o admin vem do ambiente, o resto nasce na tela

- **Política decidida pelo dono (21/10)**: a única conta criada por variável de ambiente é a
  do **admin** (`NEXOS_ADMIN`). Usuário comum é cadastrado **dentro da plataforma**, na
  tela **Usuários**, pelo admin — `POST /usuarios` já existia desde a v2.7; aqui muda o uso,
  não o código. Auto-cadastro (pessoa se inscreve sozinha) foi avaliado e **não** é objetivo:
  cada usuário é um tenant isolado com chave própria.
- **Guarda nova no apagar**: `DELETE /usuarios/:nome` agora responde `409`
  (`este e o ultimo operador ativo: crie outro antes de apagar`) quando se tenta apagar o
  último operador ativo. A guarda já existia no `PATCH` (desativar/rebaixar); faltava no
  `DELETE` — e com o `NEXOS_USERS` vazio isso viraria **trancamento sem volta**, porque não
  haveria mais semente no ambiente para recriar o admin no boot seguinte.
- **Efeito colateral desejado**: usuário criado pela tela não existe no env, então **deixa de
  voltar** no deploy seguinte. Antes, um usuário apagado que ainda constasse em `NEXOS_USERS`
  era recriado no boot, com a chave antiga (o seed é `ON CONFLICT DO NOTHING`).
- **Ação pendente do dono (no painel Dokploy)**: esvaziar `NEXOS_USERS` em produção.

- **Versão**: `3.2.3`.

---

## v3.1 — A conversa para de puxar a tela e o recomeçar desceu para o pé (21/10/2026)

- **Você manda na rolagem**: enquanto o modelo pensa, a caixa de mensagens descia sozinha a
  cada tique do cronômetro — não dava para ler o que já tinha chegado nem digitar a próxima.
  A causa era dupla: a área de mensagens não tinha altura limitada (`flex-1 overflow-auto`
  sem `min-h-0` faz a caixa **crescer** em vez de rolar, então quem andava era a página
  inteira) e o `scrollIntoView` era chamado em todo tique de 500 ms. Agora a caixa tem altura
  própria, a página não se mexe mais, e o acompanhamento automático só acontece **se você
  estiver a menos de 80 px do fim**.
- **Botão de descer**: quando você sobe para reler, aparece `↓ fim` (com
  `· chegou coisa nova` quando a resposta cresceu enquanto você estava em cima de um trecho
  antigo). O clique salta na hora para o fim da conversa e o botão some.
- **Recomeçar no pé, como no Open WebUI**: o botão estava na barra do topo (chamado
  `limpar`). Agora é `nova conversa`, na mesma linha do campo de pergunta — apaga a conversa
  da gaveta atual e recomeça, pedindo confirmação antes. A barra do topo ficou só com o
  seletor de gaveta.
- **Boot que não quebra mais**: a semente de usuários do ambiente usava
  `ON CONFLICT (nome)`, que não cobre o caso de a **mesma chave** já existir registrada sob
  **outro nome** (acontece depois de uma rotação de chave pelo painel). Nesse caso o boot
  morria em `usuarios_chave_hash_key` e o serviço não subia. Passou a `ON CONFLICT DO
  NOTHING`. A suíte tem um bloco que reproduz a situação e reinicia a API de verdade.
- **Versão**: `3.1.0`.

## v3.0 — O chat lembra da conversa, cabe na janela e trabalha em segundo plano (21/10/2026)

- **Memória de verdade**: até aqui o modelo recebia só as instruções + a pergunta — cada
  mensagem era, para ele, a primeira da conversa. Agora as últimas rodadas da gaveta
  (`memoria_turnos`, padrão 12) vão junto, e o tamanho da memória é configurável **por
  cliente** em Configurações → Modelo. `0` volta ao comportamento antigo (conversa pura).
- **Orçamento de contexto**: o "testar conexão" pergunta ao provedor a janela dele
  (`GET /v1/models` → `context_length`) e passa a usá-la sem ninguém digitar. Três campos
  mandam nisso: **janela de contexto** (`0` = usa a detectada, e sem detecção cai no padrão
  8192), **reserva para a resposta** (tokens que sobram para o modelo escrever) e
  **rodadas verbatim** (quantas mensagens recentes vão inteiras).
- **Compactação determinística** (`src/compactar.ts`, sem gastar LLM): quando o histórico
  não cabe, a regra age — as rodadas antigas viram uma linha curta por mensagem
  (`papel · trecho do texto`), resultado de ferramenta é aparado, e o que ainda não coube é
  descartado **do mais antigo**. System prompt e a pergunta atual nunca são comprimidos.
  Se nem assim couber, o histórico vai vazio e a resposta avisa (`coube: false`) — nada de
  estourar o provedor. Não é resumo semântico: é corte com forma, e isso é dito na tela.
- **Contabilidade honesta**: toda resposta de `/chat` traz `compactacao` com
  `historico_lido`, `resumidas`, `aparadas`, `descartadas`, `tokens`, `disponivel`, `janela`,
  `origem_janela` e `coube`. O Chat mostra uma linha embaixo da bolha quando a compactação
  mexeu naquela rodada.
- **Escopo do provider**: a tela agora grava e lê **no mesmo lugar que mostra** — salvar o
  padrão global devolve a linha padrão, e a linha de um cliente só vale se for completa
  (incompleta herda o padrão; regra nascida na v2.8.1 e que a v2.9 ainda não aplicava na
  leitura). `GET/PUT /config/provider` respondem `escopo`, `memoria_turnos`,
  `verbatim_turnos`, `reserva_tokens`, `contexto_tokens`, `contexto_detectado`,
  `janela_efetiva` e `origem_janela`.
- **Segundo plano no painel**: a conversa saiu do estado do componente e vive em
  `frontend/src/lib/conversa.ts`, uma fila por cliente + gaveta. Trocar para a Busca, os
  Documentos ou outra gaveta no meio de uma resposta **não interrompe** nada: ao voltar, a
  bolha está maior, a fila está lá e o cronômetro conta desde o início real da tarefa.
- **O que não é resolvido aqui**: estimativa de tokens é heurística (4 caracteres ≈ 1
  token), não tokenizador do modelo; a detecção só funciona se o provedor anunciar
  `context_length` (o gateway litellm anuncia — mas exige a chave salva, e é ela que o teste
  de conexão já usa); compactar não lembra o sentido das rodadas antigas, só o formato; e
  apagar a conversa na tela apaga a memória (o banco é a fonte, nada é reescrito pela
  compactação).

**API**: mesmas rotas, campos novos em `/chat` (`compactacao`) e `/config/provider` (memória e
janela). **Versão**: `3.0.0`.

**Suíte**: bloco `v3.0` com 28 checagens (o que chega ao modelo com e sem memória, gaveta
padrão, orçamento estourado, contabilidade da compactação e escopo por cliente). Para rodar
só os blocos afetados: `SO_BLOCOS=v3.0 npm test` (~1min em vez de ~5min da suíte inteira).

---

## v2.9 — Chat que escreve em pedaços, markdown de verdade e fila de perguntas (20/10/2026)

- **Markdown na bolha do chat**: o texto que o modelo devolve é convertido na tela
  (`frontend/src/lib/md.ts`) — negrito, itálico, código, link, títulos, citação,
  linha horizontal, **lista numerada e sub-lista** (o filho mora dentro do `<li>` do
  pai) e **tabela GFM** com rolagem horizontal quando não cabe. Continua sem
  dependência nova e **tudo passa por escape antes de qualquer marca**: `<script>`
  escrito no documento vira texto, nunca tag. Link só aceita `http(s)` —
  `javascript:` fica de fora por construção.
- **Resposta ao vivo (`POST /chat/stream`, SSE)**: a bolha aparece e cresce com os
  pedaços do modelo, com cursor piscando, em vez de chegar inteira depois de 15 s.
  Eventos: `delta` (pedaço), `descartar` (o texto até aqui NÃO era a resposta — era
  o raciocínio que vazou pelo `content`), `ferramenta` (uma chamada terminou, ainda
  durante o fluxo), `fim` (o mesmo objeto que `POST /chat` devolve) e `erro`
  (depois de `hijack()` não existe mais HTTP de erro: o problema vira evento).
  O pulso `: ping` a cada 10 s segura a conexão contra proxies enquanto o modelo
  local pensa. `POST /chat` continua igual, sem streaming — é o caminho do
  `Clauricio` via MCP e a reserva do painel se o servidor não tiver `/chat/stream`.
- **Regra nova do raciocínio vazado**: um modelo local
  (llama.cpp, vLLM com chat template de raciocínio) pode escrever o pensamento em
  voz alta dentro de `message.content` ANTES de chamar a ferramenta, e o mesmo
  texto se repete em `reasoning_content`/`thinking`. A resposta não é final quando
  vêm `tool_calls`: o texto daquela rodada é descartado e a tela recebe
  `descartar`, então nada de `Thinking:` fica na bolha nem no histórico.
  Na rodada final (sem `tool_calls`) o texto é a resposta e vai inteiro.
- **Fila de perguntas**: o campo fica livre enquanto o modelo trabalha. Enter manda
  para a fila (uma por vez, na ordem, serial — o modelo local tem duas placas e
  requisição paralela só deixaria tudo mais lento). Item na fila tem **✕ na fila**
  para cancelar antes de sair; se uma pergunta falhar, a fila continua. Trocar de
  gaveta derruba o que ainda não saiu.
- **Rodapé do chat**: enquanto nada chegou, a bolha mostra `pensando… Ns` (cronômetro
  real) e quantas perguntas estão na fila.
- **Configurações em abas** (`Config.tsx`): Provider do chat · Ferramentas (MCP) ·
  Servidores MCP externos.
- **API**: +1 rota (`POST /chat/stream`). Versão: `2.9.0`.
- **Suíte**: +22 checagens (convertedor de markdown testado a partir do MESMO
  arquivo do frontend, sem build; fluxo SSE completo com provedor falso dentro do
  container: pedaços, descarte do raciocínio, ferramenta ao vivo, histórico limpo,
  erro como evento).

## v2.8.1 — Regra do escopo: linha própria só vale completa (20/10/2026)

- `provider_config` tem linha por usuário e o padrão global (`*`). **Ambos os lados agora
  usam a mesma regra**: a linha própria só vale quando tem `base_url` **e** `modelo`.
  Uma linha salva pela metade (URL sem modelo) **não esconde mais o global** — nem na tela
  (`GET /config/provider` volta `origem: "global"`, `escopo: "*"`) nem no chat.
- Motivo: o chat já escolhia assim (`resolverProvider`), mas a tela escolhia `propria ?? global`.
  Resultado medido: usuário com linha incompleta via "chat desligado / sem modelo" enquanto
  o global respondia. A suíte tem checagem para os dois lados.

## v2.8 — Chat sem regra embutida: provider + system prompt + ferramentas MCP (20/10/2026)

O Chat deixou de ser "busca automática na gaveta + resposta com fonte obrigatória".
Agora são **três peças separadas**, cada uma controlando uma coisa:

| Peça | Controla | Onde |
|---|---|---|
| **Provider** | se o Chat existe. Sem provider → `409` e a Busca segue normal | Configurações → Provider do chat |
| **System prompt** | as instruções iniciais. **Campo vazio = nenhuma instrução** (modelo conversa puro, sem citar fonte) | Configurações → Provider do chat |
| **MCP** | as ferramentas. Nada ligado = nenhuma ferramenta | Configurações → Ferramentas (MCP) |

- **Nada de regra dentro do código.** A antiga constante `SISTEMA` ("use só os trechos,
  cite `[documento]`") foi embora junto com a busca automática: quem quer rastreabilidade
  escreve isso no prompt; quem quer documento liga o MCP interno.
- **MCP do próprio nexos como ferramenta** (`mcp_interno`): botão na tela. As ferramentas
  são chamadas **dentro do mesmo processo** (`chamarToolInterna`), com a sessão de quem está
  logado — mesmo `switch` que serve o `POST /mcp`, sem HTTP e sem segunda autenticação.
  O isolamento por usuário/gaveta vem de graça. O `chat` fica de fora da lista (seria recursivo).
- **Servidores MCP externos, quantos o operador quiser**: cadastro por **endereço HTTP**
  (`initialize` → `tools/list` → `tools/call`), com cabeçalho de acesso guardado no servidor
  e devolvido **mascarado** (`••••xy98`). A lista vem cacheada em `mcp_servidores.ferramentas`;
  "atualizar ferramentas" relê o servidor. Nome sem colisão: `drive-prod__buscar`.
- **Execução direta, sem cartão de confirmação** (decisão do dono). O freio que ficou é o
  registro: `ferramentas` (servidor, nome, argumentos mascarados, ok, resumo, ms) vai na
  resposta, no painel embaixo da mensagem e no histórico (`chat_mensagens.ferramentas`).
- **Trava de loop**: `max_rodadas` (0 a 60, padrão 5; teto 10→60 na v3.8). `0` = não oferece ferramenta nenhuma.
  Ao estourar, a resposta vem com `aviso` ("bateu o limite de N rodadas").
- **Corte de contexto**: saída de ferramenta é truncada em 4.000 caracteres; base64 longo
  vira `[arquivo em base64: N caracteres, não mostrei]`.
- **Segredo não fica no registro**: campos com nome de chave/token/senha viram `••••últimos4`,
  e texto com forma de chave (`sk-…`, `mr_…`, hash longo) é mascarado no resumo gravado.
  O **texto que o modelo devolve** não é reescrito — se ele copiar uma chave criada, ela fica
  na conversa do próprio usuário.
- **Defeito corrigido**: uma linha própria salva pela metade (URL sem modelo) tampava o padrão
  global. A ordem agora é **própria completa › global › própria incompleta**.
- **MCP**: 21 tools — as 19 da v2.7 + `listar_mcp` e `gerir_mcp` (criar/atualizar/apagar/testar
  servidor; só operador).
- Versão do produto: **2.8.1**.

## v2.7 — menu lateral, Painel, Chat, Configurações e usuários no banco (20/10/2026)

O painel deixou de ser "abas no topo" e virou um sistema com **menu lateral**:
`Painel · Usuários · Chat · Buscar · Fila · Configurações`. `Arquivos` e `Editor`
não são itens de menu — são passos do caminho `usuários → gavetas → arquivos → nota`
(antes dava para cair em "Arquivos" sem gaveta escolhida).

- **Painel (`GET /dashboard`)**: usuários, gavetas, documentos, trechos, fila,
  buscas/chats do dia, documentos por usuário, saúde (embedder, OCR, provider) e
  últimos envios — tudo em **uma** chamada. O contador do dia fica em `metricas_dia`.
- **Chat (`POST /chat`)** na v2.7 buscava os trechos da gaveta e devolvia `fontes`
  (`doc_id`, `trecho`, `score`). **Na v2.8 isso saiu**: o modelo conversa e pede
  ferramenta ao MCP; o histórico continua em `chat_mensagens` (`GET`/`DELETE /chat`),
  agora gravando `ferramentas`. **Sem provider configurado o Chat responde `409`** e a
  Busca continua normal.
- **Provider configurável na tela (`/config/provider`)**: `litellm` (OpenAI
  compatível), `openai` ou `ollama`. Campos: `base_url`, `modelo`, `temperatura`,
  `system_prompt`, `mcp_interno`, `max_rodadas`, `ativo` (`trechos` era da busca
  automática da v2.7; saiu de uso na v2.8). A **chave nunca volta em claro** — a API devolve
  `chave_mascarada` (`••••4f2a`) e `tem_chave`. `POST /config/provider/testar`
  mede a latência e falha com mensagem legível. Cada usuário tem a sua configuração;
  o operador pode gravar o padrão de todos (`global: true`, escopo `*`).
- **Usuários no banco (`/usuarios`)**: tabela `usuarios` (nome, `chave_hash`
  sha256, `chave_hint`, `papel`, `ativo`). `NEXOS_USERS`/`NEXOS_ADMIN`
  passam a ser **semente** do boot (entram uma vez, sem sobrescrever). Criar pela
  tela devolve a chave **uma única vez**; desativar vale na hora; o último operador
  ativo não pode ser rebaixado/desativado; usuário com documentos não pode ser
  removido (apague as gavetas antes). Quem não é operador recebe `403`.
- **Configurações (`GET /config`)**: limites em vigor e política de esquecimento,
  sem expor segredo.
- **MCP**: 19 tools na v2.7 — as 15 anteriores + `chat`, `listar_usuarios`,
  `criar_usuario`, `config_provider` (21 na v2.8).
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
- **Limite**: 6 páginas de PDF escaneado por arquivo (`NEXOS_OCR_PAGINAS_MAX`) —
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
