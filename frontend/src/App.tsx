import { useCallback, useEffect, useState } from "react";
import { useSessao } from "./hooks/useSessao";
import { Login } from "./components/Login";
import { Gavetas } from "./components/Gavetas";
import { Arquivos } from "./components/Arquivos";
import { Editor } from "./components/Editor";
import { Buscar } from "./components/Buscar";
import { Jobs } from "./components/Jobs";
import { Painel } from "./components/Painel";
import { Chat } from "./components/Chat";
import { Config, SECOES_CFG, type Aba } from "./components/Config";
import { Maquinas } from "./components/Maquinas";
import { get, qs } from "./services/api";
import type { GavetasResp, HealthResp, ProviderResp, Vista } from "./types";

/* A ordem é do dono (21/10, v3.2.2): Chat logo depois de Painel; Usuários/Gavetas
   em cima de Configurações. Arquivos e Editor são passos internos (usuário → gaveta
   → arquivos → nota) e não aparecem aqui. */
const MENU: { id: Vista; rotulo: string; icone: string }[] = [
  { id: "painel", rotulo: "Painel", icone: "▦" },
  { id: "chat", rotulo: "Chat", icone: "💬" },
  { id: "maquinas", rotulo: "Máquinas", icone: "🖥" },
  { id: "buscar", rotulo: "Buscar", icone: "⌕" },
  { id: "jobs", rotulo: "Fila", icone: "≡" },
  { id: "gavetas", rotulo: "Gavetas", icone: "👤" },
  { id: "config", rotulo: "Configurações", icone: "⚙" },
];

const DENTRO_DO_CAMINHO = new Set<Vista>(["gavetas", "arquivos", "editor"]);

/* v3.4 (política do dono, 21/10): o usuário comum só tem três lugares na tela —
   Chat, Buscar e Fila. Painel, Usuários/Gavetas e Configurações são do admin.
   A parede de verdade está na API (dashboard/config gravam exigem operador);
   o filtro aqui é a consequência visual, não a segurança. */
const VISTAS_DO_COMUM: Vista[] = ["chat", "maquinas", "buscar", "jobs"];

const TITULOS: Record<Vista, string> = {
  painel: "Painel",
  gavetas: "Usuários",
  arquivos: "Arquivos",
  editor: "Editor",
  chat: "Chat",
  buscar: "Buscar",
  jobs: "Fila",
  maquinas: "Máquinas",
  config: "Configurações",
};

