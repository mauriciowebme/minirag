/**
 * v3.5 (dono, 21/10): o esquecimento ganha três números configuráveis NA TELA,
 * gravados na tabela `esquecimento_cfg` (fonte única depois de mexer; enquanto a
 * linha não existe, o default vem do ambiente/código):
 *
 *   dias_arquivar         — documento sem uso vira ARQUIVADO (some da busca, revive
 *                           ao ser usado). Default novo: 180 (6 meses; era 30).
 *   dias_excluir_arquivado— arquivado que continua encostado morre DE VERDADE
 *                           (chunks+fonte+original). Default: 365 (1 ano).
 *   dias_carencia         — janela entre "apagar usuário" e a exclusão dos dados dele;
 *                           recriar o nome dentro da janela DEFAZ tudo. Default: 30.
 *
 * Nunca apaga documento VIVO: o expurgo de arquivados exige archived_at em TODOS os
 * chunks do doc e o marco mais antigo do doc parado por inteiro além da janela.
 */
import { CONFIG } from "./config";
import { q } from "./db";
import { erro422 } from "./errors";

export type AjusteChave = "dias_arquivar" | "dias_excluir_arquivado" | "dias_carencia";

const PADROES: Record<AjusteChave, number> = {
  dias_arquivar: CONFIG.decayDias,
  dias_excluir_arquivado: CONFIG.expurgoArquivadoDias,
  dias_carencia: CONFIG.carenciaDias,
};

export async function criarTabelaEsquecimento(): Promise<void> {
  await q(
    `CREATE TABLE IF NOT EXISTS esquecimento_cfg (
       chave TEXT PRIMARY KEY,
       valor INT NOT NULL,
       atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
}

export type EsquecimentoEfetivo = {
  efetivos: Record<AjusteChave, number>;
  origem: Record<AjusteChave, "tela" | "ambiente">;
};

/** Lento o bastante para um índice por hora, barato o bastante para chamar em cada request. */
export async function lerEsquecimento(): Promise<EsquecimentoEfetivo> {
  const r = await q<{ chave: string; valor: number }>(`SELECT chave, valor FROM esquecimento_cfg`);
  const mapa = new Map(r.rows.map((x) => [x.chave, Number(x.valor)]));
  const efetivos = {} as Record<AjusteChave, number>;
  const origem = {} as Record<AjusteChave, "tela" | "ambiente">;
  for (const k of Object.keys(PADROES) as AjusteChave[]) {
    const naTela = mapa.has(k);
    efetivos[k] = naTela ? (mapa.get(k) as number) : PADROES[k];
    origem[k] = naTela ? "tela" : "ambiente";
  }
  return { efetivos, origem };
}

/** Escrita parcial: campos ausentes ficam como estão. inteiros 0..36500. */
export async function escreverEsquecimento(body: Record<string, unknown>): Promise<EsquecimentoEfetivo> {
  const pares: Array<[AjusteChave, number]> = [];
  for (const k of Object.keys(PADROES) as AjusteChave[]) {
    if (body[k] === undefined || body[k] === null) continue;
    const v = Number(body[k]);
    if (!Number.isInteger(v) || v < 0 || v > 36500) {
      throw erro422(`${k} deve ser inteiro entre 0 e 36500`);
    }
    pares.push([k, v]);
  }
  if (!pares.length) throw erro422("nada para salvar: envie dias_arquivar, dias_excluir_arquivado ou dias_carencia");
  for (const [k, v] of pares) {
    await q(
      `INSERT INTO esquecimento_cfg (chave, valor, atualizado_em) VALUES ($1, $2, now())
       ON CONFLICT (chave) DO UPDATE SET valor = $2, atualizado_em = now()`,
      [k, v],
    );
  }
  return lerEsquecimento();
}

/**
 * Data em que o usuário apagado será expurgado. 0 dias = expira na hora seguinte
 * do faxineiro (usado pela suíte; na tela a careência default é 30).
 */
export function dataCarencia(dias: number): string {
  const ms = Date.now() + dias * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}
