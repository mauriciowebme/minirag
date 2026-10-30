/**
 * Arquivos que a MÁQUINA manda para o servidor e que o dono vê na conversa
 * (print de tela, imagem, log, vídeo, backup — de KB a dezenas de GB).
 *
 * v3.45: o arquivo saiu do Postgres e foi para o DISCO, em pasta por usuário:
 *
 *   <MINIRAG_ARQUIVOS_DIR>/<tenant>/<id>/<nome>
 *
 * O banco guarda só a ficha (nome, mime, bytes). Isso é o que permite 10 GB:
 * `bytea` obrigaria o banco a carregar o arquivo inteiro em memória, inchar o
 * WAL e o backup. Aqui a gravação é em BLOCOS com `offset` — se a conexão cair,
 * a próxima chamada continua exatamente do byte onde parou.
 *
 * O `id` do envio é determinístico (tenant + host + caminho + tamanho + mtime):
 * repetir o envio do MESMO arquivo retoma o que já estava em disco em vez de
 * recomeçar. Nome de arquivo nunca vira caminho — o `id` é a pasta, o nome
 * original é coluna (nome com `..\` não escapa daqui).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CONFIG } from "./config";
import type { Usuario } from "./config";
import { q } from "./db";
import { HttpError } from "./errors";

export type AnexoMeta = {
  id: string;
  nome: string;
  mime: string;
  bytes: number;
  host?: string;
  completo?: boolean;
};

/** cada subida é UM arquivo; o teto é espaço em disco, com este guarda-chuva */
export const MAX_ANEXO = CONFIG.maxArquivoBytes;

