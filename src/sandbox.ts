/**
 * T052 — Sandbox Python por usuário.
 *
 * Cada usuário tem a SUA pasta, dentro do mesmo volume que guarda os arquivos dele:
 *
 *   /app/dados/usuarios/<tenant>/
 *     venv/                  caixa de bibliotecas só dele (criada na primeira execução)
 *     scripts/ferramentas/   scripts salvos (etapa 2 da tarefa)
 *     scripts/saida/         arquivos que os scripts geram (fica entre execuções)
 *     dependencias.txt       o que já foi instalado, com data — a lista de compras
 *     pip-cache/             download guardado; não baixa duas vezes
 *
 * A ponte com as ferramentas do nexos (sem rede, sem token, sem HTTP):
 *
 *   pai (Node)                          filho (python)
 *   ----------                          --------------
 *   stdin  ─────── resposta JSON ─────▶  sys.stdin
 *   fd 3   ◀───── pedido  JSON ────────  os.fdopen(3, "w")
 *   stdout ◀───── print do script ─────  print()
 *
 * O script importa o módulo `nexos` (gerado em cada execução) e chama
 * `nexos.web_search(query="...")`. Cada chamada vira uma linha JSON no fd 3; o Node executa
 * `chamarToolInterna`, que é o MESMO caminho do POST /mcp e checa a permissão do usuário que
 * pediu — o script nunca ganha poder que o usuário não tem.
 *
 * Bibliotecas: o script DECLARA o que precisa (`dependencias`) e o servidor instala só o que
 * falta, no venv daquele usuário. `pip` é o único processo com rede liberada; o script roda
 * com a rede fechada e alcança a internet só pelas ferramentas.
 */
import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import type { Usuario } from "./config";
import { log } from "./config";

const rodar = promisify(execFile);

/** Raiz das pastas por usuário (mesmo volume dos anexos). */
const RAIZ = process.env.NEXOS_SCRIPTS_DIR ?? "/app/dados/usuarios";
/** Teto de disco por usuário (bibliotecas + scripts + saídas). */
const TETO_MB = Number(process.env.NEXOS_SANDBOX_TETO_MB ?? 2048);
/** Teto de saída devolvida ao modelo (o resto é cortado e sinalizado). */
const TETO_SAIDA = 120_000;
/** Tempo máximo de uma execução. */
const TETO_SEG = 120;

export type ChamadaFerramenta = { ferramenta: string; ok: boolean; ms: number };

export type ResultadoPython = {
  ok: boolean;
  codigo: number | null;
  saida: string;
  erro: string;
  truncado: boolean;
  ms: number;
  chamadas: ChamadaFerramenta[];
  instalados: string[];
  pasta: string;
  uso_mb: number;
};

const escapar = (s: string): string => JSON.stringify(s);

