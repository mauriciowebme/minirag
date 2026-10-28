/** Navegador de verdade para o web_open (v3.33): chromium headless via CDP, sem npm.
 *
 * Por que existe: metade dos sites monta o conteúdo por JavaScript — o HTML que o curl
 * baixa vem oco. Aqui o chromium abre a página, espera a rede sossegar e devolve o texto
 * que o usuário veria.
 *
 * Custo medido (container de produção): +381 MB de imagem, ~270 MB de RSS parado e
 * 350-620 MB navegando, 1,3 s para subir, 3-4 s por página comum e até 15 s em portal
 * cheio de anúncio. Por isso: UMA página por vez, teto de tempo, reinício por memória e
 * desligamento por ociosidade.
 *
 * SSRF: além da checagem da URL, cada requisição (inclusive sub-recurso e redirecionamento)
 * passa pelo Fetch do CDP e é abortada se o host for interno.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { readFileSync, readdirSync, rmSync } from "node:fs";

const PORTA = 9377;
const PERFIL = "/tmp/minirag-chromium";
const TETO_PAGINA_MS = 20000;
const SOSSEGO_MS = 1200;
const OCIOSO_MS = 180000;
const TETO_PAGINAS = 40;
const TETO_RSS_MB = 800;
const MAX_TEXTO = 12000;

const INTERNOS = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^169\.254\./,
  /^10\./,
  /^127\./,
  /^0\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^::1$/,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
];

export function hostInterno(host: string) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return INTERNOS.some((re) => re.test(h));
}

async function hostInternoResolvido(host: string) {
  if (hostInterno(host)) return true;
  if (isIP(host)) return false;
  try {
    const { address } = await lookup(host, { verbatim: true });
    return hostInterno(address);
  } catch {
    return false;
  }
}

type Sessao = { alvo: string; sessao: string };
type Cliente = { ws: WebSocket; cmd: (m: string, p?: unknown, s?: string) => Promise<any>; eventos: any[] };

let proc: ChildProcess | null = null;
let cliente: Cliente | null = null;
let subindo: Promise<Cliente> | null = null;
let fila: Promise<unknown> = Promise.resolve();
let paginas = 0;
let ocioso: NodeJS.Timeout | null = null;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rssMb() {
  let kb = 0;
  try {
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        if (!/chrom/i.test(readFileSync(`/proc/${d}/cmdline`, "utf8"))) continue;
        const m = /VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${d}/status`, "utf8"));
        if (m) kb += Number(m[1]);
      } catch {
        /* processo saiu no meio da leitura */
      }
    }
  } catch {
    /* sem /proc */
  }
  return Math.round(kb / 1024);
}

function encerrar() {
  if (ocioso) {
    clearTimeout(ocioso);
    ocioso = null;
  }
  try {
    cliente?.ws.close();
  } catch {
    /* já fechado */
  }
  cliente = null;
  subindo = null;
  if (proc) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* já morreu */
    }
    proc = null;
  }
  paginas = 0;
  try {
    rmSync(PERFIL, { recursive: true, force: true });
  } catch {
    /* perfil travado: o próximo /tmp limpa */
  }
}