/** nome seguro para header/disco: sem barra, sem controle, tamanho limitado */
export function nomeLimpo(n: string): string {
  const base =
    String(n ?? "")
      .replace(/\\/g, "/")
      .split("/")
      .pop() ?? "";
  const limpo = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[<>:"|?*]/g, "_").trim();
  return (limpo || "arquivo").slice(0, 180);
}

/** tenant vira nome de pasta: só o alfabeto seguro (o resto é "_") */
function pastaDe(tenant: string): string {
  const t = String(tenant ?? "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
  return t || "_";
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
    mp4: "video/mp4", mkv: "video/x-matroska", mp3: "audio/mpeg", wav: "audio/wav",
    iso: "application/octet-stream", bin: "application/octet-stream",
    sql: "application/sql", gz: "application/gzip", tar: "application/x-tar",
    "7z": "application/x-7z-compressed", rar: "application/vnd.rar",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return mapa[ext] ?? "application/octet-stream";
}

let RAIZ = path.resolve(CONFIG.arquivosDir);
const SEGREDO_ARQ = path.join(RAIZ, ".segredo");

/** segredo do canal de upload — mora no VOLUME (sobrevive a restart/redeploy) */
let segredoCache: Buffer | null = null;
async function lerSegredo(): Promise<Buffer> {
  if (segredoCache) return segredoCache;
  try {
    segredoCache = await fsp.readFile(SEGREDO_ARQ);
  } catch {
    const novo = randomBytes(32);
    await fsp.mkdir(RAIZ, { recursive: true });
    await fsp.writeFile(SEGREDO_ARQ, novo, { mode: 0o600 });
    segredoCache = novo;
  }
  return segredoCache;
}

/* ATENÇÃO: `arquivos` NÃO é tabela nova — desde a v1 ela guarda o ORIGINAL dos
   documentos enviados (pk tenant+memoria+doc_id, com `conteudo` bytea). A ficha
   dos arquivos que a máquina manda mora em `anexos_maquina`, sem risco de
   colidir com a tabela que o RAG usa. */
const TABELA = "anexos_maquina";

export async function iniciarAnexos(): Promise<void> {
  /* a imagem roda como root (sem USER no Dockerfile), então a raiz de um volume
     nomeado novo já nasce gravável. Esta sonda é rede de segurança para o dia em
     que a imagem passar a rodar sem root: se a raiz não for gravável, os arquivos
     vão para <home>/dados/anexos em vez de o serviço subir quebrado. */
  const raiz = await raizGravavel();
  await fsp.mkdir(raiz, { recursive: true });
  /* a raiz do volume chega do Docker com dono root; a gravação é por tenant
     (`<raiz>/<tenant>/<id>`), então cada tenant precisa da pasta dele criada
     por quem tem permissão (aqui, no boot). Falha aqui não derruba o serviço:
     o erro real aparece na hora de gravar, com o caminho na mensagem. */
  for (const t of await tenantsExistentes()) {
    await fsp.mkdir(path.join(RAIZ, pastaDe(t)), { recursive: true }).catch(() => undefined);
  }
  await lerSegredo();
  await q(
    `CREATE TABLE IF NOT EXISTS ${TABELA} (
       id              VARCHAR(64) PRIMARY KEY,
       tenant          VARCHAR(64) NOT NULL,
       host            VARCHAR(128) NOT NULL DEFAULT '',
       nome            VARCHAR(255) NOT NULL,
       mime            VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
       bytes           BIGINT NOT NULL DEFAULT 0,
       bytes_esperados BIGINT NOT NULL DEFAULT 0,
       completo        BOOLEAN NOT NULL DEFAULT FALSE,
       criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
       atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  await q(`CREATE INDEX IF NOT EXISTS anexos_maquina_tenant ON ${TABELA} (tenant, criado_em DESC)`);
  await q(`ALTER TABLE ${TABELA} ADD COLUMN IF NOT EXISTS bytes_esperados BIGINT NOT NULL DEFAULT 0`);
  /* tabela criada por uma versão anterior (a 3.45 em teste) não tem `completo` */
  await q(`ALTER TABLE ${TABELA} ADD COLUMN IF NOT EXISTS completo BOOLEAN NOT NULL DEFAULT FALSE`);
  await q(`ALTER TABLE ${TABELA} ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()`);

  /* anexos antigos (bytea) migram uma vez para o disco — a tabela velha fica como
     registro até o expurgo, mas ninguém mais escreve nela */
  const velhos = await q<{ id: string; tenant: string; host: string; nome: string; mime: string; dados: Buffer }>(
    `SELECT id, tenant, host, nome, mime, dados FROM anexos ORDER BY criado_em`,
  ).catch(() => null);
  for (const a of velhos?.rows ?? []) {
    const existe = await q(`SELECT 1 FROM ${TABELA} WHERE id = $1`, [a.id]);
    if (existe.rowCount) continue;
    await gravarBlocoCompleto(a.dados, { id: a.id, tenant: a.tenant, host: a.host, nome: a.nome, mime: a.mime });
  }
  if ((velhos?.rows.length ?? 0) > 0) await q(`DELETE FROM anexos`).catch(() => undefined);

  /* faxina: arquivo completo some depois dos dias configurados; pedaço órfão em 7 dias */
  await q(`DELETE FROM ${TABELA} WHERE completo AND criado_em < now() - ($1 || ' days')::interval`, [String(CONFIG.arquivosDias)]);
  await q(`DELETE FROM ${TABELA} WHERE NOT completo AND atualizado_em < now() - interval '7 days'`);
}

async function raizGravavel(): Promise<string> {
  const tentar = async (dir: string): Promise<boolean> => {
    try {
      await fsp.mkdir(dir, { recursive: true });
      const sonda = path.join(dir, `.sonda-${process.pid}`);
      await fsp.writeFile(sonda, "ok");
      await fsp.rm(sonda, { force: true });
      return true;
    } catch {
      return false;
    }
  };
  if (await tentar(RAIZ)) return RAIZ;
  const alt = path.join(process.env.HOME || "/tmp", "dados", "anexos");
  if (await tentar(alt)) {
    console.warn(`[minirag] ${RAIZ} nao e gravavel — usando ${alt} (volume nao montado com dono certo?)`);
    return alt;
  }
  throw new Error(`nenhuma pasta gravavel para os arquivos (${RAIZ} e ${alt} falharam)`);
}

/** tenants com arquivo — e os que já existem como usuário (o boot não conhece todos) */
async function tenantsExistentes(): Promise<string[]> {
  const r = await q<{ tenant: string }>(`SELECT DISTINCT tenant FROM ${TABELA}`).catch(() => null);
  const u = await q<{ tenant: string }>(`SELECT DISTINCT tenant FROM usuarios`).catch(() => null);
  const nomes = new Set<string>([...(r?.rows ?? []), ...(u?.rows ?? [])].map((x) => String(x.tenant)));
  return [...nomes];
}

/** id determinístico do envio: o mesmo arquivo, reenviado, retoma o que já foi */
export function idDoEnvio(tenant: string, host: string, caminho: string, tamanho: number, mtime: number): string {
  return createHash("sha256")
    .update(`${tenant}\u0000${host}\u0000${caminho}\u0000${tamanho}\u0000${mtime}`)
    .digest("hex")
    .slice(0, 32);
}

/** chave do canal (stateless, sobrevive a restart): "<exp>.<hmac>" */
export async function chaveDoEnvio(tenant: string, host: string, id: string, horas = 24): Promise<string> {
  const exp = Date.now() + horas * 3600_000;
  const s = await lerSegredo();
  const mac = createHmac("sha256", s).update(`${tenant}|${host}|${id}|${exp}`).digest("base64url");
  return `${exp}.${mac}`;
}

/** valida a chave e devolve o id (401 curto, sem dica para adivinhar) */
export async function conferirChave(tenant: string, host: string, id: string, k: string): Promise<void> {
  const [expTxt, mac] = String(k ?? "").split(".");
  const exp = Number(expTxt);
  if (!mac || !Number.isFinite(exp) || exp < Date.now())
    throw new HttpError(401, "chave do envio expirada — a maquina pede outra");
  const s = await lerSegredo();
  const esperado = createHmac("sha256", s).update(`${tenant}|${host}|${id}|${exp}`).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, "chave do envio nao confere com este arquivo");
}

function caminhoDoArquivo(tenant: string, id: string, nome: string): string {
  return path.join(RAIZ, pastaDe(tenant), id, nome);
}

/** abre (ou cria) a ficha do envio — chamar antes do primeiro bloco */
export async function abrirEnvio(opts: {
  id: string;
  tenant: string;
  host: string;
  nome: string;
  mime?: string;
  bytesEsperados?: number;
}): Promise<{ id: string; bytes: number; completo: boolean }> {
  const nome = nomeLimpo(opts.nome);
  const mime = String(opts.mime ?? mimePorNome(nome)).slice(0, 120);
  const total = Math.max(0, Number(opts.bytesEsperados ?? 0));
  if (total > MAX_ANEXO) throw new HttpError(422, `arquivo maior que o teto de ${Math.round(MAX_ANEXO / 1048576)} MB`);
  /* um id de envio pertence a UM tenant: sem esta checagem, quem adivinhasse o id
     de outra pessoa sobrescreveria o arquivo dela (o upsert abaixo aceitaria) */
  const dono = await q<{ tenant: string }>(`SELECT tenant FROM ${TABELA} WHERE id = $1`, [opts.id]);
  if (dono.rows[0] && String(dono.rows[0].tenant) !== String(opts.tenant))
    throw new HttpError(403, "este envio pertence a outro usuario");
  await q(
    `INSERT INTO ${TABELA} (id, tenant, host, nome, mime, bytes_esperados)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE SET atualizado_em = now(),
       bytes_esperados = CASE WHEN $6 > 0 THEN $6 ELSE ${TABELA}.bytes_esperados END`,
    [opts.id, String(opts.tenant), String(opts.host ?? ""), nome, mime, total],
  );
  const r = await q<{ bytes: string; completo: boolean }>(`SELECT bytes, completo FROM ${TABELA} WHERE id = $1`, [opts.id]);
  return { id: opts.id, bytes: Number(r.rows[0]?.bytes ?? 0), completo: Boolean(r.rows[0]?.completo) };
}

/** grava UM bloco no offset indicado (append validado) e devolve o total no disco */
export async function gravarBloco(
  id: string,
  offset: number,
  corpo: Readable,
  tamanhoEsperado: number,
): Promise<{ bytes: number; completo: boolean }> {
  const ficha = await q<{ tenant: string; nome: string; bytes_esperados: string }>(
    `SELECT tenant, nome, bytes_esperados FROM ${TABELA} WHERE id = $1`,
    [id],
  );
  const a = ficha.rows[0];
  if (!a) throw new HttpError(404, "envio nao encontrado — comece de novo");
  const destino = caminhoDoArquivo(a.tenant, id, a.nome);
  await fsp.mkdir(path.dirname(destino), { recursive: true });

  const atual = await fsp.stat(destino).then((s) => s.size).catch(() => 0);
  if (offset !== atual) {
    throw new HttpError(409, `offset fora de ordem: o servidor tem ${atual} bytes, veio ${offset}`);
  }

  const fluxo = fs.createWriteStream(destino, offset === 0 ? { flags: "w" } : { flags: "r+", start: offset });
  try {
    await pipeline(corpo, fluxo);
  } catch (e) {
    /* conexão caiu no meio do bloco: o que chegou já está no disco e o próximo
       POST continua daqui — não perdemos o bloco inteiro */
    const parcial = await fsp.stat(destino).then((s) => s.size).catch(() => atual);
    await q(`UPDATE ${TABELA} SET bytes = $2, atualizado_em = now() WHERE id = $1`, [id, parcial]);
    throw new HttpError(502, `bloco interrompido em ${parcial} bytes (continue daqui): ${String((e as Error)?.message ?? e)}`);
  }

  const total = await fsp.stat(destino).then((s) => s.size).catch(() => atual);
  const esperado = Number(a.bytes_esperados || tamanhoEsperado || 0);
  const completo = esperado > 0 ? total >= esperado : false;
  await q(`UPDATE ${TABELA} SET bytes = $2, completo = $3, atualizado_em = now() WHERE id = $1`, [id, total, completo]);
  return { bytes: total, completo };
}

/** grava de uma vez (usado pela migração e pelos anexos pequenos de antes) */
export async function gravarBlocoCompleto(
  dados: Buffer,
  opts: { id?: string; tenant: string; host?: string; nome: string; mime?: string },
): Promise<AnexoMeta> {
  const nome = nomeLimpo(opts.nome);
  const mime = String(opts.mime ?? mimePorNome(nome)).slice(0, 120);
  if (dados.length > MAX_ANEXO) throw new HttpError(422, `arquivo maior que ${Math.round(MAX_ANEXO / 1048576)} MB`);
  const id = opts.id ?? randomBytes(12).toString("hex");
  const destino = caminhoDoArquivo(opts.tenant, id, nome);
  await fsp.mkdir(path.dirname(destino), { recursive: true });
  await fsp.writeFile(destino, dados);
  await q(
    `INSERT INTO ${TABELA} (id, tenant, host, nome, mime, bytes, bytes_esperados, completo)
     VALUES ($1,$2,$3,$4,$5,$6,$6,TRUE)
     ON CONFLICT (id) DO UPDATE SET bytes = $6, bytes_esperados = $6, completo = TRUE, atualizado_em = now()`,
    [id, String(opts.tenant), String(opts.host ?? ""), nome, mime, dados.length],
  );
  return { id, nome, mime, bytes: dados.length, host: opts.host || undefined, completo: true };
}

/** ficha + estado atual no disco (a máquina pergunta antes de retomar) */
export async function estadoDoEnvio(id: string): Promise<{ bytes: number; completo: boolean; nome: string; tenant: string }> {
  const r = await q<{ tenant: string; nome: string; bytes: string; completo: boolean }>(
    `SELECT tenant, nome, bytes, completo FROM ${TABELA} WHERE id = $1`,
    [id],
  );
  const a = r.rows[0];
  if (!a) return { bytes: 0, completo: false, nome: "", tenant: "" };
  const noDisco = await fsp
    .stat(caminhoDoArquivo(a.tenant, id, a.nome))
    .then((s) => s.size)
    .catch(() => 0);
  const bytes = Math.max(Number(a.bytes || 0), noDisco);
  if (bytes !== Number(a.bytes || 0)) {
    await q(`UPDATE ${TABELA} SET bytes = $2, atualizado_em = now() WHERE id = $1`, [id, bytes]);
  }
  return { bytes, completo: Boolean(a.completo), nome: a.nome, tenant: a.tenant };
}

/** com sessão: o tenant vem do usuário */
export async function criarAnexo(
  u: Usuario,
  dados: Buffer,
  opts: { nome: string; mime?: string; host?: string; tenant?: string } = { nome: "arquivo" },
): Promise<AnexoMeta> {
  return gravarBlocoCompleto(dados, {
    tenant: String(opts.tenant ?? u.tenant),
    nome: opts.nome,
    mime: opts.mime,
    host: opts.host,
  });
}

/** ficha do anexo com o caminho no disco — só o dono (operador vê todos) */
export async function abrirAnexo(
  id: string,
  u: Usuario,
): Promise<{ nome: string; mime: string; bytes: number; caminho: string }> {
  const r = await q<{ nome: string; mime: string; tenant: string }>(
    `SELECT nome, mime, tenant FROM ${TABELA} WHERE id = $1 AND ($2::text IS NULL OR tenant = $2)`,
    [String(id ?? "").slice(0, 64), u.operador ? null : u.tenant],
  );
  const a = r.rows[0];
  if (!a) throw new HttpError(404, "anexo não encontrado (ou expirou — a faxina guarda os dias configurados)");
  const caminho = caminhoDoArquivo(a.tenant, String(id), a.nome);
  const bytes = await fsp.stat(caminho).then((s) => s.size).catch(() => 0);
  if (!bytes) throw new HttpError(404, "o arquivo do anexo não está mais no disco");
  return { nome: a.nome, mime: a.mime, bytes, caminho };
}

/** leitura inteira (só para usos pequenos: cópia de até 16 MB, testes) */
export async function lerAnexo(id: string, u: Usuario): Promise<{ nome: string; mime: string; dados: Buffer }> {
  const a = await abrirAnexo(id, u);
  if (a.bytes > 64 * 1024 * 1024)
    throw new HttpError(422, "arquivo grande demais para leitura inteira — use o download por stream");
  return { nome: a.nome, mime: a.mime, dados: await fsp.readFile(a.caminho) };
}

/** apaga do disco e do banco (faxina de usuário / teste) */
export async function apagarAnexo(id: string): Promise<void> {
  const r = await q<{ tenant: string; nome: string }>(`SELECT tenant, nome FROM ${TABELA} WHERE id = $1`, [id]);
  const a = r.rows[0];
  if (!a) return;
  await fsp.rm(path.dirname(caminhoDoArquivo(a.tenant, id, a.nome)), { recursive: true, force: true });
  await q(`DELETE FROM ${TABELA} WHERE id = $1`, [id]);
}
