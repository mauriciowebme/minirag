import { useCallback, useEffect, useRef, useState } from "react";
import { ApiErro, del, get, getStream, post, postStream, qs } from "../services/api";
import { useToast } from "./Toast";
import { mdParaHtml } from "../lib/md";
import {
  assinar,
  cancelar,
  chaveConversa,
  estado,
  enviar as enviarNaConversa,
  limpar as limparConversa,
  reativar,
  semear,
  type Estado,
  type EventoTransporte,
  type Transportar,
} from "../lib/conversa";
import type { ChatHistorico, Compactacao, GavetasResp, ProviderResp } from "../types";

/** linha de status da tarefa viva (GET /chat/tarefas e GET /chat/tarefa/:id) */
type TarefaStatus = { id: string; pergunta?: string; status: string; parcial: string; ferramentas?: unknown[]; aviso?: string | null };

/** v3.3: lê o stream de uma tarefa no servidor, RELIGANDO em queda de rede (até 3×, backoff).
 *  Queda de conexão ≠ falha: a tarefa vive no servidor; se o stream quebrar, consulta o
 *  estado e reanexa. Devolve os dados do `fim` (ou reconstrói do GET se terminou no vão). */
async function bombearTarefa(
  id: string,
  onEvent: (e: EventoTransporte) => void,
): Promise<Record<string, unknown> | null> {
  let dados: Record<string, unknown> | null = null;
  for (let tentativa = 0; tentativa <= 3; tentativa++) {
    try {
      await getStream(`/chat/tarefa/${id}/stream`, (e) => {
        if (e.tipo === "fim") dados = e.dados as Record<string, unknown>;
        onEvent(e as EventoTransporte);
      });
      return dados; // stream fechou de verdade (fim, erro ou corrida tratada no servidor)
    } catch (e) {
      if (e instanceof ApiErro && e.status === 404) throw e; // tarefa sumiu: não tem o que religar
      /* rede/proxy caiu no meio: perguntar ao servidor o que houve, sem confiar no stream */
      let t: TarefaStatus | null = null;
      try {
        t = await get<TarefaStatus>(`/chat/tarefa/${id}`);
      } catch {
        /* servidor inacessível também: tratar como rodando e tentar de novo */
      }
      if (t && t.status !== "rodando") {
        if (t.status === "terminou") return { resposta: t.parcial, ferramentas: t.ferramentas ?? [], aviso: t.aviso ?? null };
        throw new ApiErro(0, t.aviso || "a tarefa falhou");
      }
      if (tentativa >= 3) throw new ApiErro(0, "sem conexão com o servidor");
      await new Promise((r) => setTimeout(r, 500 * 2 ** tentativa));
      if (t) onEvent({ tipo: "parcial", texto: t.parcial }); // ressincroniza a base antes de reanexar
    }
  }
  return dados;
}

/** traduz o que a compactação fez em uma linha honesta (nada de "resumido por IA") */
function textoCompacto(c?: Compactacao | null): string | undefined {
  if (!c) return undefined;
  const partes: string[] = [];
  if (c.resumidas) partes.push(`${c.resumidas} mensagem(ns) antigas viraram 1 linha`);
  if (c.aparadas) partes.push(`${c.aparadas} resultado(s) de ferramenta cortado(s)`);
  if (c.descartadas) partes.push(`${c.descartadas} descartada(s) do mais antigo`);
  if (!c.coube) partes.push("nem assim coube: enviou só instruções + pergunta");
  if (!partes.length) return undefined;
  return `histórico compactado: ${partes.join(" · ")} · ${c.tokens}/${c.disponivel} tokens (${c.origem_janela})`;
}

