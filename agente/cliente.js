#!/usr/bin/env node
/*
 * Cliente de máquina — minirag v3.6 (túnel absorvido)
 *
 * Um arquivo, sem instalação: conecta no hub do minirag, recebe comandos e
 * executa NA MÁQUINA onde roda. Wire herdado do agent-tunel, tags intactas:
 *   cliente → servidor: {"token","host","os","user"}  (oi)
 *   servidor → cliente: {"cmd","rotulo","espera"}
 *   cliente → servidor: {"exit","stdout","stderr"}
 *   servidor → cliente: {"ack":"ok","token":<maquina>} | {"ack":"negado","motivo":...}
 *
 * Cores do longo prazo (decisão do dono 22/10):
 *  - o token de pareamento é de uso único: ao receber o token de máquina no
 *    ack, o cliente ADOTA, persiste (~/.minirag-maquina.json) e reconecta com
 *    ele — a suíte pegou exatamente esse defeito no cliente falso da primeira vez;
 *  - reconexão com backoff (400ms → 30s), heartbeat por ping do protocolo
 *    (o WebSocket nativo do Node responde pong sozinho), kill de ÁRVORE em timeout;
 *  - auto-update: compara a versão embutida com o /maquina/atualizacao e reconsulta
 *    em TODA conexão; se o servidor fala versão maior, mostra o progresso na TELA,
 *    baixa, troca e reabre em janela própria minimizada (no Windows o exe velho vira
 *    .old porque não se apaga arquivo em execução);
 *  - UM log só (minirag-cliente.log), memória de 30 dias: faxina no boot apaga linhas
 *    mais velhas e corta o topo se estourar 2 MB — sem arquivo .old de log.
 *
 * Uso:
 *   minirag-cliente-win.exe --token <token-da-tela>
 *   minirag-cliente-linux   --token ... [--host nome] [--url minirag.techupsistemas.com]
 *   MINIRAG_MAQUINA_URL / MINIRAG_MAQUINA_CONF sobrepõem os padrões.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const https = require("node:https");
const { spawn } = require("node:child_process");

const EH_WIN = process.platform === "win32";
const VERSAO_CLIENTE = process.env.MINIRAG_CLIENTE_VERSAO || "dev";

const argv = process.argv.slice(2);
function flag(nome, padrao) {
  const i = argv.indexOf("--" + nome);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : padrao;
}

/* ---------------- alvo ---------------- */
const confPath = flag("conf", process.env.MINIRAG_MAQUINA_CONF || path.join(os.homedir(), ".minirag-maquina.json"));
let base = flag("url", process.env.MINIRAG_MAQUINA_URL || lerConf().url || "https://minirag.techupsistemas.com");
if (!/^https?:/i.test(base)) base = "https://" + base;
const URL_WS = (() => {
  const u = new URL(base);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  u.pathname = "/maquina/ws";
  return u.toString();
})();
const host = flag("host", process.env.MINIRAG_MAQUINA_HOST || os.hostname());

function lerConf() {
  try {
    return JSON.parse(fs.readFileSync(confPath, "utf8"));
  } catch {
    return {};
  }
}
function gravarConf(o) {
  try {
    fs.writeFileSync(confPath, JSON.stringify(o, null, 2));
  } catch (e) {
    log("aviso: não consegui guardar o token em " + confPath + " (" + e.message + ")");
  }
}

/* chave assada no proprio arquivo (v3.7): o painel cola {v:1,k:...}+len+MRQK no fim do exe */
function lerChaveEmbutida() {
  try {
    const fd = fs.openSync(process.execPath, "r");
    const st = fs.fstatSync(fd);
    const corte = Math.min(8192, st.size);
    const b = Buffer.alloc(corte);
    fs.readSync(fd, b, 0, corte, st.size - corte);
    fs.closeSync(fd);
    if (b.slice(-4).toString("ascii") !== "MRQK") return "";
    const len = b.readUInt32BE(b.length - 8);
    if (len <= 0 || len > corte - 8) return "";
    const o = JSON.parse(b.slice(b.length - 8 - len, b.length - 8).toString("utf8"));
    return o && o.v === 1 && typeof o.k === "string" ? o.k : "";
  } catch {
    return "";
  }
}

let chaveEmbutida = "";
let tokenDoConf = false;
let token = flag("token", "");
if (!token) {
  const doConf = lerConf().token || "";
  if (doConf) { token = doConf; tokenDoConf = true; } // token adotado numa conexão anterior
}
if (!token) { chaveEmbutida = lerChaveEmbutida(); token = chaveEmbutida; }
let tentouChaveDepoisDoErro = false;
let negadoPermanente = false;

