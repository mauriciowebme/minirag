import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

type Ctx = { toast: (msg: string, ms?: number) => void };
const ToastCtx = createContext<Ctx>({ toast: () => {} });

export function useToast(): Ctx {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState("");
  const [ver, setVer] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const toast = useCallback((m: string, ms = 3500) => {
    setMsg(m);
    setVer(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setVer(false), ms);
  }, []);

  const valor = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastCtx.Provider value={valor}>
      {children}
      <div id="toast" role="status" aria-live="polite" className={`toast ${ver ? "toast-ver" : ""}`}>
        {msg}
      </div>
    </ToastCtx.Provider>
  );
}