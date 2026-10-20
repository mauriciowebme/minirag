/** Postgres: pool, espera de boot e schema (idêntico ao da v1.x). */
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { CONFIG, log } from "./config";

export const pool = new Pool({
  host: CONFIG.dbHost,
  port: CONFIG.dbPort,
  user: CONFIG.dbUser,
  password: CONFIG.dbPassword,
  database: CONFIG.dbName,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (e) => log(`pool erro: ${e.message}`));

export async function q<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(sql, params as never[]);
}

/** Executa um bloco em transação (BEGIN/COMMIT/ROLLBACK). */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* conexão já perdida */
    }
    throw e;
  } finally {
    client.release();
  }
}

/** Espera o Postgres aceitar conexão (no boot o Docker religa sem ordem). */
export async function waitDb(): Promise<void> {
  let ultimo: unknown = null;
  for (let tentativa = 1; tentativa <= CONFIG.dbWaitTries; tentativa++) {
    try {
      await pool.query("SELECT 1");
      if (tentativa > 1) log(`Postgres respondeu na tentativa ${tentativa}`);
      return;
    } catch (e) {
      ultimo = e;
      const msg = (e as Error).message.split("\n")[0].slice(0, 160);
      log(`aguardando Postgres (${tentativa}/${CONFIG.dbWaitTries}): ${msg}`);
      await new Promise((r) => setTimeout(r, CONFIG.dbWaitSeconds * 1000));
    }
  }
  throw new Error(
    `Postgres indisponivel apos ${CONFIG.dbWaitTries} tentativas de ${CONFIG.dbWaitSeconds}s: ${ultimo}`,
  );
}

const n = (v: unknown): number => Number(v ?? 0);

export async function initDb(dim: number): Promise<void> {
  await q(`CREATE EXTENSION IF NOT EXISTS vector`);
  await q(
    `CREATE TABLE IF NOT EXISTS chunks (
      id BIGSERIAL PRIMARY KEY,
      tenant TEXT NOT NULL,
      memoria TEXT NOT NULL DEFAULT '',
      doc_id TEXT NOT NULL,
      title TEXT,
      body TEXT NOT NULL,
      embedding VECTOR(${dim}) NOT NULL,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  await q(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS tenant TEXT NOT NULL DEFAULT 'default'`);
  await q(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS memoria TEXT NOT NULL DEFAULT ''`);
  await q(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ`);
  await q(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS access_count INT NOT NULL DEFAULT 0`);
  await q(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
  await q(`CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw(embedding vector_cosine_ops)`);
  await q(`CREATE INDEX IF NOT EXISTS chunks_scope_idx ON chunks (tenant, memoria)`);

  await q(
    `CREATE TABLE IF NOT EXISTS ingest_jobs (
      id BIGSERIAL PRIMARY KEY,
      tenant TEXT NOT NULL,
      memoria TEXT NOT NULL DEFAULT '',
      doc_id TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'na_fila',
      chunks_total INT NOT NULL DEFAULT 0,
      chunks_feitos INT NOT NULL DEFAULT 0,
      erro TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      finalizado_em TIMESTAMPTZ)`,
  );
  await q(`CREATE INDEX IF NOT EXISTS ingest_jobs_status_idx ON ingest_jobs (status, id)`);

  await q(
    `CREATE TABLE IF NOT EXISTS documents (
      tenant TEXT NOT NULL,
      memoria TEXT NOT NULL DEFAULT '',
      doc_id TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      origem TEXT NOT NULL DEFAULT 'direto',
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant, memoria, doc_id))`,
  );

  /* Arquivo ORIGINAL enviado (pdf/docx/xlsx...). Fica fora de `documents` de
     propósito: o worker recria a linha de `documents` a cada reindexação e não
     pode encostar no binário. */
  await q(
    `CREATE TABLE IF NOT EXISTS arquivos (
      tenant TEXT NOT NULL,
      memoria TEXT NOT NULL DEFAULT '',
      doc_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      tipo TEXT NOT NULL DEFAULT '',
      tamanho BIGINT NOT NULL DEFAULT 0,
      conteudo BYTEA NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant, memoria, doc_id))`,
  );
  /* v2.5: o texto deste documento veio de OCR (imagem ou PDF escaneado)?
     A API e o painel usam para avisar "confira no original". */
  await q(`ALTER TABLE arquivos ADD COLUMN IF NOT EXISTS ocr BOOLEAN NOT NULL DEFAULT false`);

  /* Gavetas registradas: permite gaveta vazia (criada à mão) aparecer no mapa
     antes do primeiro documento. */
  await q(
    `CREATE TABLE IF NOT EXISTS gavetas (
      tenant TEXT NOT NULL,
      memoria TEXT NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant, memoria))`,
  );

  // container pode ter morrido no meio de um job: devolve pra fila
  await q(`UPDATE ingest_jobs SET status = 'na_fila', chunks_feitos = 0 WHERE status = 'processando'`);

  // migração: documentos anteriores (só chunks) são reconstruídos
  const r = await q(
    `INSERT INTO documents (tenant, memoria, doc_id, title, content, size_bytes, origem, criado_em, atualizado_em)
     SELECT c.tenant, c.memoria, c.doc_id, max(c.title),
            string_agg(c.body, ' ' ORDER BY c.id),
            sum(octet_length(c.body)), 'reconstruido',
            min(c.ingested_at), max(c.ingested_at)
     FROM chunks c
     WHERE NOT EXISTS (SELECT 1 FROM documents d
       WHERE d.tenant = c.tenant AND d.memoria = c.memoria AND d.doc_id = c.doc_id)
     GROUP BY c.tenant, c.memoria, c.doc_id`,
  );
  if (r.rowCount) log(`documents: ${r.rowCount} doc(s) reconstruido(s) de chunks`);
}

export { n };