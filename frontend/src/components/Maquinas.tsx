import { useCallback, useEffect, useState } from "react";
import { del, get, patch, post } from "../services/api";
import { useToast } from "./Toast";
import type { MaquinaLinha, MaquinasLogLinha, MaquinasResp, PareamentoResp } from "../types";

/* v3.6: máquinas do usuário (o túnel absorvido). Cada login comum vê e gerencia
   as SUAS; o admin vê todas e pode apontar o pareamento para um tenant com ?tenant.
   A parede de verdade está na API (alvoMaquina escopa pelo login). */

function minutesAgo(iso: string | null): string {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "agora";
  if (s < 3600) return Math.floor(s / 60) + "min";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

export function Maquinas({ operador }: { operador: boolean }) {
  const { toast } = useToast();
  const [maquinas, setMaquinas] = useState<MaquinaLinha[]>([]);
  const [log, setLog] = useState<MaquinasLogLinha[]>([]);
  const [nomeNovo, setNomeNovo] = useState("");
  const [tenantNovo, setTenantNovo] = useState("");
  const [criando, setCriando] = useState(false);
  const [pareamento, setPareamento] = useState<PareamentoResp | null>(null);

  const carregar = useCallback(() => {
    void get<MaquinasResp>("/maquinas")
      .then((r) => setMaquinas(r.maquinas))
      .catch((e) => toast("máquinas: " + (e as Error).message));
    void get<{ log: MaquinasLogLinha[] }>("/maquinas/log?limit=30")
      .then((r) => setLog(r.log))
      .catch(() => undefined);
  }, [toast]);

  useEffect(() => {
    carregar();
    const rel = setInterval(carregar, 8000);
    return () => clearInterval(rel);
  }, [carregar]);

  async function parear() {
    if (!nomeNovo.trim()) return;
    setCriando(true);
    try {
      const suf = operador && tenantNovo.trim() ? "?tenant=" + encodeURIComponent(tenantNovo.trim()) : "";
      const r = await post<PareamentoResp>("/maquinas" + suf, { nome: nomeNovo.trim() });
      setPareamento(r);
      setNomeNovo("");
      toast("token gerado — ele aparece uma única vez, copie agora");
    } catch (e) {
      toast("parear: " + (e as Error).message);
    } finally {
      setCriando(false);
    }
  }

  async function ativar(m: MaquinaLinha, ativo: boolean) {
    try {
      await patch(`/maquinas/${encodeURIComponent(m.host)}?tenant=${encodeURIComponent(m.tenant)}`, { ativo });
      toast(`${m.host} ${ativo ? "reativada" : "desativada"}`);
      carregar();
    } catch (e) {
      toast("interruptor: " + (e as Error).message);
    }
  }

  async function apagar(m: MaquinaLinha) {
    if (!window.confirm(`apagar a máquina ${m.host}? o cliente dela precisa ser re-pareado.`)) return;
    try {
      await del(`/maquinas/${encodeURIComponent(m.host)}?tenant=${encodeURIComponent(m.tenant)}`);
      toast(`${m.host} removida`);
      carregar();
    } catch (e) {
      toast("apagar: " + (e as Error).message);
    }
  }

  return (
    <section className="flex flex-col gap-3" id="telaMaquinas">
      <div className="barra">
        <h2>
          Máquinas <span className="sub2">— {operador ? "todas as máquinas (admin)" : "as suas máquinas"}</span>
        </h2>
      </div>

      {pareamento && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3" id="maqTokenCaixa">
          <div className="mb-1 text-[12px] font-semibold text-amber-300">
            Token de pareamento — aparece só esta vez, vale {Math.round((pareamento.segundos ?? 900) / 60)} min, uso único
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 select-all break-all rounded bg-black/40 p-2 text-[12px]" id="maqTokenTexto">
              {pareamento.token}
            </code>
            <button
              className="btn self-start"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(pareamento.token)
                  .then(() => toast("token copiado"))
                  .catch(() => toast("copie manualmente"));
              }}
            >
              copiar
            </button>
            <button className="btn self-start" onClick={() => setPareamento(null)}>
              fechei
            </button>
          </div>
          <div className="mt-2 flex items-center gap-3 text-[11px] text-txt3">
            <span>cliente na máquina (dê duplo clique ou rode no terminal):</span>
            <a id="baixarClienteWin" className="text-azul underline" href="/maquina/cliente/win" download>
              ⬓ baixar para Windows
            </a>
            <a id="baixarClienteLinux" className="text-azul underline" href="/maquina/cliente/linux" download>
              ⬓ baixar para Linux
            </a>
          </div>
        </div>
      )}

      <div className="cartao">
        <h3 className="mb-1 text-[13px] font-semibold text-txt2">Binários do cliente</h3>
        <p className="dica mt-0 mb-2">
          rode na máquina que você quer controlar, com um token gerado abaixo. Clientes desta versão se
          auto-atualizam: quando sair versão nova, a máquina baixa e religa sozinha.
        </p>
        <div className="flex flex-wrap gap-2">
          <a id="binarioClienteWin" className="btn" href="/maquina/cliente/win" download>
            ⬓ Windows (.exe)
          </a>
          <a id="binarioClienteLinux" className="btn" href="/maquina/cliente/linux" download>
            ⬓ Linux
          </a>
        </div>
        <p className="dica mt-2 mb-0">
          primeiro acesso no Windows: o SmartScreen avisa (binário sem assinatura) — escolha Manter/mais
          informações e rode mesmo, é o seu próprio programa.
        </p>
      </div>

      <div className="cartao">
        <h3 className="mb-2 text-[13px] font-semibold text-txt2">Adicionar máquina</h3>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="maqNome"
            className="campo w-40"
            placeholder="nome (opcional)"
            value={nomeNovo}
            onChange={(e) => setNomeNovo(e.target.value)}
          />
          {operador && (
            <input
              id="maqTenant"
              className="campo w-40"
              placeholder="tenant (só admin)"
              value={tenantNovo}
              onChange={(e) => setTenantNovo(e.target.value)}
            />
          )}
          <button id="btnParear" className="btn btn-primario" disabled={criando || !nomeNovo.trim()} onClick={() => void parear()}>
            {criando ? "gerando…" : "＋ gerar token"}
          </button>
        </div>
        <div className="mt-2 text-[11px] text-txt3">
          o cliente da máquina se conecta com este token uma vez; depois passa a usar o token de máquina que recebe na resposta
        </div>
      </div>

      <table className="tabela" id="maquinasTabela">
        <thead>
          <tr>
            <th>máquina</th>
            {operador && <th>donos</th>}
            <th>sistema</th>
            <th className="num">estado</th>
            <th className="num">vista</th>
            <th className="acoes">ações</th>
          </tr>
        </thead>
        <tbody>
          {maquinas.length === 0 && (
            <tr>
              <td colSpan={operador ? 6 : 5} className="py-3 text-center text-txt3">
                nenhuma máquina ainda — gere um token e rode o cliente nela
              </td>
            </tr>
          )}
          {maquinas.map((m) => (
            <tr key={m.tenant + "/" + m.host} id={"maq-" + m.host}>
              <td data-rot="máquina">
                <div className="font-medium">{m.host}</div>
                {m.nome && m.nome !== m.host && <div className="text-[11px] text-txt3">{m.nome}</div>}
              </td>
              {operador && (
                <td data-rot="donos">
                  <span className="chip">{m.tenant}</span>
                </td>
              )}
              <td data-rot="sistema">
                <div>{m.so || "—"}</div>
                {m.usuario_win ? <div className="text-[11px] text-txt3">{m.usuario_win}</div> : null}
              </td>
              <td className="num" data-rot="estado">
                <span className={"chip " + (m.online ? "chip-verde" : "")} title={m.online ? "conectada agora" : "offline"}>
                  {m.online ? "● online" : "○ offline"}
                </span>
                {!m.ativo && <div className="text-[11px] text-red-400">desativada</div>}
              </td>
              <td className="num" data-rot="vista">
                {minutesAgo(m.visto_em)}
              </td>
              <td className="acoes">
                <label className="mr-2 inline-flex cursor-pointer items-center gap-1 text-[11px]" title="desligar barra comandos e derruba o cano da máquina">
                  <input
                    type="checkbox"
                    checked={m.ativo}
                    onChange={(e) => void ativar(m, e.target.checked)}
                  />
                  ativa
                </label>
                <button className="btn btn-perigo" onClick={() => void apagar(m)}>
                  apagar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="cartao" id="maqLogCard">
        <h3 className="mb-2 text-[13px] font-semibold text-txt2">
          Histórico de execução <span className="sub2">— tudo o que foi rodado, sem máscara (auditoria)</span>
        </h3>
        {log.length === 0 ? (
          <div className="py-2 text-center text-[12px] text-txt3">nada rodou ainda</div>
        ) : (
          <table className="tabela" id="maqLogTabela">
            <thead>
              <tr>
                <th>quando</th>
                {operador && <th>donos</th>}
                <th>máquina</th>
                <th>comando</th>
                <th className="num">exit</th>
                <th className="num">ms</th>
                <th className="num">origem</th>
              </tr>
            </thead>
            <tbody>
              {log.map((l, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap text-[11px]">{new Date(l.criado_em).toLocaleString("pt-BR")}</td>
                  {operador && <td>{l.tenant}</td>}
                  <td>{l.host}</td>
                  <td className="max-w-[340px] truncate font-mono text-[11px]" title={(l.stdout || "") + (l.stderr ? "\n— stderr: " + l.stderr : "")}>
                    {l.cmd}
                  </td>
                  <td className={"num " + (l.exit === 0 ? "text-emerald-400" : "text-red-400")}>{l.exit}</td>
                  <td className="num">{l.ms}</td>
                  <td className="num">{l.origem}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
