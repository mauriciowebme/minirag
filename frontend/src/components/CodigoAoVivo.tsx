import { useEffect, useRef, useState } from "react";

/**
 * v3.24 — o código da tela nascendo na tela.
 *
 * Pedido do dono (27/10): "queria muito poder ver o streaming digitando o código do
 * preview, do jeito que está eu não vejo". O modelo escreve o HTML da tela dentro dos
 * argumentos da ferramenta; o servidor manda esses pedaços no evento `codigo` e aqui
 * eles aparecem letra por letra, com o cursor piscando no fim — igual ao streaming da
 * resposta. Quando a tela fica pronta, o bloco recolhe sozinho e o card com o preview
 * funcional assume; "ver código" reabre para conferir o que foi escrito.
 */
export function CodigoAoVivo({ texto, digitando }: { texto: string; digitando: boolean }) {
  /* aberto enquanto escreve; recolhido quando termina (o card do preview toma o lugar) */
  const [aberto, setAberto] = useState(digitando);
  const area = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    setAberto(digitando);
  }, [digitando]);

  /* acompanha a última linha escrita: o olho tem de estar onde a caneta está */
  useEffect(() => {
    const el = area.current;
    if (!el || !aberto) return;
    el.scrollTop = el.scrollHeight;
  }, [texto, aberto]);

  const linhas = texto ? texto.split("\n").length : 0;

  return (
    <div className={"codigo-vivo" + (digitando ? " vivo" : "")} id="codigoVivo">
      <button
        type="button"
        className="codigo-topo"
        onClick={() => setAberto((v) => !v)}
        aria-expanded={aberto}
        title={aberto ? "esconder o código" : "ver o código"}
      >
        <span className="codigo-ponto" aria-hidden="true" />
        <span className="codigo-rotulo">{digitando ? "escrevendo a tela…" : "código da tela"}</span>
        <span className="codigo-conta">
          {linhas} {linhas === 1 ? "linha" : "linhas"} · {texto.length} caracteres
        </span>
        <span className="codigo-seta" aria-hidden="true">
          {aberto ? "▾" : "▸"}
        </span>
      </button>
      {aberto && (
        <pre className="codigo-area" ref={area} tabIndex={0} aria-label="código da tela">
          {texto}
          {digitando && <span className="codigo-cursor" aria-hidden="true" />}
        </pre>
      )}
    </div>
  );
}
