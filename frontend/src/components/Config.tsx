import { useCallback, useEffect, useState } from "react";
import { get, post, put, qs } from "../services/api";
import { useToast } from "./Toast";
import type { ConfigResp, HealthResp, ProviderResp } from "../types";

type Aba = "provider" | "conta" | "limites" | "esquecimento" | "sistema";

/** Configurações: provider do chat, conta, limites, esquecimento e sistema. */
export function Config({
  nome,
  operador,
  tenant,
  onChaveNova,
  onIrPainel,
}: {
  nome: string;
  operador: boolean;
  tenant: string;
  onChaveNova: (chave: string) => void;
  onIrPainel: () => void;
}) {
  const [aba, setAba] = useState<Aba>("provider");

  return (
    <section className="flex flex-col gap-3" id="telaConfig">
      <div className="barra">
        <h2>
          Configurações <span className="sub2">— provider do chat, conta e limites</span>
        </h2>
      </div>
      <div className="grade-cfg">
        <nav className="cfg-nav" id="cfgNav">
          {(
            [
              ["provider", "Provider do chat"],
              ["conta", "Conta e chave"],
              ["limites", "Limites"],
              ["esquecimento", "Esquecimento"],
              ["sistema", "Sistema"],
            ] as [Aba, string][]
          ).map(([id, rotulo]) => (
            <button key={id} className={"cfg-item" + (aba === id ? " cfg-item-on" : "")} data-cfg={id} onClick={() => setAba(id)}>
              {rotulo}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {aba === "provider" && <Provider operador={operador} tenant={tenant} onIrPainel={onIrPainel} />}
          {aba === "conta" && <Conta nome={nome} operador={operador} onChaveNova={onChaveNova} />}
          {aba === "limites" && <Limites />}
          {aba === "esquecimento" && <Esquecimento />}
          {aba === "sistema" && <Sistema />}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- provider */

function Provider({ operador, tenant, onIrPainel }: { operador: boolean; tenant: string; onIrPainel: () => void }) {
  const { toast } = useToast();
  const [p, setP] = useState<ProviderResp | null>(null);
  const [tipo, setTipo] = useState<"litellm" | "openai" | "ollama">("litellm");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelo, setModelo] = useState("");
  const [chave, setChave] = useState("");
  const [temperatura, setTemperatura] = useState("0.2");
  const [trechos, setTrechos] = useState("6");
  const [ativo, setAtivo] = useState(false);
  const [global, setGlobal] = useState(false);
  const [teste, setTeste] = useState<{ ok: boolean; msg: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const r = await get<ProviderResp>("/config/provider" + (operador && tenant ? "?" + qs({ tenant }) : ""));
      setP(r);
      setTipo(r.tipo);
      setBaseUrl(r.base_url);
      setModelo(r.modelo);
      setTemperatura(String(r.temperatura));
      setTrechos(String(r.trechos));
      setAtivo(r.configurado || r.ativo);
      setChave("");
    } catch (e) {
      toast("provider: " + (e as Error).message);
    }
  }, [operador, tenant, toast]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  function corpo(extra: Record<string, unknown> = {}) {
    return {
      tipo,
      base_url: baseUrl,
      modelo,
      temperatura: Number(temperatura),
      trechos: Number(trechos),
      ativo,
      global,
      ...(chave ? { chave } : {}),
      ...extra,
    };
  }

  async function testar() {
    setOcupado(true);
    setTeste(null);
    try {
      const r = await post<{ ok: boolean; ms: number; modelo: string }>("/config/provider/testar", corpo());
      setTeste({ ok: true, msg: `conexão ok · respondeu em ${r.ms} ms · modelo ${r.modelo}` });
    } catch (e) {
      setTeste({ ok: false, msg: (e as Error).message });
    } finally {
      setOcupado(false);
    }
  }

  async function salvar() {
    setOcupado(true);
    try {
      const r = await put<ProviderResp>("/config/provider", corpo());
      setP(r);
      setChave("");
      toast("provider salvo");
    } catch (e) {
      toast("salvar: " + (e as Error).message);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="cartao">
      <h2 className="mb-3 text-[13px] font-semibold text-txt2">
        Provider do chat <span className="sub2">— usado nas respostas do Chat</span>
      </h2>
      <div className="flex max-w-[620px] flex-col gap-3" id="formProvider">
        <div className="grade-2 !gap-3">
          <label className="rotulo m-0">
            tipo
            <select className="campo mt-1" value={tipo} onChange={(e) => setTipo(e.target.value as typeof tipo)}>
              <option value="litellm">LiteLLM (OpenAI compatível)</option>
              <option value="openai">OpenAI</option>
              <option value="ollama">Ollama local</option>
            </select>
          </label>
          <label className="rotulo m-0">
            modelo
            <input id="provModelo" className="campo mt-1" value={modelo} placeholder="ex.: claude-sonnet-4.5" onChange={(e) => setModelo(e.target.value)} />
          </label>
        </div>
        <label className="rotulo m-0">
          URL base
          <input id="provUrl" className="campo mt-1 mono" value={baseUrl} placeholder="https://litellm.exemplo.com/v1" onChange={(e) => setBaseUrl(e.target.value)} />
          <span className="dica mt-1 block">sem /chat/completions no fim — o sistema completa</span>
        </label>
        <label className="rotulo m-0">
          chave da API
          <input
            id="provChave"
            type="password"
            className="campo mt-1 mono"
            value={chave}
            placeholder={p?.tem_chave ? `${p.chave_mascarada} (deixe vazio para manter)` : "cole a chave do provider"}
            onChange={(e) => setChave(e.target.value)}
            autoComplete="new-password"
          />
          <span className="dica mt-1 block">guardada no servidor; a tela só vê os 4 últimos caracteres</span>
        </label>
        <div className="grade-2 !gap-3">
          <label className="rotulo m-0">
            temperatura
            <input className="campo mt-1" value={temperatura} onChange={(e) => setTemperatura(e.target.value)} />
          </label>
          <label className="rotulo m-0">
            trechos enviados ao modelo
            <input className="campo mt-1" value={trechos} onChange={(e) => setTrechos(e.target.value)} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-borda pt-3">
          <label className="check">
            <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} /> usar este provider no chat
          </label>
          {operador && (
            <label className="check">
              <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} /> gravar como padrão de todos
            </label>
          )}
          <span className="flex-1" />
          <button id="provTestar" className="btn" disabled={ocupado} onClick={() => void testar()}>
            testar conexão
          </button>
          <button id="provSalvar" className="btn btn-primario" disabled={ocupado} onClick={() => void salvar()}>
            salvar
          </button>
        </div>
        {teste && (
          <p className={teste.ok ? "text-[13px] text-verde" : "text-[13px] text-vermelho"} id="provTesteResultado">
            {teste.ok ? "✓ " : "✕ "}
            {teste.msg}
          </p>
        )}
        {p && !p.configurado && (
          <div className="aviso">
            <span>Sem provider o Chat fica desligado — a Busca continua funcionando normalmente.</span>
          </div>
        )}
        {p?.configurado && (
          <button className="btn btn-sutil self-start" onClick={onIrPainel}>
            ver no painel
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- conta */

function Conta({ nome, operador, onChaveNova }: { nome: string; operador: boolean; onChaveNova: (c: string) => void }) {
  const { toast } = useToast();
  const [nova, setNova] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  async function gerar() {
    if (!confirm("gerar chave nova? a chave atual para de funcionar na hora.")) return;
    setOcupado(true);
    try {
      const r = await post<{ chave: string; aviso: string }>(`/usuarios/${encodeURIComponent(nome)}/chave`);
      setNova(r.chave);
      onChaveNova(r.chave);
      toast("chave trocada — guarde a nova");
    } catch (e) {
      toast("chave: " + (e as Error).message);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="cartao">
      <h2 className="mb-3 text-[13px] font-semibold text-txt2">Conta e chave</h2>
      <div className="flex max-w-[520px] flex-col gap-3">
        <div className="it-linha">
          <span className="sub2">usuário</span>
          <b>{nome}</b>
        </div>
        <div className="it-linha">
          <span className="sub2">papel</span>
          <span>{operador ? "operador (vê tudo)" : "usuário"}</span>
        </div>
        <div className="it-linha">
          <span className="sub2">chave</span>
          <span className="mono">•••••••• (guardada com hash — não é possível mostrar)</span>
        </div>
        <div className="flex gap-2 border-t border-borda pt-3">
          <button id="btnNovaChave" className="btn" disabled={ocupado} onClick={() => void gerar()}>
            gerar chave nova
          </button>
        </div>
        {nova && (
          <div className="aviso" id="chaveNova">
            <div>
              <b>guarde agora — não aparece de novo:</b>
              <div className="mono mt-1 select-all break-all">{nova}</div>
            </div>
            <button
              className="btn btn-mini ml-auto"
              onClick={() => {
                void navigator.clipboard?.writeText(nova);
                toast("chave copiada");
              }}
            >
              copiar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- limites */

function Limites() {
  const { toast } = useToast();
  const [c, setC] = useState<ConfigResp | null>(null);

  useEffect(() => {
    void get<ConfigResp>("/config")
      .then(setC)
      .catch((e) => toast("config: " + (e as Error).message));
  }, [toast]);

  if (!c) return <div className="cartao dica">carregando…</div>;
  const l = c.limites;
  return (
    <div className="cartao">
      <h2 className="mb-3 text-[13px] font-semibold text-txt2">Limites em vigor</h2>
      <table className="tabela">
        <tbody>
          <tr><td>Tamanho de um documento</td><td><b>{l.max_content_chars.toLocaleString("pt-BR")}</b> caracteres</td></tr>
          <tr><td>Tamanho da pergunta</td><td><b>{l.max_query_chars.toLocaleString("pt-BR")}</b> caracteres</td></tr>
          <tr><td>Trechos por usuário (cota)</td><td><b>{l.max_chunks_tenant.toLocaleString("pt-BR")}</b></td></tr>
          <tr><td>Trechos por busca (padrão)</td><td><b>{l.top_k}</b></td></tr>
          <tr><td>Similaridade mínima</td><td><b>{l.min_score}</b></td></tr>
          <tr><td>Pedaço do documento</td><td><b>{l.chunk_palavras}</b> palavras ({l.chunk_sobreposicao} de sobreposição)</td></tr>
          <tr><td>Páginas por PDF escaneado</td><td><b>{l.ocr_paginas_max}</b></td></tr>
        </tbody>
      </table>
      <p className="dica mt-3 mb-0">estes números vêm do ambiente do servidor; para mudar, ajuste as variáveis e o operador redeploya</p>
    </div>
  );
}

/* ---------------------------------------------------------- esquecimento */

function Esquecimento() {
  const { toast } = useToast();
  const [c, setC] = useState<ConfigResp | null>(null);
  const [rodando, setRodando] = useState(false);

  useEffect(() => {
    void get<ConfigResp>("/config")
      .then(setC)
      .catch((e) => toast("config: " + (e as Error).message));
  }, [toast]);

  async function rodar() {
    setRodando(true);
    try {
      const r = await post<{ docs_arquivados_agora: number }>("/decay", {});
      toast(`arquivados agora: ${r.docs_arquivados_agora}`);
    } catch (e) {
      toast("esquecimento: " + (e as Error).message);
    } finally {
      setRodando(false);
    }
  }

  if (!c) return <div className="cartao dica">carregando…</div>;
  const e = c.esquecimento;
  return (
    <div className="cartao">
      <h2 className="mb-3 text-[13px] font-semibold text-txt2">Arquivar esquecidos</h2>
      <div className="flex max-w-[560px] flex-col gap-3">
        <div className="it-linha"><span className="sub2">situação</span><b>{e.ativo ? "ligado" : "desligado"}</b></div>
        <div className="it-linha"><span className="sub2">arquiva depois de</span><b>{e.dias} dias sem acesso</b></div>
        <div className="it-linha"><span className="sub2">exige menos de</span><b>{e.min_acessos} acessos</b></div>
        <div className="it-linha"><span className="sub2">verifica a cada</span><b>{e.intervalo_minutos} minutos</b></div>
        <p className="dica m-0">arquivar não apaga: o documento pode ser revivido na busca com “mostrar arquivados”.</p>
        <button id="btnRodarDecay" className="btn self-start" disabled={rodando} onClick={() => void rodar()}>
          arquivar esquecidos agora
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- sistema */

function Sistema() {
  const { toast } = useToast();
  const [h, setH] = useState<HealthResp | null>(null);
  const [c, setC] = useState<ConfigResp | null>(null);

  useEffect(() => {
    void get<HealthResp>("/health").then(setH).catch((e) => toast("health: " + (e as Error).message));
    void get<ConfigResp>("/config").then(setC).catch(() => undefined);
  }, [toast]);

  return (
    <div className="cartao">
      <h2 className="mb-3 text-[13px] font-semibold text-txt2">Sistema</h2>
      <div className="saude max-w-[520px]">
        <div className="it"><span className={"dot" + (h?.embedder === "ok" ? "" : " ruim")} /> motor de busca<span className="v">{h?.embedder ?? "?"}</span></div>
        <div className="it"><span className="dot" /> versão<span className="v mono">{h?.versao ?? c?.versao ?? "?"}</span></div>
        <div className="it"><span className="dot cinza" /> modelo de embedding<span className="v mono">{c?.modelo_embedding ?? "?"}</span></div>
      </div>
    </div>
  );
}