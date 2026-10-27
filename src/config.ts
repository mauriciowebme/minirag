/** Configuração do minirag — mesmas variáveis MINIRAG_* da v1.x. */
import os from "node:os";

function int(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? def : n;
}

function flt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number.parseFloat(raw);
  return Number.isNaN(n) ? def : n;
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return def;
  return ["1", "true", "sim", "yes"].includes(raw.trim().toLowerCase());
}

export const CONFIG = {
  versao: "3.30.0",
  model: process.env.MINIRAG_MODEL ?? "nomic-ai/nomic-embed-text-v1.5",
  modelDir: process.env.MINIRAG_MODEL_DIR ?? "/app/models",

  dbHost: process.env.MINIRAG_DB_HOST ?? "minirag-db",
  dbPort: int("MINIRAG_DB_PORT", 5432),
  dbUser: process.env.MINIRAG_DB_USER ?? "minirag",
  dbPassword: process.env.MINIRAG_DB_PASSWORD ?? "minirag",
  dbName: process.env.MINIRAG_DB_NAME ?? "minirag",
  dbWaitTries: int("MINIRAG_DB_WAIT_TRIES", 30),
  dbWaitSeconds: int("MINIRAG_DB_WAIT_SECONDS", 2),

  maxChunkWords: int("MINIRAG_MAX_CHUNK_WORDS", 500),
  chunkOverlap: int("MINIRAG_CHUNK_OVERLAP", 80),
  topK: int("MINIRAG_TOP_K", 5),
  minScore: flt("MINIRAG_MIN_SCORE", 0.55),

  maxContentChars: int("MINIRAG_MAX_CONTENT_CHARS", 500_000),
  maxQueryChars: int("MINIRAG_MAX_QUERY_CHARS", 2_000),
  maxChunksTenant: int("MINIRAG_MAX_CHUNKS_TENANT", 10_000),

  decayAtivo: bool("MINIRAG_DECAY_ATIVO", true),
  // v3.5 (dono, 21/10): o esquecimento padrão passou de 30 dias para 6 MESES, e os três
  // números (arquivar / morte do arquivado / carência do apagar usuário) podem ser
  // gravados na tela — a tabela `esquecimento_cfg` tem precedência sobre estes defaults.
  decayDias: int("MINIRAG_DECAY_DIAS", 180),
  expurgoArquivadoDias: int("MINIRAG_EXPURGO_ARQUIVADO_DIAS", 365),
  carenciaDias: int("MINIRAG_CARENCIA_DIAS", 30),
  decayMinAcessos: int("MINIRAG_DECAY_MIN_ACESSOS", 2),
  decayIntervaloMinutos: int("MINIRAG_DECAY_INTERVALO_MINUTOS", 60),

  corsOrigins: (process.env.MINIRAG_CORS_ORIGINS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean),

  loginMaxFalhas: int("MINIRAG_LOGIN_MAX_FALHAS", 10),
  loginJanelaSeg: int("MINIRAG_LOGIN_JANELA_SEG", 300),

  port: int("MINIRAG_PORT", 8000),
  host: process.env.MINIRAG_HOST ?? "0.0.0.0",

  embedderPort: int("MINIRAG_EMBEDDER_PORT", 8001),
  embedderUrl: process.env.MINIRAG_EMBEDDER_URL ?? "http://127.0.0.1:8001",
  embedderModo: (process.env.MINIRAG_EMBEDDER_MODO ?? "filho") as "filho" | "externo",
  pythonBin: process.env.MINIRAG_PYTHON ?? "python3",

  painelDir:
    process.env.MINIRAG_PAINEL_DIR ??
    require("node:path").resolve(__dirname, "..", "frontend", "dist"),
  workerAtivo: bool("MINIRAG_WORKER_ATIVO", true),
} as const;

export type Usuario = { tenant: string; operador?: boolean };

/** 'nome:chave, outro:outra' -> [{nome, chave}] */
export function parseUsers(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const entry of raw.split(",")) {
    const e = entry.trim();
    if (!e || !e.includes(":")) continue;
    const idx = e.indexOf(":");
    const nome = e.slice(0, idx).trim();
    const chave = e.slice(idx + 1).trim();
    if (nome && chave) out.push([nome, chave]);
  }
  return out;
}

export const USERS = parseUsers(process.env.MINIRAG_USERS ?? "");
/* v3.4 (21/10): o nome canônico é MINIRAG_ADMIN. MINIRAG_OPERADOR continua valendo como
 * apelido antigo — ambiente que ainda não trocou a variável segue bootando igual.
 * Com as duas presentes, ADMIN vence. */
const ENV_ADMIN = process.env.MINIRAG_ADMIN || process.env.MINIRAG_OPERADOR || "";
export const OPERADOR = parseUsers(ENV_ADMIN);

export function isOperador(u: Usuario): boolean {
  return Boolean(u.operador);
}

/** Tenant ALVO: login comum = o próprio (arg ignorado); operador = ?tenant. */
export function tenantFor(u: Usuario, arg?: string | null): string {
  if (isOperador(u)) return (arg ?? "").trim() || u.tenant;
  return u.tenant;
}

/** Filtro de agregados: null = ver tudo (operador sem ?tenant). */
export function tenantFilter(u: Usuario, arg?: string | null): string | null {
  if (isOperador(u)) {
    const a = (arg ?? "").trim();
    return a || null;
  }
  return u.tenant;
}

export function log(msg: string): void {
  // stdout sem buffer, prefixo fixo (o docker logs fica legível)
  process.stdout.write(`[minirag] ${msg}${os.EOL}`);
}