/* ---------------- console + arquivo de log (ao lado do exe, como o túnel) ---- */
let LOG_DIR = path.dirname(process.execPath); // SEA: o log nasce do lado do .exe
try {
  const sea = require("node:sea");
  if (!sea.isSea()) LOG_DIR = __dirname;     // desenvolvimento (node cliente.js): no repo
} catch {
  LOG_DIR = __dirname;
}
const LOG_PATH = path.join(LOG_DIR, "minirag-cliente.log");
let nivelBackoff = 0;
let escritasLog = 0;
/* v3.12: o log gira por TAMANHO também. Um laço de recusa do servidor enchia o
 * arquivo em minutos ("log gigante"), e o dono acabou apagando para trabalhar. */
function girarLogSeGrande() {
  if (++escritasLog % 200 !== 0) return;
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size < 2 * 1024 * 1024) return;
    try { fs.unlinkSync(LOG_PATH + ".1"); } catch { /* não existe */ }
    fs.renameSync(LOG_PATH, LOG_PATH + ".1");
  } catch { /* sem arquivo ainda */ }
}

function log(msg) {
  const linha = new Date().toISOString().slice(0, 19).replace("T", " ") + "  " + msg;
  console.log(linha);
  try {
    fs.appendFileSync(LOG_PATH, linha + "\n");
    girarLogSeGrande();
  } catch { /* sem disco de escrita? o console ainda salva a sessão */ }
  try { if (typeof ouvintes !== "undefined" && ouvintes.size) evocar({ tipo: "log", linha }); } catch { /* painel ainda nascendo */ }
}
function logTela(msg) {
  // só a tela: o log do arquivo é para o essencial (um arquivo só, cobrado 23/10)
  console.log(new Date().toISOString().slice(0, 19).replace("T", " ") + "  " + msg);
}
function faxinaLog() {
  // UM log apenas, 30 dias de memória: linhas mais velhas morrem no boot e, se o
  // arquivo estourar 2 MB, corta-se pelo começo (nunca renomeia para .old — o dono
  // vetou o segundo arquivo: "um log só para tomar conta de tudo"). Sem atalho por
  // tamanho: arquivo pequeno ainda pode guardar linha de 45 dias (pego pela sonda).
  try {
    try { fs.unlinkSync(LOG_PATH + ".old"); } catch { /* fósforo antigo sumiu do mapa */ }
    const corte = Date.now() - 30 * 864e5;
    const vivas = fs.readFileSync(LOG_PATH, "utf8").split("\n").filter((l) => {
      if (!l.trim()) return false;
      const t = Date.parse(l.slice(0, 19).replace(" ", "T") + "Z");
      return Number.isNaN(t) ? true : t >= corte; // linha sem data legível: fica
    });
    let texto = vivas.join("\n") + (vivas.length ? "\n" : "");
    if (Buffer.byteLength(texto) > 2_000_000) {
      const buf = Buffer.from(texto);
      let inicio = buf.length - 1_900_000;
      const nl = buf.indexOf(0x0a, inicio);
      if (nl > 0) inicio = nl + 1;
      texto = buf.subarray(inicio).toString("utf8");
    }
    fs.writeFileSync(LOG_PATH, texto);
  } catch { /* sem permissão: o log segue gravando sem faxina */ }
}
function esperarEnter() {
  // duplo clique no Windows: sem isto a janela fecha antes de a pessoa ler
  const rl = require("node:readline").createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question("\n[ENTER para fechar esta janela]\n", () => { rl.close(); res(); });
    rl.on("close", res); // stdin fechado (serviço/pipe): não pendura
  });
}

/* ---------------- execução de comando com kill de árvore ---------------- */
function rodar(cmd, esperaSeg) {
  return new Promise((resolve) => {
    const filho = EH_WIN
      ? spawn("cmd.exe", ["/d", "/c", cmd], { windowsHide: true })
      : spawn("/bin/sh", ["-c", cmd], { detached: true }); // detached = grupo próprio; matamos o grupo
    let stdout = "";
    let stderr = "";
    let morto = false;
    const matarArvore = () => {
      morto = true;
      try {
        if (EH_WIN) spawn("taskkill", ["/T", "/F", "/PID", String(filho.pid)], { windowsHide: true });
        else process.kill(-filho.pid, "SIGKILL");
      } catch {
        try { filho.kill("SIGKILL"); } catch { /* já morreu */ }
      }
    };
    const teto = Math.max(1, Math.min(600, Number(esperaSeg) || 30)) + 2; // servidor dá -124 em espera+8; aqui é a última barreira
    const rel = setTimeout(() => {
      matarArvore();
      stderr += "\n[cliente: mata-árvore após " + teto + "s]";
      resolve({ exit: -124, stdout: stdout.slice(0, 1500000), stderr: stderr.slice(0, 8000) });
    }, teto * 1000);
    filho.stdout && filho.stdout.on("data", (b) => { stdout += b; if (stdout.length > 40000) matarArvore(); });
    filho.stderr && filho.stderr.on("data", (b) => { stderr += b; if (stderr.length > 16000) matarArvore(); });
    filho.on("error", (e) => {
      clearTimeout(rel);
      resolve({ exit: -1, stdout: "", stderr: String(e.message || e) });
    });
    filho.on("close", (code) => {
      clearTimeout(rel);
      if (morto) return; // o timeout já resolveu com -124
      resolve({ exit: code == null ? -9 : code, stdout: stdout.slice(0, 1500000), stderr: stderr.slice(0, 8000) });
    });
  });
}

