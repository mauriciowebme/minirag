/**
 * Anexos do chat — arquivos que a MÁQUINA manda para o servidor e que o dono vê
 * na conversa (print de tela, imagem, log, qualquer arquivo).
 *
 * Antes da v3.44 não existia caminho de volta: `ler_arquivo` devolvia base64 ao
 * MODELO e o chat só desenhava imagem que o USUÁRIO mandava. Aqui o arquivo vira
 * uma linha em `anexos` e o front busca por `GET /anexos/:id` (com a chave no
 * header) para exibir/baixar.
 */
import { randomBytes } from "node:crypto";
import { q } from "./db";
import { HttpError } from "./errors";
import type { Usuario } from "./config";

export type AnexoMeta = { id: string; nome: string; mime: string; bytes: number; host?: string };

/** teto por arquivo — o túnel não é canal para GB (para isso existe a LAN) */
export const MAX_ANEXO = 32 * 1024 * 1024;

/** nome seguro para header/disco: sem barra, sem controle, tamanho limitado */
export function nomeLimpo(n: string): string {
  const base = String(n ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop() ?? "";
  const limpo = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[<>:"|?*]/g, "_").trim();
  return (limpo || "arquivo").slice(0, 180);
}

export function mimePorNome(nome: string): string {
  const ext = (nome.split(".").pop() ?? "").toLowerCase();
  const mapa: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
    pdf: "application/pdf", json: "application/json", csv: "text/csv",
    txt: "text/plain; charset=utf-8", log: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8", html: "text/html; charset=utf-8",
    zip: "application/zip", xml: "application/xml",
  };
  return mapa[ext] ?? "application/octet-stream";
}

export async function iniciarAnexos(): Promise<void> {
  await q(
    `CREATE TABLE IF NOT EXISTS anexos (
       id        VARCHAR(32) PRIMARY KEY,
       tenant    VARCHAR(64) NOT NULL,
       host      VARCHAR(128) NOT NULL DEFAULT '',
       nome      VARCHAR(255) NOT NULL,
       mime      VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
       bytes     INTEGER NOT NULL,
       dados     BYTEA NOT NULL,
       criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  /* anexo é conveniência, não acervo: 7 dias e some (o original do documento mora em `docs`) */
  await q(`DELETE FROM anexos WHERE criado_em < now() - interval '7 days'`);
}

/** grava direto com o tenant explícito (usado pelo canal da máquina, que não tem sessão) */
export async function gravarAnexo(
  dados: Buffer,
  opts: { tenant: string; nome: string; mime?: string; host?: string },
): Promise<AnexoMeta> {
  if (!dados || dados.length === 0) throw new HttpError(422, "arquivo vazio — nada foi guardado");
  if (dados.length > MAX_ANEXO)
    throw new HttpError(422, `arquivo maior que ${MAX_ANEXO / 1048576} MB (${dados.length} bytes)`);
  const nome = nomeLimpo(opts.nome);
  const mime = String(opts.mime ?? mimePorNome(nome)).slice(0, 120);
  const tenant = String(opts.tenant);
  const id = randomBytes(12).toString("hex");
  await q(`INSERT INTO anexos (id, tenant, host, nome, mime, bytes, dados) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    id, tenant, String(opts.host ?? ""), nome, mime, dados.length, dados,
  ]);
  return { id, nome, mime, bytes: dados.length, host: opts.host ? String(opts.host) : undefined };
}

/** com sessão: o tenant vem do usuário */
export async function criarAnexo(
  u: Usuario,
  dados: Buffer,
  opts: { nome: string; mime?: string; host?: string; tenant?: string } = { nome: "arquivo" },
): Promise<AnexoMeta> {
  return gravarAnexo(dados, { tenant: String(opts.tenant ?? u.tenant), nome: opts.nome, mime: opts.mime, host: opts.host });
}

/** anexo só é servido para quem é dono dele (operador vê todos) */
export async function lerAnexo(id: string, u: Usuario): Promise<{ nome: string; mime: string; dados: Buffer }> {
  const r = await q<{ nome: string; mime: string; dados: Buffer }>(
    `SELECT nome, mime, dados FROM anexos WHERE id = $1 AND ($2::text IS NULL OR tenant = $2)`,
    [String(id ?? "").slice(0, 32), u.operador ? null : u.tenant],
  );
  const a = r.rows[0];
  if (!a) throw new HttpError(404, "anexo não encontrado (ou expirou — a faxina guarda 7 dias)");
  return a;
}
