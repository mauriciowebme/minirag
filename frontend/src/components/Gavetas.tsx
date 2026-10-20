import { useCallback, useEffect, useState } from "react";
import { baixar, del, get, post, qs } from "../services/api";
import { fmtData, slug } from "../lib/fmt";
import { useToast } from "./Toast";
import type { DecayResp, GavetasResp } from "../types";

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
    const rotulo = (operador ? `${tenant} ▸ ` : "") + (memoria || "(padrão)");
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

  return (
    <section>
      <div className="barra">
        <h2>Mapa da memória</h2>
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
        {dados ? `${dados.gavetas.length} gaveta(s) · ${dados.documentos_fonte} documento(s) com fonte guardada` : ""}
      </div>

      <div id="gavetasGrid" className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
        {carregando && <p className="dica">carregando…</p>}
        {!carregando && dados && dados.gavetas.length === 0 && (
          <div className="vazio col-span-full">
            <div className="tit">Nenhuma memória ainda</div>
            Crie uma nota ou envie um arquivo na aba Arquivos.
          </div>
        )}
        {!carregando &&
          dados?.gavetas.map((g) => (
            <div
              key={g.tenant + "|" + g.memoria}
              role="button"
              tabIndex={0}
              className="cursor-pointer rounded-cartao border border-borda bg-sup p-4 transition-colors hover:border-bordaforte hover:bg-sup2"
              onClick={() => onAbrir(g.tenant, g.memoria)}
              onKeyDown={(e) => e.key === "Enter" && onAbrir(g.tenant, g.memoria)}
            >
              <div className="mb-2 text-[14px] font-semibold">
                {operador ? <span className="text-txt3">{g.tenant} ▸ </span> : null}
                {g.memoria || "(padrão)"}
              </div>
              <div className="mb-3 flex flex-wrap gap-2.5 text-[13px] text-txt3">
                <span>
                  <b className="text-txt2">{g.docs}</b> arquivo(s)
                </span>
                <span>
                  <b className="text-txt2">{g.chunks}</b> chunks
                </span>
                <span>{g.chunks_arquivados ? `${g.chunks_arquivados} arquiv.` : "tudo ativo"}</span>
                <span>último {fmtData(g.ultimo_ingress)}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
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
            </div>
          ))}
      </div>
    </section>
  );
}