/* ---------------- painel local do dono (só 127.0.0.1) ----------------
 * Interface amigável no navegador do próprio computador (pedido 23/10: "parece um
 * terminal; queria ver status e logs"). Nada de segredo na tela: o token nunca aparece. */
const PAINEL_PORTA = 48123;
let painelPorta = 0;
const estado = {
  host,
  usuario: (() => { try { return os.userInfo().username; } catch { return "?"; } })(),
  so: process.platform + " " + os.release(),
  servidor: base,
  versao: VERSAO_CLIENTE,
  online: false,
  conectou_em: null,
  negado: null,
  atualizacao: null,
  comandos: [],
};
const ouvintes = new Set();
function evocar(ev) {
  const t = "data: " + JSON.stringify(ev) + "\n\n";
  for (const r of ouvintes) { try { r.write(t); } catch { ouvintes.delete(r); } }
}
function setOnline(v) {
  estado.online = v;
  estado.conectou_em = v ? new Date().toISOString() : null;
  if (!v) estado.negado = null;
  evocar({ tipo: "status", online: v, conectou_em: estado.conectou_em, negado: estado.negado });
}
function setAtualizacao(patch) {
  estado.atualizacao = { de: VERSAO_CLIENTE, ...(estado.atualizacao || {}), ...patch };
  evocar({ tipo: "atualizacao", atualizacao: estado.atualizacao });
}
function registrarComando(rotulo, exit, bytes) {
  estado.comandos.unshift({ ts: new Date().toISOString(), rotulo, exit, bytes });
  if (estado.comandos.length > 50) estado.comandos.length = 50;
  evocar({ tipo: "comando", comando: estado.comandos[0] });
}
function tailLog(n) {
  try {
    return fs.readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean).slice(-n).join("\n");
  } catch { return ""; }
}
function iniciarPainel() {
  const semJanela = argv.includes("--sem-janela");
  const servidor = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/api/estado") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ ...estado, porta: painelPorta, conf: confPath, log: tailLog(80) }));
      return;
    }
    if (u.pathname === "/evento") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("data: " + JSON.stringify({ tipo: "oi", estado: { ...estado, log: undefined } }) + "\n\n");
      ouvintes.add(res);
      const ka = setInterval(() => { try { res.write(":ka\n\n"); } catch { /* fecha junto */ } }, 25000);
      res.on("close", () => { clearInterval(ka); ouvintes.delete(res); });
      return;
    }
    if (u.pathname === "/") {
      // v3.12.1: sem cache — o navegador abriu a página ANTIGA e ela ficava em "carregando…"
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
        pragma: "no-cache",
        expires: "0",
      });
      res.end(PAINEL_HTML);
      return;
    }
    res.writeHead(404); res.end("nao tem isso aqui");
  });
  const jaRodando = (porta) => new Promise((ok) => {
    // v3.12: se já existe um cliente nesta porta, abrir OUTRA instância só confunde
    const t = http.get({ host: "127.0.0.1", port: porta, path: "/api/estado", timeout: 1500 }, (r) => {
      let d = "";
      r.on("data", (c) => { d += c; });
      r.on("end", () => {
        /* só é "a mesma instalação" se o painel de lá usa o MESMO arquivo de config —
         * dois clientes apontando para configs diferentes são instâncias legítimas */
        try { const j = JSON.parse(d); ok(Boolean(j && j.versao && "online" in j && j.conf === confPath)); } catch { ok(false); }
      });
    });
    t.on("timeout", () => { t.destroy(); ok(false); });
    t.on("error", () => ok(false));
  });
  const tenta = (porta) => {
    servidor.once("error", async (e) => {
      if (e.code === "EADDRINUSE" && (await jaRodando(porta))) {
        const url = "http://127.0.0.1:" + porta + "/?v=" + Date.now();
        log("já existe um cliente rodando nesta máquina — abro a janela dele (http://127.0.0.1:" + porta + "/) e saio");
        if (!semJanela) { abrirJanela(url); setTimeout(() => process.exit(0), 1500); }
        return;
      }
      if (e.code === "EADDRINUSE" && porta < PAINEL_PORTA + 6) { log("painel: porta " + porta + " ocupada, tentando a próxima"); tenta(porta + 1); }
      else log("painel local: " + e.code);
    });
    servidor.listen(porta, "127.0.0.1", () => {
      painelPorta = porta;
      const url = "http://127.0.0.1:" + porta + "/?v=" + Date.now(); // endereço novo: o navegador não reaproveita a página velha
      log("painel local em http://127.0.0.1:" + porta + "/");
      if (!semJanela) abrirJanela(url);
    });
  };
  tenta(PAINEL_PORTA);
}
/* v3.11: UMA janela só. O programa deixou de ser "console + aba de navegador":
 * no Windows ele abre a página em MODO APLICATIVO (janela própria, sem abas, sem
 * barra de endereço) e o executável é compilado sem console. */
