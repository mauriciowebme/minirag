import { useCallback, useEffect, useRef, useState } from "react";
import { baixar, del, get, patch, post, qs } from "../services/api";
import { fmtData, slug } from "../lib/fmt";
import { useToast } from "./Toast";
import type { DocItem, DocsResp, Escopo } from "../types";

export function Arquivos({
  escopo,
  operador,
  onAbrirEditor,
  onEscopoVazio,
}: {
  escopo: Escopo;
  operador: boolean;
  onAbrirEditor: (docId: string | null, novoNome?: string) => void;
  onEscopoVazio: () => void;
}) {
  const { toast } = useToast();
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [filtro, setFiltro] = useState("");
  const [mostrarArq, setMostrarArq] = useState(false);
  const [novaNota, setNovaNota] = useState(false);
  const [nomeNota, setNomeNota] = useState("");
  const [quente, setQuente] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const filtroRef = useRef("");

  const carregar = useCallback(
    async (q: string, arquivados: boolean) => {
      if (!escopo.tenant) {
        toast("escolha uma gaveta primeiro");
        onEscopoVazio();
        return;
      }
      setCarregando(true);
      try {
        const d = await get<DocsResp>(
          "/docs?" +
            qs({
              memoria: escopo.memoria,
              tenant: escopo.tenant,
              include_archived: arquivados ? "true" : "",
              q,
              limit: 500,
            }),
        );
        setDocs(d.docs);
        setTotal(d.total);
      } catch (e) {
        setDocs([]);
        toast("docs: " + (e as Error).message);
      } finally {
        setCarregando(false);
      }
    },
    [escopo, onEscopoVazio, toast],
  );

  useEffect(() => {
    void carregar("", false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [escopo.tenant, escopo.memoria]);

  function aoFiltrar(v: string) {
    setFiltro(v);
    filtroRef.current = v;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void carregar(v.trim(), mostrarArq), 350);
  }

  async function subir(lista: File[]) {
    if (!lista.length) return;
    let ok = 0;
    let falha = 0;
    for (const f of lista) {
      try {
        const texto = await f.text();
        const r = await post<{ job_id: number; chunks_total: number }>("/ingest", {
          doc_id: f.name,
          title: f.name,
          content: texto,
          memoria: escopo.memoria,
          tenant: operador ? escopo.tenant : undefined,
        });
        ok++;
        toast(`⬆ ${f.name}: na fila (job ${r.job_id}, ${r.chunks_total} chunk[s])`, 2500);
      } catch (e) {
        falha++;
        toast(`⬆ ${f.name}: ${(e as Error).message}`, 5000);
      }
    }
    if (lista.length > 1) toast(`upload: ${ok} enviado(s), ${falha} com erro`, 5000);
    void carregar(filtroRef.current, mostrarArq);
  }

  async function exportar() {
    try {
      await baixar(
        `/gavetas/${encodeURIComponent(escopo.memoria)}/export.zip?${qs({ tenant: operador ? escopo.tenant : undefined })}`,
        slug(escopo.memoria || "gaveta") + ".zip",
      );
      toast("zip gerado ✓");
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function apagarGaveta() {
    const rotulo = (operador ? `${escopo.tenant} ▸ ` : "") + (escopo.memoria || "(padrão)");
    if (!confirm(`APAGAR a gaveta ${rotulo} inteira (${total ?? "?"} arquivo(s), chunks, fontes e jobs na fila)?`)) return;
    if (!confirm("Tem certeza? Isso NÃO tem como desfazer no painel.")) return;
    try {
      const r = await del<{ chunks_apagados: number; fontes_apagadas: number }>(
        `/gavetas/${encodeURIComponent(escopo.memoria)}?${qs({ tenant: operador ? escopo.tenant : undefined })}`,
      );
      toast(`gaveta apagada: ${r.chunks_apagados} chunks, ${r.fontes_apagadas} fontes`);
      onEscopoVazio();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function alternarArquivado(doc: DocItem) {
    const arquivado = doc.chunks_arquivados > 0;
    try {
      await patch(
        `/documents/${encodeURIComponent(doc.doc_id)}/arquivado?${qs({ memoria: escopo.memoria })}`,
        { arquivado: !arquivado, tenant: operador ? escopo.tenant : undefined },
      );
      toast(arquivado ? "documento revivido ✓" : "documento arquivado ✓");
      void carregar(filtroRef.current, mostrarArq);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function apagarDoc(doc: DocItem) {
    if (!confirm(`APAGAR definitivamente "${doc.doc_id}" (${doc.chunks} chunks + fonte)?`)) return;
    try {
      const r = await del<{ chunks_apagados: number; fonte_apagada: boolean }>(
        `/docs/${encodeURIComponent(doc.doc_id)}?` +
          qs({ memoria: escopo.memoria, tenant: operador ? escopo.tenant : undefined }),
      );
      toast(`apagado: ${r.chunks_apagados} chunks` + (r.fonte_apagada ? " + fonte" : ""));
      void carregar(filtroRef.current, mostrarArq);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function baixarDoc(doc: DocItem) {
    try {
      await baixar(
        `/documents/${encodeURIComponent(doc.doc_id)}/raw?` + qs({ memoria: escopo.memoria, tenant: escopo.tenant }),
        slug(doc.doc_id) + ".txt",
      );
    } catch (e) {
      toast((e as Error).message);
    }
  }

  function criarNota() {
    const nome = nomeNota.trim().replace(/\s+/g, "-");
    if (!nome) {
      toast("dê um nome à nota");
      return;
    }
    setNovaNota(false);
    onAbrirEditor(null, nome);
  }

  return (
    <section>
      <div className="barra">
        <h2>
          Arquivos{" "}
          <span id="arqOnde" className="sub2">
            {escopo.tenant ? `— 👤 ${escopo.tenant} ▸ gaveta ${escopo.memoria || "padrão"}` : ""}
          </span>
        </h2>
        <span className="flex-1" />
        <button
          id="btnNovaNota"
          className="btn btn-primario"
          onClick={() => {
            setNovaNota((v) => !v);
            setNomeNota("nota-" + new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-"));
          }}
        >
          ＋ nova nota
        </button>
        <label className="btn" title="enviar um ou vários arquivos">
          ⬆ upload
          <input
            type="file"
            id="arquivoInput"
            accept=".txt,.md,.markdown,text/plain"
            multiple
            hidden
            ref={inputRef}
            onChange={(e) => {
              const lista = Array.from(e.target.files || []);
              e.target.value = "";
              void subir(lista);
            }}
          />
        </label>
        <button id="btnExport" className="btn btn-sutil" title="baixar a gaveta em .zip" onClick={() => void exportar()}>
          ⬇ exportar
        </button>
        <span className="mx-0.5 h-[22px] w-px bg-bordaforte" />
        <button id="btnApagarGaveta" className="btn btn-perigo" title="apagar TODOS os arquivos desta gaveta" onClick={() => void apagarGaveta()}>
          apagar gaveta
        </button>
      </div>

      <div className="faixa">
        <input
          id="arqFiltro"
          className="campo min-w-[200px] flex-1"
          placeholder="filtrar por título ou doc_id…"
          aria-label="filtrar arquivos"
          value={filtro}
          onChange={(e) => aoFiltrar(e.target.value)}
        />
        <label className="check">
          <input
            type="checkbox"
            id="arqMostrarArq"
            checked={mostrarArq}
            onChange={(e) => {
              setMostrarArq(e.target.checked);
              void carregar(filtroRef.current, e.target.checked);
            }}
          />
          mostrar arquivados
        </label>
        <span id="arqTotal" className="sub2">
          {total !== null ? `${total} arquivo(s)` : ""}
        </span>
      </div>

      {novaNota && (
        <div id="novaNotaBox" className="cartao mb-4">
          <div className="barra !mb-0">
            <label className="rotulo m-0 flex-1">
              nome da nova nota (doc_id)
              <input
                id="novaNotaNome"
                className="campo mt-[5px]"
                placeholder="ex.: decisoes-2026"
                value={nomeNota}
                autoFocus
                onChange={(e) => setNomeNota(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && criarNota()}
              />
            </label>
            <button id="btnCriarNota" className="btn btn-primario" onClick={criarNota}>
              criar
            </button>
            <button id="btnCancelarNota" className="btn btn-sutil" onClick={() => setNovaNota(false)}>
              cancelar
            </button>
          </div>
          <p className="mt-2 text-[12px] text-txt3">Cria vazia nesta gaveta; o texto é indexado ao salvar.</p>
        </div>
      )}

      <div
        id="dropzone"
        className={`drop ${quente ? "drop-hot" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragEnter={(e) => {
          e.preventDefault();
          setQuente(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setQuente(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setQuente(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setQuente(false);
          void subir(Array.from(e.dataTransfer.files || []));
        }}
      >
        <b>⬆</b> arraste arquivos .txt/.md aqui — ou clique para escolher
      </div>

      <table className="tabela" id="arqTabela">
        <thead>
          <tr>
            <th>título</th>
            <th>doc_id</th>
            <th>estado</th>
            <th className="num">chunks</th>
            <th>atualizado</th>
            <th aria-label="ações"></th>
          </tr>
        </thead>
        <tbody>
          {carregando && (
            <tr>
              <td colSpan={6} className="text-txt3">
                carregando…
              </td>
            </tr>
          )}
          {!carregando && docs.length === 0 && (
            <tr>
              <td colSpan={6} className="text-txt3">
                {filtro.trim() ? "nenhum arquivo com esse filtro" : "gaveta vazia — use nova nota ou arraste arquivos acima"}
              </td>
            </tr>
          )}
          {!carregando &&
            docs.map((doc) => {
              const arquivado = doc.chunks_arquivados > 0;
              return (
                <tr key={doc.doc_id} className={arquivado ? "arquivada" : ""}>
                  <td>{doc.title || "(sem título)"}</td>
                  <td data-rot="doc_id">
                    <span className="tcode">{doc.doc_id}</span>
                  </td>
                  <td data-rot="estado">
                    <span className={`tag ${arquivado ? "tag-arquivado" : "tag-ativo"}`}>{arquivado ? "arquivado" : "ativo"}</span>
                  </td>
                  <td className="num" data-rot="chunks">
                    {doc.chunks}
                  </td>
                  <td data-rot="atualizado">{fmtData(doc.updated_at)}</td>
                  <td className="acoes">
                    <span className="acoes-linha">
                      <button className="btn btn-sutil btn-mini" title="abrir no editor" aria-label="abrir no editor" onClick={() => onAbrirEditor(doc.doc_id)}>
                        abrir
                      </button>
                      <button className="btn btn-sutil btn-mini" title="baixar o arquivo original" aria-label="baixar o arquivo original" onClick={() => void baixarDoc(doc)}>
                        baixar
                      </button>
                      <button
                        className="btn btn-sutil btn-mini"
                        title="copiar o doc_id"
                        aria-label="copiar o doc_id"
                        onClick={() =>
                          void navigator.clipboard.writeText(doc.doc_id).then(
                            () => toast("doc_id copiado ✓"),
                            () => toast("copiar falhou — " + doc.doc_id),
                          )
                        }
                      >
                        ⧉
                      </button>
                      <button
                        className={`btn btn-sutil btn-mini ${arquivado ? "btn-reviver" : "btn-arquivar"}`}
                        title={arquivado ? "voltar a usar este documento" : "tirar da memória ativa (sem apagar)"}
                        aria-label={arquivado ? "reviver documento" : "arquivar documento"}
                        onClick={() => void alternarArquivado(doc)}
                      >
                        {arquivado ? "reviver" : "arquivar"}
                      </button>
                      <button className="btn btn-perigo btn-mini" title="apagar para sempre (chunks + fonte)" aria-label="apagar documento" onClick={() => void apagarDoc(doc)}>
                        apagar
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </section>
  );
}