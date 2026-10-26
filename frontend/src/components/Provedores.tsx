import { useCallback, useEffect, useState } from "react";
import { del, get, patch, post, put } from "../services/api";
import { useToast } from "./Toast";
import type { Provedor } from "../types";

/** v3.19: cadastro dos provedores nomeados. O operador registra cada serviço uma vez
 *  (nome + URL + chave); os modelos vêm do próprio serviço no botão "descobrir" —
 *  é assim que o Open WebUI e o Hermes fazem. O usuário escolhe na hora da conversa. */
export function Provedores({ operador }: { operador: boolean }) {
  const { toast } = useToast();
  const [lista, setLista] = useState<Provedor[]>([]);
  const [novo, setNovo] = useState({ nome: "", tipo: "litellm", base_url: "", chave: "", modelo: "", paraTodos: true });
  const [editando, setEditando] = useState<string | null>(null);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [rodando, setRodando] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const r = await get<{ provedores: Provedor[] }>("/provedores");
      setLista(r.provedores);
    } catch (e) {
      toast("provedores: " + (e as Error).message);
    }
  }, [toast]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  function preencher(p: Provedor) {
    setEditando(p.nome);
    setNovo({ nome: p.nome, tipo: p.tipo, base_url: p.base_url, chave: "", modelo: p.modelo, paraTodos: p.escopo === "*" });
    setMostrarForm(true);
  }

  async function salvar() {
    setRodando("form");
    try {
      await put("/provedores", {
        nome: novo.nome.trim(),
        tipo: novo.tipo,
        base_url: novo.base_url.trim(),
        modelo: novo.modelo.trim(),
        /* "serve para todos" = escopo global, como no provider da casa */
        tenant: novo.paraTodos ? "global" : "",
        ...(novo.chave ? { chave: novo.chave } : {}),
      });
      toast(editando ? "provedor atualizado" : "provedor cadastrado — descubra os modelos para o chat escolher");
      setNovo({ nome: "", tipo: "litellm", base_url: "", chave: "", modelo: "", paraTodos: true });
      setEditando(null);
      setMostrarForm(false);
      await carregar();
    } catch (e) {
      toast("salvar provedor: " + (e as Error).message);
    } finally {
      setRodando(null);
    }
  }

  /** AUTO-DESCOBERTA: o serviço devolve a lista dele (GET /models; Ollama: /api/tags). */
  async function descobrir(p: Provedor) {
    setRodando(p.nome);
    try {
      const r = await post<{ modelos: string[]; aviso?: string }>("/provedores/modelos", { id: p.id });
      toast(
        r.modelos.length
          ? `${p.nome}: ${r.modelos.length} modelo(s) descobertos`
          : (r.aviso ?? "descobrir modelos: o serviço não devolveu lista"),
      );
      await carregar();
    } catch (e) {
      toast("descobrir modelos: " + (e as Error).message);
    } finally {
      setRodando(null);
    }
  }

  async function definirPadrao(p: Provedor) {
    setRodando(p.nome);
    try {
      await patch("/provedores/padrao", { id: p.id });
      toast(`"${p.nome}" agora é o padrão — vale para quem não escolhe nada na conversa`);
      await carregar();
    } catch (e) {
      toast("definir padrão: " + (e as Error).message);
    } finally {
      setRodando(null);
    }
  }

  async function alternar(p: Provedor) {
    setRodando(p.nome);
    try {
      /* chave "***" = mantém a gravada (nunca reenviar segredo do formulário) */
      await put("/provedores", {
        nome: p.nome,
        tipo: p.tipo,
        base_url: p.base_url,
        modelo: p.modelo,
        chave: "***",
        ativo: !p.ativo,
      });
      await carregar();
    } catch (e) {
      toast("ligar/desligar: " + (e as Error).message);
    } finally {
      setRodando(null);
    }
  }

  async function apagar(p: Provedor) {
    if (!confirm(`apagar o provedor "${p.nome}"? as conversas voltam a usar o padrão da casa.`)) return;
    setRodando(p.nome);
    try {
      await del(`/provedores/${p.id}`);
      toast("provedor removido");
      await carregar();
    } catch (e) {
      toast("remover: " + (e as Error).message);
    } finally {
      setRodando(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="cartao">
        <h2 className="mb-1 text-[13px] font-semibold text-txt2">Provedores nomeados</h2>
        <p className="dica mt-0 mb-3">
          cada linha é um serviço de modelos (litellm, OpenAI-compatível ou Ollama). Cadastre a URL e a chave uma vez,
          toque em <b>descobrir modelos</b> e a lista aparece sozinha no seletor do chat. O <b>padrão da casa</b> continua
          valendo para quem não escolher nada. {operador ? "" : "Só o operador cadastra."}
        </p>
        <table className="tabela" id="listaProvedores">
          <thead>
            <tr>
              <th>nome</th>
              <th>endereço</th>
              <th>modelo</th>
              <th>modelos</th>
              <th>acesso</th>
              <th>estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lista.length === 0 && (
              <tr>
                <td colSpan={7} className="dica">
                  nenhum provedor cadastrado — o chat usa o padrão da casa (Configurações → Provider do chat)
                </td>
              </tr>
            )}
            {lista.map((p) => (
              <tr key={p.id} id={"prov-" + p.nome}>
                <td>
                  <b className="mono">{p.nome}</b>
                  <span className="sub2 block">{p.tipo}</span>
                </td>
                <td className="mono break-all">{p.base_url}</td>
                <td className="mono break-all">{p.modelo || "—"}</td>
                <td>
                  {p.modelos.length ? (
                    <span title={p.modelos.join("\n")}>
                      {p.modelos.length}
                      <span className="sub2 block">{p.modelos_em ? p.modelos_em.slice(0, 10) : ""}</span>
                    </span>
                  ) : (
                    <span className="sub2">nenhum descoberto</span>
                  )}
                </td>
                <td className="mono">{p.chave_mascarada || "sem chave"}</td>
                <td>
                  {p.padrao ? (
                    <span className="chip chip-verde">padrão</span>
                  ) : p.ativo ? (
                    <span className="chip chip-verde">ligado</span>
                  ) : (
                    <span className="chip">desligado</span>
                  )}
                </td>
                {operador && (
                  <td className="text-right">
                    <button className="btn btn-mini" disabled={rodando === p.nome} onClick={() => void descobrir(p)}>
                      descobrir modelos
                    </button>
                    {!p.padrao && (
                      <button className="btn btn-mini ml-1" disabled={rodando === p.nome} onClick={() => void definirPadrao(p)}>
                        padrão
                      </button>
                    )}
                    <button className="btn btn-mini ml-1" disabled={rodando === p.nome} onClick={() => void alternar(p)}>
                      {p.ativo ? "desligar" : "ligar"}
                    </button>
                    <button className="btn btn-mini ml-1" disabled={rodando === p.nome} onClick={() => preencher(p)}>
                      editar
                    </button>
                    <button className="btn btn-mini ml-1" disabled={rodando === p.nome} onClick={() => void apagar(p)}>
                      apagar
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>

        {!mostrarForm && operador && (
          <button id="btnNovoProvedor" className="btn mt-3 self-start" onClick={() => { setEditando(null); setMostrarForm(true); }}>
            + cadastrar provedor
          </button>
        )}

        {mostrarForm && operador && (
          <div className="mt-3 flex max-w-[560px] flex-col gap-3 border-t border-borda pt-3" id="formNovoProvedor">
            <label className="rotulo m-0">
              nome (é o que aparece no seletor do chat)
              <input id="provNome" className="campo mt-1" value={novo.nome} placeholder="ex.: claude, gemini, llama-local"
                disabled={Boolean(editando)} onChange={(e) => setNovo({ ...novo, nome: e.target.value })} />
            </label>
            <label className="rotulo m-0">
              tipo
              <select id="provTipo" className="campo mt-1" value={novo.tipo} onChange={(e) => setNovo({ ...novo, tipo: e.target.value })}>
                <option value="litellm">litellm / OpenAI-compatível</option>
                <option value="openai">openai</option>
                <option value="ollama">ollama</option>
              </select>
            </label>
            <label className="rotulo m-0">
              URL do serviço
              <input id="provUrl" className="campo mt-1 mono" value={novo.base_url} placeholder="https://gw.exemplo.com/v1"
                onChange={(e) => setNovo({ ...novo, base_url: e.target.value })} />
            </label>
            <label className="rotulo m-0">
              chave {editando ? "(deixe em branco para manter a atual)" : ""}
              <input id="provChave" className="campo mt-1 mono" type="password" value={novo.chave} placeholder={editando ? "••••••" : "sk-…"}
                onChange={(e) => setNovo({ ...novo, chave: e.target.value })} />
            </label>
            <label className="rotulo m-0">
              modelo preferido (o chat pode trocar por outro descoberto)
              <input id="provModelo" className="campo mt-1 mono" value={novo.modelo} placeholder="ex.: claude-sonnet-4-20250514"
                onChange={(e) => setNovo({ ...novo, modelo: e.target.value })} />
            </label>
            <label className="check">
              <input id="provGlobal" type="checkbox" checked={novo.paraTodos}
                onChange={(e) => setNovo({ ...novo, paraTodos: e.target.checked })} />
              servir para todos (global) — desmarcado, só o teu escopo usa
            </label>
            <div>
              <button id="btnSalvarProvedor" className="btn" disabled={rodando === "form"} onClick={() => void salvar()}>
                {editando ? "salvar mudanças" : "cadastrar"}
              </button>
              <button className="btn btn-mini ml-2" onClick={() => { setMostrarForm(false); setEditando(null); setNovo({ nome: "", tipo: "litellm", base_url: "", chave: "", modelo: "", paraTodos: true }); }}>
                fechar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