function acharNavegadorApp() {
  const pf = process.env.PROGRAMFILES || "C:\\Program Files";
  const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const la = process.env.LOCALAPPDATA || "";
  return [
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    la ? path.join(la, "Microsoft", "Edge", "Application", "msedge.exe") : "",
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean).find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || "";
}

function abrirJanela(url) {
  if (!EH_WIN) {
    try { spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref(); } catch { /* sem navegador */ }
    return;
  }
  const navegador = acharNavegadorApp();
  if (navegador) {
    try {
      const perfil = path.join(path.dirname(confPath), ".minirag-janela");
      const f = spawn(navegador, ["--app=" + url, "--window-size=1180,820", "--user-data-dir=" + perfil], { detached: true, stdio: "ignore", windowsHide: true });
      f.on("error", () => abrirNavegadorPadrao(url));
      if (f.unref) f.unref();
      return;
    } catch { /* cai no padrão */ }
  }
  abrirNavegadorPadrao(url);
}

function abrirNavegadorPadrao(url) {
  // última alternativa: navegador do sistema (a página é a mesma)
  try {
    const f = EH_WIN
      ? spawn("cmd.exe", ["/d", "/c", "start", "", url], { windowsHide: true })
      : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    f.on("error", () => log("não consegui abrir a janela sozinho — abra " + url));
    if (!EH_WIN) f.unref();
  } catch { /* silencioso: o log já diz tudo */ }
}
/* A página é estática de propósito: os dados chegam por /api/estado e /evento.
 * Sem segredo algum na tela — o token nunca é exibido. */