async function abrirCliente(): Promise<Cliente> {
  const bin = process.env.MINIRAG_CHROMIUM || "/usr/bin/chromium";
  proc = spawn(
    bin,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--blink-settings=imagesEnabled=false",
      "--disable-background-networking",
      "--disable-sync",
      "--metrics-recording-only",
      `--remote-debugging-port=${PORTA}`,
      `--user-data-dir=${PERFIL}`,
      "about:blank",
    ],
    { stdio: "ignore", detached: false },
  );
  proc.on("exit", () => {
    proc = null;
    cliente = null;
    subindo = null;
  });

  let versao: { webSocketDebuggerUrl: string } | null = null;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORTA}/json/version`, { signal: AbortSignal.timeout(800) });
      if (r.ok) {
        versao = (await r.json()) as { webSocketDebuggerUrl: string };
        break;
      }
    } catch {
      /* ainda subindo */
    }
    await dormir(250);
  }
  if (!versao) {
    encerrar();
    throw new Error("chromium não subiu (veja MINIRAG_CHROMIUM)");
  }

  const ws = new WebSocket(versao.webSocketDebuggerUrl);
  const pend = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  const eventos: any[] = [];
  let seq = 0;
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id)!;
      pend.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    } else if (m.method) {
      eventos.push(m);
      if (eventos.length > 5000) eventos.splice(0, 2500);
    }
  });
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("cdp não abriu")));
  });
  const cmd = (method: string, params: unknown = {}, sessionId?: string) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise<any>((res, rej) => pend.set(id, { res, rej }));
  };
  return { ws, cmd, eventos };
}

async function garantirCliente(): Promise<Cliente> {
  if (cliente) return cliente;
  if (!subindo) {
    subindo = abrirCliente().then((c) => {
      cliente = c;
      subindo = null;
      return c;
    });
  }
  return subindo;
}

/** Renderiza uma página e devolve o texto visível. Serializa: uma página por vez. */
export function renderizar(url: string): Promise<{ texto: string; url: string; ms: number; bytes: number }> {
  const tarefa = fila.then(() => renderizarAgora(url));
  fila = tarefa.catch(() => undefined);
  return tarefa;
}

async function renderizarAgora(url: string): Promise<{ texto: string; url: string; ms: number; bytes: number }> {
  const alvo = new URL(url);
  if (await hostInternoResolvido(alvo.hostname)) throw new Error("endereco interno nao permitido");

  if (paginas >= TETO_PAGINAS || rssMb() > TETO_RSS_MB) encerrar(); // começa limpo
  const c = await garantirCliente();
  const t0 = Date.now();

  const { targetId } = await c.cmd("Target.createTarget", { url: "about:blank" });
  const { sessionId } = (await c.cmd("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
  try {
    await c.cmd("Page.enable", {}, sessionId);
    await c.cmd("Runtime.enable", {}, sessionId);
    /* trava de SSRF em TODA requisição da página (sub-recurso e redirecionamento) */
    await c.cmd("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
    const punho = c.cmd("Page.navigate", { url: alvo.toString() }, sessionId);

    const inicio = c.eventos.length;
    let abortado = false;
    /* cada requestPaused só pode ser liberado UMA vez: continuar duas vezes devolve
     * "Invalid state for continueInterceptedRequest" e derruba o processo. Daí o set. */
    const vistos = new Set<string>();
    const vigia = setInterval(() => {
      for (const ev of c.eventos.slice(inicio)) {
        if (ev.method !== "Fetch.requestPaused") continue;
        const { requestId, request } = ev.params;
        if (vistos.has(requestId)) continue;
        vistos.add(requestId);
        let host = "";
        try {
          host = new URL(request.url).hostname;
        } catch {
          void c.cmd("Fetch.continueRequest", { requestId }, sessionId).catch(() => undefined);
          continue;
        }
        if (host && hostInterno(host)) {
          abortado = true;
          void c.cmd("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => undefined);
        } else {
          void c.cmd("Fetch.continueRequest", { requestId }, sessionId).catch(() => undefined);
        }
      }
    }, 60);

    let carregou = false;
    const limite = Date.now() + TETO_PAGINA_MS;
    while (Date.now() < limite) {
      if (c.eventos.slice(inicio).some((e) => e.method === "Page.loadEventFired")) {
        carregou = true;
        break;
      }
      await dormir(120);
    }
    await dormir(carregou ? SOSSEGO_MS : 400);
    const r = await c.cmd(
      "Runtime.evaluate",
      { expression: "document.body ? document.body.innerText : ''", returnByValue: true },
      sessionId,
    );
    clearInterval(vigia);
    await punho.catch(() => undefined);
    const texto = String(r?.result?.value ?? "").replace(/\n{3,}/g, "\n\n").trim();
    paginas++;
    return { texto, url: alvo.toString(), ms: Date.now() - t0, bytes: texto.length };
  } finally {
    await c.cmd("Target.closeTarget", { targetId }).catch(() => undefined);
    if (ocioso) clearTimeout(ocioso);
    ocioso = setTimeout(() => encerrar(), OCIOSO_MS);
    ocioso.unref?.();
  }
}

export function estadoNavegador() {
  return { vivo: Boolean(proc), paginas, rss_mb: rssMb() };
}

export { MAX_TEXTO };
