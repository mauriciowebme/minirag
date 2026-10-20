import { useCallback, useEffect, useMemo, useState } from "react";
import { baixar, del, get, post, qs } from "../services/api";
import { fmtData, slug } from "../lib/fmt";
import { useToast } from "./Toast";
import type { DecayResp, Gaveta, GavetasResp } from "../types";

/** Plural certo: 1 usuário / 2 usuários. */
function pl(n: number, um: string, muitos: string): string {
  return `${n} ${n === 1 ? um : muitos}`;
}

/** Identificador técnico de gaveta (p:<uuid>), usado pelo IA_GO. */
function ehTecnica(m: string): boolean {
  return /^p:[0-9a-f-]{20,}$/i.test(m);
}

/** Trecho legível do identificador técnico. */
function curto(m: string): string {
  return `p:${m.slice(2, 10)}…`;
}

const GAVETA_VAZIA: Gaveta = {
  tenant: "",
  memoria: "",
  chunks: 0,
  docs: 0,
  chunks_arquivados: 0,
  primeiro_ingress: null,
  ultimo_ingress: null,
};

export function Gavetas({
  operador,
  onAbrir,
}: {
  operador: boolean;
  onAbrir: (tenant: string, memoria: string) => void;
}) {
  const { toast } = useToast();
  const [dados, setDados] = useState<GavetasResp | null>(null);
  const [carregando, setCarregando] = useState(true);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      setDados(await get<GavetasResp>("/gavetas"));
    } catch (e) {
      setDados(null);
      toast("gavetas: " + (e as Error).message);
    } finally {
      setCarregando(false);
    }
  }, [toast]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /* nível 1 (usuário) → nível 2 (gavetas dele).
     Usuário sem dado aparece com a gaveta padrão vazia, para poder receber documento. */
  const grupos = useMemo(() => {
    const mapa = new Map<string, Gaveta[]>();
    for (const t of dados?.usuarios ?? []) if (!mapa.has(t)) mapa.set(t, []);
    for (const g of dados?.gavetas ?? []) {
      const atual = mapa.get(g.tenant);
      if (atual) atual.push(g);
      else mapa.set(g.tenant, [g]);
    }
    return [...mapa.entries()]
      .map(([tenant, gavetas]) => {
        const ordenadas = [...gavetas].sort((a, b) => (a.memoria || "").localeCompare(b.memoria || ""));
        const vazio = ordenadas.length === 0;
        return {
          tenant,
          vazio,
          qtdGavetas: ordenadas.length,
          gavetas: vazio ? [{ ...GAVETA_VAZIA, tenant }] : ordenadas,
          docs: ordenadas.reduce((s, g) => s + g.docs, 0),
        };
      })
      .sort((a, b) => a.tenant.localeCompare(b.tenant));
  }, [dados]);

  async function exportar(tenant: string, memoria: string) {
    try {
      await baixar(
        `/gavetas/${encodeURIComponent(memoria)}/export.zip?${qs({ tenant: operador ? tenant : undefined })}`,
        slug(memoria || "gaveta") + ".zip",
      );
      toast("zip gerado ✓");
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function apagar(tenant: string, memoria: string, docs: number) {
    const rotulo = (operador ? `${tenant} ▸ ` : "") + (memoria || "padrão");
    if (!confirm(`APAGAR a gaveta ${rotulo} inteira (${docs} arquivo(s), chunks, fontes e jobs na fila)?`)) return;
    if (!confirm("Tem certeza? Isso NÃO tem como desfazer no painel.")) return;
    try {
      const r = await del<{ chunks_apagados: number; fontes_apagadas: number }>(
        `/gavetas/${encodeURIComponent(memoria)}?${qs({ tenant: operador ? tenant : undefined })}`,
      );
      toast(`gaveta apagada: ${r.chunks_apagados} chunks, ${r.fontes_apagadas} fontes`);
      void carregar();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function arquivarEsquecidos() {
    const alvo = operador ? "todas as gavetas" : "a tua gaveta";
    const ok = confirm(
      `Arquivar os documentos sem uso há 30 dias ou mais em ${alvo}?\n\n` +
        "Nada é apagado: eles só saem da busca e podem ser revividos depois.",
    );
    if (!ok) return;
    try {
      const r = await post<DecayResp>("/decay");
      toast(
        `${r.docs_arquivados_agora} documento(s) arquivado(s) agora · ` +
          `${r.ativos} ativo(s) · ${r.arquivados} arquivado(s)`,
      );
      void carregar();
    } catch (e) {
      toast("não deu para arquivar: " + (e as Error).message);
    }
  }

  const totalGavetas = dados?.gavetas.length ?? 0;
  const totalDocs = dados?.documentos_fonte ?? 0;

  return (
    <section>
      <div className="barra">
        <h2>{operador ? "Usuários e gavetas" : "As tuas gavetas"}</h2>
        <span className="flex-1" />
        <button id="btnAtualizarGav" className="btn btn-sutil" title="recarregar a lista" onClick={() => void carregar()}>
          <span aria-hidden="true">⟳</span>
          atualizar
        </button>
        <button
          id="btnDecay"
          className="btn"
          title="arquiva (sem apagar) os documentos sem uso há 30 dias ou mais — padrão, ajustável"
          onClick={() => void arquivarEsquecidos()}
        >
          arquivar esquecidos
        </button>
      </div>

      <div id="gavetasInfo" className="dica">
        {dados
          ? (operador ? `${pl(grupos.length, "usuário", "usuários")} · ` : "") +
            `${
              totalGavetas === 0 ? "nenhuma gaveta com documento" : `${pl(totalGavetas, "gaveta", "gavetas")} com documento`
            } · ${pl(totalDocs, "documento", "documentos")} com fonte guardada` +
            (grupos.length ? " · clique numa gaveta para ver os documentos" : "")
          : ""}
      </div>

      <div id="gavetasGrid" className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
        {carregando && <p className="dica">carregando…</p>}
        {!carregando && grupos.length === 0 && (
          <div className="vazio col-span-full">
            <div className="tit">Nenhum usuário ainda</div>
            Crie uma nota ou envie um arquivo na aba Arquivos.
          </div>
        )}
        {!carregando &&
          grupos.map(({ tenant, gavetas, docs, qtdGavetas, vazio }) => (
            <div key={tenant} className="rounded-cartao border border-borda bg-sup">
              {/* nível 1: o usuário (chave de login) */}
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-borda/70 px-3.5 py-2.5">
                {operador ? (
                  <h3 className="text-[13px] font-semibold text-txt2">👤 {tenant}</h3>
                ) : (
                  <h3 className="text-[13px] font-semibold text-txt2">As tuas gavetas</h3>
                )}
                <span className="text-[12px] text-txt3">
                  {vazio
                    ? "nenhuma gaveta ainda"
                    : `${pl(qtdGavetas, "gaveta", "gavetas")} · ${pl(docs, "documento", "documentos")}`}
                </span>
              </div>

              {/* nível 2: as gavetas desse usuário, uma por linha */}
              <ul className="divide-y divide-borda/60">
                {gavetas.map((g) => (
                  <li key={g.tenant + "|" + g.memoria}>
                    <div
                      role="button"
                      tabIndex={0}
                      className="flex cursor-pointer items-center gap-2 px-3.5 py-2.5 transition-colors hover:bg-sup2 focus-visible:bg-sup2 focus-visible:outline-none"
                      onClick={() => onAbrir(g.tenant, g.memoria)}
                      onKeyDown={(e) => e.key === "Enter" && onAbrir(g.tenant, g.memoria)}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-[13px] font-semibold" title={g.memoria || "padrão"}>
                            {vazio ? "gaveta padrão" : ehTecnica(g.memoria) ? "gaveta do perfil" : g.memoria || "padrão"}
                          </span>
                          {ehTecnica(g.memoria) && !vazio && (
                            <span className="chip" title={g.memoria}>
                              {curto(g.memoria)}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-[12px] text-txt3">
                          {vazio ? (
                            <span className="text-txt3">vazia — clique para enviar o primeiro documento</span>
                          ) : (
                            <>
                              <b className="text-txt2">{g.docs}</b> {g.docs === 1 ? "arquivo" : "arquivos"} ·{" "}
                              <b className="text-txt2">{g.chunks}</b> {g.chunks === 1 ? "chunk" : "chunks"} ·{" "}
                              {g.chunks_arquivados ? `${g.chunks_arquivados} arquiv.` : "tudo ativo"} · último{" "}
                              {fmtData(g.ultimo_ingress)}
                            </>
                          )}
                        </div>
                      </div>

                      {vazio ? (
                        <span className="btn btn-primario btn-mini shrink-0">＋ documento</span>
                      ) : (
                        <div className="flex shrink-0 gap-1">
                          <button
                            className="btn btn-sutil btn-mini"
                            title="baixar esta gaveta em zip"
                            onClick={(e) => {
                              e.stopPropagation();
                              void exportar(g.tenant, g.memoria);
                            }}
                          >
                            ⬇ zip
                          </button>
                          <button
                            className="btn btn-perigo btn-mini"
                            title="apagar a gaveta inteira"
                            onClick={(e) => {
                              e.stopPropagation();
                              void apagar(g.tenant, g.memoria, g.docs);
                            }}
                          >
                            apagar
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>
    </section>
  );
}