const PAINEL_HTML = "<!doctype html><html lang=pt-br><head><meta charset=utf-8>" +
"<meta name=viewport content='width=device-width,initial-scale=1'>" +
"<title>minirag · cliente</title><style>" +
":root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,Segoe UI,Roboto,sans-serif;background:radial-gradient(1200px 600px at 70% -10%,#123 0,#0b1020 55%,#090d18 100%);color:#dbe4f3;min-height:100vh}" +
"header{display:flex;align-items:center;gap:12px;padding:18px 22px;border-bottom:1px solid #1c2740}" +
"header .logo{font-size:22px}h1{font-size:16px;margin:0;font-weight:600}header .dir{margin-left:auto;font-size:12px;color:#8fa1c0;text-align:right}" +
"main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px;padding:18px 22px;max-width:1100px}" +
"section{background:#10182bcc;border:1px solid #1e2a47;border-radius:14px;padding:14px 16px}" +
"h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#8fa1c0;margin:0 0 10px}" +
".dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;background:#666}" +
".dot.on{background:#3ddc84;box-shadow:0 0 10px #3ddc8480}.dot.off{background:#ff5d5d;box-shadow:0 0 10px #ff5d5d80}.dot.meio{background:#f0b429}" +
".linha{display:flex;align-items:center;gap:8px;font-size:15px}" +
".sub{color:#8fa1c0;font-size:12px;margin-top:6px}" +
".grade{display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;font-size:13px}.k{color:#8fa1c0}.v{font-weight:600;word-break:break-all}" +
".bar{height:10px;background:#1c2740;border-radius:6px;overflow:hidden;margin-top:10px}.bar i{display:block;height:100%;width:0%;background:linear-gradient(90deg,#4f8cff,#3ddc84);transition:width .3s}" +
"table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:4px 6px;text-align:left;border-bottom:1px solid #1c2740}th{color:#8fa1c0;font-weight:500;font-size:12px}" +
".ok{color:#3ddc84}.ruim{color:#ff5d5d}pre{margin:0;max-height:260px;overflow:auto;background:#0a0f1e;border-radius:8px;padding:10px;font-size:11.5px;color:#aebcd8;white-space:pre-wrap;word-break:break-word}" +
"footer{padding:10px 22px 18px;font-size:11px;color:#5f6f90}" +
"</style></head><body>" +
"<header><span class=logo>🛰️</span><h1>minirag — cliente da máquina</h1><div class=dir id=dir></div></header>" +
"<main>" +
"<section><h2>Conexão</h2><div class=linha><i class='dot off' id=dot></i><b id=ctxt>carregando…</b></div><div class=sub id=quando></div><div class=sub id=negado style='color:#ff8d8d'></div></section>" +
"<section><h2>Máquina</h2><div class=grade id=mach></div></section>" +
"<section><h2>Atualização</h2><div id=up>—</div><div class=bar id=wrapbar style=display:none><i id=fill></i></div></section>" +
"<section style=grid-column:1/-1><h2>Últimos comandos recebidos</h2><table><thead><tr><th>hora</th><th>rótulo</th><th>exit</th><th>bytes</th></tr></thead><tbody id=cms><tr><td colspan=4 style=color:#5f6f90>nada ainda</td></tr></tbody></table></section>" +
"<section style=grid-column:1/-1><h2>Log — um arquivo, últimos 30 dias</h2><pre id=lg></pre></section>" +
"</main><footer>Página local deste cliente (só este computador a enxerga). A janela de terminal continua funcionando por baixo.</footer>" +
"<script>" +
"function hora(s){return s? new Date(s).toLocaleTimeString('pt-BR'):''}" +
"function apply(e){" +
"var d=document.getElementById('dot');d.className='dot '+(e.online?'on':'off');" +
"document.getElementById('ctxt').textContent=e.online?'ONLINE no minirag':'desconectado — reconecta sozinho';" +
"document.getElementById('quando').textContent=e.online?'conectado desde '+new Date(e.conectou_em).toLocaleString('pt-BR'):'';" +
"document.getElementById('negado').textContent=e.negado?'servidor negou: '+e.negado:'';" +
"document.getElementById('dir').textContent='v'+e.versao+' · porta '+e.porta;" +
"var m='';m+='<span class=k>nome da máquina</span><span class=v>'+e.host+'</span>';" +
"m+='<span class=k>usuário</span><span class=v>'+e.usuario+'</span>';" +
"m+='<span class=k>sistema</span><span class=v>'+e.so+'</span>';" +
"m+='<span class=k>servidor</span><span class=v>'+e.servidor+'</span>';" +
"document.getElementById('mach').innerHTML=m;" +
"var a=e.atualizacao,u=document.getElementById('up'),w=document.getElementById('wrapbar'),f=document.getElementById('fill');" +
"if(a&&a.fase==='baixando'){u.textContent=a.de+' → '+a.para+' · '+a.mb+' MB de '+a.total_mb+' MB ('+a.pct+'%) · '+a.velocidade+' MB/s';w.style.display='block';f.style.width=a.pct+'%';}" +
"else if(a&&a.fase==='trocando'){u.textContent=a.de+' → '+a.para+' · download pronto, trocando o programa';w.style.display='block';f.style.width='100%';}" +
"else if(a&&a.fase==='reiniciando'){u.textContent='reabrindo na versão '+a.para;}" +
"else u.textContent='versão em uso: '+e.versao+' (o servidor manda novidade sozinha)';" +
"var t=document.getElementById('cms'),L=(e.comandos||[]).slice(0,15);" +
"if(L.length){t.innerHTML='';for(var i=0;i<L.length;i++){var c=L[i],tr=document.createElement('tr');" +
"tr.innerHTML='<td>'+hora(c.ts)+'</td><td>'+c.rotulo+'</td><td class=\"'+(c.exit===0?'ok':'ruim')+'\">'+c.exit+'</td><td>'+c.bytes+'</td>';t.appendChild(tr);}}}" +
"function logAppend(l){var lg=document.getElementById('lg');var e=lg.textContent?lg.textContent.split(String.fromCharCode(10)):[];e.push(l);if(e.length>200)e.splice(0,e.length-200);lg.textContent=e.join(String.fromCharCode(10));lg.scrollTop=lg.scrollHeight;}" +
"var es,ultimo={};" +
"function liga(){es=new EventSource('/evento');es.onmessage=function(x){try{var o=JSON.parse(x.data);" +
"if(o.estado){ultimo=o.estado;apply(ultimo);}" +
"else if(o.tipo==='status'&&ultimo.host){ultimo.online=o.online;ultimo.conectou_em=o.conectou_em;ultimo.negado=o.negado;apply(ultimo);}" +
"else if(o.tipo==='atualizacao'&&ultimo.host){ultimo.atualizacao=o.atualizacao;apply(ultimo);}" +
"else if(o.tipo==='comando'&&o.comando&&ultimo.host){ultimo.comandos=[o.comando].concat(ultimo.comandos||[]).slice(0,15);apply(ultimo);}" +
"if(o.tipo==='log')logAppend(o.linha);}catch(e3){}};es.onerror=function(){try{es.close();}catch(e2){};setTimeout(liga,3000);};}liga();" +
"var lg0=document.getElementById('lg'),tent=0;" +
"function puxar(){fetch('/api/estado',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){tent=0;apply(j);lg0.textContent=j.log||'';}).catch(function(){tent++;if(tent>2)document.getElementById('ctxt').textContent='sem resposta do programa local — tentando de novo…';setTimeout(puxar,2000);});}puxar();" +
"</script></body></html>";
/* ---------------- websocket (nativo do Node — SEA sem dependência) ---------------- */
let ws = null;
let morrendo = false;
let atualizando = false;
let destinoVersao = null;
let tmpArq = null; // arquivo .novo da tentativa em curso (apagado se falhar)
let falhouPara = null; // versão cujo update já falhou neste processo (não rebaixa em loop)

