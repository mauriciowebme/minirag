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
import { Config } from "./components/Config";
import { get } from "./services/api";
import type { HealthResp, Vista } from "./types";

/* A ordem é do dono (21/10, v3.2.2): Chat logo depois de Painel; Usuários/Gavetas
   em cima de Configurações. Arquivos e Editor são passos internos (usuário → gaveta
   → arquivos → nota) e não aparecem aqui. */
const MENU: { id: Vista; rotulo: string; icone: string }[] = [
  { id: "painel", rotulo: "Painel", icone: "▦" },
  { id: "chat", rotulo: "Chat", icone: "💬" },
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
const VISTAS_DO_COMUM: Vista[] = ["chat", "buscar", "jobs"];

const TITULOS: Record<Vista, string> = {
  painel: "Painel",
  gavetas: "Usuários",
  arquivos: "Arquivos",
  editor: "Editor",
  chat: "Chat",
  buscar: "Buscar",
  jobs: "Fila",
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
      if (sujo && !confirm("descartar o que você digitou no editor?")) return;
      setSujo(false);
      setVista(destino);
      setMenuAberto(false);
    },
    [sujo, sessao.logado, sessao.sessao.operador],
  );

  if (!sessao.logado) {
    return (
      <div className="min-h-screen">
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
      {MENU.filter((m) => operador || VISTAS_DO_COMUM.includes(m.id)).map((m) => {
        const ativo = m.id === "gavetas" ? DENTRO_DO_CAMINHO.has(vista) : vista === m.id;
        const rotulo = m.id === "gavetas" ? (operador ? "Usuários" : "Gavetas") : m.rotulo;
        return (
          <button key={m.id} data-menu={m.id} className={"nav-item" + (ativo ? " nav-item-on" : "")} onClick={() => navegar(m.id)}>
            <span className="w-4 text-center opacity-90" aria-hidden="true">
              {m.icone}
            </span>
            {rotulo}
          </button>
        );
      })}

      <div className="mt-auto border-t border-borda pt-3">
        <div className="flex items-center gap-2 px-1">
          <div className="grid h-8 w-8 place-items-center rounded-[10px] border border-bordaforte bg-sup3 text-[12px] text-verde">
            {(nome || "?").slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold">{nome}</div>
            <div className="text-[11px] text-txt3">{operador ? "vê tudo · admin" : "usuário"}</div>
          </div>
        </div>
        <button id="btnSair" className="btn btn-sutil mt-2 w-full justify-start" title="sair da sessão" onClick={() => sessao.sair()}>
          sair
        </button>
      </div>
    </aside>
  );

  return (
    <div className="flex min-h-screen">
      <div className="sticky top-0 hidden h-screen lg:block">{lateral}</div>

      {menuAberto && (
        <div className="fixed inset-0 z-30 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMenuAberto(false)} />
          <div className="absolute inset-y-0 left-0 border-r border-borda bg-sup shadow-painel">{lateral}</div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-borda bg-bg/95 px-4 py-2.5 backdrop-blur sm:px-6">
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
              👤 {tenant}
            </span>
          )}
        </header>

        <main className="mx-auto w-full max-w-[1180px] px-4 pb-12 pt-5 sm:px-6">
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

          {vista === "chat" && <Chat escopo={{ tenant, memoria }} operador={operador} onIrConfig={() => navegar("config")} />}

          {vista === "buscar" && <Buscar escopo={{ tenant, memoria }} operador={operador} onAbrirEditor={(id) => abrirEditor(id)} />}

          {vista === "jobs" && <Jobs tenant={tenant} nome={nome} operador={operador} />}

          {vista === "config" && (
            <Config
              nome={nome}
              operador={operador}
              tenant={tenant}
              onChaveNova={(c) => sessao.trocarChave(c)}
              onIrPainel={() => navegar("painel")}
            />
          )}
        </main>

        <footer id="rodape" className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center gap-3 px-4 pb-8 text-[12px] text-txt3 sm:px-6">
          <span id="ver" className="chip">
            {versao ? `versão ${versao}` : ""}
          </span>
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