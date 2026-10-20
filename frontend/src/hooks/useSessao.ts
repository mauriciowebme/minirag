import { useCallback, useState } from "react";
import { ApiErro, definirChave, get } from "../services/api";
import type { GavetasResp } from "../types";

const TTL_MS = 12 * 3600 * 1000; // sessão expira em 12h

export type Sessao = {
  nome: string;
  chave: string;
  operador: boolean;
  tenant: string;
  memoria: string;
};

const vazia: Sessao = { nome: "", chave: "", operador: false, tenant: "", memoria: "" };

function lerStorage(): Sessao {
  const chave = sessionStorage.getItem("mr_key") || "";
  const nome = sessionStorage.getItem("mr_nome") || "";
  const ts = Number(sessionStorage.getItem("mr_ts") || 0);
  if (!chave || !nome || Date.now() - ts >= TTL_MS) return vazia;
  definirChave(chave);
  return {
    nome,
    chave,
    operador: sessionStorage.getItem("mr_op") === "1",
    tenant: sessionStorage.getItem("mr_tenant") || nome,
    memoria: sessionStorage.getItem("mr_mem") || "",
  };
}

export function useSessao() {
  const [sessao, setSessao] = useState<Sessao>(vazia);
  const [restaurando, setRestaurando] = useState(() => !!sessionStorage.getItem("mr_key"));
  const [erro, setErro] = useState("");

  const guardar = useCallback((s: Sessao) => {
    definirChave(s.chave);
    sessionStorage.setItem("mr_nome", s.nome);
    sessionStorage.setItem("mr_key", s.chave);
    sessionStorage.setItem("mr_op", s.operador ? "1" : "0");
    sessionStorage.setItem("mr_tenant", s.tenant);
    sessionStorage.setItem("mr_mem", s.memoria);
    sessionStorage.setItem("mr_ts", String(Date.now()));
    setSessao(s);
  }, []);

  const entrar = useCallback(
    async (nome: string, chave: string): Promise<void> => {
      if (!nome || !chave) {
        setErro("preencha nome e segredo");
        return;
      }
      definirChave(chave);
      try {
        const g = await get<GavetasResp>("/gavetas");
        setErro("");
        guardar({ nome, chave, operador: !!g.operador, tenant: nome, memoria: "" });
      } catch (e) {
        setErro((e as Error).message);
        throw e;
      }
    },
    [guardar],
  );

  const restaurar = useCallback(async (): Promise<void> => {
    const s = lerStorage();
    if (!s.chave) {
      setRestaurando(false);
      setErro(sessionStorage.getItem("mr_key") ? "sessão passou de 12h — entre de novo" : "");
      sessionStorage.clear();
      return;
    }
    try {
      const g = await get<GavetasResp>("/gavetas");
      setSessao({ ...s, operador: !!g.operador, tenant: s.tenant || s.nome });
      setRestaurando(false);
    } catch {
      sessionStorage.clear();
      definirChave("");
      setSessao(vazia);
      setErro("sessão expirada ou chave inválida");
      setRestaurando(false);
    }
  }, []);

  const sair = useCallback((msg = "") => {
    sessionStorage.clear();
    definirChave("");
    setSessao(vazia);
    setErro(msg);
  }, []);

  const escopo = useCallback(
    (tenant: string, memoria: string) => {
      setSessao((s) => {
        const nova = { ...s, tenant, memoria };
        sessionStorage.setItem("mr_tenant", nova.tenant);
        sessionStorage.setItem("mr_mem", nova.memoria);
        return nova;
      });
    },
    [],
  );

  return { sessao, logado: !!sessao.chave, restaurando, erro, setErro, entrar, sair, escopo, restaurar } as const;
}

export type SessaoApi = ReturnType<typeof useSessao>;
export { ApiErro };