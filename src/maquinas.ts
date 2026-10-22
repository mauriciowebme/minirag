/**
 * v3.6 (dono, 22/10) — MÁQUINAS: o túnel absorvido pelo minirag.
 *
 * Cada usuário pode parear as SUAS máquinas com o minirag. Um cliente leve
 * (mesma linguagem do servidor) abre WebSocket de SAÍDA para `/maquina/ws` e
 * obedece comandos — só quem tem a chave do usuário manda nas máquinas dele.
 *
 * Wire herdado do agent-tunel, tags intocadas (cliente velho não pode quebrar):
 *   1ª frame do cliente: {"token","host","os","user"}  →  {"ack":"ok"|"negado", token?}
 *   servidor → cliente:  {"cmd","rotulo","espera"}
 *   cliente → servidor:  {"exit","stdout","stderr"}
 *
 * Pareamento (a adaptação multi-tenant que o túnel nunca teve):
 *   POST /maquinas cria um token de UMA vez (expira em ~15min); o primeiro `oi`
 *   com ele grava a máquina e devolve um token de máquina de longa duração, que o
 *   cliente guarda num arquivo-irmão e usa em toda reconexão. Máquinas ficam
 *   presas ao tenant do usuário que as criou.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { q } from "./db";
import { HttpError } from "./errors";
import { log, type Usuario } from "./config";
import { hashChave, validarNome } from "./usuarios";

const PAREAMENTO_SEG = Math.min(3600, Math.max(60, Number(process.env.MINIRAG_PAREAMENTO_SEG ?? 900) || 900));
const TIMEOUT_PADRAO = 30;
const TIMEOUT_MAX = 120;

type Ligacao = {
  ws: WebSocket;
  tenant: string;
  host: string;
  nome: string;
  so: string;
  user: string;
  desde: string; // ISO
  pendente: ((r: { exit: number; stdout: string; stderr: string }) => void) | null;
  cauda: Promise<unknown>;
};

const ligacoes = new Map<string, Ligacao>(); // chave `tenant|host`
const chaveDe = (tenant: string, host: string) => `${tenant}|${host}`;

export async function initMaquinas(): Promise<void> {
  await q(
    `CREATE TABLE IF NOT EXISTS maquinas (
       tenant      VARCHAR(64) NOT NULL,
       host        VARCHAR(128) NOT NULL,
       nome        VARCHAR(64) NOT NULL DEFAULT '',
       so          TEXT NOT NULL DEFAULT '',
       usuario_win TEXT NOT NULL DEFAULT '',
       token_hash  CHAR(64) NOT NULL UNIQUE,
       ativo       BOOLEAN NOT NULL DEFAULT true,
       visto_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
       criado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (tenant, host)
     )`,
  );
  await q(
    `CREATE TABLE IF NOT EXISTS pareamentos (
       id         SERIAL PRIMARY KEY,
       tenant     VARCHAR(64) NOT NULL,
       nome       VARCHAR(64) NOT NULL,
       token_hash CHAR(64) NOT NULL UNIQUE,
       expira_em  TIMESTAMPTZ NOT NULL,
       usado      BOOLEAN NOT NULL DEFAULT false,
       criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  await q(
    `CREATE TABLE IF NOT EXISTS comandos_log (
       id        SERIAL PRIMARY KEY,
       tenant    VARCHAR(64) NOT NULL,
       host      VARCHAR(128) NOT NULL,
       cmd       TEXT NOT NULL,
       exit      INT,
       stdout    TEXT NOT NULL DEFAULT '',
       stderr    TEXT NOT NULL DEFAULT '',
       ms        INT NOT NULL DEFAULT 0,
       origem    VARCHAR(16) NOT NULL DEFAULT 'rest',
       criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
}

/* ------------------------------------------------------------------ REST ---- */

