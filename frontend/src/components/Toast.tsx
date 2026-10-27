import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

/* v3.25 (T025): o toast segue o gabarito do arquiteto
   (arquiteto-sistema/references/notificacoes.md): sucesso = verde + ícone,
   erro = vermelho + ícone, botão X fecha na hora, toasts empilham.
   O default "neutro" preserva o visual de hoje para call sites sem tipo. */

type Tipo = "neutro" | "sucesso" | "erro";
type Item = { id: number; msg: string; tipo: Tipo };
/* v3.25.1 (27/10): os nomes das variantes têm que aparecer COMO LITERAL no
   fonte — o Tailwind v3 só emite a regra do @layer components quando o nome
   aparece no scan de conteúdo. `toast-${tipo}` (interpolação) fazia as três
   variantes sumirem do CSS compilado: o toast de sucesso/erro ficava sem
   cor. Medido no build: .toast-sucesso/.toast-erro ausentes, DOM sem cor. */
const CLASSE_TIPO: Record<Tipo, string> = {
  neutro: "toast-neutro",
  sucesso: "toast-sucesso",
  erro: "toast-erro",
};
type Ctx = { toast: (msg: string, tipo?: Tipo, ms?: number) => void };
const ToastCtx = createContext<Ctx>({ toast: () => {} });

export function useToast(): Ctx {
  return useContext(ToastCtx);
}

function Ico({ tipo }: { tipo: Tipo }) {
  if (tipo === "sucesso")
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none">
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12.5 2.5 2.5 4.5-5" />
      </svg>
    );
  if (tipo === "erro")
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none">
        <path d="M12 3.5 2.5 20h19L12 3.5z" />
        <path d="M12 10v4.5" />
        <path d="M12 17.5h.01" />
      </svg>
    );
  return null;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [itens, setItens] = useState<Item[]>([]);
  const seq = useRef(0);

  const toast = useCallback((m: string, tipo: Tipo = "neutro", ms = 5000) => {
    const id = ++seq.current;
    // empilha (máx. 3 visíveis); cada um tem auto-hide próprio
    setItens((v) => [...v.slice(-2), { id, msg: m, tipo }]);
    window.setTimeout(() => setItens((v) => v.filter((x) => x.id !== id)), ms);
  }, []);

  const fechar = useCallback((id: number) => setItens((v) => v.filter((x) => x.id !== id)), []);

  const valor = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastCtx.Provider value={valor}>
      {children}
      <div id="toast" className="toast-pilha" role="status" aria-live="polite">
        {itens.map((x) => (
          <div key={x.id} className={`toast ${CLASSE_TIPO[x.tipo]}`}>
            <Ico tipo={x.tipo} />
            <span>{x.msg}</span>
            <button className="toast-x" aria-label="fechar aviso" onClick={() => fechar(x.id)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
