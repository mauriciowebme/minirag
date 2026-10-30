/**
 * T052 — Sandbox Python: o modelo escreve um script e o script enxerga as ferramentas do nexos.
 *
 * Como a ponte funciona (sem rede, sem token, sem HTTP):
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
 * Nada de rede direta: o script alcança a internet só pelas ferramentas (e portanto pelo
 * mesmo log e pelo mesmo controle). O isolamento de rede por namespace fica para a etapa 2.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Usuario } from "./config";
import { log } from "./config";

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
};

const escapar = (s: string): string => JSON.stringify(s);

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

/** Resolve o interpretador: python3, python ou py -3 (Windows). */
function interpretador(): { cmd: string; args: string[] } {
  const escolhido = process.env.NEXOS_PYTHON?.trim();
  if (escolhido) return { cmd: escolhido, args: [] };
  if (process.platform === "win32") return { cmd: "py", args: ["-3"] };
  return { cmd: "python3", args: [] };
}

/**
 * Roda um script Python e devolve o que ele imprimiu.
 * `user` é quem pediu: toda chamada de ferramenta passa por `chamarToolInterna` com ele.
 */
export async function rodarPython(codigo: string, user: Usuario, opts: { segundos?: number } = {}): Promise<ResultadoPython> {
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

  const pasta = await mkdtemp(path.join(tmpdir(), "nexos-py-"));
  const script = path.join(pasta, "script.py");
  await writeFile(path.join(pasta, "nexos.py"), moduloPonte(permitidas.map((t) => t.name), descricoes), "utf8");
  await writeFile(path.join(pasta, "sitecustomize.py"), BLOQUEIO_REDE, "utf8");
  await writeFile(script, codigo, "utf8");

  const { cmd, args } = interpretador();
  const filho = spawn(cmd, [...args, script], {
    cwd: pasta,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      PYTHONPATH: pasta,
      HOME: pasta,
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
  let saida = "";
  let erro = "";
  let truncado = false;

  const juntar = (destino: "saida" | "erro", pedaco: string) => {
    const atual = destino === "saida" ? saida : erro;
    const total = saida.length + erro.length;
    if (total >= TETO_SAIDA) {
      truncado = true;
      return;
    }
    const sobra = TETO_SAIDA - total;
    const texto = pedaco.length > sobra ? pedaco.slice(0, sobra) : pedaco;
    if (texto.length < pedaco.length) truncado = true;
    if (destino === "saida") saida = atual + texto;
    else erro = atual + texto;
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
    saida: saida.trimEnd(),
    erro: erro.trimEnd(),
    truncado,
    ms: Date.now() - inicio,
    chamadas,
  };
}
