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
  type FerramentaLinha,
  type SegmentoRastro,
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

/* ------------------------------------------------------------------ rastro do turno (v3.15) */

const RASTRO_CHAVE = "minirag:rastro-expandido";

/* As ferramentas internas do minirag têm nome em inglês no MCP; a linha do rastro fala como a
   tela (o jeito do IA_GO, que tem mapa de rótulos). Ferramenta de servidor externo mantém o
   nome que o servidor deu — inventar rótulo alheio seria mentira. */
const ROTULOS_FERRAMENTA: Record<string, string> = {
  health: "a saúde do servidor",
  search: "a busca semântica",
  ingest: "a ingestão",
  ingest_status: "o estado da ingestão",
  list_docs: "os documentos",
  delete_doc: "apagar documento",
  upload_file: "subir arquivo",
  get_file: "baixar arquivo",
  edit_doc: "editar documento",
  rename_doc: "renomear documento",
  archive_doc: "arquivar documento",
  list_gavetas: "as gavetas",
  create_gaveta: "criar gaveta",
  delete_gaveta: "apagar gaveta",
  chat: "o chat",
  listar_usuarios: "os usuários",
  criar_usuario: "criar usuário",
  apagar_usuario: "apagar usuário",
  esquecimento: "o esquecimento",
  config_provider: "a configuração do modelo",
};

function rotuloFerramenta(s: { servidor: string; nome: string }): string {
  const interno = s.servidor === "minirag" || s.servidor === "?";
  if (interno && ROTULOS_FERRAMENTA[s.nome]) return ROTULOS_FERRAMENTA[s.nome];
  return interno ? s.nome : `${s.servidor} · ${s.nome}`;
}

/** O rastro do turno: a trilha do que aconteceu, na ordem, dentro da mesma bolha — o jeito
 *  do assistente do IA_GO. Narração em cinza, pensamento em roxo com o tempo dele, ferramenta
 *  em azul com o tempo dela. Aberto enquanto o turno vive, recolhido quando acaba; a escolha
 *  do usuário vale para todas as mensagens. A resposta final não entra aqui: ela é a bolha. */