/** Chat: conversa com o provider; as ferramentas vêm do MCP ligado e ficam registradas na mensagem.
 *  Você pode emendar perguntas: entram na fila e saem uma por vez, na ordem.
 *  v3.0: a conversa mora em `lib/conversa` (fora do React). Você troca de página no painel, vai
 *  olhar a Busca ou outra gaveta, e o que o agente está fazendo NÃO é interrompido por isso —
 *  ao voltar, a bolha está lá, maior, com o tempo certo desde o começo. */
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
  const [pergunta, setPergunta] = useState("");
  const [provider, setProvider] = useState<ProviderResp | null>(null);
  const [espera, setEspera] = useState(0);
  /* rolagem respeitando quem manda: a tela SÓ desce sozinha se você já estiver no fim.
     (antes descia a cada tique do cronômetro e não deixava ler a resposta nem digitar) */
  const area = useRef<HTMLDivElement>(null);
  const colado = useRef(true);
  const [noFundo, setNoFundo] = useState(true);
  const [novoAbaixo, setNovoAbaixo] = useState(false);

  const tenantParam = operador && escopo.tenant ? escopo.tenant : undefined;
  const chave = chaveConversa(escopo.tenant, memoria);
  const [snap, setSnap] = useState<Estado>(() => estado(chave));

  useEffect(() => {
    setMemoria(escopo.memoria);
  }, [escopo.memoria]);

  /* a tela é só uma janela para a conversa: assina, mostra, e pode fechar sem matar o trabalho */
  useEffect(() => {
    const gritar = () => setSnap(estado(chave));
    gritar();
    return assinar(chave, gritar);
  }, [chave]);

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
      const h = await get<ChatHistorico>("/chat?" + qs({ memoria, ...(tenantParam ? { tenant: tenantParam } : {}) }));
      semear(
        chave,
        h.mensagens.map((m) => ({
          id: `h${m.id}`,
          papel: m.papel as "user" | "assistant",
          texto: m.texto,
          ferramentas: m.ferramentas ?? [],
        })),
      );
    } catch (e) {
      toast("histórico: " + (e as Error).message);
    }
    /* v3.3: fechou a aba no meio e voltou? A tarefa viva do servidor entra na tela
       (pergunta empurrada + bolha escrevendo desde o parcial, religando sozinha).
       Em servidor antigo a rota não existe: silencia, o histórico acima já valeu. */
    try {
      const tv = await get<{ tarefas: TarefaStatus[] }>(
        "/chat/tarefas?" + qs({ memoria, ...(tenantParam ? { tenant: tenantParam } : {}) }),
      );
      const viva = (tv.tarefas ?? [])[0];
      if (viva) {
        void reativar(
          chave,
          { id: String(viva.id), pergunta: String(viva.pergunta ?? ""), parcial: String(viva.parcial ?? "") },
          bombearTarefa,
        );
      }
    } catch {
      /* servidor antigo ou rede caída agora: nada a readotar */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave, memoria, tenantParam, toast]);

  useEffect(() => {
    void carregarHistorico();
  }, [carregarHistorico]);

  /* trocar de gaveta/conversa: começa no fim da lista, sem puxar a página inteira */
  useEffect(() => {
    irParaOFim();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave]);

  /** medir é o que decide: folga menor que 80px = você está acompanhando de baixo */
  function medirRolagem() {
    const a = area.current;
    if (!a) return;
    colado.current = a.scrollHeight - a.scrollTop - a.clientHeight < 80;
    setNoFundo(colado.current);
    if (colado.current) setNovoAbaixo(false);
  }

  function irParaOFim() {
    const a = area.current;
    if (!a) return;
    /* salto imediato: suave em travessia longa parece que nao fez nada */
    a.scrollTo({ top: a.scrollHeight, behavior: "auto" });
    colado.current = true;
    setNoFundo(true);
    setNovoAbaixo(false);
  }

  /* o texto chega em pedaços: desce junto se (e somente se) o usuário estiver no fim.
     NAO depende do cronômetro — era ele que puxava a tela a cada 500 ms. */
  const rastro = snap.msgs.length + ":" + (snap.msgs[snap.msgs.length - 1]?.texto.length ?? 0);
  useEffect(() => {
    if (colado.current) irParaOFim();
    else setNovoAbaixo(true);
  }, [rastro, snap.rodando]);

  /* cronômetro honesto: conta desde QUANDO a tarefa começou (voltar para a tela não zera o tempo) */
  useEffect(() => {
    if (!snap.rodando || !snap.inicio) {
      setEspera(0);
      return;
    }
    const marcar = () => setEspera(Math.max(0, Math.round((Date.now() - snap.inicio) / 1000)));
    marcar();
    const t = setInterval(marcar, 500);
    return () => clearInterval(t);
  }, [snap.rodando, snap.inicio]);

  /** o transporte sabe falar com o servidor; a conversa não precisa de tela aberta para existir */
  const transportar = useCallback<Transportar>(
    async (pedido, onEvent) => {
      let dados: Record<string, unknown> | null = null;
      /* v3.3: a resposta agora VIVE no servidor (tarefa): fechar a aba não mata o trabalho.
         Servidor antigo (404 em /chat/tarefa): cai no caminho direto /chat/stream. */
      let idTarefa = "";
      try {
        idTarefa = String((await post<{ id: string }>("/chat/tarefa", pedido)).id);
      } catch (e) {
        if (e instanceof ApiErro && e.status === 404) {
          await postStream("/chat/stream", pedido, (ev) => {
            if (ev.tipo === "fim") dados = ev.dados as Record<string, unknown>;
            else onEvent(ev as EventoTransporte);
          });
        } else {
          throw e;
        }
      }
      if (idTarefa) dados = await bombearTarefa(idTarefa, onEvent);
      const d = (dados ?? {}) as Record<string, unknown>;
      const aviso = textoCompacto(d.compactacao as Compactacao | undefined);
      if (aviso) d.compacto = aviso;
      if (d.resposta) setProvider((p) => (p ? { ...p, configurado: true } : p));
      return d;
    },
    [],
  );

  function enviar() {
    const texto = pergunta.trim();
    if (!texto) return;
    setPergunta("");
    enviarNaConversa(chave, texto, memoria, tenantParam, transportar);
  }

  function tirarDaFila(id?: number | string) {
    if (typeof id === "string") cancelar(chave, id);
  }

  async function limpar() {
    if (!confirm("apagar a conversa desta gaveta?")) return;
    try {
      await del("/chat?" + qs({ memoria, ...(tenantParam ? { tenant: tenantParam } : {}) }));
      limparConversa(chave);
      toast("conversa apagada");
    } catch (e) {
      toast("apagar: " + (e as Error).message);
    }
  }

  const semProvider = provider && !provider.configurado;
  const semFerramenta = provider && provider.configurado && !provider.mcp_interno;
  const naFila = snap.fila.length;
  const msgs = snap.msgs;
  const rodando = snap.rodando;

  return (
    <section className="flex flex-col gap-3" id="telaChat">
      <div className="barra">
        <h2>
          Chat <span className="sub2">— conversa com o modelo e as ferramentas do MCP</span>
        </h2>
        {rodando && (
          <span className="sub2" id="chatSegundoPlano" title="a tarefa continua mesmo se você for ver outra página">
            · trabalhando em segundo plano
          </span>
        )}
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
      </div>

      {semProvider && (
        <div className="aviso" id="avisoProvider">
          <span>Chat desligado: nenhum provider configurado. A Busca continua funcionando.</span>
          {/* v3.4: provider é decisão de admin — o comum não tem Configurações na tela */}
          {operador ? (
            <button className="btn btn-mini ml-auto" onClick={onIrConfig}>
              configurar agora
            </button>
          ) : (
            <span className="ml-auto text-[12px] text-txt3">peça ao administrador para ligar o provider</span>
          )}
        </div>
      )}

      <div className="cartao relative flex h-[68dvh] min-h-[380px] flex-col gap-0 p-0">
        {/* min-h-0 e o que falta para a caixa rolar por dentro: sem isso ela crescia
            e quem andava era a pagina inteira */}
        <div className="min-h-0 flex-1 overflow-auto p-4" id="chatMsgs" ref={area} onScroll={medirRolagem}>
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
              {m.compacto && <div className="sub2 mt-1">{m.compacto}</div>}
            </div>
          ))}
          {rodando && !msgs.some((m) => m.escrevendo) && (
            <div className="msg msg-ia">
              pensando… {espera}s
              {naFila > 0 && <span className="sub2"> · {naFila} na fila</span>}
            </div>
          )}
          {/* botão para descer: aparece só quando você subiu para ler algo */}
          {!noFundo && (
            <button
              id="chatIrAoFim"
              className="btn btn-mini absolute bottom-[76px] left-1/2 z-10 -translate-x-1/2 rounded-full px-3 shadow-md"
              title="rolar até o fim da conversa"
              onClick={irParaOFim}
            >
              {"↓ fim"}
              {novoAbaixo ? " · chegou coisa nova" : ""}
            </button>
          )}
        </div>
        <div className="flex gap-2 border-t border-borda p-3">
          <button
            id="chatNovaConversa"
            className="btn btn-sutil shrink-0"
            title="apagar esta conversa e recomeçar do zero"
            onClick={() => void limpar()}
          >
            nova conversa
          </button>
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
          {provider.mcp_interno ? "MCP do minirag ligado" : "MCP do minirag desligado"} · até {provider.max_rodadas} rodada(s) · memória{" "}
          {provider.memoria_turnos} · janela {provider.janela_efetiva.toLocaleString("pt-BR")} tokens ({provider.origem_janela})
        </p>
      )}
    </section>
  );
}