function conectar() {
  if (morrendo) return;
  log("conectando em " + URL_WS + " como " + host + " (v" + VERSAO_CLIENTE + ")");
  ws = new WebSocket(URL_WS);
  /* v3.12.2: no deploy o pedido de conexão pode ficar pendurado — antes o programa
   * esperava para sempre e a janela ficava "desconectado" até reiniciar à mão */
  const relogioConexao = setTimeout(() => {
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      log("conexão sem resposta em 15 s — tento de novo");
      try { ws.close(); } catch { /* ignored */ }
    }
  }, 15000);
  ws.addEventListener("open", () => clearTimeout(relogioConexao));
  ws.addEventListener("close", () => clearTimeout(relogioConexao));
  ws.addEventListener("open", () => {
    nivelBackoff = 0;
    ws.send(JSON.stringify({ token, host, os: process.platform + " " + os.release(), user: os.userInfo().username }));
    // herança do Go v1.11: a novidade é reconsultada em TODA conexão (primeira e reconexões)
    verificarAtualizacao().catch(() => {});
  });
  ws.addEventListener("message", async (ev) => {
    let m;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (m.ack) {
      if (m.ack === "ok") {
        log("ONLINE no minirag");
        setOnline(true);
        if (m.token && m.token !== token) {
          token = m.token; // PAREAMENTO → token de máquina: adota e persiste (reconexão não pode usar o pareamento queimado)
          gravarConf({ ...lerConf(), token, host, url: base, desde: new Date().toISOString() });
          log("token de máquina adotado e guardado em " + confPath);
        }
      } else if (m.ack === "negado") {
        const motivo = m.motivo || "?";
        setOnline(false); estado.negado = motivo;
        evocar({ tipo: "status", online: false, conectou_em: null, negado: estado.negado });
        try { ws.close(); } catch { /* ignore */ }
        /* v3.12: o token guardado pode ter morrido (máquina apagada). Nesse caso o
         * cliente esquece o token e tenta a chave embutida UMA vez — antes ficava
         * repetindo "token desconhecido" a cada 15s para sempre. */
        if (/desconhec/i.test(motivo) && tokenDoConf && !tentouChaveDepoisDoErro) {
          tentouChaveDepoisDoErro = true;
          chaveEmbutida = chaveEmbutida || lerChaveEmbutida();
          if (chaveEmbutida) {
            gravarConf({ ...lerConf(), token: "", host, url: base });
            token = chaveEmbutida;
            tokenDoConf = false;
            nivelBackoff = 0;
            log("o token guardado não existe mais no servidor — tentando de novo com a chave do arquivo");
            setTimeout(conectar, 1500);
            return;
          }
        }
        negadoPermanente = /desconhec|removid|expirad/i.test(motivo);
        log("NEGADO pelo servidor: " + motivo + (negadoPermanente ? " — paro de insistir; resolva no painel" : " — tentando de novo em 30s"));
        nivelBackoff = 5; // 30s
      }
      return;
    }
    if (typeof m.cmd === "string") {
      log("cmd (" + (m.rotulo || "?") + "): " + m.cmd.slice(0, 120));
      estado.ultimo_rotulo = m.rotulo || "?";
      const r = await rodar(m.cmd, m.espera);
      registrarComando(m.rotulo || "?", r.exit, r.stdout.length + r.stderr.length);
      log("resposta: exit " + r.exit + " (" + r.stdout.length + "+" + r.stderr.length + " bytes)");
      try {
        ws.send(JSON.stringify(r));
      } catch {
        log("caiu antes de responder — o servidor vai marcar sem resposta");
      }
    }
  });
  ws.addEventListener("error", () => { /* o close vem em seguida e trata */ });
  ws.addEventListener("close", () => {
    setOnline(false);
    if (morrendo) return;
    const atrasos = negadoPermanente ? [300000] : [400, 800, 1500, 3000, 8000, 15000, 30000];
    const ms = atrasos[Math.min(nivelBackoff++, atrasos.length - 1)];
    log("desconectado — reconecto em " + ms + "ms");
    setTimeout(conectar, ms);
  });
}

