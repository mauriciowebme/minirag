/** Painel (dashboard): números do acervo em UMA chamada + contador diário de uso. */
import { CONFIG, Usuario, isOperador } from "./config";
import { q } from "./db";
import { embedderDim, embedderDisponivel } from "./embed";
import { ocrDisponivel } from "./ocr";
import { nomesUsuarios, nomesOperadores } from "./usuarios";

export async function initMetricas(): Promise<void> {
  await q(
    `CREATE TABLE IF NOT EXISTS metricas_dia (
       dia DATE PRIMARY KEY,
       buscas INT NOT NULL DEFAULT 0,
       chats INT NOT NULL DEFAULT 0)`,
  );
}

/** +1 no contador do dia; nunca derruba a rota que chamou. */
export async function contarUso(campo: "buscas" | "chats"): Promise<void> {
  try {
    await q(
      `INSERT INTO metricas_dia (dia, ${campo}) VALUES (CURRENT_DATE, 1)
       ON CONFLICT (dia) DO UPDATE SET ${campo} = metricas_dia.${campo} + 1`,
    );
  } catch {
    /* métrica é enfeite: não pode quebrar busca/chat */
  }
}

export async function dadosPainel(user: Usuario, tenantArg?: string | null) {
  const alvo = isOperador(user) ? ((tenantArg ?? "").trim() || null) : user.tenant;
  const filtro = alvo ? "WHERE tenant = $1" : "";
  const params = alvo ? [alvo] : [];

  const [chunks, gavetas, docs, jobs, porUsuario, ultimos, uso, provider] = await Promise.all([
    q<{ n: string; arquivados: string }>(
      `SELECT count(*) AS n, count(*) FILTER (WHERE archived_at IS NOT NULL) AS arquivados FROM chunks ${filtro}`,
      params,
    ),
    q<{ n: string }>(`SELECT count(*) AS n FROM gavetas ${filtro}`, params),
    q<{ n: string }>(`SELECT count(*) AS n FROM documents ${filtro}`, params),
    q<{ status: string; n: string }>(
      `SELECT status, count(*) AS n FROM ingest_jobs ${filtro} GROUP BY status`,
      params,
    ),
    q<{ tenant: string; docs: string; chunks: string; ultimo: string | null }>(
      `SELECT tenant, count(DISTINCT doc_id) AS docs, count(*) AS chunks, max(ingested_at) AS ultimo
       FROM chunks ${filtro} GROUP BY tenant ORDER BY docs DESC, tenant`,
      params,
    ),
    q<{ tenant: string; memoria: string; doc_id: string; nome: string; tipo: string; ocr: boolean; criado_em: string }>(
      `SELECT tenant, memoria, doc_id, nome, tipo, ocr, criado_em FROM arquivos ${filtro}
       ORDER BY criado_em DESC LIMIT 8`,
      params,
    ),
    q<{ buscas: string; chats: string }>(`SELECT buscas, chats FROM metricas_dia WHERE dia = CURRENT_DATE`),
    q<{ escopo: string }>(`SELECT escopo FROM provider_config WHERE ativo AND base_url <> '' AND modelo <> '' LIMIT 1`),
  ]);

  const porStatus: Record<string, number> = { na_fila: 0, processando: 0, concluido: 0, erro: 0 };
  for (const j of jobs.rows) porStatus[j.status] = Number(j.n);

  const noAr = await q(`SELECT escopo FROM provider_config WHERE escopo = $1 AND ativo`, [user.tenant]);
  const globalOk = provider.rowCount ?? 0;

  return {
    versao: CONFIG.versao,
    escopo: alvo ?? "tudo",
    numeros: {
      /* login comum não precisa saber quantas contas existem no servidor */
      usuarios: isOperador(user) ? nomesUsuarios().length : 1,
      operadores: isOperador(user) ? nomesOperadores().length : 0,
      gavetas: Number(gavetas.rows[0]?.n ?? 0),
      documentos: Number(docs.rows[0]?.n ?? 0),
      chunks: Number(chunks.rows[0]?.n ?? 0),
      chunks_arquivados: Number(chunks.rows[0]?.arquivados ?? 0),
      buscas_hoje: Number(uso.rows[0]?.buscas ?? 0),
      chats_hoje: Number(uso.rows[0]?.chats ?? 0),
    },
    fila: porStatus,
    buscas_hoje: Number(uso.rows[0]?.buscas ?? 0),
    chats_hoje: Number(uso.rows[0]?.chats ?? 0),
    por_usuario: porUsuario.rows.map((r) => ({
      tenant: r.tenant,
      documentos: Number(r.docs),
      chunks: Number(r.chunks),
      ultimo: r.ultimo,
    })),
    ultimos: ultimos.rows.map((r) => ({
      tenant: r.tenant,
      memoria: r.memoria,
      doc_id: r.doc_id,
      nome: r.nome,
      tipo: r.tipo,
      ext: (r.nome.split(".").pop() ?? "").toLowerCase(),
      ocr: Boolean(r.ocr),
      quando: r.criado_em,
    })),
    saude: {
      embedder: embedderDisponivel() ? "ok" : "fora",
      ocr: ocrDisponivel() === null ? "?" : ocrDisponivel() ? "ok" : "fora",
      dim: embedderDim(),
      provider: (noAr.rowCount ?? 0) > 0 ? "proprio" : globalOk > 0 ? "global" : "nao configurado",
    },
  };
}

/** Configuração exposta na tela (sem segredo): limites e esquecimento. */
export function configPublica() {
  return {
    versao: CONFIG.versao,
    limites: {
      max_content_chars: CONFIG.maxContentChars,
      max_query_chars: CONFIG.maxQueryChars,
      max_chunks_tenant: CONFIG.maxChunksTenant,
      top_k: CONFIG.topK,
      min_score: CONFIG.minScore,
      chunk_palavras: CONFIG.maxChunkWords,
      chunk_sobreposicao: CONFIG.chunkOverlap,
      ocr_paginas_max: Number(process.env.MINIRAG_OCR_PAGINAS_MAX ?? 6),
    },
    esquecimento: {
      ativo: CONFIG.decayAtivo,
      dias: CONFIG.decayDias,
      min_acessos: CONFIG.decayMinAcessos,
      intervalo_minutos: CONFIG.decayIntervaloMinutos,
    },
    modelo_embedding: CONFIG.model,
  };
}