export default function App() {
  const sessao = useSessao();
  const [vista, setVista] = useState<Vista>("painel");
  const [usuarioAberto, setUsuarioAberto] = useState<string | null>(null);
  const [docAberto, setDocAberto] = useState<string | null>(null);
  const [novoNome, setNovoNome] = useState<string | null>(null);
  const [versao, setVersao] = useState("");
  const [sujo, setSujo] = useState(false);
  const [recarregarArquivos, setRecarregarArquivos] = useState(0);
  const [menuAberto, setMenuAberto] = useState(false);
  /* v3.19.1 (dono, 26/10): Configurações no menu principal é PAI com submenu —
     a aba interna do Config passou a viver aqui em cima para o filho marcado
     refletir a seção aberta, e navegar para o filho cair direto nela. */
  const [cfgAberto, setCfgAberto] = useState(false);
  const [abaConfig, setAbaConfig] = useState<Aba>("provider");

  /* v3.14.1 — no celular o chat ocupa a tela toda e o ☰ virou a única porta de saída da
     conversa: Esc fecha a gaveta (antes só fechava clicando no fundo escuro). */
  useEffect(() => {
    if (!menuAberto) return;
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuAberto(false);
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [menuAberto]);
  /* v3.6.1: a aba Máquinas vive e morre com o interruptor de Controle das máquinas
     (Configurações → Ferramentas), igual à tela do túnel — desligado, some a aba. */
  const [controleMaq, setControleMaq] = useState(true);

  /* v3.16: o contexto da conversa (gaveta em uso + modelo) passou a morar na lateral.
     As buscas viviam dentro do Chat, na pílula do topo; com o bloco compartilhado,
     quem é dono da lateral (App) busca e o Chat recebe por props. */
  const [gavetas, setGavetas] = useState<{ memoria: string; rotulo: string; fixada: boolean }[]>([{ memoria: "", rotulo: "padrão", fixada: false }]);
  const [provider, setProvider] = useState<ProviderResp | null>(null);
  useEffect(() => {
    if (!sessao.logado) return;
    const t = sessao.sessao.tenant;
    const op = sessao.sessao.operador;
    void (async () => {
      try {
        const g = await get<GavetasResp>("/gavetas" + (t ? "?" + qs({ tenant: t }) : ""));
        /* v3.18 (T015/T016/T019): rótulo (manual ou automático) na barra, fixada no topo,
           arquivada FORA da barra — quem arquiva ainda vê e devolve pela página Gavetas. */
        const porMemoria = new Map<string, { memoria: string; rotulo: string; fixada: boolean }>();
        for (const x of g.gavetas) {
          if (x.arquivada || porMemoria.has(x.memoria)) continue;
          porMemoria.set(x.memoria, { memoria: x.memoria, rotulo: x.titulo || x.memoria || "padrão", fixada: Boolean(x.fixada) });
        }
        const lista = [...porMemoria.values()].sort(
          (a, b) => Number(b.fixada) - Number(a.fixada) || a.rotulo.localeCompare(b.rotulo),
        );
        setGavetas(lista.length ? lista : [{ memoria: "", rotulo: "padrão", fixada: false }]);
      } catch {
        /* segue com a gaveta padrão */
      }
      try {
        setProvider(await get<ProviderResp>("/config/provider" + (t && op ? "?" + qs({ tenant: t }) : "")));
      } catch {
        setProvider(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessao.logado, sessao.sessao.tenant, vista]);

  useEffect(() => {
    void sessao.restaurar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!sessao.logado) return;
    setUsuarioAberto(null);
    /* comum não tem Painel: o ponto de entrada dele é o Chat (v3.4) */
    setVista(sessao.sessao.operador ? "painel" : "chat");
    get<HealthResp>("/health")
      .then((h) => setVersao(h.versao || "?"))
      .catch(() => undefined);
    get<{ controle_maquinas?: boolean }>("/config/mcp")
      .then((r) => setControleMaq(r.controle_maquinas !== false))
      .catch(() => undefined);
  }, [sessao.logado]);

  useEffect(() => {
    function antesDeSair(e: BeforeUnloadEvent) {
      if (sujo) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", antesDeSair);
    return () => window.removeEventListener("beforeunload", antesDeSair);
  }, [sujo]);

  const abrirEditor = useCallback((docId: string | null, nomeNovo: string | null = null) => {
    setDocAberto(docId);
    setNovoNome(nomeNovo);
    setVista("editor");
  }, []);

  const fecharEditor = useCallback(() => {
    setSujo(false);
    setDocAberto(null);
    setNovoNome(null);
    setRecarregarArquivos((n) => n + 1);
    setVista("arquivos");
  }, []);

  const navegar = useCallback(
    (destino: Vista) => {
      /* v3.4: se o comum tentar ir a módulo de admin (por qualquer caminho), fica no Chat */
      if (sessao.logado && !sessao.sessao.operador && !VISTAS_DO_COMUM.includes(destino)) destino = "chat";
      /* máquina desligada na config não tem aba: admin cai na Configurações (o interruptor mora lá) */
      if (destino === "maquinas" && !controleMaq) destino = operador ? "config" : "chat";
      if (sujo && !confirm("descartar o que você digitou no editor?")) return;
      setSujo(false);
      setVista(destino);
      setMenuAberto(false);
    },
    [sujo, sessao.logado, sessao.sessao.operador, controleMaq],
  );

  const cliqueConfig = useCallback(() => {
    if (vista === "config") setCfgAberto((v) => !v);
    else {
      navegar("config");
      setCfgAberto(true);
    }
  }, [vista, navegar]);

  if (!sessao.logado) {
    return (
      <div className="min-h-[100dvh]">
        <Login sessao={sessao} />
        {sessao.restaurando && <p className="mt-4 text-center text-[13px] text-txt3">restaurando sessão…</p>}
      </div>
    );
  }

  const { tenant, memoria, operador, nome } = sessao.sessao;
  const titulo = vista === "gavetas" && !operador ? "Gavetas" : TITULOS[vista];

  const lateral = (
    <aside className="flex h-full w-[224px] flex-none flex-col gap-0.5 border-r border-borda bg-sup px-2.5 py-4">
      <div className="flex items-center gap-2 px-2 pb-4 text-[15px] font-semibold tracking-[0.2px]">
        <span className="text-verde">◆</span> minirag
      </div>

      {/* Um menu só, na ordem definida pelo dono (sem títulos de grupo: "visão geral"
          e "memória" saíram — a divisão não ajudava a achar nada). */}
      {MENU.filter((m) => (operador || VISTAS_DO_COMUM.includes(m.id)) && (m.id !== "maquinas" || controleMaq)).map((m) => {
        const ativo = m.id === "gavetas" ? DENTRO_DO_CAMINHO.has(vista) : vista === m.id;
        const rotulo = m.id === "gavetas" ? (operador ? "Usuários" : "Gavetas") : m.rotulo;
        const botao = (
          <button
            key={m.id}
            data-menu={m.id}
            aria-current={ativo ? "page" : undefined}
            aria-expanded={m.id === "config" ? cfgAberto : undefined}
            className={"nav-item" + (ativo ? (m.id === "config" && cfgAberto ? " nav-item-suave" : " nav-item-on") : "")}
            onClick={() => (m.id === "config" ? cliqueConfig() : navegar(m.id))}
          >
            <span className="w-4 text-center opacity-90" aria-hidden="true">
              {m.icone}
            </span>
            {rotulo}
            {m.id === "config" && (
              <span className={"nav-seta" + (cfgAberto ? " nav-seta-on" : "")} aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </span>
            )}
          </button>
        );
        /* v3.19.1 (política do dono, 26/10): Configurações é item pai — as seções
           aparecem como FILHOS indentados no menu principal, cada um navegando
           direto para a seção. v3.21: o accordion interno saiu; a lateral é a
           navegação única das seções. */
        if (m.id !== "config") return botao;
        return (
          <div key="config-grupo" className="flex flex-col gap-0.5">
            {botao}
            {cfgAberto && (
              <div className="nav-rail">
                {SECOES_CFG.map(([id, secRotulo]) => (
                  <button
                    key={"cfg-filho-" + id}
                    data-menu-filho={id}
                    aria-current={vista === "config" && abaConfig === id ? "page" : undefined}
                    className={"nav-filho" + (vista === "config" && abaConfig === id ? " nav-filho-on" : "")}
                    onClick={() => {
                      navegar("config");
                      setAbaConfig(id);
                    }}
                  >
                    {secRotulo}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* v3.16: contexto da conversa — a gaveta que o Chat escreve e o modelo em uso.
          Isso vivia numa pílula no topo da conversa; a tela do chat agora é só conversa
          e caixa de escrita. No celular o bloco acompanha a lateral para dentro da gaveta ☰. */}
      <div className="conv-bloco">
        <div className="conv-linha">
          <span className="conv-legenda">gaveta</span>
          <select
            id="chatGaveta"
            className="conv-gav"
            value={memoria}
            onChange={(e) => sessao.escopo(tenant, e.target.value)}
            aria-label="gaveta"
            title={memoria || "padrão"}
          >
            {gavetas.map((g) => (
              <option key={g.memoria} value={g.memoria}>
                {g.fixada ? "📌 " : ""}
                {g.rotulo}
              </option>
            ))}
          </select>
        </div>
        <div className="conv-linha">
          <span className="conv-legenda">modelo</span>
          <span className="mono conv-modelo" title={provider?.modelo ?? "sem modelo"}>
            {provider?.modelo ?? "sem modelo"}
          </span>
        </div>
        {/* v3.16: a linha "› ver detalhes" morava embaixo da caixa de escrita e era o ÚNICO
           lugar onde o usuário comum via provider, chave mascarada e MCP do turno.
           Veio para a lateral junto com o modelo — a tela do chat fica só com a conversa. */}
        {provider && provider.configurado && (
          <details className="conv-detalhe" id="chatRodape">
            <summary>› ver detalhes</summary>
            <p>
              provider {provider.origem === "global" ? "global" : "seu"}
              {provider.chave_mascarada ? ` · chave ${provider.chave_mascarada}` : ""} ·{" "}
              {provider.tem_system_prompt ? "com instruções do modelo" : "sem instruções (conversa pura)"} ·{" "}
              {provider.mcp_interno ? "MCP do minirag ligado" : "MCP do minirag desligado"} · até {provider.max_rodadas} rodada(s) · memória{" "}
              {provider.memoria_turnos} · janela {provider.janela_efetiva.toLocaleString("pt-BR")} tokens ({provider.origem_janela})
            </p>
          </details>
        )}
      </div>

      <div className="mt-auto border-t border-borda pt-3">
        <div className="flex items-center gap-2 px-1">
          <div className="grid h-8 w-8 place-items-center rounded-[10px] border border-bordaforte bg-sup3 text-[12px] text-verde">
            {(nome || "?").slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold">{nome}</div>
            <div className="text-[11px] text-txt3">{operador ? "vê tudo · admin" : "usuário"}</div>
            {/* v3.14.1 — no celular o chat ocupa a tela toda e o chip de foco saiu do topo:
                o usuário em foco passa a viver aqui dentro do menu */}
            {operador && tenant && (
              <div className="truncate text-[11px] text-txt3" title="usuário em foco">
                foco: {tenant}
              </div>
            )}
          </div>
        </div>
        <button id="btnSair" className="btn btn-sutil mt-2 w-full justify-start" title="sair da sessão" onClick={() => sessao.sair()}>
          sair
        </button>
        {/* v3.16: a versão era chip no rodapé da tela; a lateral é a casa única dela
            (o rodapé saiu da tela do chat e repetia o que já estava aqui) */}
        {versao && <div id="ver" className="px-1 pt-1 text-[10.5px] text-txt3">versão {versao}</div>}
      </div>
    </aside>
  );

  return (
    <div className="flex min-h-[100dvh]">
      <div className="sticky top-0 hidden h-screen lg:block">{lateral}</div>

      {menuAberto && (
        <div className="fixed inset-0 z-30 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMenuAberto(false)} />
          <div className="absolute inset-y-0 left-0 border-r border-borda bg-sup shadow-painel">{lateral}</div>
        </div>
      )}

      {/* v3.14 — no Chat, o painel é a janela inteira: sem isso a conversa tinha altura
          chutada no css e o campo de escrita encostava (e às vezes passava) do fim da tela */}
      <div className={"flex min-w-0 flex-1 flex-col" + (vista === "chat" ? " chat-janela h-[100dvh]" : "")}>
        <header
          className={
            "sticky top-0 z-20 flex items-center gap-3 border-b border-borda bg-bg/95 px-4 py-2.5 backdrop-blur sm:px-6" +
            (vista === "chat" ? " hidden" : "")
          }
        >
          <button className="btn btn-sutil btn-mini lg:hidden" aria-label="abrir menu" onClick={() => setMenuAberto(true)}>
            ☰
          </button>
          <h1 className="text-[15px] font-semibold">{titulo}</h1>
          <span className="hidden text-[12px] text-txt3 sm:inline">
            {vista === "painel" ? "visão geral do acervo" : vista === "config" ? "provider do chat, conta e limites" : ""}
          </span>
          <span className="flex-1" />
          {operador && tenant && (
            <span className="chip" title="usuário em foco">
              <span aria-hidden="true">◉</span> {tenant}
            </span>
          )}
        </header>

        <main
          className={
            "mx-auto w-full max-w-[1180px] px-4 pt-5 sm:px-6 " +
            (vista === "chat"
              ? "flex min-h-0 flex-1 flex-col pb-2 max-[720px]:px-0 max-[720px]:pt-0 max-[720px]:pb-0"
              : "pb-12")
          }
        >
          {vista === "painel" && <Painel tenant={tenant} operador={operador} />}

          {vista === "gavetas" && (
            <Gavetas
              operador={operador}
              tenant={tenant}
              usuario={usuarioAberto}
              onAbrirUsuario={(t) => {
                setUsuarioAberto(t);
                setVista("gavetas");
              }}
              onVoltar={() => {
                setUsuarioAberto(null);
                setVista("gavetas");
              }}
              onAbrir={(t, m) => {
                sessao.escopo(t, m);
                setUsuarioAberto(t); // mantém o nível: voltar cai nas gavetas DESTE usuário
                setVista("arquivos");
              }}
            />
          )}

          {vista === "arquivos" && (
            <Arquivos
              key={`${tenant}|${memoria}|${recarregarArquivos}`}
              escopo={{ tenant, memoria }}
              operador={operador}
              onAbrirEditor={(docId, nomeNovo) => abrirEditor(docId, nomeNovo ?? null)}
              onVoltar={() => setVista("gavetas")}
              onEscopoVazio={() => {
                if (operador && usuarioAberto) {
                  setVista("gavetas");
                  return;
                }
                setUsuarioAberto(null);
                sessao.escopo(nome, "");
                setVista("gavetas");
              }}
            />
          )}

          {vista === "editor" && (docAberto !== null || novoNome !== null) && (
            <Editor
              key={docAberto ?? novoNome ?? "novo"}
              escopo={{ tenant, memoria }}
              operador={operador}
              docId={docAberto}
              novoNome={novoNome}
              onFechar={fecharEditor}
              onSalvo={() => setRecarregarArquivos((n) => n + 1)}
              onDirty={setSujo}
            />
          )}

          {vista === "chat" && (
            <Chat
              escopo={{ tenant, memoria }}
              operador={operador}
              provider={provider}
              onProviderConfirmado={() => setProvider((p) => (p ? { ...p, configurado: true } : p))}
              onIrConfig={() => navegar("config")}
              onAbrirMenu={() => setMenuAberto(true)}
            />
          )}

          {vista === "maquinas" && <Maquinas operador={operador} />}
          {vista === "buscar" && <Buscar escopo={{ tenant, memoria }} operador={operador} onAbrirEditor={(id) => abrirEditor(id)} />}

          {vista === "jobs" && <Jobs tenant={tenant} nome={nome} operador={operador} />}

          {vista === "config" && (
            <Config
              nome={nome}
              operador={operador}
              tenant={tenant}
              onChaveNova={(c) => sessao.trocarChave(c)}
              onIrPainel={() => navegar("painel")}
              onControleMaquinas={setControleMaq}
              aba={abaConfig}
            />
          )}
        </main>

        <footer
          id="rodape"
          className={
            "mx-auto flex w-full max-w-[1180px] flex-wrap items-center gap-3 px-4 pb-8 text-[12px] text-txt3 sm:px-6" +
            (vista === "chat" ? " hidden" : "")
          }
        >
          {/* v3.16: o chip de versão saiu do rodapé — a lateral é a casa única dela */}
          <span>
            <kbd className="rounded border border-borda px-1">Ctrl</kbd>+<kbd className="rounded border border-borda px-1">S</kbd> salva ·{" "}
            <kbd className="rounded border border-borda px-1">Esc</kbd> fecha o editor
          </span>
          <span className="flex-1" />
          <span>minirag · memória de documentos com busca semântica</span>
        </footer>
      </div>
    </div>
  );
}