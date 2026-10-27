import { useEffect, useRef, useState } from "react";
import type { Tela } from "../types";

/**
 * v3.28 — a tela gerada é UMA caixa só, na conclusão.
 *
 * Pedido do dono (27/10): "não precisa gerar muitos frames pra isso, basta uma caixa
 * que vai escrever nela". Então a MESMA caixa faz o caminho inteiro:
 *   1) enquanto o modelo escreve o HTML, ela mostra o código nascendo letra por letra;
 *   2) quando a tela fica pronta, ela mesma vira o renderizado — sem bloco extra;
 *   3) no topo, as ações: ver código, baixar o .html e expandir.
 *
 * O iframe roda com `sandbox="allow-scripts"` e SEM `allow-same-origin`: o script da tela
 * funciona (clique, conta, desenho), mas não alcança o painel, o cookie de login nem o
 * armazenamento da sessão. É a fronteira que torna seguro mostrar código gerado.
 *
 * Fullscreen é um overlay próprio (não `requestFullscreen`): sobrevive ao Escape do
 * navegador e não some quando o painel é embutido.
 */
export function TelaGerada({
  tela,
  codigo,
  digitando,
}: {
  /** tela pronta (null enquanto o HTML ainda está sendo escrito) */
  tela: Tela | null;
  /** o HTML que chega em pedaços enquanto o modelo escreve (evento `codigo`) */
  codigo?: string;
  /** o turno ainda está vivo — controla o cursor e o rótulo "escrevendo a tela…" */
  digitando?: boolean;
}) {
  const [cheia, setCheia] = useState(false);
  const [verCodigo, setVerCodigo] = useState(false);
  const area = useRef<HTMLPreElement | null>(null);

  const pronto = tela !== null;
  const escrevendo = !pronto && Boolean(digitando);
  const html = tela?.html ?? codigo ?? "";
  const linhas = html ? html.split("\n").length : 0;

  /* Escape fecha a tela cheia — mesmo gesto de qualquer modal do painel */
  useEffect(() => {
    if (!cheia) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCheia(false);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [cheia]);

  /* acompanha a última linha escrita: o olho tem de estar onde a caneta está */
  useEffect(() => {
    const el = area.current;
    if (el && (escrevendo || verCodigo)) el.scrollTop = el.scrollHeight;
  }, [html, escrevendo, verCodigo]);

  /* quando fica pronto, volta para o renderizado (o código fica a um clique) */
  useEffect(() => {
    if (pronto) setVerCodigo(false);
  }, [pronto]);

  const baixar = () => {
    if (!tela) return;
    const url = URL.createObjectURL(new Blob([tela.html], { type: "text/html;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = (tela.titulo || "tela").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") + ".html";
    a.click();
    /* revogar só depois do clique: Safari cancela o download se a URL morre na hora */
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const quadro = (classe: string) => (
    <iframe
      className={"tela-quadro " + classe}
      title={tela?.titulo || "tela gerada"}
      sandbox="allow-scripts allow-modals allow-forms allow-popups"
      srcDoc={tela?.html ?? ""}
    />
  );

  const codigoNaCaixa = (
    <pre className="tela-codigo" ref={area} tabIndex={0} aria-label="código da tela">
      {html}
      {escrevendo && <span className="codigo-cursor" aria-hidden="true" />}
    </pre>
  );

  return (
    <div className={"tela-card" + (escrevendo ? " escrevendo" : "")} data-testid="telaCaixa">
      <div className="tela-topo">
        <span className="tela-ponto" aria-hidden="true" />
        <span className="tela-titulo" title={tela?.titulo}>
          {escrevendo ? "escrevendo a tela…" : tela?.titulo || "tela"}
        </span>
        <span className="tela-conta">
          {linhas} {linhas === 1 ? "linha" : "linhas"} · {html.length} caracteres
        </span>
        {pronto && (
          <span className="tela-acoes">
            <button
              className={"chat-acao-icone" + (verCodigo ? " tela-acao-on" : "")}
              aria-pressed={verCodigo}
              title={verCodigo ? "ver a tela" : "ver o código"}
              aria-label={verCodigo ? "ver a tela" : "ver o código"}
              onClick={() => setVerCodigo((v) => !v)}
            >
              {verCodigo ? "▦" : "</>"}
            </button>
            <button className="chat-acao-icone" title="baixar o .html" aria-label="baixar o html" onClick={baixar}>
              ↓
            </button>
            <button className="chat-acao-icone" title="expandir (tela cheia)" aria-label="expandir" onClick={() => setCheia(true)}>
              ⤢
            </button>
          </span>
        )}
      </div>
      {pronto ? (verCodigo ? codigoNaCaixa : quadro("embutida")) : codigoNaCaixa}
      {cheia && tela && (
        <div className="tela-cheia" role="dialog" aria-modal="true" onClick={() => setCheia(false)}>
          <div className="tela-cheia-caixa" onClick={(e) => e.stopPropagation()}>
            <div className="tela-topo">
              <span className="tela-titulo">{tela.titulo || "tela"}</span>
              <span className="tela-acoes">
                <button className="chat-acao-icone" title="baixar o .html" aria-label="baixar o html" onClick={baixar}>
                  ↓
                </button>
                <button className="chat-acao-icone" title="fechar (Esc)" aria-label="fechar" onClick={() => setCheia(false)}>
                  ✕
                </button>
              </span>
            </div>
            {quadro("cheia")}
          </div>
        </div>
      )}
    </div>
  );
}