/* ---------------- auto-update ---------------- */
function baixar(para, urlBaixa) {
  return new Promise((res, rej) => {
    const mod = urlBaixa.startsWith("http:") ? http : https;
    const arq = fs.createWriteStream(para);
    mod
      .get(urlBaixa, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          r.resume();
          return baixar(para, new URL(r.headers.location, urlBaixa).toString()).then(res, rej);
        }
        if (r.statusCode !== 200) {
          r.resume();
          return rej(new Error("http " + r.statusCode));
        }
        // progresso visível (janela do duplo clique + log): % a cada 5%, MB e velocidade
        const total = Number(r.headers["content-length"] || 0);
        const t0 = Date.now();
        let feito = 0;
        let ultimo = 0; // último valor publicado (pct, ou bytes se não houver total)
        r.on("data", (chunk) => {
          feito += chunk.length;
          const passo = total ? Math.floor((feito * 100) / total) >= ultimo + 5 : feito - ultimo >= 2_000_000;
          if (!passo) return;
          ultimo = total ? Math.floor((feito * 100) / total) : feito;
          const s = Math.max(0.5, (Date.now() - t0) / 1000);
          const mb = (feito / 1048576).toFixed(1);
          const de = total ? " de " + (total / 1048576).toFixed(1) + " MB (" + ultimo + "%)" : "";
          logTela("download: " + mb + " MB" + de + " · " + (feito / 1048576 / s).toFixed(1) + " MB/s");
          setAtualizacao({ para: destinoVersao || "?", fase: "baixando", pct: ultimo, mb, total_mb: total ? (total / 1048576).toFixed(1) : "?", velocidade: (feito / 1048576 / s).toFixed(1) });
        });
        r.pipe(arq);
        arq.on("finish", () => {
          arq.close(() => {
            log("download concluído: " + (feito / 1048576).toFixed(1) + " MB em " + ((Date.now() - t0) / 1000).toFixed(1) + " s — trocando arquivo");
            res();
          });
        });
      })
      .on("error", rej);
    arq.on("error", rej);
  });
}

/* carência de update: versão que já falhou nesta máquina não é tentada de novo por
 * 30 min — sem isso, cada reconexão rebaixava 83 MB (loop visto em campo 23/10). */
const CARENCIA_MS = 30 * 60 * 1000;
function podeTentar(versao) {
  if (falhouPara === versao) return false;
  const t = lerConf().tentou;
  return !(t && t.para === versao && Date.now() - Number(t.ts || 0) < CARENCIA_MS);
}
function registrarFalha(versao) {
  falhouPara = versao;
  gravarConf({ ...lerConf(), tentou: { para: versao, ts: Date.now() } });
}

/* trocaExe: põe o exe novo no lugar devolvendo o caminho que deve ser reaberto.
 * Windows não deixa SOBRESCREVER o exe em uso: o jeito limpo é renomear o vivo
 * (para .old, com o fóssil da tentativa anterior removido antes) e mover o .novo
 * para o nome canônico. Se o sistema travar mesmo a renomeada (antivírus/Explorer
 * segurando o handle), NADA é sobrescrito: a versão nova roda com nome versionado
 * ao lado — o cliente atualiza de qualquer jeito e o nome velho fica intacto. */
function trocarExe(eu, tmp, para) {
  const velho = eu + ".old";
  try {
    try { fs.unlinkSync(velho); } catch { /* não existia */ }
    fs.renameSync(eu, velho);
    try {
      fs.renameSync(tmp, eu);
      if (!EH_WIN) fs.chmodSync(eu, 0o755);
      return eu;
    } catch (e) {
      try { fs.renameSync(velho, eu); } catch { /* devolveu o nome ao vivo */ }
      throw e;
    }
  } catch (e) {
    const alt = eu.replace(/\.exe$/i, "") + "-v" + para + (EH_WIN ? ".exe" : "");
    fs.renameSync(tmp, alt);
    if (!EH_WIN) fs.chmodSync(alt, 0o755);
    log("troca no mesmo nome negada pelo sistema (" + (e.code || e.message) + ") — a versão nova roda como " + alt.split(/[\\/]/).pop());
    return alt;
  }
}

