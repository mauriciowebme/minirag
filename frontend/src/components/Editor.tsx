import { useCallback, useEffect, useRef, useState } from "react";
import { get, patch, post, put, qs } from "../services/api";
import { fmtData } from "../lib/fmt";
import { mdParaHtml } from "../lib/md";
import { useToast } from "./Toast";
import type { DocCompleto, Escopo, JobStatus } from "../types";

export function Editor({
  escopo,
  operador,
  docId,
  novoNome,
  onFechar,
  onSalvo,
  onDirty,
}: {
  escopo: Escopo;
  operador: boolean;
  docId: string | null;
  novoNome?: string | null;
  onFechar: () => void;
  onSalvo: () => void;
  onDirty: (sujo: boolean) => void;
}) {
  const { toast } = useToast();
  const inicial = docId ?? novoNome ?? null;
  const [titulo, setTitulo] = useState(inicial || "");
  const [conteudo, setConteudo] = useState("");
  const [status, setStatus] = useState(docId ? "carregando…" : "nota nova");
  const [sujo, setSujo] = useState(false);
  const [previa, setPrevia] = useState(false);
  const [renomear, setRenomear] = useState(false);
  const [novoId, setNovoId] = useState("");
  const [novaGaveta, setNovaGaveta] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [idAtual, setIdAtual] = useState<string | null>(inicial);
  const [criando, setCriando] = useState(docId === null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!docId) {
      setTitulo(novoNome || "");
      setConteudo("");
      setStatus("nota nova");
      areaRef.current?.focus();
      return;
    }
    let vivo = true;
    (async () => {
      try {
        const d = await get<DocCompleto>(
          `/documents/${encodeURIComponent(docId)}?` + qs({ memoria: escopo.memoria, tenant: escopo.tenant }),
        );
        if (!vivo) return;
        setTitulo(d.title || "");
        setConteudo(d.content);
        setStatus(`fonte ${d.origem} · ${d.size_bytes} bytes · atualizado ${fmtData(d.atualizado_em)}`);
      } catch (e) {
        if (!vivo) return;
        setStatus("");
        setConteudo("");
        toast("sem fonte para abrir: " + (e as Error).message);
      }
      if (vivo) areaRef.current?.focus();
    })();
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  const marcarSujo = useCallback(
    (v: boolean) => {
      setSujo(v);
      onDirty(v);
    },
    [onDirty],
  );

  const palavras = conteudo.trim() ? conteudo.trim().split(/\s+/).length : 0;

  async function acompanhar(jobId: number) {
    for (let i = 0; i < 400; i++) {
      let st: JobStatus;
      try {
        st = await get<JobStatus>(`/ingest/${jobId}?` + qs({ tenant: operador ? escopo.tenant : "" }));
      } catch {
        break;
      }
      setStatus(`reindexando ${st.chunks_feitos}/${st.chunks_total} · ${st.status}`);
      if (st.status === "concluido") {
        setStatus("salvo e reindexado ✓");
        toast("salvo e reindexado ✓");
        onSalvo();
        break;
      }
      if (st.status === "erro") {
        toast("job com erro: " + (st.erro || "?"));
        break;
      }
      if (st.status === "cancelado") break;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  const salvar = useCallback(async () => {
    const alvo = idAtual;
    if (!alvo) return;
    if (!conteudo.trim()) {
      toast("conteúdo vazio");
      return;
    }
    setSalvando(true);
    try {
      let r: { job_id: number };
      if (criando) {
        r = await post<{ job_id: number }>("/ingest", {
          doc_id: alvo,
          title: titulo || alvo,
          content: conteudo,
          memoria: escopo.memoria,
          tenant: operador ? escopo.tenant : undefined,
        });
        setCriando(false);
      } else {
        r = await put<{ job_id: number }>(
          `/documents/${encodeURIComponent(alvo)}?` + qs({ memoria: escopo.memoria }),
          { content: conteudo, title: titulo || null, memoria: escopo.memoria, tenant: operador ? escopo.tenant : undefined },
        );
      }
      marcarSujo(false);
      void acompanhar(r.job_id);
    } catch (e) {
      toast("salvar: " + (e as Error).message);
    } finally {
      setSalvando(false);
    }
  }, [conteudo, criando, escopo, idAtual, marcarSujo, operador, titulo, toast]);

  const fechar = useCallback(() => {
    if (sujo && !confirm("descartar a edição não salva?")) return;
    marcarSujo(false);
    onFechar();
  }, [marcarSujo, onFechar, sujo]);

  useEffect(() => {
    function aoTeclar(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        fechar();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void salvar();
      }
    }
    document.addEventListener("keydown", aoTeclar);
    return () => document.removeEventListener("keydown", aoTeclar);
  }, [fechar, salvar]);

  async function aplicarRename() {
    if (!idAtual) return;
    if (!novoId.trim() && !novaGaveta.trim()) {
      toast("nada para mudar");
      return;
    }
    try {
      const r = await patch<{ doc_id: string; memoria: string; movido: boolean }>(
        `/documents/${encodeURIComponent(idAtual)}?` + qs({ memoria: escopo.memoria }),
        {
          novo_doc_id: novoId.trim() || null,
          destino_memoria: novaGaveta.trim() || null,
          tenant: operador ? escopo.tenant : undefined,
        },
      );
      toast(`ok: ${r.doc_id} → gaveta ${r.memoria || "(padrão)"}`);
      if (r.movido && r.memoria !== escopo.memoria) {
        marcarSujo(false);
        onFechar();
      } else {
        setIdAtual(r.doc_id);
        setRenomear(false);
        onSalvo();
      }
    } catch (e) {
      toast("renomear: " + (e as Error).message);
    }
  }

  return (
    <section>
      <div className="barra">
        <h2>
          Editor{" "}
          <span id="edOnde" className="sub2">
            {escopo.tenant ? `— 👤 ${escopo.tenant} ▸ gaveta ${escopo.memoria || "padrão"}` : "—"}
            {idAtual ? ` · ${idAtual}` : ""}
          </span>
        </h2>
        <span className="flex-1" />
        <span id="edStatus" className="sub2">
          {status}
        </span>
        <button id="btnPreview" className="btn btn-sutil" onClick={() => setPrevia((p) => !p)}>
          {previa ? "editar" : "prévia"}
        </button>
        <button id="btnRenomear" className="btn btn-sutil" disabled={!idAtual} onClick={() => setRenomear((v) => !v)}>
          renomear/mover
        </button>
        <button id="btnCancelarEd" className="btn btn-sutil" title="fechar o editor (Esc)" onClick={fechar}>
          fechar
        </button>
        <button
          id="btnSalvar"
          className="btn btn-primario"
          title="salvar e reindexar (Ctrl+S)"
          disabled={salvando}
          onClick={() => void salvar()}
        >
          {criando ? "criar & reindexar" : "salvar & reindexar"}
        </button>
      </div>

      {renomear && (
        <div id="edRenameBox" className="cartao mb-4">
          <div className="barra !mb-0">
            <label className="rotulo m-0">
              novo doc_id
              <input id="edNovoId" className="campo mt-[5px]" placeholder="vazio = manter" value={novoId} autoFocus onChange={(e) => setNovoId(e.target.value)} />
            </label>
            <label className="rotulo m-0">
              gaveta destino
              <input id="edNovaGaveta" className="campo mt-[5px]" placeholder="vazio = manter" value={novaGaveta} onChange={(e) => setNovaGaveta(e.target.value)} />
            </label>
            <button id="btnAplicarRename" className="btn btn-primario" onClick={() => void aplicarRename()}>
              aplicar
            </button>
            <button id="btnFecharRename" className="btn btn-sutil" onClick={() => setRenomear(false)}>
              cancelar
            </button>
          </div>
          <p className="mt-2 text-[12px] text-txt3">
            Instantâneo, sem reindexar. Gaveta nova é criada; id já usado no destino é recusado.
          </p>
        </div>
      )}

      <label className="rotulo">
        título
        <input
          id="edTitulo"
          className="campo mt-[5px]"
          value={titulo}
          onChange={(e) => {
            setTitulo(e.target.value);
            marcarSujo(true);
          }}
        />
      </label>

      {previa ? (
        <div id="edPreview" className="previa" dangerouslySetInnerHTML={{ __html: mdParaHtml(conteudo) }} />
      ) : (
        <textarea
          id="edConteudo"
          ref={areaRef}
          className="campo h-auto min-h-[52vh] resize-y p-3 font-mono text-[13px] leading-[1.6]"
          spellCheck={false}
          placeholder="conteúdo do arquivo…"
          value={conteudo}
          onChange={(e) => {
            setConteudo(e.target.value);
            marcarSujo(true);
          }}
        />
      )}

      <p className="mt-2 text-[12px] text-txt3">
        <span id="edConta">{palavras} palavras</span> · salvar manda para a fila: a busca continua respondendo a versão antiga até o
        reembedding terminar.
      </p>
    </section>
  );
}