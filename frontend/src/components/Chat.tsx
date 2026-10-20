import { useCallback, useEffect, useRef, useState } from "react";
import { del, get, post, qs } from "../services/api";
import { useToast } from "./Toast";
import type { ChamadaFerramenta, ChatHistorico, ChatResp, GavetasResp, ProviderResp } from "../types";

type Msg = { papel: "user" | "assistant"; texto: string; ferramentas: ChamadaFerramenta[]; aviso?: string | null; id?: number };

/** Chat: conversa com o provider; as ferramentas vêm do MCP ligado e ficam registradas na mensagem. */
export function Chat({
  escopo,
  operador,
  onIrConfig,
}: {
  escopo: { tenant: string; memoria: string };
  operador: boolean;
  onIrConfig: () => void;
}) {
  const { toast } = useToast();
  const [gavetas, setGavetas] = useState<string[]>([""]);
  const [memoria, setMemoria] = useState(escopo.memoria);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [pergunta, setPergunta] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [provider, setProvider] = useState<ProviderResp | null>(null);
  const fim = useRef<HTMLDivElement>(null);

  const tenantParams = operador && escopo.tenant ? { tenant: escopo.tenant } : {};

  useEffect(() => {
    setMemoria(escopo.memoria);
  }, [escopo.memoria]);

  useEffect(() => {
    void (async () => {
      try {
        const g = await get<GavetasResp>("/gavetas" + (escopo.tenant ? "?" + qs({ tenant: escopo.tenant }) : ""));
        const nomes = [...new Set(g.gavetas.map((x) => x.memoria))];
        setGavetas(nomes.length ? nomes : [""]);
      } catch {
        /* segue com a gaveta padrão */
      }
      try {
        setProvider(await get<ProviderResp>("/config/provider" + (Object.keys(tenantParams).length ? "?" + qs(tenantParams) : "")));
      } catch {
        setProvider(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [escopo.tenant]);

  const carregarHistorico = useCallback(async () => {
    try {
      const h = await get<ChatHistorico>("/chat?" + qs({ memoria, ...tenantParams }));
      setMsgs(h.mensagens.map((m) => ({ id: m.id, papel: m.papel, texto: m.texto, ferramentas: m.ferramentas ?? [] })));
    } catch (e) {
      toast("histórico: " + (e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoria, escopo.tenant, operador, toast]);

  useEffect(() => {
    void carregarHistorico();
  }, [carregarHistorico]);

  useEffect(() => {
    fim.current?.scrollIntoView({ block: "end" });
  }, [msgs.length, enviando]);

  async function enviar() {
    const texto = pergunta.trim();
    if (!texto || enviando) return;
    setPergunta("");
    setMsgs((m) => [...m, { papel: "user", texto, ferramentas: [] }]);
    setEnviando(true);
    try {
      const r = await post<ChatResp>("/chat", { pergunta: texto, memoria, ...tenantParams });
      setMsgs((m) => [...m, { papel: "assistant", texto: r.resposta, ferramentas: r.ferramentas ?? [], aviso: r.aviso }]);
      setProvider((p) => (p ? { ...p, configurado: true } : p));
    } catch (e) {
      const err = e as Error;
      setMsgs((m) => [...m, { papel: "assistant", texto: "não consegui responder: " + err.message, ferramentas: [] }]);
      if (err.message.includes("provider")) setProvider((p) => (p ? { ...p, configurado: false } : p));
    } finally {
      setEnviando(false);
    }
  }

  async function limpar() {
    if (!confirm("apagar a conversa desta gaveta?")) return;
    try {
      await del("/chat?" + qs({ memoria, ...tenantParams }));
      setMsgs([]);
      toast("conversa apagada");
    } catch (e) {
      toast("apagar: " + (e as Error).message);
    }
  }

  const semProvider = provider && !provider.configurado;
  const semFerramenta = provider && provider.configurado && !provider.mcp_interno;

  return (
    <section className="flex flex-col gap-3" id="telaChat">
      <div className="barra">
        <h2>
          Chat <span className="sub2">— conversa com o modelo e as ferramentas do MCP</span>
        </h2>
        <span className="flex-1" />
        <label className="sub2 flex items-center gap-2">
          gaveta
          <select className="campo !h-8 !w-auto" value={memoria} onChange={(e) => setMemoria(e.target.value)}>
            {gavetas.map((g) => (
              <option key={g} value={g}>
                {g || "padrão"}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-sutil" title="apagar esta conversa" onClick={() => void limpar()}>
          limpar
        </button>
      </div>

      {semProvider && (
        <div className="aviso" id="avisoProvider">
          <span>Chat desligado: nenhum provider configurado. A Busca continua funcionando.</span>
          <button className="btn btn-mini ml-auto" onClick={onIrConfig}>
            configurar agora
          </button>
        </div>
      )}

      <div className="cartao flex min-h-[62vh] flex-col gap-0 p-0">
        <div className="flex-1 overflow-auto p-4" id="chatMsgs">
          {msgs.length === 0 && !enviando && (
            <p className="dica">
              {semFerramenta
                ? "nenhuma ferramenta ligada — o modelo responde só com o que sabe (ligue MCP em Configurações → Ferramentas)"
                : "pergunte o que quiser; o que ele chamar de ferramenta aparece registrado embaixo da resposta"}
            </p>
          )}
          {msgs.map((m, i) => (
            <div key={m.id ?? i} className={"msg " + (m.papel === "user" ? "msg-eu" : "msg-ia")}>
              {m.texto}
              {m.ferramentas.length > 0 && (
                <details className="fontes" open={false}>
                  <summary className="fonte">
                    ferramentas chamadas · {m.ferramentas.length} ({m.ferramentas.map((f) => (f.servidor === "minirag" ? "" : f.servidor + "·") + f.nome).join(", ")})
                  </summary>
                  {m.ferramentas.map((f, j) => (
                    <div className="fonte" key={j}>
                      <b>{f.servidor === "minirag" ? "minirag" : f.servidor} · {f.nome}</b> {f.ok ? "✓" : "✕"} · {f.ms} ms
                      <div className="mono break-all">{JSON.stringify(f.args)}</div>
                      <div className="sub2 break-all">{f.resumo}</div>
                    </div>
                  ))}
                </details>
              )}
              {m.aviso && <div className="sub2 mt-1">aviso: {m.aviso}</div>}
            </div>
          ))}
          {enviando && <div className="msg msg-ia">pensando…</div>}
          <div ref={fim} />
        </div>
        <div className="flex gap-2 border-t border-borda p-3">
          <input
            id="chatPergunta"
            className="campo flex-1"
            placeholder="pergunte qualquer coisa…"
            value={pergunta}
            onChange={(e) => setPergunta(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void enviar();
              }
            }}
          />
          <button id="chatEnviar" className="btn btn-primario" disabled={enviando || !pergunta.trim()} onClick={() => void enviar()}>
            enviar
          </button>
        </div>
      </div>

      {provider && provider.configurado && (
        <p className="dica m-0" id="chatRodape">
          modelo <span className="mono">{provider.modelo}</span> · provider {provider.origem === "global" ? "global" : "seu"}
          {provider.chave_mascarada ? ` · chave ${provider.chave_mascarada}` : ""} ·{" "}
          {provider.tem_system_prompt ? "com instruções do modelo" : "sem instruções (conversa pura)"} ·{" "}
          {provider.mcp_interno ? "MCP do minirag ligado" : "MCP do minirag desligado"} · até {provider.max_rodadas} rodada(s)
        </p>
      )}
    </section>
  );
}
