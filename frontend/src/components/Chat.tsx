import { useCallback, useEffect, useRef, useState } from "react";
import { del, get, post, postStream, qs, type ApiErro } from "../services/api";
import { useToast } from "./Toast";
import { mdParaHtml } from "../lib/md";
import type { ChamadaFerramenta, ChatHistorico, ChatResp, GavetasResp, ProviderResp } from "../types";

type Msg = {
  papel: "user" | "assistant";
  texto: string;
  ferramentas: ChamadaFerramenta[];
  aviso?: string | null;
  id?: number | string;
  /** fila local: ainda não foi para o modelo */
  naFila?: boolean;
  /** erro de envio (provider desligado, rede) */
  falha?: boolean;
  /** ainda chegando em pedaços */
  escrevendo?: boolean;
};

let seq = 0;
const proximoId = () => `l${Date.now().toString(36)}-${++seq}`;

/** Chat: conversa com o provider; as ferramentas vêm do MCP ligado e ficam registradas na mensagem.
 *  Você pode emendar perguntas: entram na fila e saem uma por vez, na ordem. */
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
  const [rodando, setRodando] = useState(false);
  const [espera, setEspera] = useState(0);
  const [provider, setProvider] = useState<ProviderResp | null>(null);
  const fim = useRef<HTMLDivElement>(null);
  const ocupado = useRef(false);
  const filaRef = useRef<{ id: string; texto: string }[]>([]);
  const bruto = useRef("");
  const vivoId = useRef<string>("");
  const memoriaRef = useRef(memoria);
  memoriaRef.current = memoria;
  const tenantRef = useRef(operador && escopo.tenant ? { tenant: escopo.tenant } : {});
  tenantRef.current = operador && escopo.tenant ? { tenant: escopo.tenant } : {};

  const tenantParams = tenantRef.current;

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
        setProvider(await get<ProviderResp>("/config/provider" + (escopo.tenant && operador ? "?" + qs({ tenant: escopo.tenant }) : "")));
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
    /* trocar de gaveta derruba o que ainda não saiu (a fila é da gaveta anterior) */
    filaRef.current = [];
    setMsgs((m) => m.filter((x) => !x.naFila));
    void carregarHistorico();
  }, [carregarHistorico]);

  useEffect(() => {
    fim.current?.scrollIntoView({ block: "end" });
  }, [msgs.length, rodando, espera]);

  /* cronômetro da espera: o modelo local leva segundos e a tela precisa mostrar vida */
  useEffect(() => {
    if (!rodando) {
      setEspera(0);
      return;
    }
    const t = setInterval(() => setEspera((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [rodando]);

  /** dispara a próxima da fila quando estiver livre */
  const bombear = useCallback(async () => {
    if (ocupado.current) return;
    const item = filaRef.current.shift();
    if (!item) return;
    ocupado.current = true;
    setRodando(true);
    setMsgs((m) => m.map((x) => (x.id === item.id ? { ...x, naFila: false } : x)));
    const gaveta = memoriaRef.current;
    try {
      /* resposta ao vivo: a bolha nasce vazia e cresce com os pedaços do modelo */
      vivoId.current = proximoId();
      bruto.current = "";
      setMsgs((m) => [...m, { papel: "assistant", texto: "", ferramentas: [], id: vivoId.current, escrevendo: true }]);
      let resultado: ChatResp | null = null;
      let detalheErro = "";
      try {
        await postStream("/chat/stream", { pergunta: item.texto, memoria: gaveta, ...tenantRef.current }, (e) => {
          if (e.tipo === "delta") {
            bruto.current += String(e.texto ?? "");
            setMsgs((m) => m.map((x) => (x.id === vivoId.current ? { ...x, texto: bruto.current } : x)));
          } else if (e.tipo === "descartar") {
            bruto.current = "";
            setMsgs((m) => m.map((x) => (x.id === vivoId.current ? { ...x, texto: "" } : x)));
          } else if (e.tipo === "ferramenta") {
            setMsgs((m) =>
              m.map((x) =>
                x.id === vivoId.current
                  ? { ...x, ferramentas: [...x.ferramentas, { servidor: e.servidor, nome: e.nome, ok: e.ok, ms: e.ms, args: {}, resumo: "" }] }
                  : x,
              ),
            );
          } else if (e.tipo === "fim") {
            resultado = e.dados as ChatResp;
          } else if (e.tipo === "erro") {
            detalheErro = String(e.detalhe ?? "o chat falhou");
          }
        });
      } catch (e) {
        /* servidor antigo, sem /chat/stream: volta para a resposta inteira de uma vez */
        if ((e as ApiErro).status === 404) {
          resultado = await post<ChatResp>("/chat", { pergunta: item.texto, memoria: gaveta, ...tenantRef.current });
        } else {
          throw e;
        }
      }
      if (detalheErro) throw new Error(detalheErro);
      const r = (resultado as ChatResp) ?? { resposta: bruto.current, ferramentas: [] };
      setMsgs((m) =>
        m.map((x) =>
          x.id === vivoId.current
            ? { ...x, texto: r.resposta ?? bruto.current, ferramentas: r.ferramentas ?? x.ferramentas, aviso: r.aviso ?? null, escrevendo: false }
            : x,
        ),
      );
      setProvider((p) => (p ? { ...p, configurado: true } : p));
    } catch (e) {
      const err = e as Error;
      setMsgs((m) => {
        const semCursor = m.map((x) => (x.id === vivoId.current ? { ...x, escrevendo: false, falha: !x.texto } : x));
        return [
          ...semCursor,
          { papel: "assistant", texto: "não consegui responder: " + err.message, ferramentas: [], falha: true, id: proximoId() },
        ];
      });
      if (err.message.includes("provider")) setProvider((p) => (p ? { ...p, configurado: false } : p));
    } finally {
      ocupado.current = false;
      setRodando(false);
      if (filaRef.current.length) void bombear();
    }
  }, []);

  function enviar() {
    const texto = pergunta.trim();
    if (!texto) return;
    setPergunta("");
    const id = proximoId();
    filaRef.current.push({ id, texto });
    setMsgs((m) => [...m, { papel: "user", texto, ferramentas: [], naFila: true, id }]);
    void bombear();
  }

  function tirarDaFila(id?: number | string) {
    if (id === undefined) return;
    filaRef.current = filaRef.current.filter((x) => x.id !== id);
    setMsgs((m) => m.filter((x) => x.id !== id));
  }

  async function limpar() {
    if (!confirm("apagar a conversa desta gaveta?")) return;
    try {
      await del("/chat?" + qs({ memoria, ...tenantParams }));
      filaRef.current = [];
      setMsgs([]);
      toast("conversa apagada");
    } catch (e) {
      toast("apagar: " + (e as Error).message);
    }
  }

  const semProvider = provider && !provider.configurado;
  const semFerramenta = provider && provider.configurado && !provider.mcp_interno;
  const naFila = msgs.filter((m) => m.naFila).length;

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
          {msgs.length === 0 && !rodando && (
            <p className="dica">
              {semFerramenta
                ? "nenhuma ferramenta ligada — o modelo responde só com o que sabe (ligue MCP em Configurações → Ferramentas)"
                : "pergunte o que quiser; o que ele chamar de ferramenta aparece registrado embaixo da resposta"}
            </p>
          )}
          {msgs.map((m, i) => (
            <div key={m.id ?? i} className={"msg " + (m.papel === "user" ? "msg-eu" : "msg-ia") + (m.falha ? " msg-falha" : "")}>
              {m.papel === "assistant" ? (
                m.escrevendo && !m.texto ? (
                  <span className="sub2" id="chatPensando">
                    pensando… {espera}s
                    {naFila > 0 ? ` · ${naFila} na fila` : ""}
                  </span>
                ) : (
                  <div className={m.escrevendo ? "md vivo" : "md"} dangerouslySetInnerHTML={{ __html: mdParaHtml(m.texto) }} />
                )
              ) : (
                <>
                  {m.texto}
                  {m.naFila && (
                    <button className="btn btn-mini ml-2" title="tirar da fila" onClick={() => tirarDaFila(m.id)}>
                      ✕ na fila
                    </button>
                  )}
                </>
              )}
              {m.ferramentas.length > 0 && (
                <details className="fontes" open={false}>
                  <summary className="fonte">
                    ferramentas chamadas · {m.ferramentas.length} (
                    {m.ferramentas.map((f) => (f.servidor === "minirag" ? "" : f.servidor + "·") + f.nome).join(", ")})
                  </summary>
                  {m.ferramentas.map((f, j) => (
                    <div className="fonte" key={j}>
                      <b>
                        {f.servidor === "minirag" ? "minirag" : f.servidor} · {f.nome}
                      </b>{" "}
                      {f.ok ? "✓" : "✕"} · {f.ms} ms
                      <div className="mono break-all">{JSON.stringify(f.args)}</div>
                      <div className="sub2 break-all">{f.resumo}</div>
                    </div>
                  ))}
                </details>
              )}
              {m.aviso && <div className="sub2 mt-1">aviso: {m.aviso}</div>}
            </div>
          ))}
          {rodando && !msgs.some((m) => m.escrevendo) && (
            <div className="msg msg-ia">
              pensando… {espera}s
              {naFila > 0 && <span className="sub2"> · {naFila} na fila</span>}
            </div>
          )}
          <div ref={fim} />
        </div>
        <div className="flex gap-2 border-t border-borda p-3">
          <input
            id="chatPergunta"
            className="campo flex-1"
            placeholder={rodando ? "emenda a próxima pergunta… (vai para a fila)" : "pergunte qualquer coisa…"}
            value={pergunta}
            onChange={(e) => setPergunta(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                enviar();
              }
            }}
          />
          <button id="chatEnviar" className="btn btn-primario" disabled={!pergunta.trim()} onClick={enviar}>
            {rodando ? "para a fila" : "enviar"}
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