export function criarPareamento(u: Usuario, alvo: string, nomeBruto: string) {
  const nome = validarNome(nomeBruto);
  const token = randomBytes(20).toString("hex"); // mesmo formato de chave: sem segredo em log
  void alvo;
  return q(
    `INSERT INTO pareamentos (tenant, nome, token_hash, expira_em)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [alvo, nome, hashChave(token), PAREAMENTO_SEG],
  ).then(() => ({
    tenant: alvo,
    nome,
    token,
    expira_em: new Date(Date.now() + PAREAMENTO_SEG * 1000).toISOString(),
    segundos: PAREAMENTO_SEG,
  }));
}

export async function listarMaquinas(alvo: string | null) {
  const r = alvo
    ? await q<any>(
        `SELECT tenant, host, nome, so, usuario_win, ativo, visto_em, criado_em
         FROM maquinas WHERE tenant = $1 ORDER BY host`,
        [alvo],
      )
    : await q<any>(
        `SELECT tenant, host, nome, so, usuario_win, ativo, visto_em, criado_em
         FROM maquinas ORDER BY tenant, host`,
      );
  return {
    maquinas: r.rows.map((m: any) => ({
      ...m,
      online: ligacoes.has(chaveDe(m.tenant, m.host)),
      desde: ligacoes.get(chaveDe(m.tenant, m.host))?.desde ?? null,
    })),
  };
}

export async function mudarMaquina(u: Usuario, alvo: string, host: string, corpo: Record<string, any>) {
  if (typeof corpo.ativo !== "boolean") throw new HttpError(422, "ativo deve ser booleano");
  const r = await q(
    `UPDATE maquinas SET ativo = $3 WHERE tenant = $1 AND host = $2 RETURNING tenant, host, nome, ativo`,
    [alvo, host, corpo.ativo],
  );
  if (!r.rowCount) throw new HttpError(404, "máquina não encontrada");
  if (!corpo.ativo) {
    const l = ligacoes.get(chaveDe(alvo, host));
    if (l) {
      try { l.ws.terminate(); } catch { /* ignore */ }
      ligacoes.delete(chaveDe(alvo, host));
      log(`maquinas: ${alvo}|${host} DESATIVADA → conexão derrubada`);
    }
  }
  void u;
  return r.rows[0];
}

export async function apagarMaquina(alvo: string, host: string) {
  const r = await q(`DELETE FROM maquinas WHERE tenant = $1 AND host = $2 RETURNING tenant, host`, [alvo, host]);
  const l = ligacoes.get(chaveDe(alvo, host));
  if (l) {
    try { l.ws.terminate(); } catch { /* ignore */ }
    ligacoes.delete(chaveDe(alvo, host));
  }
  if (!r.rowCount) throw new HttpError(404, "máquina não encontrada");
  return { removida: r.rows[0] };
}

export async function listarLog(alvo: string | null, host: string | null, limite: number) {
  const r = await q<any>(
    `SELECT tenant, host, cmd, exit, stdout, stderr, ms, origem, criado_em
     FROM comandos_log WHERE ($1::text IS NULL OR tenant = $1) AND ($2::text IS NULL OR host = $2)
     ORDER BY id DESC LIMIT $3`,
    [alvo, host, Math.min(500, Math.max(1, limite))],
  );
  return { log: r.rows };
}

/* ----------------------------------------------------------------- RUN ------ */

export async function rodar(
  u: Usuario,
  alvo: string,
  host: string,
  cmd: string,
  timeoutSeg: number | undefined,
  origem: string,
): Promise<{ exit: number; stdout: string; stderr: string; ms: number; host: string }> {
  if (typeof cmd !== "string" || !cmd.trim()) throw new HttpError(422, "cmd é obrigatório");
  if (cmd.length > 4000) throw new HttpError(422, "cmd longo demais (máx 4000)");
  const espera = Math.min(TIMEOUT_MAX, Math.max(1, Number(timeoutSeg ?? TIMEOUT_PADRAO) || TIMEOUT_PADRAO));
  const chave = chaveDe(alvo, host);
  const l = ligacoes.get(chave);
  if (!l) throw new HttpError(404, "máquina fora do ar (nenhum cliente conectado com esse nome)");

  const t0 = Date.now();
  const resultado = await fila(l, espera, cmd);
  const ms = Date.now() - t0;
  const stdout = (resultado.stdout ?? "").slice(0, 20000);
  const stderr = (resultado.stderr ?? "").slice(0, 8000);
  await q(
    `INSERT INTO comandos_log (tenant, host, cmd, exit, stdout, stderr, ms, origem)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [alvo, host, cmd, resultado.exit, stdout, stderr, ms, origem],
  ).catch((e) => log(`maquinas: auditoria falhou: ${(e as Error).message}`));
  void u;
  return { exit: resultado.exit, stdout, stderr, ms, host };
}