function Rastro({
  segmentos,
  vivo,
  detalhes,
  aberto,
  onToggle,
}: {
  segmentos: SegmentoRastro[];
  vivo: boolean;
  detalhes: FerramentaLinha[];
  aberto: boolean;
  onToggle: (atual: boolean) => void;
}) {
  const corpo = useRef<HTMLDivElement | null>(null);
  const colado = useRef(true);
  const ultimo = segmentos[segmentos.length - 1];
  const pensando = vivo && ultimo?.tipo === "pensamento" && ultimo.vivo === true;
  const [ticoque, setTicoque] = useState(0);

  useEffect(() => {
    if (!pensando) return;
    const t = setInterval(() => setTicoque((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [pensando]);

  /* o pensamento cresce POR DENTRO do bloco, que tem altura própria com rolagem: enquanto
     escreve, o bloco fica colado na última linha que chegou. Se você subir lá dentro para
     reler, ele para de puxar e te deixa em paz. (o defeito que o dono mostrou no celular) */
  useEffect(() => {
    const p = corpo.current;
    if (!p) {
      colado.current = true;
      return;
    }
    if (colado.current && pensando) p.scrollTop = p.scrollHeight;
  });

  const segundosVivos =
    pensando && ultimo?.tipo === "pensamento" && ultimo.inicio
      ? Math.max(0, Math.round((Date.now() - ultimo.inicio) / 1000))
      : 0;
  void ticoque; // é o que faz o relógio do bloco ao vivo andar
  const segsMs = segmentos.reduce((a, s) => a + ("ms" in s ? s.ms : 0), 0);
  const total = Math.max(1, Math.round((segsMs + segundosVivos * 1000) / 1000));
  const posTools = segmentos.map((s, i) => (s.tipo === "ferramenta" ? i : -1)).filter((i) => i >= 0);

  return (
    <div className="rastro" data-testid="rastroBloco">
      <button
        type="button"
        className="rastro-cab"
        onClick={() => onToggle(aberto)}
        aria-expanded={aberto}
        data-testid="rastroCab"
        title={aberto ? "recolher o rastro do turno" : "ver o rastro do turno"}
      >
        <span>
          <b>Rastro do turno</b>
          {` · ${segmentos.length} etapa${segmentos.length === 1 ? "" : "s"} · ${total}s`}
        </span>
        <span className="ml-auto">{aberto ? "▴" : "▾"}</span>
      </button>

      {aberto ? (
        <div className="rastro-corpo" data-testid="rastroCorpo">
          {segmentos.map((s, i) => {
            if (s.tipo === "narracao") {
              return (
                <div className="rastro-linha rastro-narra" key={`n${i}`} data-testid="rastroNarracao">
                  <i className="rastro-ponto" />
                  <span>{s.texto}</span>
                </div>
              );
            }
            if (s.tipo === "ferramenta") {
              const d = detalhes[posTools.indexOf(i)] as FerramentaLinha | undefined;
              return (
                <div className="rastro-linha rastro-tool" key={`f${i}`} data-testid="rastroFerramenta">
                  <i className="rastro-ponto rastro-ponto-azul" />
                  <details className="rastro-tool-detalhe">
                    <summary>
                      {`Consultando ${rotuloFerramenta(s)} · ${Math.max(1, Math.round(s.ms / 1000))}s `}
                      <span className={s.ok ? "txt-ok" : "txt-erro"}>{s.ok ? "✓" : "✕"}</span>
                      {d && (d.resumo || (d.args && Object.keys(d.args as object).length)) ? " · detalhe" : ""}
                    </summary>
                    {d ? (
                      <div className="rastro-tool-info">
                        {d.args && Object.keys(d.args as object).length ? (
                          <div className="mono break-all">{JSON.stringify(d.args)}</div>
                        ) : null}
                        {d.resumo ? <div className="sub2 break-all">{d.resumo}</div> : null}
                      </div>
                    ) : null}
                  </details>
                </div>
              );
            }
            const seg = Math.max(0, Math.round((s.ms || 0) / 1000));
            return (
              <div className="rastro-pensa" key={`p${i}`} data-testid="rastroPensamento">
                <div className="rastro-linha rastro-pensa-cab">
                  <i className="rastro-ponto rastro-ponto-roxo" />
                  <span>{s.vivo ? `Pensando… ${segundosVivos}s` : s.ms > 0 ? `Pensou por ${seg}s` : "Pensou"}</span>
                </div>
                {s.texto ? (
                  <div
                    className="racio-txt rastro-pensa-txt"
                    data-testid="rastroPensaTxt"
                    ref={s.vivo ? corpo : undefined}
                    onScroll={(e) => {
                      const el = e.currentTarget;
                      colado.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                    }}
                  >
                    {s.texto}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
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
  onAbrirMenu,
}: {
  escopo: { tenant: string; memoria: string };
  operador: boolean;
  onIrConfig: () => void;
  onAbrirMenu: () => void;
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
  const campoRef = useRef<HTMLTextAreaElement>(null);
  const colado = useRef(true);
  const [noFundo, setNoFundo] = useState(true);
  const [novoAbaixo, setNovoAbaixo] = useState(false);
  /* v3.15: abrir/recolher o rastro é preferência do usuário e vale para TODAS as mensagens
     (o jeito do IA_GO). Sem escolha ainda: aberto enquanto o turno vive, recolhido no fim. */
  const [rastroPref, setRastroPref] = useState<"1" | "0" | null>(
    () => (localStorage.getItem(RASTRO_CHAVE) === "1" ? "1" : localStorage.getItem(RASTRO_CHAVE) === "0" ? "0" : null),
  );
  const rastroAberto = (vivo: boolean) => (rastroPref === null ? vivo : rastroPref === "1");
  function alternarRastro(atual: boolean) {
    const novo = atual ? "0" : "1";
    localStorage.setItem(RASTRO_CHAVE, novo);
    setRastroPref(novo);
  }

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
      const linhas: { id: string; papel: "user" | "assistant"; texto: string; ferramentas: (typeof h.mensagens)[number]["ferramentas"]; fala?: boolean; raciocinio?: string; rastro?: SegmentoRastro[] }[] = [];
      for (const m of h.mensagens) {
        const trilha = (m.rastro ?? []) as SegmentoRastro[];
        /* v.8: as falas de caminho voltam como balões próprios na ordem em que foram escritas —
           a conversa fica corrida também depois de recarregar a página. Quando a mensagem já tem
           rastro (v3.15), a fala vive DENTRO da trilha: soltar balão duplicaria o mesmo texto. */
        if (!trilha.length) for (const [k, ft] of (m.falas ?? []).entries())
          linhas.push({ id: `h${m.id}f${k}`, papel: "assistant", texto: String(ft), ferramentas: [], fala: true });
        /* v3.13: o raciocínio gravado volta recolhido — "Pensou" clicável, como no Open WebUI */
        linhas.push({
          id: `h${m.id}`, papel: m.papel as "user" | "assistant", texto: m.texto,
          ferramentas: m.ferramentas ?? [],
          ...(trilha.length ? { rastro: trilha } : {}),
          ...(m.raciocinio ? { raciocinio: String(m.raciocinio) } : {}),
        });
      }
      semear(chave, linhas);
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
  const rastro =
    snap.msgs.length +
    ":" +
    (snap.msgs[snap.msgs.length - 1]?.texto.length ?? 0) +
    ":" +
    (snap.msgs[snap.msgs.length - 1]?.raciocinio?.length ?? 0);
  useEffect(() => {
    if (colado.current) irParaOFim();
    else setNovoAbaixo(true);
  }, [rastro, snap.rodando]);

  /* o pensamento cresce POR DENTRO do painel (ele tem altura própria com rolagem): enquanto
     escreve, o painel tem de acompanhar a escrita em vez de deixar o texto novo subir e
     sair de cima. Para de acompanhar se você subir lá dentro para reler; volta a colar
     quando começa uma resposta nova. */
  const racioColado = useRef(true);
  useEffect(() => {
    const painel = document.querySelector<HTMLElement>(".racio[open] .racio-txt");
    if (!painel) {
      racioColado.current = true;
      return;
    }
    if (racioColado.current) painel.scrollTop = painel.scrollHeight;
  }, [rastro]);

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

  /* a pílula de escrita acompanha o texto digitado (até ~5 linhas) em vez de esconder o
     restante atrás de um campo de altura fixa */
  function ajustarAltura(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }

  /* copiar a resposta: área de transferência do navegador com reserva para http sem
     suporte (o painel local do cliente roda em http://127.0.0.1, onde o clipboard pode faltar) */
  async function copiarResposta(texto: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(texto);
      } else {
        const sujo = document.createElement("textarea");
        sujo.value = texto;
        sujo.setAttribute("readonly", "");
        sujo.style.cssText = "position:fixed;top:-1000px;opacity:0";
        document.body.appendChild(sujo);
        sujo.select();
        document.execCommand("copy");
        sujo.remove();
      }
      toast("resposta copiada");
    } catch {
      toast("o navegador nao deixou copiar — selecione o texto e copie");
    }
  }

  function enviar() {
    const texto = pergunta.trim();
    if (!texto) return;
    setPergunta("");
    if (campoRef.current) {
      campoRef.current.style.height = "auto";
      campoRef.current.focus();
    }
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
    <section className="chat-tela flex flex-col gap-3 max-[720px]:gap-0" id="telaChat">
      {/* v3.14 — modo celular: a barra velha botava título, subtítulo, gaveta e (embaixo)
          "nova conversa" + campo + "enviar" na MESMA linha; num celular de 390px sobravam
          ~120px para escrever. O cabeçalho agora só tem o que age: a pílula do modelo com a
          gaveta dentro dela e a nova conversa (virou ícone no celular). O subtítulo saiu —
          o topo do app já diz "Chat". */}
      <div className="chat-topo">
        {/* v3.14.1 — tela inteira no celular: o cabecalho do app sai de cena, entao o
            botao de abrir o menu mora aqui (sem ele nao se chegava mais em lugar nenhum) */}
        <button
          id="chatMenuCelular"
          className="chat-acao hidden max-[720px]:inline-flex"
          aria-label="abrir menu"
          title="menu"
          onClick={onAbrirMenu}
        >
          ☰
        </button>
        <label className="chat-pilula" title="modelo em uso e gaveta de memoria desta conversa">
          <span className="chat-pilula-modelo mono">{provider?.modelo ?? "sem modelo"}</span>
          <select
            id="chatGaveta"
            className="chat-pilula-gaveta"
            value={memoria}
            onChange={(e) => setMemoria(e.target.value)}
            aria-label="gaveta"
          >
            {gavetas.map((g) => (
              <option key={g} value={g}>
                {g || "padrão"}
              </option>
            ))}
          </select>
          <span className="chat-pilula-seta" aria-hidden="true">▾</span>
        </label>
        {rodando && (
          <span className="sub2" id="chatSegundoPlano" title="a tarefa continua mesmo se você for ver outra página">
            · trabalhando em segundo plano
          </span>
        )}
        <span className="flex-1" />
        <button
          id="chatNovaConversa"
          className="chat-acao"
          title="apagar esta conversa e recomeçar do zero"
          onClick={() => void limpar()}
        >
          <svg className="chat-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
          </svg>
          <span className="chat-acao-rotulo">nova conversa</span>
        </button>
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

      <div className="chat-caixa relative flex flex-col gap-0 p-0">
        {/* min-h-0 e o que falta para a caixa rolar por dentro: sem isso ela crescia
            e quem andava era a pagina inteira */}
        <div className="chat-msgs min-h-0 flex-1 overflow-auto" id="chatMsgs" ref={area} onScroll={medirRolagem}>
          <div className="chat-coluna">
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
                <>
                  {/* v3.13 — bloco de raciocínio no estilo do Open WebUI: "Pensando… Ns"
                      aberto enquanto pensa, "Pensou por Ns" recolhido quando a resposta começa */}
                  {m.rastro && m.rastro.length > 0 ? (
                    <Rastro
                      segmentos={m.rastro}
                      vivo={Boolean(m.escrevendo)}
                      detalhes={m.ferramentas}
                      aberto={rastroAberto(Boolean(m.escrevendo))}
                      onToggle={alternarRastro}
                    />
                  ) : m.raciocinio ? (
                    <details className="racio" open={Boolean(m.escrevendo) && !m.texto}>
                      <summary className="racio-cab">
                        <svg className="racio-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                          <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z" />
                        </svg>
                        {m.escrevendo && !m.texto
                          ? `Pensando… ${espera}s`
                          : `Pensou${m.raciocinioInicio !== undefined && m.raciocinioFim !== undefined
                              ? ` por ${Math.max(1, Math.round((m.raciocinioFim - m.raciocinioInicio) / 1000))}s`
                              : ""}`}
                      </summary>
                      <div
                        className="racio-txt"
                        onScroll={(e) => {
                          const el = e.currentTarget;
                          racioColado.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                        }}
                      >
                        {m.raciocinio}
                      </div>
                    </details>
                  ) : null}
                  {m.escrevendo && !m.texto ? (
                    m.raciocinio ? null : (
                      <span className="sub2" id="chatPensando">
                        pensando… {espera}s
                        {naFila > 0 ? ` · ${naFila} na fila` : ""}
                      </span>
                    )
                  ) : (
                    <div className={(m.escrevendo ? "md vivo" : "md") + (m.fala ? " fala" : "")} dangerouslySetInnerHTML={{ __html: mdParaHtml(m.texto) }} />
                  )}
                </>
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
              {m.ferramentas.length > 0 && !(m.rastro && m.rastro.length > 0) && (
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
              {/* v3.14 — ações sobre a resposta pronta: só o que age. "refazer" ficou de fora
                  porque regenerar exige mexer no histórico no servidor (ainda não existe). */}
              {m.papel === "assistant" && !m.escrevendo && m.texto ? (
                <div className="chat-acoes">
                  <button
                    className="chat-acao-icone"
                    title="copiar a resposta"
                    aria-label="copiar a resposta"
                    onClick={() => void copiarResposta(m.texto)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                      <rect x="9" y="9" width="11" height="11" rx="2" />
                      <path d="M15 5H6a2 2 0 0 0-2 2v9" />
                    </svg>
                  </button>
                </div>
              ) : null}
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
          </div>
          {/* botão para descer: aparece só quando você subiu para ler algo */}
          {!noFundo && (
            <button
              id="chatIrAoFim"
              className="btn btn-mini absolute bottom-[116px] left-1/2 z-10 -translate-x-1/2 rounded-full px-3 shadow-md"
              title="rolar até o fim da conversa"
              onClick={irParaOFim}
            >
              {"↓ fim"}
              {novoAbaixo ? " · chegou coisa nova" : ""}
            </button>
          )}
        </div>
        {/* v3.14 — pílula de escrita com altura própria (cresce até 5 linhas) e enviar
            redondo lá dentro; no celular a pílula ocupa a largura toda, então o campo
            não divide mais linha com dois botões de texto. Microfone e "+" ficaram fora:
            no minirag nenhum dos dois teria o que fazer, e controle mudo não vai pra tela. */}
        <div className="chat-piso">
          <div
            className="chat-composer"
            onClick={(e) => {
              /* no celular o alvo de toque e a pilula inteira (62px), nao a linha de 34px do campo */
              if (e.target === e.currentTarget) campoRef.current?.focus();
            }}
          >
            <textarea
              id="chatPergunta"
              ref={campoRef}
              className="chat-campo"
              rows={1}
              placeholder={rodando ? "emenda a próxima pergunta… (vai para a fila)" : "pergunte qualquer coisa…"}
              value={pergunta}
              onChange={(e) => {
                setPergunta(e.target.value);
                ajustarAltura(e.currentTarget);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  enviar();
                }
              }}
            />
            <button
              id="chatEnviar"
              className="chat-enviar"
              disabled={!pergunta.trim()}
              title={rodando ? "colocar na fila" : "enviar"}
              onClick={enviar}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5" />
                <path d="M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
          <p className="chat-dica">
            Enter envia · Shift+Enter quebra linha{rodando ? " · a próxima vai para a fila" : ""}
          </p>
        </div>
      </div>

      {provider && provider.configurado && (
        /* v3.14 — o parágrafo técnico (8 informações) cortava na borda do celular e não
           cabia em parte alguma: vira uma linha com o essencial e abre ao toque. O texto
           completo continua aqui dentro, só que dobrado. */
        <details className="chat-rodape" id="chatRodape">
        <summary className="chat-rodape-cab">
          <span className="chat-rodape-modelo mono">{provider.modelo}</span>
          <span className="chat-rodape-fixo">· {provider.origem === "global" ? "global" : "seu"}</span>
          {provider.chave_mascarada ? (
            <span className="chat-rodape-fixo chat-rodape-chave">· chave {provider.chave_mascarada}</span>
          ) : null}
          <span className="chat-rodape-fixo chat-rodape-abrir">› ver detalhes</span>
        </summary>
        <p className="dica m-0">
          modelo <span className="mono">{provider.modelo}</span> · provider {provider.origem === "global" ? "global" : "seu"}
          {provider.chave_mascarada ? ` · chave ${provider.chave_mascarada}` : ""} ·{" "}
          {provider.tem_system_prompt ? "com instruções do modelo" : "sem instruções (conversa pura)"} ·{" "}
          {provider.mcp_interno ? "MCP do minirag ligado" : "MCP do minirag desligado"} · até {provider.max_rodadas} rodada(s) · memória{" "}
          {provider.memoria_turnos} · janela {provider.janela_efetiva.toLocaleString("pt-BR")} tokens ({provider.origem_janela})
        </p>
        </details>
      )}
    </section>
  );
}
