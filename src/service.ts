/** Regras de negócio: busca, documentos, gavetas, jobs, export e delete. */
import { ZipFile } from "yazl";
import { CONFIG, Usuario, isOperador, tenantFilter, tenantFor } from "./config";
import { q, tx } from "./db";
import { embedUm } from "./embed";
import { erro404, erro409, erro422, iso } from "./errors";
import { enqueueIngest, jobStatus, IngestBody } from "./ingest";

type Row = Record<string, any>;

export type SearchBody = {
  query: string;
  k?: number;
  min_score?: number;
  memoria?: string;
  include_archived?: boolean;
  tenant?: string | null;
};

/** Busca semântica na gaveta do chamador. */
export async function search(body: SearchBody, user: Usuario) {
  const vec = await embedUm(body.query);
  const memoria = (body.memoria ?? "").trim();
  const tenant = tenantFor(user, body.tenant);
  const k = body.k ?? CONFIG.topK;
  const minScore = body.min_score ?? CONFIG.minScore;

  let where = "tenant = $2 AND memoria = $3";
  if (!body.include_archived) where += " AND archived_at IS NULL";
  const r = await q(
    `SELECT id, doc_id, coalesce(title, '') AS title, body,
            embedding <=> $1::vector AS dist,
            archived_at IS NOT NULL AS arquivado
     FROM chunks WHERE ${where}
     ORDER BY embedding <=> $1::vector LIMIT $4`,
    [vec, tenant, memoria, k],
  );

  const items: Array<Row> = [];
  let rank = 0;
  for (const row of r.rows) {
    const score = 1.0 - Number(row.dist);
    if (score < minScore) break;
    rank += 1;
    items.push({
      rank,
      score: Math.round(score * 10000) / 10000,
      chunk_id: Number(row.id),
      doc_id: row.doc_id,
      title: row.title,
      text: row.body,
      arquivado: Boolean(row.arquivado),
    });
  }

  // memória inteligente: carimba uso; incluir arquivado REVIVE o doc inteiro
  if (items.length) {
    const ids = items.map((it) => it.chunk_id);
    const docsReviver = [...new Set(items.filter((it) => it.arquivado).map((it) => it.doc_id))];
    await q(
      `UPDATE chunks SET last_accessed_at = now(), access_count = access_count + 1
       WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    if (docsReviver.length) {
      await q(
        `UPDATE chunks SET archived_at = NULL
         WHERE tenant = $1 AND memoria = $2 AND doc_id = ANY($3::text[])
           AND archived_at IS NOT NULL`,
        [tenant, memoria, docsReviver],
      );
    }
  }
  return { tenant, memoria, items, total: items.length };
}

/** Lista documentos (agregado por doc_id). */
export async function listDocs(opts: {
  memoria?: string;
  include_archived?: boolean;
  tenant?: string | null;
  q?: string;
  limit?: number;
  offset?: number;
}, user: Usuario) {
  const memoria = (opts.memoria ?? "").trim();
  const tenant = tenantFor(user, opts.tenant);
  const conds = ["tenant = $1", "memoria = $2"];
  const params: unknown[] = [tenant, memoria];
  if (!opts.include_archived) conds.push("archived_at IS NULL");
  const filtro = (opts.q ?? "").trim();
  if (filtro) {
    params.push(`%${filtro}%`, `%${filtro}%`);
    conds.push(`(coalesce(title,'') ILIKE $${params.length - 1} OR doc_id ILIKE $${params.length})`);
  }
  const where = conds.join(" AND ");
  const lim = Math.max(0, Math.min(Number(opts.limit ?? 0), 2000));
  const off = Math.max(0, Number(opts.offset ?? 0));
  const paginacao = lim ? ` LIMIT ${lim} OFFSET ${off}` : "";

  const tot = await q<{ n: string }>(
    `SELECT count(*) AS n FROM (SELECT doc_id FROM chunks WHERE ${where} GROUP BY doc_id) t`,
    params,
  );
  const r = await q(
    `SELECT doc_id, coalesce(max(title), '') AS title, count(*) AS chunks,
            max(ingested_at) AS updated_at,
            count(*) FILTER (WHERE archived_at IS NOT NULL) AS arquivados
     FROM chunks WHERE ${where}
     GROUP BY doc_id ORDER BY max(ingested_at) DESC${paginacao}`,
    params,
  );
  return {
    tenant,
    memoria,
    total: Number(tot.rows[0]?.n ?? 0),
    docs: r.rows.map((d) => ({
      doc_id: d.doc_id,
      title: d.title,
      chunks: Number(d.chunks),
      updated_at: iso(d.updated_at),
      chunks_arquivados: Number(d.arquivados),
    })),
  };
}

/** Mapa tenant x gaveta x docs/chunks. */
export async function listGavetas(user: Usuario, tenantArg?: string) {
  const alvo = tenantFilter(user, tenantArg);
  const where = alvo !== null ? "WHERE tenant = $1" : "";
  const params = alvo !== null ? [alvo] : [];
  const r = await q(
    `SELECT tenant, memoria, count(*) AS chunks, count(DISTINCT doc_id) AS docs,
            count(*) FILTER (WHERE archived_at IS NOT NULL) AS arq,
            min(ingested_at) AS primeiro, max(ingested_at) AS ultimo
     FROM chunks ${where}
     GROUP BY tenant, memoria ORDER BY tenant, memoria`,
    params,
  );
  const nd = await q<{ n: string }>(
    `SELECT count(*) AS n FROM documents${alvo !== null ? " WHERE tenant = $1" : ""}`,
    params,
  );
  return {
    operador: isOperador(user),
    gavetas: r.rows.map((g) => ({
      tenant: g.tenant,
      memoria: g.memoria,
      chunks: Number(g.chunks),
      docs: Number(g.docs),
      chunks_arquivados: Number(g.arq),
      primeiro_ingress: iso(g.primeiro),
      ultimo_ingress: iso(g.ultimo),
    })),
    documentos_fonte: Number(nd.rows[0]?.n ?? 0),
  };
}

/** Fila de ingestão com resumo por status. */
export async function listJobs(
  opts: { status?: string; tenant?: string | null; limit?: number },
  user: Usuario,
) {
  const alvo = tenantFilter(user, opts.tenant);
  const conds: string[] = [];
  const params: unknown[] = [];
  if (alvo !== null) {
    params.push(alvo);
    conds.push(`tenant = $${params.length}`);
  }
  const status = (opts.status ?? "").trim();
  if (status) {
    params.push(status);
    conds.push(`status = $${params.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")} ` : "";
  const lim = Math.max(1, Math.min(Number(opts.limit ?? 50), 200));
  const r = await q(
    `SELECT id, tenant, memoria, doc_id, coalesce(title,'') AS title, status,
            chunks_total, chunks_feitos, erro, criado_em, finalizado_em
     FROM ingest_jobs ${where}ORDER BY id DESC LIMIT $${params.length + 1}`,
    [...params, lim],
  );
  const resumoQ = await q(
    `SELECT status, count(*) AS n FROM ingest_jobs ${where.replace(/\s+$/, "")} GROUP BY status`,
    params,
  );
  const resumo: Record<string, number> = {};
  for (const s of resumoQ.rows) resumo[s.status] = Number(s.n);
  return {
    resumo_por_status: resumo,
    jobs: r.rows.map((j) => ({
      job_id: Number(j.id),
      tenant: j.tenant,
      memoria: j.memoria,
      doc_id: j.doc_id,
      title: j.title,
      status: j.status,
      chunks_total: Number(j.chunks_total),
      chunks_feitos: Number(j.chunks_feitos),
      erro: j.erro,
      criado_em: iso(j.criado_em),
      finalizado_em: iso(j.finalizado_em),
    })),
  };
}

export async function jobParaUsuario(jobId: number, user: Usuario, tenantArg?: string) {
  const alvo = tenantFilter(user, tenantArg);
  const st = await jobStatus(jobId, alvo);
  if (!st) throw erro404("job nao existe (ou e de outro usuario)");
  return st;
}

async function documentoRow(client: { query: Function }, tenant: string, memoria: string, docId: string) {
  const r = await client.query(
    `SELECT title, content, size_bytes, origem, criado_em, atualizado_em
     FROM documents WHERE tenant = $1 AND memoria = $2 AND doc_id = $3`,
    [tenant, memoria, docId],
  );
  return r.rows[0] as Row | undefined;
}

export async function getDocument(docId: string, memoria: string, tenantArg: string | null, user: Usuario) {
  const t = tenantFor(user, tenantArg);
  const mem = (memoria ?? "").trim();
  const res = await q(
    `SELECT title, content, size_bytes, origem, criado_em, atualizado_em
     FROM documents WHERE tenant = $1 AND memoria = $2 AND doc_id = $3`,
    [t, mem, docId],
  );
  const r = res.rows[0];
  if (!r) throw erro404("documento nao encontrado nesta memoria");
  return {
    tenant: t,
    memoria: mem,
    doc_id: docId,
    title: r.title,
    content: r.content,
    size_bytes: Number(r.size_bytes),
    origem: r.origem,
    criado_em: iso(r.criado_em),
    atualizado_em: iso(r.atualizado_em),
  };
}

export function nomeArquivo(base: string | null | undefined, fallback: string): string {
  const limpo = (base ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return limpo || fallback;
}

/** PUT /documents/{id}: edição = volta pra fila (versão antiga no ar). */
export async function putDocument(
  docId: string,
  body: { content: string; title?: string | null; memoria?: string; tenant?: string | null },
  user: Usuario,
) {
  const t = tenantFor(user, body.tenant);
  const memoria = (body.memoria ?? "").trim();
  const existe = await q(
    `SELECT 1 FROM chunks WHERE tenant=$1 AND memoria=$2 AND doc_id=$3 LIMIT 1`,
    [t, memoria, docId],
  );
  if (!existe.rowCount) {
    throw erro404("documento nao existe nesta memoria (para criar, use POST /ingest)");
  }
  const ing: IngestBody = {
    doc_id: docId,
    title: body.title ?? null,
    content: body.content,
    memoria: body.memoria ?? "",
  };
  const r = await enqueueIngest(ing, t);
  return {
    ...r,
    doc_id: docId,
    mensagem: "edicao na fila; reindexando — versao antiga no ar ate concluir",
  };
}

/** PATCH /documents/{id}: renomear/mover/título (sem reembedding). */
export async function patchDocument(
  docId: string,
  body: {
    title?: string | null;
    novo_doc_id?: string | null;
    destino_memoria?: string | null;
    tenant?: string | null;
  },
  memoriaArg: string,
  user: Usuario,
) {
  const t = tenantFor(user, body.tenant);
  const memoria = (memoriaArg ?? "").trim();
  const dest = (body.destino_memoria || memoria || "").trim();
  const novo = (body.novo_doc_id || "").trim() || docId;
  if (!novo || novo.length > 200) throw erro422("novo_doc_id invalido");

  return tx(async (c) => {
    const proc = await c.query(
      `SELECT count(*) AS n FROM ingest_jobs WHERE tenant=$1 AND memoria=$2
       AND doc_id=$3 AND status='processando'`,
      [t, memoria, docId],
    );
    if (Number(proc.rows[0].n)) throw erro409("documento em processamento; aguarde o job");

    const fonteR = await c.query(
      `SELECT coalesce(title,'') AS title, content, size_bytes FROM documents
       WHERE tenant=$1 AND memoria=$2 AND doc_id=$3`,
      [t, memoria, docId],
    );
    const fonte = fonteR.rows[0] as Row | undefined;
    const ch = await c.query(
      `SELECT count(*) AS n FROM chunks WHERE tenant=$1 AND memoria=$2 AND doc_id=$3`,
      [t, memoria, docId],
    );
    if (!fonte && !Number(ch.rows[0].n)) throw erro404("documento nao existe nesta memoria");

    const novoTitulo = body.title !== undefined && body.title !== null
      ? body.title
      : (fonte ? fonte.title : null);

    if (novo === docId && dest === memoria) {
      await c.query(
        `UPDATE documents SET title=$1, atualizado_em=now()
         WHERE tenant=$2 AND memoria=$3 AND doc_id=$4`,
        [novoTitulo, t, memoria, docId],
      );
      await c.query(
        `UPDATE chunks SET title=$1 WHERE tenant=$2 AND memoria=$3 AND doc_id=$4`,
        [novoTitulo, t, memoria, docId],
      );
      return { doc_id: docId, memoria, titulo: novoTitulo, movido: false, renomeado: false };
    }

    const colC = await c.query(
      `SELECT count(*) AS n FROM chunks WHERE tenant=$1 AND memoria=$2 AND doc_id=$3`,
      [t, dest, novo],
    );
    const colF = await c.query(
      `SELECT count(*) AS n FROM documents WHERE tenant=$1 AND memoria=$2 AND doc_id=$3`,
      [t, dest, novo],
    );
    if (Number(colC.rows[0].n) || Number(colF.rows[0].n)) {
      throw erro409(`ja existe documento '${novo}' nessa gaveta`);
    }

    await c.query(
      `UPDATE chunks SET doc_id=$1, memoria=$2, title=$3
       WHERE tenant=$4 AND memoria=$5 AND doc_id=$6`,
      [novo, dest, novoTitulo, t, memoria, docId],
    );
    await c.query(
      `UPDATE ingest_jobs SET doc_id=$1, memoria=$2
       WHERE tenant=$3 AND memoria=$4 AND doc_id=$5 AND status='na_fila'`,
      [novo, dest, t, memoria, docId],
    );

    let content: string;
    let size: number;
    if (fonte) {
      content = fonte.content;
      size = Number(fonte.size_bytes);
    } else {
      const agg = await c.query(
        `SELECT string_agg(body, ' ' ORDER BY id) AS content,
                coalesce(sum(octet_length(body)),0) AS size
         FROM chunks WHERE tenant=$1 AND memoria=$2 AND doc_id=$3`,
        [t, dest, novo],
      );
      content = agg.rows[0].content ?? "";
      size = Number(agg.rows[0].size ?? 0);
    }
    await c.query(
      `DELETE FROM documents WHERE tenant=$1 AND memoria=$2 AND doc_id=$3`,
      [t, memoria, docId],
    );
    await c.query(
      `INSERT INTO documents (tenant, memoria, doc_id, title, content, size_bytes, origem)
       VALUES ($1,$2,$3,$4,$5,$6,'direto')`,
      [t, dest, novo, novoTitulo, content, size],
    );
    return {
      doc_id: novo,
      memoria: dest,
      titulo: novoTitulo,
      movido: dest !== memoria,
      renomeado: novo !== docId,
    };
  });
}

/** PATCH /documents/{id}/arquivado: manual, sem busca. */
export async function patchArquivado(
  docId: string,
  arquivado: boolean,
  memoriaArg: string,
  tenantArg: string | null,
  user: Usuario,
) {
  const t = tenantFor(user, tenantArg);
  const memoria = (memoriaArg ?? "").trim();
  return tx(async (c) => {
    const ch = await c.query(
      `SELECT count(*) AS n FROM chunks WHERE tenant=$1 AND memoria=$2 AND doc_id=$3`,
      [t, memoria, docId],
    );
    if (!Number(ch.rows[0].n)) throw erro404("documento nao existe nesta memoria");
    let r;
    if (arquivado) {
      r = await c.query(
        `UPDATE chunks SET archived_at=COALESCE(archived_at, now())
         WHERE tenant=$1 AND memoria=$2 AND doc_id=$3 AND archived_at IS NULL`,
        [t, memoria, docId],
      );
    } else {
      r = await c.query(
        `UPDATE chunks SET archived_at=NULL
         WHERE tenant=$1 AND memoria=$2 AND doc_id=$3 AND archived_at IS NOT NULL`,
        [t, memoria, docId],
      );
    }
    return { doc_id: docId, arquivado, chunks_afetados: r.rowCount ?? 0 };
  });
}

/** GET /gavetas/{m}/export.zip */
export async function exportGaveta(
  memoriaArg: string,
  tenantArg: string | null,
  user: Usuario,
): Promise<{ buffer: Buffer; nome: string }> {
  const t = tenantFor(user, tenantArg);
  const memoria = (memoriaArg ?? "").trim();
  const r = await q(
    `SELECT doc_id, coalesce(title,'') AS title, content FROM documents
     WHERE tenant=$1 AND memoria=$2 ORDER BY doc_id`,
    [t, memoria],
  );
  if (!r.rowCount) throw erro404("gaveta vazia ou sem fontes guardadas");

  const manifest: Row = {
    tenant: t,
    memoria,
    gerado_em: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    docs: [],
  };
  const zip = new ZipFile();
  const usados = new Set<string>();
  for (const row of r.rows) {
    const base = nomeArquivo(row.doc_id, "doc");
    let nome = base;
    let i = 2;
    while (usados.has(nome + ".txt")) {
      nome = `${base}_${i}`;
      i += 1;
    }
    usados.add(nome + ".txt");
    zip.addBuffer(Buffer.from(row.content ?? "", "utf8"), nome + ".txt");
    manifest.docs.push({ doc_id: row.doc_id, title: row.title, arquivo: nome + ".txt" });
  }
  zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), "manifest.json");
  zip.end();

  const buffer: Buffer = await new Promise((resolve, reject) => {
    const pedacos: Buffer[] = [];
    zip.outputStream.on("data", (d: Buffer) => pedacos.push(d));
    zip.outputStream.on("end", () => resolve(Buffer.concat(pedacos)));
    zip.outputStream.on("error", reject);
  });
  return { buffer, nome: nomeArquivo(memoria, "gaveta") };
}

/** DELETE /gavetas/{m} */
export async function deleteGaveta(memoriaArg: string, tenantArg: string | null, user: Usuario) {
  const t = tenantFor(user, tenantArg);
  const memoria = (memoriaArg ?? "").trim();
  return tx(async (c) => {
    const proc = await c.query(
      `SELECT count(*) AS n FROM ingest_jobs WHERE tenant=$1 AND memoria=$2 AND status='processando'`,
      [t, memoria],
    );
    if (Number(proc.rows[0].n)) throw erro409("ha job processando nesta gaveta");
    const canc = await c.query(
      `UPDATE ingest_jobs SET status='cancelado', finalizado_em=now()
       WHERE tenant=$1 AND memoria=$2 AND status='na_fila'`,
      [t, memoria],
    );
    const ch = await c.query(`DELETE FROM chunks WHERE tenant=$1 AND memoria=$2`, [t, memoria]);
    const fo = await c.query(`DELETE FROM documents WHERE tenant=$1 AND memoria=$2`, [t, memoria]);
    if (!ch.rowCount && !fo.rowCount) throw erro404("gaveta vazia ou inexistente");
    return {
      tenant: t,
      memoria,
      chunks_apagados: ch.rowCount ?? 0,
      fontes_apagadas: fo.rowCount ?? 0,
      jobs_cancelados: canc.rowCount ?? 0,
    };
  });
}

export async function cancelJob(jobId: number, tenantArg: string | null, user: Usuario) {
  const alvo = tenantFilter(user, tenantArg);
  const filtro = alvo !== null ? " AND tenant=$2" : "";
  const params: unknown[] = alvo !== null ? [jobId, alvo] : [jobId];
  const r = await q(
    `UPDATE ingest_jobs SET status='cancelado', finalizado_em=now()
     WHERE id=$1 AND status='na_fila'${filtro}`,
    params,
  );
  if (r.rowCount) return { job_id: jobId, status: "cancelado" };
  const s = await q(`SELECT status FROM ingest_jobs WHERE id=$1${filtro}`, params);
  if (!s.rowCount) throw erro404("job nao existe (ou e de outro usuario)");
  throw erro409(`job esta '${s.rows[0].status}' — so cancela quem esta na_fila`);
}

export async function retryJob(jobId: number, tenantArg: string | null, user: Usuario) {
  const alvo = tenantFilter(user, tenantArg);
  const filtro = alvo !== null ? " AND tenant=$2" : "";
  const params: unknown[] = alvo !== null ? [jobId, alvo] : [jobId];
  const r = await q(
    `UPDATE ingest_jobs SET status='na_fila', chunks_feitos=0, erro=NULL, finalizado_em=NULL
     WHERE id=$1 AND status IN ('erro','cancelado')${filtro}`,
    params,
  );
  if (r.rowCount) return { job_id: jobId, status: "na_fila" };
  const s = await q(`SELECT status FROM ingest_jobs WHERE id=$1${filtro}`, params);
  if (!s.rowCount) throw erro404("job nao existe (ou e de outro usuario)");
  throw erro409(`job esta '${s.rows[0].status}' — so retenta erro ou cancelado`);
}

/** DELETE /docs/{id}: apaga chunks + fonte + jobs na fila. */
export async function deleteDoc(docId: string, memoriaArg: string, tenantArg: string | null, user: Usuario) {
  const memoria = (memoriaArg ?? "").trim();
  const tenant = tenantFor(user, tenantArg);
  return tx(async (c) => {
    const ch = await c.query(
      `SELECT count(*) AS n FROM chunks WHERE tenant=$1 AND memoria=$2 AND doc_id=$3`,
      [tenant, memoria, docId],
    );
    const nChunks = Number(ch.rows[0].n);
    const pr = await c.query(
      `SELECT count(*) AS n FROM ingest_jobs WHERE tenant=$1 AND memoria=$2
       AND doc_id=$3 AND status='processando'`,
      [tenant, memoria, docId],
    );
    if (Number(pr.rows[0].n)) {
      throw erro409("documento em processamento agora; acompanhe o job e apague quando terminar");
    }
    const fo = await c.query(
      `SELECT count(*) AS n FROM documents WHERE tenant=$1 AND memoria=$2 AND doc_id=$3`,
      [tenant, memoria, docId],
    );
    const nFonte = Number(fo.rows[0].n);
    if (!nChunks && !nFonte) throw erro404("documento nao encontrado nesta memoria");

    const canc = await c.query(
      `UPDATE ingest_jobs SET status='cancelado', finalizado_em=now()
       WHERE tenant=$1 AND memoria=$2 AND doc_id=$3 AND status='na_fila'`,
      [tenant, memoria, docId],
    );
    const del = await c.query(
      `DELETE FROM chunks WHERE tenant=$1 AND memoria=$2 AND doc_id=$3`,
      [tenant, memoria, docId],
    );
    const delF = await c.query(
      `DELETE FROM documents WHERE tenant=$1 AND memoria=$2 AND doc_id=$3`,
      [tenant, memoria, docId],
    );
    return {
      tenant,
      memoria,
      doc_id: docId,
      chunks_apagados: del.rowCount ?? 0,
      jobs_cancelados: canc.rowCount ?? 0,
      fonte_apagada: Boolean(delF.rowCount),
    };
  });
}

export { documentoRow };