/** Nome de pasta seguro a partir do tenant. */
function pastaDe(tenant: string): string {
  const t = String(tenant ?? "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
  return t || "_";
}

/** Gera o `nexos.py` da execução: só as ferramentas que ESTE usuário pode chamar. */
export function moduloPonte(nomes: string[], descricoes: Record<string, string>): string {
  const funcoes = nomes
    .map((n) => {
      const doc = (descricoes[n] ?? "").replace(/"""/g, "'''").slice(0, 200);
      return `def ${n}(**kwargs):\n    """${doc}"""\n    return _chamar(${escapar(n)}, **kwargs)\n`;
    })
    .join("\n");
  return `"""Ponte gerada pelo nexos (T052) — as ferramentas do servidor como funções Python.

Cada função recebe os mesmos parâmetros da ferramenta e devolve o resultado em Python
(dict, lista, texto ou numero). Em caso de recusa ou erro, levanta RuntimeError.
Nao use 'import requests' nem sockets para falar com a internet: use estas funcoes.
"""

import json as _json
import os as _os
import sys as _sys

_pedidos = _os.fdopen(3, "w", buffering=1, encoding="utf-8")
_respostas = _sys.stdin


def _chamar(nome, **args):
    _pedidos.write(_json.dumps({"tool": nome, "args": args}, ensure_ascii=False) + "\\n")
    _pedidos.flush()
    linha = _respostas.readline()
    if not linha:
        raise RuntimeError("a ponte com o nexos caiu (o servidor encerrou a execucao)")
    r = _json.loads(linha)
    if not r.get("ok"):
        raise RuntimeError(r.get("erro") or ("falha em " + nome))
    return r.get("resultado")


def ferramentas():
    """Lista os nomes das ferramentas disponiveis nesta execucao."""
    return [${nomes.map(escapar).join(", ")}]


${funcoes}`;
}

/** Gera o `sitecustomize.py`: fecha a rede direta ANTES do script rodar. */
const BLOQUEIO_REDE = `"""Rede direta desligada no sandbox (T052): a internet so pelas ferramentas do nexos."""
import socket as _sock

_orig = _sock.socket


class _RedeBloqueada(OSError):
    pass


def _recusar(*_a, **_k):
    raise _RedeBloqueada(
        "rede direta bloqueada no sandbox: use as ferramentas do nexos "
        "(nexos.web_search, nexos.web_open, nexos.baixar_arquivo, ...)"
    )


class _Socket(_orig):
    def connect(self, *a, **k):
        _recusar()

    def connect_ex(self, *a, **k):
        _recusar()


_sock.socket = _Socket
_sock.create_connection = _recusar
_sock.getaddrinfo = _recusar
`;

/** Só nome de pacote com versão/extras opcional — nada de URL, `-r`, `--index-url`, `git+`. */
const PACOTE_VALIDO =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}(\s*\[[A-Za-z0-9_,.-]{1,80}\])?(\s*(==|>=|<=|~=|!=|>|<)\s*[A-Za-z0-9*+._-]{1,40})?$/;

/** Valida a lista declarada pelo modelo; recusa qualquer coisa que não seja nome/versão. */
export function pacotesValidos(lista: unknown): string[] {
  if (lista === undefined || lista === null) return [];
  const bruto = Array.isArray(lista) ? lista : [lista];
  const limpos: string[] = [];
  for (const item of bruto) {
    const nome = String(item ?? "").trim();
    if (!nome) continue;
    if (!PACOTE_VALIDO.test(nome)) {
      throw new Error(`dependencia invalida: "${nome}" (use nome ou nome==versao; sem URL, sem opcoes)`);
    }
    limpos.push(nome.replace(/\s+/g, ""));
  }
  return limpos;
}

async function existe(caminho: string): Promise<boolean> {
  try {
    await access(caminho, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function pythonDoVenv(venv: string): string {
  return process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
}

function pipDoVenv(venv: string): string {
  return process.platform === "win32" ? path.join(venv, "Scripts", "pip.exe") : path.join(venv, "bin", "pip");
}

/** Tamanho da pasta do usuário em MB (0 quando ainda não existe). */
async function usoMb(pasta: string): Promise<number> {
  try {
    const { stdout } = await rodar("du", ["-sm", pasta], { timeout: 20000 });
    return Number(stdout.trim().split(/\s+/)[0] ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** Garante o venv do usuário (cria na primeira execução). */
async function garantirVenv(base: string): Promise<string> {
  const venv = path.join(base, "venv");
  const py = pythonDoVenv(venv);
  if (await existe(py)) return venv;
  await mkdir(base, { recursive: true });
  log(`sandbox: criando venv do usuário em ${venv}`);
  await rodar(process.env.NEXOS_PYTHON_SISTEMA ?? "python3", ["-m", "venv", venv], {
    timeout: 120000,
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: base },
  });
  if (!(await existe(py))) throw new Error("nao consegui criar o venv do usuario");
  return venv;
}

/** Instala no venv o que ainda falta da lista declarada. Devolve o que foi instalado agora. */
async function garantirDependencias(base: string, venv: string, pedidos: string[]): Promise<string[]> {
  if (!pedidos.length) return [];
  const lista = path.join(base, "dependencias.txt");
  const registro = (await existe(lista)) ? await readFile(lista, "utf8").catch(() => "") : "";
  const jaTem = new Set(
    registro
      .split("\n")
      .map((l) => l.trim().split(/\s+/)[1] ?? "")
      .filter(Boolean)
      .map((p) => p.split(/[=<>!~]/)[0].toLowerCase()),
  );
  const faltam = pedidos.filter((p) => !jaTem.has(p.split(/[=<>!~ ]/)[0].toLowerCase()));
  if (!faltam.length) return [];

  const antes = await usoMb(base);
  if (antes >= TETO_MB) {
    throw new Error(`a pasta do usuario ja usa ${antes} MB (teto ${TETO_MB} MB); apague algo antes de instalar`);
  }

  log(`sandbox: instalando no venv de ${path.basename(base)}: ${faltam.join(", ")}`);
  try {
    await rodar(pipDoVenv(venv), ["install", "--no-input", "--no-warn-script-location", ...faltam], {
      timeout: 300000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: base,
        PIP_CACHE_DIR: path.join(base, "pip-cache"),
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
        PYTHONIOENCODING: "utf-8",
      },
    });
  } catch (e) {
    const detalhe = String((e as { stderr?: string; message?: string }).stderr ?? (e as Error).message ?? e);
    throw new Error(`pip falhou: ${detalhe.slice(-1200)}`);
  }

  const quando = new Date().toISOString().slice(0, 10);
  await appendFile(lista, faltam.map((p) => `${quando} ${p}\n`).join(""), "utf8");

  const depois = await usoMb(base);
  if (depois > TETO_MB) {
    throw new Error(`instalacao passou do teto: ${depois} MB (limite ${TETO_MB} MB)`);
  }
  return faltam;
}

/**
 * Roda um script Python na pasta do usuário, com as ferramentas do nexos como funções.
 * `user` é quem pediu: toda chamada de ferramenta passa por `chamarToolInterna` com ele.
 */
export async function rodarPython(
  codigo: string,
  user: Usuario,
  opts: { segundos?: number; dependencias?: unknown } = {},
): Promise<ResultadoPython> {
  const teto = Math.min(Math.max(opts.segundos ?? TETO_SEG, 5), 600);
  const inicio = Date.now();

  /* import dinâmico: mcp.ts importa este arquivo, e o ciclo só existe em runtime */
  const { chamarToolInterna, TOOLS } = await import("./mcp");
  const { motivoDeBloqueio } = await import("./mcp_acesso");

  const permitidas = TOOLS.filter(
    (t) => t.name !== "rodar_python" && motivoDeBloqueio(user.tenant, user.operador, t.name) === null,
  );
  const descricoes: Record<string, string> = {};
  for (const t of permitidas) descricoes[t.name] = t.description;

  const base = path.join(RAIZ, pastaDe(user.tenant));
  const pastaSaida = path.join(base, "scripts", "saida");
  await mkdir(pastaSaida, { recursive: true });

  const venv = await garantirVenv(base);
  const instalados = await garantirDependencias(base, venv, pacotesValidos(opts.dependencias));

  const pasta = await mkdtemp(path.join(tmpdir(), "nexos-py-"));
  const script = path.join(pasta, "script.py");
  await writeFile(path.join(pasta, "nexos.py"), moduloPonte(permitidas.map((t) => t.name), descricoes), "utf8");
  await writeFile(path.join(pasta, "sitecustomize.py"), BLOQUEIO_REDE, "utf8");
  await writeFile(script, codigo, "utf8");

  const filho = spawn(pythonDoVenv(venv), [script], {
    cwd: pastaSaida,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      PYTHONPATH: pasta,
      HOME: base,
      TMPDIR: pasta,
      LANG: "C.UTF-8",
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    },
    /* [stdin, stdout, stderr, fd3] */
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });

  const chamadas: ChamadaFerramenta[] = [];
  let texto = "";
  let erro = "";
  let truncado = false;

  const juntar = (destino: "saida" | "erro", pedaco: string) => {
    const total = texto.length + erro.length;
    if (total >= TETO_SAIDA) {
      truncado = true;
      return;
    }
    const sobra = TETO_SAIDA - total;
    const parte = pedaco.length > sobra ? pedaco.slice(0, sobra) : pedaco;
    if (parte.length < pedaco.length) truncado = true;
    if (destino === "saida") texto += parte;
    else erro += parte;
  };

  filho.stdout?.on("data", (d: Buffer) => juntar("saida", d.toString("utf8")));
  filho.stderr?.on("data", (d: Buffer) => juntar("erro", d.toString("utf8")));

  /* pedidos do script → ferramentas do servidor */
  const leitor = readline.createInterface({ input: filho.stdio[3] as NodeJS.ReadableStream });
  leitor.on("line", (linha) => {
    void (async () => {
      const t0 = Date.now();
      let nome = "?";
      try {
        const pedido = JSON.parse(linha) as { tool?: string; args?: Record<string, unknown> };
        nome = String(pedido.tool ?? "");
        if (!nome) throw new Error("pedido sem 'tool'");
        const args = (pedido.args ?? {}) as Record<string, unknown>;
        const r = await chamarToolInterna(nome, args, user);
        chamadas.push({ ferramenta: nome, ok: true, ms: Date.now() - t0 });
        filho.stdin?.write(JSON.stringify({ ok: true, resultado: r }) + "\n");
      } catch (e) {
        chamadas.push({ ferramenta: nome, ok: false, ms: Date.now() - t0 });
        filho.stdin?.write(JSON.stringify({ ok: false, erro: String((e as Error).message ?? e) }) + "\n");
      }
    })();
  });

  const codigoSaida = await new Promise<number | null>((resolve) => {
    const relogio = setTimeout(() => {
      log(`sandbox: script passou de ${teto}s, encerrando`);
      filho.kill("SIGKILL");
    }, teto * 1000);
    filho.on("exit", (c) => {
      clearTimeout(relogio);
      resolve(c);
    });
    filho.on("error", (e) => {
      clearTimeout(relogio);
      erro += `\n${String(e.message ?? e)}`;
      resolve(null);
    });
  });

  leitor.close();
  await rm(pasta, { recursive: true, force: true }).catch(() => {});

  return {
    ok: codigoSaida === 0,
    codigo: codigoSaida,
    saida: texto.trimEnd(),
    erro: erro.trimEnd(),
    truncado,
    ms: Date.now() - inicio,
    chamadas,
    instalados,
    pasta: `usuarios/${pastaDe(user.tenant)}/scripts/saida`,
    uso_mb: await usoMb(base),
  };
}