async function verificarAtualizacao() {
  if (VERSAO_CLIENTE === "dev" || atualizando) return; // dev não se auto-atualiza; sem reentrância
  atualizando = true;
  try {
    const r = await fetch(new URL("/maquina/atualizacao", base).toString(), { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return;
    const j = await r.json();
    const meuPlat = EH_WIN ? "win" : "linux";
    if (!j.cliente || !j.cliente[meuPlat] || !j.versao) return;
    const maisNovo = (a, b) => {
      const pa = String(a).split(".").map(Number);
      const pb = String(b).split(".").map(Number);
      for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
      return false;
    };
    if (!maisNovo(j.versao, VERSAO_CLIENTE)) { if (estado.atualizacao && estado.atualizacao.fase !== "reiniciando") estado.atualizacao = null; return; }
    if (!podeTentar(j.versao)) { log("atualização para " + j.versao + " já falhou há pouco — não repito o download por 30 min"); return; }
    destinoVersao = j.versao;
    setAtualizacao({ para: j.versao, fase: "baixando", pct: 0, mb: "0", total_mb: "?", velocidade: "0" });
    log("atualizando cliente: " + VERSAO_CLIENTE + " → " + j.versao);
    const eu = process.execPath;
    const tmp = eu + ".novo";
    tmpArq = tmp;
    await baixar(tmp, new URL("/maquina/cliente/" + meuPlat, base).toString());
    setAtualizacao({ fase: "trocando", pct: 100 });
    const novoExe = trocarExe(eu, tmp, j.versao);
    log("exe novo no lugar (" + novoExe.split(/[\\/]/).pop() + ") — reabrindo em janela própria (minimizada, sem roubar tua tela)");
    const semToken = (() => { const i = argv.indexOf("--token"); return i < 0 ? argv : [...argv.slice(0, i), ...argv.slice(i + 2)]; })();
    const err = await relancar(novoExe, semToken);
    if (err) log("update aplicado mas relancar falhou: " + err.message + " (reabra o exe; esta janela segue funcionando)");
    morrendo = true;
    process.exit(0);
  } catch (e) {
    if (tmpArq) { try { fs.unlinkSync(tmpArq); } catch { /* já foi */ } }
    if (destinoVersao) registrarFalha(destinoVersao);
    log("atualização: " + e.message + (destinoVersao ? " — não repito por 30 min" : "") + " (sigo na versão atual)");
  } finally {
    atualizando = false;
  }
}

/* relancar: herança exata do agente Go (regra do dono 15/10): o sucessor nasce em
 * janela NOVA, já minimizada (start /min = não rouba o foreground), e sobrevive à
 * saída deste processo. O wrapper cmd fica invisível (windowsHide = CREATE_NO_WINDOW).
 * Antes: spawn com stdio inherit — o filho morava NO console do pai; o pai saía e a
 * janela fechava com o agente vivo por trás ("fechou e não reabriu", cobrado 23/10). */
function relancar(caminho, args) {
  if (EH_WIN) {
    const w = spawn("cmd.exe", ["/d", "/c", "start", "", "/min", caminho, ...args], { windowsHide: true });
    return new Promise((res) => {
      w.on("error", res);
      w.on("exit", (code) => res(code ? new Error("start saiu com código " + code) : null));
    });
  }
  try {
    const filho = spawn(caminho, args, { detached: true, stdio: "ignore" });
    filho.unref();
    return Promise.resolve(null);
  } catch (e) {
    return Promise.resolve(e);
  }
}

/* ---------------- entrada ---------------- */
process.on("uncaughtException", (e) => log("erro interno (sigo vivo): " + (e && e.stack ? e.stack.split("\n")[0] : e)));
process.on("unhandledRejection", (e) => log("promessa rejeitada (sigo vivo): " + e));
process.on("SIGINT", () => {
  morrendo = true;
  try { ws && ws.close(); } catch { /* ignore */ }
  process.exit(0);
});

(async function principal() {
  faxinaLog();
  if (!token) {
    log("sem token ainda — assim funciona:");
    log("  1) painel " + base.replace(/\/$/, "") + "/painel/  → aba Máquinas → 'gerar token' (aparece 1 vez)");
    log("  2) ou baixe o seu cliente pronto direto do painel (botão gerar cliente) e dê dois cliques nele");
    log("  depois da primeira vez o arquivo " + confPath + " guarda o token definitivo");
    log("  (tudo o que acontecer fica escrito em " + LOG_PATH + ")");
    await esperarEnter();
    process.exit(2);
  }
  log("log do cliente em " + LOG_PATH);
  iniciarPainel();
  await verificarAtualizacao();
  gravarConf({ ...lerConf(), token, host, url: base, desde: lerConf().desde || new Date().toISOString() });
  conectar();
})();
