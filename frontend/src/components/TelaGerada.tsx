import { useEffect, useState } from "react";
import type { Tela } from "../types";

/**
 * v3.23 — a tela que o agente escreveu (HTML + CSS + JS) funcionando dentro do chat.
 *
 * Pedido do dono (26/10): "o agente gera o HTML e eu vejo o resultado funcionando, clicando".
 * O iframe roda com `sandbox="allow-scripts"` e SEM `allow-same-origin`: o script da tela
 * funciona (clique, conta, desenho), mas não alcança o painel, o cookie de login nem o
 * armazenamento da sessão. É a fronteira que torna seguro mostrar código gerado.
 *
 * Fullscreen é um overlay próprio (não `requestFullscreen`): sobrevive ao Escape do
 * navegador e não some quando o painel é embutido.
 */
export function TelaGerada({ tela }: { tela: Tela }) {
  const [cheia, setCheia] = useState(false);

  /* Escape fecha a tela cheia — mesmo gesto de qualquer modal do painel */
  useEffect(() => {
    if (!cheia) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCheia(false);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [cheia]);

  const baixar = () => {
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
      title={tela.titulo || "tela gerada"}
      sandbox="allow-scripts allow-modals allow-forms allow-popups"
      srcDoc={tela.html}
    />
  );

  return (
    <div className="tela-card">
      <div className="tela-topo">
        <span className="tela-titulo" title={tela.titulo}>
          {tela.titulo || "tela"}
        </span>
        <span className="tela-acoes">
          <button className="chat-acao-icone" title="abrir em tela cheia" aria-label="abrir em tela cheia" onClick={() => setCheia(true)}>
            ⤢
          </button>
          <button className="chat-acao-icone" title="baixar o .html" aria-label="baixar o html" onClick={baixar}>
            ↓
          </button>
        </span>
      </div>
      {quadro("embutida")}
      {cheia && (
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
