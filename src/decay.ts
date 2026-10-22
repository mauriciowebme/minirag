/** Decay: arquiva (sem apagar) documentos pouco usados há muito tempo. */
import { PoolClient } from "pg";
import { CONFIG } from "./config";
import { q } from "./db";
import { lerEsquecimento } from "./esquecimento";

export type DecayResultado = {
  arquivados_agora: number;
  docs_arquivados_agora: number;
  ativos: number;
  arquivados: number;
};

/**
 * A decisão é POR DOCUMENTO: soma dos acessos dos chunks do doc; o doc inteiro
 * vira arquivado. dias/min_acessos null = valor EFETIVO (tela > ambiente > código).
 * tenant null = global.
 */
export async function runDecay(
  dias?: number | null,
  minAcessos?: number | null,
  tenant?: string | null,
): Promise<DecayResultado> {
  const { efetivos } = await lerEsquecimento();
  const d = dias ?? efetivos.dias_arquivar;
  const m = minAcessos ?? CONFIG.decayMinAcessos;
  const escopo = tenant !== null && tenant !== undefined ? " AND c.tenant = $3" : "";
  const params: unknown[] = [m, d];
  if (escopo) params.push(tenant);

  const r = await q<{ tenant: string; memoria: string; doc_id: string }>(
    `WITH uso AS (
       SELECT tenant, memoria, doc_id,
              sum(access_count) AS acessos,
              max(COALESCE(last_accessed_at, ingested_at)) AS ultimo
       FROM chunks GROUP BY tenant, memoria, doc_id
     )
     UPDATE chunks c SET archived_at = now()
     FROM uso u
     WHERE u.tenant = c.tenant AND u.memoria = c.memoria AND u.doc_id = c.doc_id
       AND c.archived_at IS NULL
       AND u.acessos < $1
       AND u.ultimo < now() - make_interval(days => $2)
       ${escopo}
     RETURNING c.tenant, c.memoria, c.doc_id`,
    params,
  );
  const docs = new Set(r.rows.map((x) => `${x.tenant}\u0000${x.memoria}\u0000${x.doc_id}`));

  const filtro = escopo ? " WHERE tenant = $1" : "";
  const cont = await q<{ ativos: string; arquivados: string }>(
    `SELECT count(*) FILTER (WHERE archived_at IS NULL) AS ativos,
            count(*) FILTER (WHERE archived_at IS NOT NULL) AS arquivados
     FROM chunks${filtro}`,
    escopo ? [tenant] : [],
  );
  const linha = cont.rows[0];
  return {
    arquivados_agora: r.rowCount ?? 0,
    docs_arquivados_agora: docs.size,
    ativos: Number(linha?.ativos ?? 0),
    arquivados: Number(linha?.arquivados ?? 0),
  };
}

let timer: NodeJS.Timeout | null = null;

export function iniciarDecayLoop(onArquivou: (n: number) => void): void {
  if (!CONFIG.decayAtivo) return;
  timer = setInterval(async () => {
    try {
      const r = await runDecay();
      if (r.arquivados_agora) onArquivou(r.arquivados_agora);
    } catch (e) {
      // nunca derruba o servidor por manutenção
      process.stdout.write(`[minirag] decay falhou: ${(e as Error).message}\n`);
    }
  }, CONFIG.decayIntervaloMinutos * 60 * 1000);
  timer.unref?.();
}

export function pararDecayLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export type { PoolClient };