/** Serial por máquina (regra herdada do túnel: fila no mesmo host) + teto de tempo. */
function fila(l: Ligacao, espera: number, cmd: string) {
  const proximo = l.cauda.then(
    () =>
      new Promise<{ exit: number; stdout: string; stderr: string }>((resolve) => {
        let feito = false;
        const terminar = (r: { exit: number; stdout: string; stderr: string }) => {
          if (feito) return;
          feito = true;
          l.pendente = null;
          clearTimeout(religio);
          resolve(r);
        };
        l.pendente = terminar;
        const religio = setTimeout(() => {
          terminar({ exit: -124, stdout: "", stderr: `sem resposta em ${espera + 8}s (espera=${espera}s)` });
        }, (espera + 8) * 1000);
        try {
          l.ws.send(JSON.stringify({ cmd, rotulo: cmd.slice(0, 60), espera }));
        } catch {
          terminar({ exit: -1, stdout: "", stderr: "cano quebrado no envio" });
        }
      }),
  );
  l.cauda = proximo.catch(() => undefined);
  return proximo;
}

/* ------------------------------------------------------------------ HUB ----- */

type OiFrame = { token?: string; host?: string; os?: string; user?: string };

async function receberOi(ws: WebSocket, oi: OiFrame): Promise<void> {
  const host = String(oi.host ?? "").trim().slice(0, 128);
  const token = String(oi.token ?? "").trim();
  if (!host || !token) {
    ws.send(JSON.stringify({ ack: "negado", motivo: "oi sem host/token" }));
    ws.close();
    return;
  }
  const hash = hashChave(token);

  // 1) token de máquina (reconexão) — o host declarado DEVE bater com o dono do token
  const m = await q<any>(
    `SELECT tenant, host, nome, ativo FROM maquinas WHERE token_hash = $1 AND host = $2`,
    [hash, host],
  );
  let registro: { tenant: string; host: string; nome: string } | null = null;
  let tokenNovo: string | null = null;
  if (m.rowCount) {
    if (!m.rows[0].ativo) {
      ws.send(JSON.stringify({ ack: "negado", motivo: "máquina desativada" }));
      log(`maquinas: REJEITADO ${m.rows[0].tenant}|${host} (desativada)`);
      ws.close();
      return;
    }
    const lin = m.rows[0] as { tenant: string; host: string; nome: string };
    registro = lin;
    await q(`UPDATE maquinas SET visto_em = now(), so = $3, usuario_win = $4 WHERE tenant = $1 AND host = $2`, [
      lin.tenant, lin.host, String(oi.os ?? "").slice(0, 40), String(oi.user ?? "").slice(0, 64),
    ]);
  } else {
    // 2) token de pareamento (primeira vez): usa e cria a máquina
    const p = await q<any>(
      `SELECT tenant, nome, expira_em, usado FROM pareamentos WHERE token_hash = $1`,
      [hash],
    );
    if (!p.rowCount) {
      ws.send(JSON.stringify({ ack: "negado", motivo: "token desconhecido" }));
      log(`maquinas: REJEITADO host=${host} token invalido`);
      ws.close();
      return;
    }
    const par = p.rows[0];
    if (par.usado || new Date(par.expira_em).getTime() < Date.now()) {
      ws.send(JSON.stringify({ ack: "negado", motivo: "pareamento vencido ou já usado" }));
      log(`maquinas: REJEITADO host=${host} pareamento velho`);
      ws.close();
      return;
    }
    tokenNovo = randomBytes(20).toString("hex");
    await q(
      `INSERT INTO maquinas (tenant, host, nome, so, usuario_win, token_hash)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant, host) DO UPDATE SET nome = EXCLUDED.nome, so = EXCLUDED.so,
         usuario_win = EXCLUDED.usuario_win, token_hash = EXCLUDED.token_hash, visto_em = now()`,
      [par.tenant, host, par.nome, String(oi.os ?? "").slice(0, 40), String(oi.user ?? "").slice(0, 64), hashChave(tokenNovo)],
    );
    await q(`UPDATE pareamentos SET usado = true WHERE token_hash = $1`, [hash]);
    registro = { tenant: par.tenant, host, nome: par.nome };
    log(`maquinas: PAREADA ${par.tenant}|${host}`);
  }

  const reg = registro; // estreitamento final (todos os caminhos acima já garantem; TS não prova com await no meio)
  if (!reg) {
    ws.send(JSON.stringify({ ack: "negado", motivo: "interno" }));
    ws.close();
    return;
  }
  const chave = chaveDe(reg.tenant, reg.host);
  const antiga = ligacoes.get(chave);
  if (antiga && antiga.ws !== ws) {
    try { antiga.ws.terminate(); } catch { /* ignore */ }
    ligacoes.delete(chave);
    log(`maquinas: SUBSTITUIDO ${chave}`);
  }
  const lig: Ligacao = {
    ws,
    tenant: reg.tenant,
    host: reg.host,
    nome: reg.nome,
    so: String(oi.os ?? ""),
    user: String(oi.user ?? ""),
    desde: new Date().toISOString(),
    pendente: null,
    cauda: Promise.resolve(),
  };
  ligacoes.set(chave, lig);
  ws.send(JSON.stringify(tokenNovo ? { ack: "ok", token: tokenNovo } : { ack: "ok" }));
  log(`maquinas: ONLINE ${chave} (so=${lig.so || "?"} user=${lig.user || "?"})`);

  ws.on("message", (bytes) => {
    let r: any;
    try {
      r = JSON.parse(String(bytes));
    } catch {
      return;
    }
    if (r && typeof r.exit === "number" && lig.pendente) {
      lig.pendente({ exit: r.exit, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") });
    }
  });
  ws.on("close", () => {
    if (ligacoes.get(chave) === lig) {
      ligacoes.delete(chave);
      if (lig.pendente) lig.pendente({ exit: -1, stdout: "", stderr: "máquina caiu no meio do comando" });
      log(`maquinas: OFFLINE ${chave}`);
    }
  });
  ws.on("error", () => { /* close cuida da limpeza */ });
}

export function anexarHubMaquinas(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    let path = "";
    try {
      path = new URL(req.url ?? "", "http://int").pathname;
    } catch {
      path = "";
    }
    if (path !== "/maquina/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let aguardandoOi = true;
      ws.once("message", (bytes) => {
        aguardandoOi = false;
        let oi: OiFrame = {};
        try {
          oi = JSON.parse(String(bytes));
        } catch {
          /* nega embaixo */
        }
        void receberOi(ws, oi);
      });
      setTimeout(() => {
        if (aguardandoOi) {
          try { ws.close(); } catch { /* ignore */ }
        }
      }, 10_000).unref?.();
    });
  });
  // heartbeat: Traefik fecha cano ocioso; Ping 25s é a receita provada no túnel
  setInterval(() => {
    for (const [, l] of ligacoes) {
      try { l.ws.ping(); } catch { /* ignore */ }
    }
  }, 25_000).unref?.();
}

/** Alvo de escopo: comum = sempre o próprio; operador = ?tenant ou o próprio. */
export function alvoMaquina(u: Usuario, arg?: string | null): string {
  return u.operador ? String(arg ?? "").trim() || u.tenant : u.tenant;
}
