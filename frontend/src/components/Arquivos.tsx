import { useCallback, useEffect, useRef, useState } from "react";
import { baixar, del, enviar, get, patch, qs } from "../services/api";
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
  /** doc que vai receber a versão nova (input de substituição) */
  const [substituindo, setSubstituindo] = useState<string | null>(null);
  const inputVersao = useRef<HTMLInputElement>(null);
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

  async function subir(lista: File[], docAlvo?: string) {
    if (!lista.length) return;
    let ok = 0;
    let falha = 0;
    for (const f of lista) {
      const alvo = docAlvo ?? "";
      try {
        const form = new FormData();
        form.append("arquivo", f, f.name);
        form.append("memoria", escopo.memoria);
        if (operador) form.append("tenant", escopo.tenant);
        if (alvo) form.append("doc_id", alvo);
        const r = await enviar<{
          doc_id: string;
          substituiu: boolean;
          job_id: number;
          chunks_total: number;
          tipo: string;
          editavel_na_tela: boolean;
        }>("/arquivos", form);
        ok++;
        const dica = r.editavel_na_tela
          ? ""
          : ` · ${r.tipo.toUpperCase()}: para editar, baixe o original, altere e suba de novo`;
        toast(
          (r.substituiu
            ? `♻ ${f.name}: substituiu "${r.doc_id}" — reindexando (job ${r.job_id})`
            : `⬆ ${f.name} (${r.tipo}): na fila — job ${r.job_id}, ${r.chunks_total} chunk[s]`) + dica,
          6000,
        );
      } catch (e) {
        falha++;
        toast(`⬆ ${f.name}: ${(e as Error).message}`, 7000);
      }
    }
    if (lista.length > 1) toast(`upload: ${ok} enviado(s), ${falha} com erro`, 5000);
    /* o documento só passa a aparecer quando o worker cria a linha: recarrega
       agora e mais algumas vezes até a fila andar (senão a gaveta parece vazia) */
    const recarregar = () => void carregar(filtroRef.current, mostrarArq);
    recarregar();
    if (ok) for (const ms of [2500, 6000, 12000]) window.setTimeout(recarregar, ms);
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
    const orig = doc.arquivo;
    try {
      if (orig) {
        await baixar(
          `/documents/${encodeURIComponent(doc.doc_id)}/arquivo?` +
            qs({ memoria: escopo.memoria, tenant: escopo.tenant }),
          orig.nome || `${slug(doc.doc_id)}.${orig.tipo || "bin"}`,
        );
      } else {
        await baixar(
          `/documents/${encodeURIComponent(doc.doc_id)}/raw?` + qs({ memoria: escopo.memoria, tenant: escopo.tenant }),
          slug(doc.doc_id) + ".txt",
        );
      }
    } catch (e) {
      toast((e as Error).message, 6000);
    }
  }

  /** abre o seletor de arquivo para substituir ESTE documento (mesmo doc_id = substitui) */
  function pedirVersao(doc: DocItem) {
    setSubstituindo(doc.doc_id);
    inputVersao.current?.click();
  }

  function tamanhoLegivel(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
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
        <label className="btn" title="enviar um ou vários arquivos (pdf, docx, xlsx, csv, html, txt, md)">
          ⬆ upload
          <input
            type="file"
            id="arquivoInput"
            accept=".pdf,.docx,.xlsx,.csv,.html,.htm,.txt,.md,.markdown"
            multiple
            hidden
            ref={inputRef}
            onChange={(e) => {
              const lista = Array.from(e.target.files || []);
              const alvoInput = e.target;
              void subir(lista).finally(() => {
                alvoInput.value = "";
              });
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
        <b>⬆</b> arraste pdf, docx, xlsx, csv, html, txt ou md — ou clique para escolher
        <span className="mt-1 block text-[12px] text-txt3">
          o arquivo original fica guardado; subir o mesmo nome substitui e reprocessa
        </span>
      </div>

      <input
        type="file"
        id="versaoInput"
        hidden
        ref={inputVersao}
        accept=".pdf,.docx,.xlsx,.csv,.html,.htm,.txt,.md,.markdown"
        onChange={(e) => {
          const lista = Array.from(e.target.files || []);
          const alvo = substituindo;
          const alvoInput = e.target;
          setSubstituindo(null);
          const fim = () => {
            alvoInput.value = "";
          };
          if (alvo) void subir(lista, alvo).finally(fim);
          else fim();
        }}
      />

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
                {filtro.trim()
                  ? "nenhum arquivo com esse filtro"
                  : "gaveta vazia — use nova nota, arraste arquivos acima ou marque \"mostrar arquivados\""}
              </td>
            </tr>
          )}
          {!carregando &&
            docs.map((doc) => {
              const arquivado = doc.chunks_arquivados > 0;
              return (
                <tr key={doc.doc_id} className={arquivado ? "arquivada" : ""}>
                  <td>
                    <div>{doc.title || "(sem título)"}</div>
                    {doc.arquivo && (
                      <div className="mt-0.5 text-[12px] text-txt3">
                        <span className="chip mr-1">{(doc.arquivo.ext || doc.arquivo.tipo).toUpperCase()}</span>
                        {doc.arquivo.nome} · {tamanhoLegivel(doc.arquivo.tamanho)}
                      </div>
                    )}
                  </td>
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
                      {(!doc.arquivo || doc.arquivo.editavel) ? (
                        <button
                          className="btn btn-sutil btn-mini"
                          title="editar o texto na tela e reindexar"
                          aria-label="abrir no editor"
                          onClick={() => onAbrirEditor(doc.doc_id)}
                        >
                          abrir
                        </button>
                      ) : (
                        <button
                          className="btn btn-sutil btn-mini"
                          title="baixar o original, editar na sua máquina e usar 'nova versão'"
                          aria-label="baixar o arquivo original"
                          onClick={() => void baixarDoc(doc)}
                        >
                          ⬇ original
                        </button>
                      )}
                      {doc.arquivo && (
                        <button
                          className="btn btn-sutil btn-mini"
                          title="subir uma versão nova deste documento (substitui e reprocessa)"
                          aria-label="subir nova versão"
                          onClick={() => pedirVersao(doc)}
                        >
                          ⬆ versão
                        </button>
                      )}
                      {!doc.arquivo && (
                        <button className="btn btn-sutil btn-mini" title="baixar o texto" aria-label="baixar o texto" onClick={() => void baixarDoc(doc)}>
                          baixar
                        </button>
                      )}
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