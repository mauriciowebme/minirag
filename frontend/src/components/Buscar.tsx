import { useState } from "react";
import { post } from "../services/api";
import { useToast } from "./Toast";
import type { Escopo, SearchResp } from "../types";

export function Buscar({
  escopo,
  operador,
  onAbrirEditor,
}: {
  escopo: Escopo;
  operador: boolean;
  onAbrirEditor: (docId: string) => void;
}) {
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [k, setK] = useState(8);
  const [score, setScore] = useState(0.55);
  const [arquivados, setArquivados] = useState(false);
  const [resp, setResp] = useState<SearchResp | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [rodou, setRodou] = useState(false);

  async function buscar() {
    if (!q.trim()) return;
    setBuscando(true);
    setRodou(true);
    try {
      const r = await post<SearchResp>("/search", {
        query: q.trim(),
        k,
        min_score: score,
        memoria: escopo.memoria,
        include_archived: arquivados,
        tenant: operador ? escopo.tenant : undefined,
      });
      setResp(r);
    } catch (e) {
      setResp(null);
      toast("busca: " + (e as Error).message);
    } finally {
      setBuscando(false);
    }
  }

  return (
    <section>
      <h2>
        Testar busca semântica{" "}
        <span id="busOnde" className="sub2">
          — {escopo.tenant || "—"} : {escopo.memoria || "(padrão)"}
        </span>
      </h2>

      <div className="barra mt-3.5">
        <input
          id="busQuery"
          className="campo flex-1"
          placeholder="pergunta em linguagem natural…"
          aria-label="pergunta"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void buscar()}
        />
        <button id="btnBuscar" className="btn btn-primario" disabled={buscando} onClick={() => void buscar()}>
          {buscando ? "buscando…" : "buscar"}
        </button>
      </div>

      <div className="faixa">
        <label className="flex items-center gap-2 text-[13px] text-txt2">
          k
          <input
            type="number"
            id="busK"
            min={1}
            max={50}
            className="campo w-[72px]"
            value={k}
            onChange={(e) => setK(Number(e.target.value) || 8)}
          />
        </label>
        <label className="flex items-center gap-2 text-[13px] text-txt2">
          score mínimo
          <input
            type="range"
            id="busScore"
            min={0}
            max={1}
            step={0.05}
            value={score}
            className="accent-verde"
            onChange={(e) => setScore(Number(e.target.value))}
          />
          <output id="busScoreOut" className="w-9 font-mono text-[12.5px] text-txt3">
            {score.toFixed(2)}
          </output>
        </label>
        <label className="check">
          <input type="checkbox" id="busArq" checked={arquivados} onChange={(e) => setArquivados(e.target.checked)} />
          incluir arquivados (achar revive)
        </label>
      </div>

      <div id="busResultado">
        {rodou && resp && (
          <p className="dica">
            {resp.total} resultado(s){arquivados ? " · arquivados achados foram revividos" : ""}
          </p>
        )}
        {rodou && resp && resp.total === 0 && (
          <div className="vazio">
            <div className="tit">Nada acima de {score.toFixed(2)}</div>
            Baixe o score mínimo — o texto pode estar lá, só fora do corte.
          </div>
        )}
        {resp?.items.map((it) => (
          <div key={it.chunk_id} className="hit">
            <div className="topo-hit">
              <span className="score">{it.score.toFixed(3)}</span>
              <b className="t">{it.title || it.doc_id}</b>
              <span className="meta">
                {it.doc_id}
                {it.arquivado ? " · estava arquivado" : ""}
              </span>
              <button className="btn btn-sutil btn-mini abrir-doc ml-auto" onClick={() => onAbrirEditor(it.doc_id)}>
                abrir
              </button>
            </div>
            <p className="x">{it.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}