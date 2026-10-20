import { useCallback, useEffect, useState } from "react";
import { useSessao } from "./hooks/useSessao";
import { Login } from "./components/Login";
import { Gavetas } from "./components/Gavetas";
import { Arquivos } from "./components/Arquivos";
import { Editor } from "./components/Editor";
import { Buscar } from "./components/Buscar";
import { Jobs } from "./components/Jobs";
import { get } from "./services/api";
import type { HealthResp, Vista } from "./types";

const ABAS: { id: Vista; rotulo: string }[] = [
  { id: "gavetas", rotulo: "Gavetas" },
  { id: "arquivos", rotulo: "Arquivos" },
  { id: "editor", rotulo: "Editor" },
  { id: "buscar", rotulo: "Buscar" },
  { id: "jobs", rotulo: "Fila" },
];

export default function App() {
  const sessao = useSessao();
  const [vista, setVista] = useState<Vista>("gavetas");
  const [docAberto, setDocAberto] = useState<string | null>(null);
  const [novoNome, setNovoNome] = useState<string | null>(null);
  const [versao, setVersao] = useState("");
  const [sujo, setSujo] = useState(false);
  const [recarregarArquivos, setRecarregarArquivos] = useState(0);

  useEffect(() => {
    void sessao.restaurar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!sessao.logado) return;
    setVista("gavetas");
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

  if (!sessao.logado) {
    return (
      <div className="min-h-screen">
        <Login sessao={sessao} />
        {sessao.restaurando && <p className="mt-4 text-center text-[13px] text-txt3">restaurando sessão…</p>}
      </div>
    );
  }

  const { tenant, memoria, operador, nome } = sessao.sessao;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-[18px] gap-y-1.5 border-b border-borda bg-sup/95 px-4 py-2.5 backdrop-blur sm:px-5">
        <div className="flex items-baseline gap-2 whitespace-nowrap text-[14px] font-semibold tracking-[0.2px]">
          <span className="text-verde">◆</span> minirag
          <span className="text-[12px] font-normal text-txt3">painel de memória</span>
        </div>

        <nav id="nav" className="order-3 -mx-1 flex w-full gap-0.5 overflow-x-auto pb-0.5 sm:order-none sm:mx-0 sm:w-auto sm:flex-1 sm:pb-0">
          {ABAS.filter((a) => a.id !== "editor" || docAberto !== null || novoNome !== null).map((a) => (
            <button
              key={a.id}
              id={a.id === "editor" ? "abaEditor" : undefined}
              data-view={a.id}
              className={`aba ${vista === a.id ? "aba-ativa" : ""}`}
              onClick={() => setVista(a.id)}
            >
              {a.rotulo}
            </button>
          ))}
        </nav>

        <div id="userbox" className="ml-auto flex items-center gap-2 border-borda pl-0 text-[13px] text-txt2 sm:border-l sm:pl-3.5">
          <span id="quo" className="max-w-[160px] truncate">
            {nome}
          </span>
          <span id="chipEscopo">
            {operador ? <span className="chip chip-op">operador · vê tudo</span> : <span className="chip">tenant</span>}
          </span>
          <button id="btnSair" className="btn btn-sutil" title="sair da sessão" onClick={() => sessao.sair()}>
            sair
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1120px] px-5 pb-10 pt-[22px]">
        {vista === "gavetas" && (
          <Gavetas
            operador={operador}
            onAbrir={(t, m) => {
              sessao.escopo(t, m);
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
            onEscopoVazio={() => {
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

        {vista === "buscar" && <Buscar escopo={{ tenant, memoria }} operador={operador} onAbrirEditor={(id) => abrirEditor(id)} />}

        {vista === "jobs" && <Jobs tenant={tenant} nome={nome} operador={operador} />}
      </main>

      <footer id="rodape" className="mx-auto flex max-w-[1120px] flex-wrap items-center gap-3 px-5 pb-8 text-[12px] text-txt3">
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
  );
}