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
 *  - auto-update: compara a versão embutida no build com o /maquina/atualizacao
 *    do servidor; se o servidor fala versão maior, baixa, troca e reinicia
 *    (no Windows o velho vira .old porque não se apaga arquivo em execução).
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

let token = flag("token", "") || lerConf().token || ""; // argv ganha no primeiro pareamento; depois o conf manda

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
function log(msg) {
  const linha = new Date().toISOString().slice(0, 19).replace("T", " ") + "  " + msg;
  console.log(linha);
  try {
    fs.appendFileSync(LOG_PATH, linha + "\n");
  } catch { /* sem disco de escrita? o console ainda salva a sessão */ }
}
function rotacionarLog() {
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size > 2_000_000) fs.renameSync(LOG_PATH, LOG_PATH + ".old"); // 2 MB, mantém o .old como fósforo
  } catch { /* ainda não existe */ }
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
      resolve({ exit: -124, stdout: stdout.slice(0, 20000), stderr: stderr.slice(0, 8000) });
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
      resolve({ exit: code == null ? -9 : code, stdout: stdout.slice(0, 20000), stderr: stderr.slice(0, 8000) });
    });
  });
}

/* ---------------- websocket (nativo do Node — SEA sem dependência) ---------------- */
let ws = null;
let morrendo = false;

function conectar() {
  if (morrendo) return;
  log("conectando em " + URL_WS + " como " + host + " (v" + VERSAO_CLIENTE + ")");
  ws = new WebSocket(URL_WS);
  ws.addEventListener("open", () => {
    nivelBackoff = 0;
    ws.send(JSON.stringify({ token, host, os: process.platform + " " + os.release(), user: os.userInfo().username }));
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
        if (m.token && m.token !== token) {
          token = m.token; // PAREAMENTO → token de máquina: adota e persiste (reconexão não pode usar o pareamento queimado)
          gravarConf({ token, host, url: base, desde: new Date().toISOString() });
          log("token de máquina adotado e guardado em " + confPath);
        }
      } else if (m.ack === "negado") {
        log("NEGADO pelo servidor: " + (m.motivo || "?") + " — tentando de novo em 30s");
        try { ws.close(); } catch { /* ignore */ }
        nivelBackoff = 5; // 30s fixo: negado é problema de conta/máquina, não de rede
      }
      return;
    }
    if (typeof m.cmd === "string") {
      log("cmd (" + (m.rotulo || "?") + "): " + m.cmd.slice(0, 120));
      const r = await rodar(m.cmd, m.espera);
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
    if (morrendo) return;
    const atrasos = [400, 800, 1500, 3000, 8000, 15000, 30000];
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
        r.pipe(arq);
        arq.on("finish", () => arq.close(() => res()));
      })
      .on("error", rej);
    arq.on("error", rej);
  });
}

async function verificarAtualizacao() {
  if (VERSAO_CLIENTE === "dev") return; // build de desenvolvimento não se auto-atualiza
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
    if (!maisNovo(j.versao, VERSAO_CLIENTE)) return;
    log("atualizando cliente: " + VERSAO_CLIENTE + " → " + j.versao);
    const eu = process.execPath;
    const tmp = eu + ".novo";
    await baixar(tmp, new URL("/maquina/cliente/" + meuPlat, base).toString());
    if (EH_WIN) {
      try { fs.renameSync(eu, eu + ".old"); } catch { /* .old de antes */ }
    } else {
      fs.copyFileSync(eu, eu + ".old");
      fs.chmodSync(tmp, 0o755);
    }
    fs.renameSync(tmp, eu);
    if (!EH_WIN) fs.chmodSync(eu, 0o755);
    log("exe novo no lugar — reiniciando");
    const semToken = (() => { const i = argv.indexOf("--token"); return i < 0 ? argv : [...argv.slice(0, i), ...argv.slice(i + 2)]; })();
    const filho = spawn(eu, semToken, { detached: true, stdio: "inherit" }); // sem --token: o pareamento pode estar queimado; conf tem o de máquina
    filho.unref();
    morrendo = true;
    process.exit(0);
  } catch (e) {
    log("atualização: " + e.message + " (sigo com a versão atual)");
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
  rotacionarLog();
  if (!token) {
    log("sem token ainda — assim funciona:");
    log("  1) painel " + base.replace(/\/$/, "") + "/painel/  → aba Máquinas → 'gerar token' (aparece 1 vez)");
    log("  2) neste terminal:  " + path.basename(process.execPath) + " --token COLE-O-TOKEN");
    log("  depois da primeira vez o arquivo " + confPath + " guarda o token definitivo");
    log("  (tudo o que acontecer fica escrito em " + LOG_PATH + ")");
    await esperarEnter();
    process.exit(2);
  }
  log("log do cliente em " + LOG_PATH);
  await verificarAtualizacao();
  gravarConf({ token, host, url: base, desde: lerConf().desde || new Date().toISOString() });
  conectar();
})();
