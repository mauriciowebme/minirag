import { useCallback, useEffect, useRef, useState } from "react";
import { ApiErro, del, get, getStream, post, postStream, qs } from "../services/api";
import { useToast } from "./Toast";
import { mdParaHtml } from "../lib/md";
import {
  apararAteSid,
  assinar,
  cancelar,
  chaveConversa,
  definirSelecao,
  descartarUltimos,
  pedirParada,
  registrarTarefa,
  estado,
  getSelecao,
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
import type { ChatHistorico, Compactacao, ProviderResp, Provedor } from "../types";

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
  provider,
  onProviderConfirmado,
  onIrConfig,
  onAbrirMenu,
}: {
  escopo: { tenant: string; memoria: string };
  operador: boolean;
  /** v3.16: o provider (e o modelo em uso) agora é buscado pelo App e mostrado na
   * lateral; o Chat recebe por props — a pílula do topo saiu de cena. */
  provider: ProviderResp | null;
  /** uma resposta que chegou é prova de que o provider está vivo mesmo se o fetch
   * pegou "não configurado" (o dono ligou o provider depois do login). */
  onProviderConfirmado: () => void;
  onIrConfig: () => void;
  onAbrirMenu: () => void;
}) {
  const { toast } = useToast();
  const [memoria, setMemoria] = useState(escopo.memoria);
  const [pergunta, setPergunta] = useState("");
  const [espera, setEspera] = useState(0);
  /* rolagem respeitando quem manda: a tela SÓ desce sozinha se você já estiver no fim.
     (antes descia a cada tique do cronômetro e não deixava ler a resposta nem digitar) */
  const area = useRef<HTMLDivElement>(null);
  const campoRef = useRef<HTMLTextAreaElement>(null);
  const colado = useRef(true);
  const [noFundo, setNoFundo] = useState(true);
  const [novoAbaixo, setNovoAbaixo] = useState(false);
  /* ---------------- v3.18: edição de pergunta, ditado por voz, rascunho por gaveta ---------------- */
  const [editando, setEditando] = useState<number | null>(null); // sid da pergunta que está sendo editada
  const [ditando, setDitando] = useState(false);
  const recRef = useRef<{ stop(): void } | null>(null);
  /* T014: trocar de gaveta não mata o texto que você começou a digitar na outra */
  const rascunhos = useRef(new Map<string, string>());
  const perguntaRef = useRef(pergunta);
  perguntaRef.current = pergunta;
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
  /* v3.19: o usuário escolhe qual provedor (e qual modelo) responde esta conversa */
  const [provedores, setProvedores] = useState<Provedor[]>([]);
  const [sel, setSel] = useState<{ provedor: string; modelo: string }>(() => getSelecao(chave));

  useEffect(() => {
    setSel(getSelecao(chave));
  }, [chave]);
  useEffect(() => {
    let vivo = true;
    get<{ provedores: Provedor[] }>("/provedores")
      .then((r) => {
        if (vivo) setProvedores(r.provedores);
      })
      .catch(() => {
        /* sem provedores cadastrados: a régua nem aparece */
      });
    return () => {
      vivo = false;
    };
  }, []);
  const mudarSelecao = (s: { provedor: string; modelo: string }) => {
    setSel(s);
    definirSelecao(chave, s);
  };
  const selProvedor = provedores.find((x) => x.ativo && x.nome === sel.provedor);

  useEffect(() => {
    setMemoria(escopo.memoria);
  }, [escopo.memoria]);

  /* a tela é só uma janela para a conversa: assina, mostra, e pode fechar sem matar o trabalho */
  useEffect(() => {
    const gritar = () => setSnap(estado(chave));
    gritar();
    return assinar(chave, gritar);
  }, [chave]);

  /* v3.16: a busca de gavetas e provider saiu daqui — vive no App (dono da lateral,
     onde o contexto da conversa passou a ser mostrado). O Chat recebe provider por props. */

  const carregarHistorico = useCallback(async () => {
    try {
      const h = await get<ChatHistorico>("/chat?" + qs({ memoria, ...(tenantParam ? { tenant: tenantParam } : {}) }));
      const linhas: { id: string; papel: "user" | "assistant"; texto: string; ferramentas: (typeof h.mensagens)[number]["ferramentas"]; fala?: boolean; raciocinio?: string; rastro?: SegmentoRastro[]; sid?: number; when?: string; fontes?: string[]; custo?: Record<string, unknown> | null }[] = [];
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
          /* v3.18: sid (âncora do editar/reenviar), hora, fontes e custo voltam com a linha */
          sid: Number(m.id),
          when: String(m.quando ?? ""),
          ...(trilha.length ? { rastro: trilha } : {}),
          ...(m.raciocinio ? { raciocinio: String(m.raciocinio) } : {}),
          ...(Array.isArray(m.fontes) && m.fontes.length ? { fontes: m.fontes.map(String) } : {}),
          ...(m.custo ? { custo: m.custo as Record<string, unknown> } : {}),
          ...(m.provedor ? { provedor: String(m.provedor) } : {}),
          ...(m.modelo ? { modelo: String(m.modelo) } : {}),
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

  /* T014 (v3.18): o texto digitado é POR GAVETA — trocar e voltar não apaga o rascunho */
  const chaveAnterior = useRef(chave);
  useEffect(() => {
    if (chaveAnterior.current === chave) return;
    if (perguntaRef.current.trim()) rascunhos.current.set(chaveAnterior.current, perguntaRef.current);
    setPergunta(rascunhos.current.get(chave) ?? "");
    setEditando(null);
    chaveAnterior.current = chave;
    requestAnimationFrame(() => {
      if (campoRef.current) ajustarAltura(campoRef.current);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave]);

  /* T008 (v3.18): teclado aberto no celular não pode esconder a barra de digitar —
     o visualViewport conta quantos pixels o teclado cobriu e a gente empurra o pé para cima.
     Sem essa API (desktop), nada acontece. */
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const mexer = () => {
      const piso = document.getElementById("chatPiso");
      if (!piso) return;
      const coberto = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      piso.style.transform = coberto > 60 ? `translateY(-${coberto - 16}px)` : "";
      if (coberto > 60 && document.activeElement === campoRef.current) {
        campoRef.current?.scrollIntoView({ block: "center" });
      }
    };
    vv.addEventListener("resize", mexer);
    vv.addEventListener("scroll", mexer);
    return () => {
      vv.removeEventListener("resize", mexer);
      vv.removeEventListener("scroll", mexer);
    };
  }, []);

  /* T009 (v3.18): o botão "copiar" mora no HTML vindo do md.ts (dangerouslySetInnerHTML),
     então o React não vê o clique — escuta delegada no recipiente das mensagens. */
  const delegou = useRef(false);
  useEffect(() => {
    const a = area.current;
    if (!a || delegou.current) return;
    delegou.current = true;
    const pegar = (e: MouseEvent) => {
      const alvo = e.target as HTMLElement | null;
      const botao = alvo?.closest?.(".chat-pre-copiar") as HTMLElement | null;
      if (!botao) return;
      const pre = botao.closest(".chat-bloco")?.querySelector("pre");
      if (pre) void copiarTexto(pre.textContent ?? "", "bloco copiado");
    };
    a.addEventListener("click", pegar);
    return () => a.removeEventListener("click", pegar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.msgs.length]);

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

  /* v3.16: transporte roda com deps vazias; o canal de "provider vivo" passa por ref
     para sempre chamar a função atual do App. */
  const vivoRef = useRef(onProviderConfirmado);
  vivoRef.current = onProviderConfirmado;
  /* v3.18: o transporte (estável, sem deps) precisa do escopo de AGORA para registrar a
     tarefa na conversa certa quando a tela está noutra gaveta — o truque do vivoRef de novo. */
  const escopoRef = useRef(escopo);
  escopoRef.current = escopo;

  /** o transporte sabe falar com o servidor; a conversa não precisa de tela aberta para existir */
  const transportar = useCallback<Transportar>(
    async (pedido, onEvent) => {
      let dados: Record<string, unknown> | null = null;
      /* v3.3: a resposta agora VIVE no servidor (tarefa): fechar a aba não mata o trabalho.
         Servidor antigo (404 em /chat/tarefa): cai no caminho direto /chat/stream. */
      let idTarefa = "";
      try {
        idTarefa = String((await post<{ id: string }>("/chat/tarefa", pedido)).id);
        /* v3.18 (T001): a conversa dona da tarefa registra o id — é assim que o "parar" sabe o que matar */
        registrarTarefa(chaveConversa(escopoRef.current.tenant, String(pedido.memoria ?? "")), idTarefa);
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
      if (d.resposta) vivoRef.current();
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

  /* copiar (resposta, pergunta ou bloco de código): área de transferência do navegador com
     reserva para http sem suporte (o painel local do cliente roda em http://127.0.0.1, onde o clipboard pode faltar) */
  async function copiarTexto(texto: string, brinde: string) {
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
      toast(brinde);
    } catch {
      toast("o navegador nao deixou copiar — selecione o texto e copie");
    }
  }

  const copiarResposta = (texto: string) => copiarTexto(texto, "resposta copiada");

  function enviar() {
    const texto = pergunta.trim();
    if (!texto) return;
    setPergunta("");
    rascunhos.current.delete(chave); // v3.18 (T014): rascunho daquela gaveta foi usado
    if (campoRef.current) {
      campoRef.current.style.height = "auto";
      campoRef.current.focus();
    }
    enviarNaConversa(chave, texto, memoria, tenantParam, transportar);
  }

  /* ---------------- v3.18: parar, regenerar, editar, repetir, exportar, voz, hora ---------------- */

  const fmtHora = (iso?: string): string => {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  };

  /** T001: "parar" — o servidor aborta a chamada em curso e devolve pelo stream o que já tinha saído */
  function pararResposta() {
    const id = pedirParada(chave);
    if (!id) return;
    void post(`/chat/tarefa/${encodeURIComponent(id)}/cancelar${tenantParam ? "?" + qs({ tenant: tenantParam }) : ""}`, {}).catch((e) => {
      toast("parar: " + (e as Error).message);
    });
  }

  /** T002: regenerar — o servidor corta o último par; a tela reenvia a pergunta pelo caminho normal */
  async function regenerar() {
    if (rodando) return;
    try {
      const r = await post<{ pergunta: string; removidas: number }>(
        "/chat/regenerar",
        { memoria, ...(tenantParam ? { tenant: tenantParam } : {}) },
      );
      const p = String(r.pergunta ?? "").trim();
      if (!p) return;
      descartarUltimos(chave, Number(r.removidas ?? 2));
      enviarNaConversa(chave, p, memoria, tenantParam, transportar);
    } catch (e) {
      toast("regenerar: " + (e as Error).message);
    }
  }

  /** T003: editar e reenviar — o corte no servidor vem antes; se ele falar, nada se move na tela */
  function comecarEdicao(sid: number, texto: string) {
    setEditando(sid);
    setPergunta(texto);
    requestAnimationFrame(() => {
      const el = campoRef.current;
      if (el) {
        el.focus();
        ajustarAltura(el);
      }
    });
  }

  function cancelarEdicao() {
    setEditando(null);
    setPergunta("");
  }

  async function confirmarEdicao() {
    const texto = pergunta.trim();
    const sid = editando;
    setEditando(null);
    setPergunta("");
    if (!texto || sid === null) return;
    try {
      await post("/chat/reenviar-corte", { memoria, ...(tenantParam ? { tenant: tenantParam } : {}), id: sid });
      apararAteSid(chave, sid);
      enviarNaConversa(chave, texto, memoria, tenantParam, transportar);
    } catch (e) {
      toast("reenviar: " + (e as Error).message);
    }
  }

  /** T013: erro com botão visível de repetir a última pergunta */
  function repetirUltima() {
    const alvo = [...msgs].reverse().find((m) => m.papel === "user");
    if (!alvo) {
      toast("nenhuma pergunta para repetir");
      return;
    }
    enviarNaConversa(chave, alvo.texto, memoria, tenantParam, transportar);
  }

  /** T017: exportar a conversa visível como markdown (balões na ordem, com hora) */
  function exportarConversa() {
    const corpo = msgs
      .filter((m) => m.texto.trim())
      .map((m) => `${m.papel === "user" ? "**você**" : "**minirag**"}${m.when ? ` · ${fmtHora(m.when)}` : ""}\n\n${m.texto}\n`)
      .join("\n---\n\n");
    if (!corpo) {
      toast("nada para exportar ainda");
      return;
    }
    const blob = new Blob([`# conversa${memoria ? ` — ${memoria}` : ""} (minirag)\n\n${corpo}`], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `conversa-${(memoria || "padrao").replace(/[^\w-]+/g, "_").slice(0, 40)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /** T022: ditado por voz do próprio navegador (Web Speech). Sem suporte: avisa, não finge. */
  function alternarDitado() {
    const SR = (window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any });
    const Fabrica = SR.SpeechRecognition ?? SR.webkitSpeechRecognition;
    if (!Fabrica) {
      toast("seu navegador não tem ditado por voz (funciona no Chrome/Edge)");
      return;
    }
    if (ditando) {
      recRef.current?.stop();
      setDitando(false);
      return;
    }
    const rec = new Fabrica();
    rec.lang = "pt-BR";
    rec.interimResults = false;
    rec.continuous = true;
    rec.onresult = (ev: any) => {
      let novo = "";
      for (let k = ev.resultIndex; k < ev.results.length; k++) {
        if (ev.results[k].isFinal) novo += ev.results[k][0].transcript;
      }
      if (!novo) return;
      setPergunta((p) => (p.trim() ? `${p.trimEnd()} ${novo}` : novo));
      requestAnimationFrame(() => {
        if (campoRef.current) ajustarAltura(campoRef.current);
      });
    };
    rec.onerror = (ev: any) => {
      toast("ditado: " + String(ev?.error ?? "falhou") + " (o microfone pode estar bloqueado)");
      setDitando(false);
    };
    rec.onend = () => setDitando(false);
    recRef.current = rec;
    setDitando(true);
    try {
      rec.start();
    } catch {
      setDitando(false);
    }
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

  /* o botão "regenerar" só faz sentido na ÚLTIMA resposta (a que está no fim da corrida) */
  let idxUltimaResposta = -1;
  for (let k = msgs.length - 1; k >= 0; k--) {
    if (msgs[k].papel === "assistant" && !msgs[k].fala && !msgs[k].escrevendo) {
      idxUltimaResposta = k;
      break;
    }
  }

  return (
    <section className="chat-tela flex flex-col gap-3 max-[720px]:gap-0" id="telaChat">
      {/* v3.16: a pílula (modelo+gaveta) subiu para a lateral e o reset desceu para o pé,
           ao lado da caixa de escrita. Esta linha só existe no celular, como porta ☰. */}
      <div className="chat-topo">
        <button
          id="chatMenuCelular"
          className="chat-acao"
          aria-label="abrir menu"
          title="menu"
          onClick={onAbrirMenu}
        >
          ☰
        </button>
        <span className="flex-1" />
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
                  {/* v3.18 (T012/T020/T003): hora, copiar a própria pergunta e editar-e-reenviar */}
                  <span className="chat-acoes chat-acoes-eu">
                    {m.when && <span className="chat-hora">{fmtHora(m.when)}</span>}
                    <button
                      className="chat-acao-icone"
                      title="copiar a pergunta"
                      aria-label="copiar a pergunta"
                      onClick={() => void copiarTexto(m.texto, "pergunta copiada")}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                        <rect x="9" y="9" width="11" height="11" rx="2" />
                        <path d="M15 5H6a2 2 0 0 0-2 2v9" />
                      </svg>
                    </button>
                    {m.sid !== undefined && !rodando && editando === null && (
                      <button
                        className="chat-acao-icone"
                        title="editar e reenviar (corta daqui para frente)"
                        aria-label="editar pergunta"
                        onClick={() => comecarEdicao(m.sid as number, m.texto)}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                          <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z" />
                        </svg>
                      </button>
                    )}
                    {editando === m.sid && <span className="chat-hora">editando aí embaixo…</span>}
                  </span>
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
              {/* v3.18 (T004): de onde a resposta veio — os documentos que a busca tocou.
                 Chip só com fonte real; resposta sem ferramentas não inventa procedência. */}
              {m.papel === "assistant" && m.fontes && m.fontes.length > 0 && (
                <div className="chat-fontes" title="documentos usados nesta resposta">
                  {m.fontes.slice(0, 6).map((f, k) => (
                    <span className="chat-fonte" key={k}>{f}</span>
                  ))}
                </div>
              )}
              {/* ações sobre a resposta pronta. v3.18: "refazer" virou REGENERAR — o corte
                 de histórico no servidor (T002) foi o osso que faltava. */}
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
                  {i === idxUltimaResposta && !rodando && (
                    <button
                      className="chat-acao-icone"
                      title="regenerar a resposta (refaz a última pergunta)"
                      aria-label="regenerar"
                      onClick={() => void regenerar()}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                        <path d="M20 12a8 8 0 1 1-2.3-5.6" />
                        <path d="M20 4v5h-5" />
                      </svg>
                    </button>
                  )}
                  {m.when && <span className="chat-hora">{fmtHora(m.when)}</span>}
                  {m.custo && Number(m.custo.tok_out ?? 0) > 0 && (
                    <span className="chat-hora" title={(m.custo.tok_in ? `${m.custo.tok_in} tok de entrada · ` : "") + "tokens da resposta"}>
                      {Number(m.custo.tok_out)} tok
                    </span>
                  )}
                  {m.provedor && (
                    <span className="chat-hora" title={m.modelo ? "modelo: " + m.modelo : ""}>via {m.provedor}</span>
                  )}
                </div>
              ) : null}
              {m.aviso && <div className="sub2 mt-1">aviso: {m.aviso}</div>}
              {m.compacto && <div className="sub2 mt-1">{m.compacto}</div>}
              {/* v3.18 (T013): erro com botão de repetir visível — antes, a frase de erro
                 morava sozinha na tela e a pessoa recomeçava do zero sem saber */}
              {m.falha && (
                <div className="chat-acoes">
                  <button className="btn btn-mini" onClick={repetirUltima}>↻ tentar de novo</button>
                </div>
              )}
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
        {/* v3.16 — pé da conversa: "nova conversa" mudou de lado e desceu para a linha do
            campo, oposto ao enviar (ação perto do dedo, nada de reset no topo). A dica de
            teclado saiu da tela — vive no título (hover) do campo. */}
        <div className="chat-piso" id="chatPiso">
          {rodando && (
            <p className="chat-segundo-plano" id="chatSegundoPlano" title="a tarefa continua mesmo se você for ver outra página">
              · trabalhando em segundo plano{naFila > 0 ? ` · ${naFila} na fila` : ""}
            </p>
          )}
          <div className="chat-piso-linha">
            {/* v3.18 (T017): descer a conversa em markdown — nada de PrintScreen */}
            <button
              id="chatExportar"
              className="chat-acao"
              title="exportar a conversa (markdown)"
              aria-label="exportar conversa"
              onClick={exportarConversa}
            >
              <svg className="chat-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v11M8 10l4 4 4-4" />
                <path d="M4 19h16" />
              </svg>
            </button>
            <button
              id="chatNovaConversa"
              className="chat-nova"
              title="apagar esta conversa e recomeçar do zero"
              onClick={() => void limpar()}
            >
              <svg className="chat-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 5h16v11h-9l-4 3.5V16H4z" transform="scale(.75) translate(3 2)" />
                <path d="M17 3v6M14 6h6" />
              </svg>
              <span className="chat-nova-rotulo">nova conversa</span>
            </button>
            {provedores.some((p) => p.ativo) && (
              <div className="chat-modelos" data-testid="chatModelos">
                <select
                  aria-label="provedor da conversa"
                  title="que serviço responde esta conversa"
                  value={sel.provedor}
                  onChange={(e) => mudarSelecao({ provedor: e.target.value, modelo: "" })}
                >
                  <option value="">padrão da casa</option>
                  {provedores.filter((p) => p.ativo).map((p) => (
                    <option key={p.id} value={p.nome}>
                      {p.nome}
                      {p.padrao ? " · padrão" : ""}
                    </option>
                  ))}
                </select>
                {selProvedor && (
                  <select
                    aria-label="modelo"
                    title={
                      selProvedor.modelos.length
                        ? selProvedor.modelos_em
                          ? "modelos descobertos (cache de " + selProvedor.modelos_em.slice(0, 10) + ")"
                          : "modelos descobertos"
                        : "só o modelo cadastrado"
                    }
                    value={sel.modelo || selProvedor.modelo}
                    onChange={(e) => mudarSelecao({ provedor: sel.provedor, modelo: e.target.value })}
                  >
                    {(selProvedor.modelos.length ? selProvedor.modelos : [selProvedor.modelo]).map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
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
                placeholder={editando !== null ? "reenviar pergunta editada… (Enter)" : rodando ? "próxima pergunta… (fila)" : "pergunte qualquer coisa…"}
                title={editando !== null ? "Enter reenvia · Esc cancela a edição" : "Enter envia · Shift+Enter quebra linha"}
                enterKeyHint="send"
                value={pergunta}
              onChange={(e) => {
                setPergunta(e.target.value);
                ajustarAltura(e.currentTarget);
              }}
              onKeyDown={(e) => {
                /* v3.18 (T005): Enter QUE ACEITA AUTOCORREÇÃO do teclado não envia — no celular
                   isso mandava a pergunta pela metade (o evento vem com isComposing, e em teclado
                   antigo com keyCode 229). Igual ao truque do Hermes/Open WebUI. */
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (editando !== null) void confirmarEdicao();
                  else enviar();
                } else if (e.key === "Escape" && editando !== null) {
                  cancelarEdicao();
                }
              }}
            />
            {/* v3.18 (T022): ditado por voz do próprio navegador */}
            <button
              id="chatMic"
              className={"chat-acao-icone" + (ditando ? " chat-mic-vivo" : "")}
              title={ditando ? "parar de ditar" : "ditar a pergunta (voz)"}
              aria-label="ditar"
              onClick={alternarDitado}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </svg>
            </button>
            {rodando && (
              /* v3.18 (T001): parar — o servidor corta a chamada e o que chegou fica na tela */
              <button
                id="chatParar"
                className="chat-acao-icone"
                title={snap.parando ? "parando…" : "parar esta resposta"}
                aria-label="parar a resposta"
                disabled={snap.parando}
                onClick={pararResposta}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            )}
            {editando !== null && (
              <button className="btn btn-mini" title="cancelar a edição (Esc)" onClick={cancelarEdicao}>
                ✕<span className="chat-editar-rotulo"> editar</span>
              </button>
            )}
            <button
              id="chatEnviar"
              className="chat-enviar"
              disabled={!pergunta.trim()}
              title={editando !== null ? "reenviar editada" : rodando ? "colocar na fila" : "enviar"}
              onClick={editando !== null ? confirmarEdicao : enviar}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5" />
                <path d="M5 12l7-7 7 7" />
              </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
