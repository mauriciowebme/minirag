import { useCallback, useEffect, useState } from "react";
import { del, get, patch, post, put, qs } from "../services/api";
import { useToast } from "./Toast";
import type {
  ConfigResp,
  HealthResp,
  ProviderResp,
  ServidorMcp,
  ServidoresResp,
  TesteMcpResp,
} from "../types";

type Aba = "provider" | "ferramentas" | "conta" | "limites" | "esquecimento" | "sistema";

/** Configurações: provider do chat, ferramentas (MCP), conta, limites, esquecimento e sistema. */
export function Config({
  nome,
  operador,
  tenant,
  onChaveNova,
  onIrPainel,
  onControleMaquinas,
}: {
  nome: string;
  operador: boolean;
  tenant: string;
  onChaveNova: (chave: string) => void;
  onIrPainel: () => void;
  onControleMaquinas?: (v: boolean) => void;
}) {
  const [aba, setAba] = useState<Aba>("provider");

  return (
    <section className="flex flex-col gap-3" id="telaConfig">
      <div className="barra">
        <h2>
          Configurações <span className="sub2">— provider, ferramentas e conta</span>
        </h2>
      </div>
      <div className="grade-cfg">
        <nav className="cfg-nav" id="cfgNav">
          {(
            [
              ["provider", "Provider do chat"],
              ["ferramentas", "Ferramentas (MCP)"],
              ["conta", "Conta e chave"],
              ["limites", "Limites"],
              ["esquecimento", "Esquecimento"],
              ["sistema", "Sistema"],
            ] as [Aba, string][]
          ).map(([id, rotulo]) => (
            <button key={id} className={"cfg-item" + (aba === id ? " cfg-item-on" : "")} data-cfg={id} onClick={() => setAba(id)}>
              {rotulo}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {aba === "provider" && <Provider operador={operador} tenant={tenant} onIrPainel={onIrPainel} />}
          {aba === "ferramentas" && <Ferramentas operador={operador} tenant={tenant} onControleMaquinas={onControleMaquinas} />}
          {aba === "conta" && <Conta nome={nome} operador={operador} onChaveNova={onChaveNova} />}
          {aba === "limites" && <Limites />}
          {aba === "esquecimento" && <Esquecimento />}
          {aba === "sistema" && <Sistema />}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- provider */

function Provider({ operador, tenant, onIrPainel }: { operador: boolean; tenant: string; onIrPainel: () => void }) {
  const { toast } = useToast();
  const [p, setP] = useState<ProviderResp | null>(null);
  const [tipo, setTipo] = useState<"litellm" | "openai" | "ollama">("litellm");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelo, setModelo] = useState("");
  const [chave, setChave] = useState("");
  const [temperatura, setTemperatura] = useState("0.2");
  const [prompt, setPrompt] = useState("");
  const [rodadas, setRodadas] = useState("5");
  const [memoria, setMemoria] = useState("12");
  const [verbatim, setVerbatim] = useState("4");
  const [reserva, setReserva] = useState("1024");
  /* v3.2: o tempo que o modelo pode ficar SEM ESCREVER nada antes de eu desistir (0 = padrão 180s).
     Não é limite de duração da resposta: resposta longa que não para de escrever tem todo o tempo. */
  const [silencio, setSilencio] = useState("0");
  const [contexto, setContexto] = useState("0");
  const [ativo, setAtivo] = useState(false);
  const [global, setGlobal] = useState(false);
  const [teste, setTeste] = useState<{ ok: boolean; msg: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const r = await get<ProviderResp>("/config/provider" + (operador && tenant ? "?" + qs({ tenant }) : ""));
      setP(r);
      setTipo(r.tipo);
      setBaseUrl(r.base_url);
      setModelo(r.modelo);
      setTemperatura(String(r.temperatura));
      setPrompt(r.system_prompt ?? "");
      setRodadas(String(r.max_rodadas));
      setMemoria(String(r.memoria_turnos ?? 12));
      setVerbatim(String(r.verbatim_turnos ?? 4));
      setReserva(String(r.reserva_tokens ?? 1024));
      setSilencio(String(r.silencio_s ?? 0));
      setContexto(String(r.contexto_tokens ?? 0));
      setAtivo(r.configurado || r.ativo);
      setChave("");
    } catch (e) {
      toast("provider: " + (e as Error).message);
    }
  }, [operador, tenant, toast]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  function corpo(extra: Record<string, unknown> = {}) {
    return {
      tipo,
      base_url: baseUrl,
      modelo,
      temperatura: Number(temperatura),
      system_prompt: prompt,
      max_rodadas: Number(rodadas),
      memoria_turnos: Number(memoria),
      verbatim_turnos: Number(verbatim),
      reserva_tokens: Number(reserva),
      silencio_s: Number(silencio),
      contexto_tokens: Number(contexto),
      /* para onde este corpo vai: o painel está MOSTRANDO o cliente selecionado, então é nele
         que tem que gravar (defeito da v2.9: o tenant era ignorado e salvava na linha do operador) */
      ...(operador && tenant ? { tenant } : {}),
      ativo,
      global,
      ...(chave ? { chave } : {}),
      ...extra,
    };
  }

  async function testar() {
    setOcupado(true);
    setTeste(null);
    try {
      const r = await post<{ ok: boolean; ms: number; modelo: string; contexto_detectado?: number | null }>(
        "/config/provider/testar",
        corpo(),
      );
      const janela = r.contexto_detectado
        ? ` · janela detectada: ${r.contexto_detectado.toLocaleString("pt-BR")} tokens`
        : " · o provider não informou a janela (digite o número abaixo se quiser)";
      setTeste({ ok: true, msg: `conexão ok · respondeu em ${r.ms} ms · modelo ${r.modelo}${janela}` });
    } catch (e) {
      setTeste({ ok: false, msg: (e as Error).message });
    } finally {
      setOcupado(false);
    }
  }

  async function salvar() {
    setOcupado(true);
    try {
      const r = await put<ProviderResp>("/config/provider", corpo());
      setP(r);
      setChave("");
      toast("provider salvo");
    } catch (e) {
      toast("salvar: " + (e as Error).message);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="cartao">
      <h2 className="mb-3 text-[13px] font-semibold text-txt2">
        Provider do chat{" "}
        <span className="sub2">
          — é o único pré-requisito do Chat · editando:{" "}
          {p?.escopo === "*" || global ? "padrão global (todos os clientes)" : p?.escopo ? `“${p.escopo}” (${p.origem === "global" ? "herdado do global" : "linha própria"})` : "nada salvo ainda"}
        </span>
      </h2>
      <div className="flex max-w-[620px] flex-col gap-3" id="formProvider">
        <div className="grade-2 !gap-3">
          <label className="rotulo m-0">
            tipo
            <select className="campo mt-1" value={tipo} onChange={(e) => setTipo(e.target.value as typeof tipo)}>
              <option value="litellm">LiteLLM (OpenAI compatível)</option>
              <option value="openai">OpenAI</option>
              <option value="ollama">Ollama local</option>
            </select>
          </label>
          <label className="rotulo m-0">
            modelo
            <input id="provModelo" className="campo mt-1" value={modelo} placeholder="ex.: claude-sonnet-4.5" onChange={(e) => setModelo(e.target.value)} />
          </label>
        </div>
        <label className="rotulo m-0">
          URL base
          <input id="provUrl" className="campo mt-1 mono" value={baseUrl} placeholder="https://litellm.exemplo.com/v1" onChange={(e) => setBaseUrl(e.target.value)} />
          <span className="dica mt-1 block">sem /chat/completions no fim — o sistema completa</span>
        </label>
        <label className="rotulo m-0">
          chave da API
          <input
            id="provChave"
            type="password"
            className="campo mt-1 mono"
            value={chave}
            placeholder={p?.tem_chave ? `${p.chave_mascarada} (deixe vazio para manter)` : "cole a chave do provider"}
            onChange={(e) => setChave(e.target.value)}
            autoComplete="new-password"
          />
          <span className="dica mt-1 block">guardada no servidor; a tela só vê os 4 últimos caracteres</span>
        </label>
        <label className="rotulo m-0">
          instruções do modelo (system prompt)
          <textarea
            id="provPrompt"
            className="campo mt-1"
            rows={5}
            value={prompt}
            placeholder="ex.: você é meu assistente de notas fiscais; responda curto, em tabela, citando o documento."
            onChange={(e) => setPrompt(e.target.value)}
          />
          <span className="dica mt-1 block" id="provPromptDica">
            vazio = nenhuma instrução (o modelo conversa puro, sem citar fonte). Não há regra embutida pelo sistema.
            {p?.tem_system_prompt ? ` · em uso: ${prompt.length} caracteres` : ""}
          </span>
        </label>
        <div className="grade-2 !gap-3">
          <label className="rotulo m-0">
            temperatura
            <input className="campo mt-1" value={temperatura} onChange={(e) => setTemperatura(e.target.value)} />
          </label>
          <label className="rotulo m-0">
            rodadas de ferramenta
            <input id="provRodadas" className="campo mt-1" value={rodadas} onChange={(e) => setRodadas(e.target.value)} />
            <span className="dica mt-1 block">0 = nunca chamar ferramenta (0 a 10)</span>
          </label>
        </div>
        <div className="grade-2 !gap-3">
          <label className="rotulo m-0">
            memória da conversa (mensagens)
            <input id="provMemoria" className="campo mt-1" value={memoria} onChange={(e) => setMemoria(e.target.value)} />
            <span className="dica mt-1 block">quantas mensagens antigas desta gaveta voltam ao modelo · 0 = sem memória</span>
          </label>
          <label className="rotulo m-0">
            últimas intactas na compactação
            <input id="provVerbatim" className="campo mt-1" value={verbatim} onChange={(e) => setVerbatim(e.target.value)} />
            <span className="dica mt-1 block">o resto vira uma linha curta (regra, sem custo; nada é resumido por IA)</span>
          </label>
        </div>
        <div className="grade-2 !gap-3">
          <label className="rotulo m-0">
            janela de contexto (tokens)
            <input id="provContexto" className="campo mt-1" value={contexto} onChange={(e) => setContexto(e.target.value)} />
            <span className="dica mt-1 block" id="provJanelaDica">
              0 = automático · em uso: {(p?.janela_efetiva ?? 0).toLocaleString("pt-BR")} tokens (
              {p?.origem_janela === "configurada" ? "você digitou" : p?.origem_janela === "detectada" ? "detectada no testar conexão" : "padrão do sistema"})
              {p?.contexto_detectado ? ` · detectado: ${p.contexto_detectado.toLocaleString("pt-BR")}` : ""}
            </span>
          </label>
          <label className="rotulo m-0">
            reserva para a resposta (tokens)
            <input id="provReserva" className="campo mt-1" value={reserva} onChange={(e) => setReserva(e.target.value)} />
            <span className="dica mt-1 block">espaço deixado livre para o modelo escrever</span>
          </label>
          <label className="rotulo m-0">
            espera sem sinal do modelo (segundos)
            <input id="provSilencio" className="campo mt-1" value={silencio} onChange={(e) => setSilencio(e.target.value)} />
            <span className="dica mt-1 block" id="provSilencioDica">
              0 = {p?.silencio_efetivo_s ?? 180} s · é o tempo que o modelo pode passar sem escrever nada antes de eu
              desistir; resposta longa que não para de escrever nunca é cortada por tempo
            </span>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-borda pt-3">
          <label className="check">
            <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} /> usar este provider no chat
          </label>
          {operador && (
            <label className="check">
              <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} /> gravar como padrão de todos
            </label>
          )}
          <span className="flex-1" />
          <button id="provTestar" className="btn" disabled={ocupado} onClick={() => void testar()}>
            testar conexão
          </button>
          <button id="provSalvar" className="btn btn-primario" disabled={ocupado} onClick={() => void salvar()}>
            salvar
          </button>
        </div>
        {teste && (
          <p className={teste.ok ? "text-[13px] text-verde" : "text-[13px] text-vermelho"} id="provTesteResultado">
            {teste.ok ? "✓ " : "✕ "}
            {teste.msg}
          </p>
        )}
        {p && !p.configurado && (
          <div className="aviso">
            <span>Sem provider o Chat fica desligado — a Busca continua funcionando normalmente.</span>
          </div>
        )}
        {p?.configurado && (
          <button className="btn btn-sutil self-start" onClick={onIrPainel}>
            ver no painel
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- ferramentas */

function Ferramentas({ operador, tenant, onControleMaquinas }: { operador: boolean; tenant: string; onControleMaquinas?: (v: boolean) => void }) {
  const { toast } = useToast();
  const [p, setP] = useState<ProviderResp | null>(null);
  const [servidores, setServidores] = useState<ServidorMcp[]>([]);
  const [novo, setNovo] = useState({ nome: "", url: "", cabecalho: "" });
  const [mostrarNovo, setMostrarNovo] = useState(false);
  const [rodando, setRodando] = useState<string | null>(null);
  const [controleMaq, setControleMaq] = useState(true);
  const [rodandoMaq, setRodandoMaq] = useState(false);
  const [resultado, setResultado] = useState<TesteMcpResp | null>(null);

  const carregar = useCallback(async () => {
    try {
      setP(await get<ProviderResp>("/config/provider" + (operador && tenant ? "?" + qs({ tenant }) : "")));
    } catch {
      setP(null);
    }
    try {
      const rMcp = await get<ServidoresResp>("/config/mcp");
      setServidores(rMcp.servidores);
      setControleMaq(rMcp.controle_maquinas !== false);
      onControleMaquinas?.(rMcp.controle_maquinas !== false);
    } catch (e) {
      toast("servidores MCP: " + (e as Error).message);
    }
  }, [operador, tenant, toast, onControleMaquinas]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function ligarMaquinasControle(valor: boolean) {
    setRodandoMaq(true);
    try {
      const r = await patch<{ controle_maquinas: boolean }>("/config/mcp/maquinas", { ativo: valor });
      setControleMaq(r.controle_maquinas);
      onControleMaquinas?.(r.controle_maquinas);
      toast(valor ? "controle das máquinas ligado" : "controle das máquinas desligado — ninguém executa (chat, MCP e REST)");
    } catch (e) {
      toast("controle das máquinas: " + (e as Error).message);
    } finally {
      setRodandoMaq(false);
    }
  }

  /** o botão fica na config do provider — grava só este campo, preservando o resto */
  async function ligarInterno(valor: boolean) {
    if (!p) return;
    setRodando("interno");
    try {
      const r = await put<ProviderResp>("/config/provider", {
        tipo: p.tipo,
        base_url: p.base_url,
        modelo: p.modelo,
        temperatura: p.temperatura,
        system_prompt: p.system_prompt,
        max_rodadas: p.max_rodadas,
        ativo: p.ativo,
        global: operador && p.origem === "global",
        mcp_interno: valor,
      });
      setP(r);
      toast(valor ? "ferramentas do minirag ligadas no chat" : "ferramentas do minirag desligadas");
    } catch (e) {
      toast("mcp interno: " + (e as Error).message);
    } finally {
      setRodando(null);
    }
  }

  async function adicionar() {
    setRodando("novo");
    try {
      await post<ServidorMcp>("/config/mcp", novo);
      setNovo({ nome: "", url: "", cabecalho: "" });
      setMostrarNovo(false);
      toast("servidor MCP cadastrado");
      await carregar();
    } catch (e) {
      toast("cadastrar: " + (e as Error).message);
    } finally {
      setRodando(null);
    }
  }

  async function testar(nome: string) {
    setRodando(nome);
    setResultado(null);
    try {
      const r = await post<TesteMcpResp>("/config/mcp/testar", { nome });
      setResultado(r);
      toast(`${r.ferramentas} ferramenta(s) em ${r.nome} · ${r.ms} ms`);
      await carregar();
    } catch (e) {
      toast("testar: " + (e as Error).message);
    } finally {
      setRodando(null);
    }
  }

  async function alternar(s: ServidorMcp) {
    setRodando(s.nome);
    try {
      await patch<ServidorMcp>(`/config/mcp/${encodeURIComponent(s.nome)}`, { ativo: !s.ativo });
      await carregar();
    } catch (e) {
      toast("ligar/desligar: " + (e as Error).message);
    } finally {
      setRodando(null);
    }
  }

  async function apagar(s: ServidorMcp) {
    if (!confirm(`tirar o servidor MCP '${s.nome}'? o chat perde as ${s.ferramentas} ferramenta(s) dele.`)) return;
    setRodando(s.nome);
    try {
      await del(`/config/mcp/${encodeURIComponent(s.nome)}`);
      toast("servidor removido");
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
        <h2 className="mb-1 text-[13px] font-semibold text-txt2">MCP do próprio minirag</h2>
        <p className="dica mt-0 mb-3">
          ligado, o chat pode chamar as ferramentas deste servidor (buscar, listar, criar gaveta, ver documentos…).
          As ferramentas <b>executam direto</b>, sem pedir confirmação — o que foi chamado fica registrado embaixo da resposta.
        </p>
        <label className="check">
          <input
            id="mcpInterno"
            type="checkbox"
            checked={Boolean(p?.mcp_interno)}
            disabled={!p || rodando === "interno"}
            onChange={(e) => void ligarInterno(e.target.checked)}
          />
          dar as ferramentas do minirag ao chat
        </label>
        {p?.mcp_interno && <p className="dica mt-2 mb-0" id="mcpInternoAviso">Sem nenhuma ferramenta ligada, o modelo só conversa com o que sabe.</p>}
      </div>

      <div className="cartao">
        <h2 className="mb-1 text-[13px] font-semibold text-txt2">Controle das máquinas</h2>
        <p className="dica mt-0 mb-3">
          ligado, o chat e as ferramentas MCP podem executar comandos nas máquinas cadastradas (aba Máquinas). Desligado,{' '}
          <b>ninguém executa</b>: chat, servidores MCP externos e a rota REST são barrados — as máquinas continuam online,
          a listagem e o histórico de execuções ficam preservados. {operador ? "" : "Só o operador liga e desliga."}
        </p>
        <label className="check">
          <input
            id="mcpControleMaquinas"
            type="checkbox"
            checked={controleMaq}
            disabled={!operador || rodandoMaq}
            onChange={(e) => void ligarMaquinasControle(e.target.checked)}
          />
          deixar as máquinas executarem comandos
        </label>
        {!controleMaq && (
          <p className="dica mt-2 mb-0" id="mcpControleMaquinasAviso">
            Controle desligado: a ferramenta de executar some do chat e da lista MCP, e o servidor recusa qualquer ordem —
            para voltar, marque de novo.
          </p>
        )}
      </div>

      <div className="cartao">
        <h2 className="mb-1 text-[13px] font-semibold text-txt2">Servidores MCP externos</h2>
        <p className="dica mt-0 mb-3">
          cada servidor empresta as ferramentas dele ao chat, pelo endereço HTTP (protocolo MCP). O cabeçalho de acesso fica
          guardado no servidor e nunca volta em claro. {operador ? "" : "Só o operador cadastra."}
        </p>
        <table className="tabela" id="listaMcp">
          <thead>
            <tr>
              <th>servidor</th>
              <th>endereço</th>
              <th>ferramentas</th>
              <th>acesso</th>
              <th>estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {servidores.length === 0 && (
              <tr>
                <td colSpan={6} className="dica">
                  nenhum servidor cadastrado
                </td>
              </tr>
            )}
            {servidores.map((s) => (
              <tr key={s.nome} id={"mcp-" + s.nome}>
                <td>
                  <b className="mono">{s.nome}</b>
                </td>
                <td className="mono break-all">{s.url}</td>
                <td>
                  <b>{s.ferramentas}</b>
                  {s.nomes.length > 0 && (
                    <span className="sub2 mono block break-all">
                      {s.nomes.slice(0, 3).join(", ")}
                      {s.nomes.length > 3 ? ` +${s.nomes.length - 3}` : ""}
                    </span>
                  )}
                  {s.ferramentas === 0 && <span className="sub2 block">nenhuma listada ainda</span>}
                </td>
                <td className="mono">{s.tem_cabecalho ? s.cabecalho_mascarado : "sem cabeçalho"}</td>
                <td>
                  {s.ativo ? (
                    <span className="chip chip-verde">ligado</span>
                  ) : (
                    <span className="chip">desligado</span>
                  )}
                  {s.erro ? <span className="sub2 block">último erro: {s.erro.slice(0, 60)}</span> : null}
                </td>
                <td className="text-right">
                  {operador && (
                    <>
                      <button className="btn btn-mini" disabled={rodando === s.nome} onClick={() => void testar(s.nome)}>
                        atualizar ferramentas
                      </button>
                      <button className="btn btn-mini ml-1" disabled={rodando === s.nome} onClick={() => void alternar(s)}>
                        {s.ativo ? "desligar" : "ligar"}
                      </button>
                      <button className="btn btn-mini ml-1" disabled={rodando === s.nome} onClick={() => void apagar(s)}>
                        apagar
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {resultado && (
          <p className="text-[13px] text-verde mt-2 mb-0" id="mcpTesteResultado">
            ✓ {resultado.nome} respondeu em {resultado.ms} ms · {resultado.ferramentas} ferramenta(s):{" "}
            <span className="mono">{resultado.nomes.slice(0, 8).join(", ")}</span>
            {resultado.nomes.length > 8 ? "…" : ""}
          </p>
        )}

        {operador && !mostrarNovo && (
          <button id="btnNovoMcp" className="btn mt-3 self-start" onClick={() => setMostrarNovo(true)}>
            + adicionar servidor MCP
          </button>
        )}
        {operador && mostrarNovo && (
          <div className="mt-3 flex max-w-[560px] flex-col gap-3 border-t border-borda pt-3" id="formNovoMcp">
            <label className="rotulo m-0">
              nome (aparece na frente de cada ferramenta: nome__buscar)
              <input id="mcpNome" className="campo mt-1" value={novo.nome} placeholder="ex.: drive-prod" onChange={(e) => setNovo({ ...novo, nome: e.target.value })} />
            </label>
            <label className="rotulo m-0">
              endereço HTTP do servidor MCP
              <input id="mcpUrl" className="campo mt-1 mono" value={novo.url} placeholder="https://mcp.exemplo.com/mcp" onChange={(e) => setNovo({ ...novo, url: e.target.value })} />
            </label>
            <label className="rotulo m-0">
              cabeçalho de acesso (opcional)
              <input
                id="mcpCabecalho"
                type="password"
                autoComplete="new-password"
                className="campo mt-1 mono"
                value={novo.cabecalho}
                placeholder="Authorization: Bearer xxx ou só o token"
                onChange={(e) => setNovo({ ...novo, cabecalho: e.target.value })}
              />
            </label>
            <div className="flex gap-2">
              <button id="mcpAdicionar" className="btn btn-primario" disabled={rodando === "novo" || !novo.nome || !novo.url} onClick={() => void adicionar()}>
                cadastrar e listar ferramentas
              </button>
              <button className="btn btn-sutil" onClick={() => setMostrarNovo(false)}>
                cancelar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- conta */

function Conta({ nome, operador, onChaveNova }: { nome: string; operador: boolean; onChaveNova: (c: string) => void }) {
  const { toast } = useToast();
  const [nova, setNova] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  async function gerar() {
    if (!confirm("gerar chave nova? a chave atual para de funcionar na hora.")) return;
    setOcupado(true);
    try {
      const r = await post<{ chave: string; aviso: string }>(`/usuarios/${encodeURIComponent(nome)}/chave`);
      setNova(r.chave);
      onChaveNova(r.chave);
      toast("chave trocada — guarde a nova");
    } catch (e) {
      toast("chave: " + (e as Error).message);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="cartao">
      <h2 className="mb-3 text-[13px] font-semibold text-txt2">Conta e chave</h2>
      <div className="flex max-w-[520px] flex-col gap-3">
        <div className="it-linha">
          <span className="sub2">usuário</span>
          <b>{nome}</b>
        </div>
        <div className="it-linha">
          <span className="sub2">papel</span>
          <span>{operador ? "admin (vê tudo)" : "usuário"}</span>
        </div>
        <div className="it-linha">
          <span className="sub2">chave</span>
          <span className="mono">•••••••• (guardada com hash — não é possível mostrar)</span>
        </div>
        <div className="flex gap-2 border-t border-borda pt-3">
          <button id="btnNovaChave" className="btn" disabled={ocupado} onClick={() => void gerar()}>
            gerar chave nova
          </button>
        </div>
        {nova && (
          <div className="aviso" id="chaveNova">
            <div>
              <b>guarde agora — não aparece de novo:</b>
              <div className="mono mt-1 select-all break-all">{nova}</div>
            </div>
            <button
              className="btn btn-mini ml-auto"
              onClick={() => {
                void navigator.clipboard?.writeText(nova);
                toast("chave copiada");
              }}
            >
              copiar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- limites */

function Limites() {
  const { toast } = useToast();
  const [c, setC] = useState<ConfigResp | null>(null);

  useEffect(() => {
    void get<ConfigResp>("/config")
      .then(setC)
      .catch((e) => toast("config: " + (e as Error).message));
  }, [toast]);

  if (!c) return <div className="cartao dica">carregando…</div>;
  const l = c.limites;
  return (
    <div className="cartao">
      <h2 className="mb-3 text-[13px] font-semibold text-txt2">Limites em vigor</h2>
      <table className="tabela">
        <tbody>
          <tr><td>Tamanho de um documento</td><td><b>{l.max_content_chars.toLocaleString("pt-BR")}</b> caracteres</td></tr>
          <tr><td>Tamanho da pergunta</td><td><b>{l.max_query_chars.toLocaleString("pt-BR")}</b> caracteres</td></tr>
          <tr><td>Trechos por usuário (cota)</td><td><b>{l.max_chunks_tenant.toLocaleString("pt-BR")}</b></td></tr>
          <tr><td>Trechos por busca (padrão)</td><td><b>{l.top_k}</b></td></tr>
          <tr><td>Similaridade mínima</td><td><b>{l.min_score}</b></td></tr>
          <tr><td>Pedaço do documento</td><td><b>{l.chunk_palavras}</b> palavras ({l.chunk_sobreposicao} de sobreposição)</td></tr>
          <tr><td>Páginas por PDF escaneado</td><td><b>{l.ocr_paginas_max}</b> páginas</td></tr>
        </tbody>
      </table>
      <p className="dica mt-3 mb-0">estes números vêm do ambiente do servidor; para mudar, ajuste as variáveis e o operador redeploya</p>
    </div>
  );
}

/* ---------------------------------------------------------- esquecimento */

function Esquecimento() {
  const { toast } = useToast();
  const [c, setC] = useState<ConfigResp | null>(null);
  const [rodando, setRodando] = useState(false);
  /* v3.5: os três números (arquivar / morte do arquivado / carência) editáveis */
  const [form, setForm] = useState<{ dias_arquivar: string; dias_excluir_arquivado: string; dias_carencia: string } | null>(null);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(() => {
    void get<ConfigResp>("/config")
      .then((r) => {
        setC(r);
        setForm({
          dias_arquivar: String(r.esquecimento.dias_arquivar),
          dias_excluir_arquivado: String(r.esquecimento.dias_excluir_arquivado),
          dias_carencia: String(r.esquecimento.dias_carencia),
        });
      })
      .catch((e) => toast("config: " + (e as Error).message));
  }, [toast]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function salvar() {
    if (!form) return;
    setSalvando(true);
    try {
      const r = await put<{ efetivos: Record<string, number> }>("/config/esquecimento", {
        dias_arquivar: Number(form.dias_arquivar),
        dias_excluir_arquivado: Number(form.dias_excluir_arquivado),
        dias_carencia: Number(form.dias_carencia),
      });
      toast(`esquecimento salvo: arquiva em ${r.efetivos.dias_arquivar}d, apaga arquivado em ${r.efetivos.dias_excluir_arquivado}d, carência ${r.efetivos.dias_carencia}d`);
      carregar(); // prova de escrita: reler
    } catch (e) {
      toast("salvar esquecimento: " + (e as Error).message);
    } finally {
      setSalvando(false);
    }
  }

  async function rodar() {
    setRodando(true);
    try {
      const r = await post<{ docs_arquivados_agora: number; expurgo?: { usuarios_apagados: string[]; docs_expurgados: number } }>("/decay", {});
      const ex = r.expurgo;
      const extra = ex && (ex.usuarios_apagados.length || ex.docs_expurgados)
        ? ` · faxina: ${ex.usuarios_apagados.length} conta(s), ${ex.docs_expurgados} arquivado(s) apagado(s)`
        : "";
      toast(`arquivados agora: ${r.docs_arquivados_agora}${extra}`);
    } catch (e) {
      toast("esquecimento: " + (e as Error).message);
    } finally {
      setRodando(false);
    }
  }

  if (!c || !form) return <div className="cartao dica">carregando…</div>;
  const e = c.esquecimento;
  const campo = (chave: "dias_arquivar" | "dias_excluir_arquivado" | "dias_carencia", rotulo: string, dica: string) => (
    <label className="rotulo m-0">
      {rotulo}
      <input
        id={`esq-${chave}`}
        type="number"
        min={0}
        max={36500}
        className="campo mt-1"
        value={form[chave]}
        onChange={(ev) => setForm({ ...form, [chave]: ev.target.value })}
      />
      <span className="text-[11px] text-txt3">{dica}</span>
    </label>
  );
  return (
    <div className="cartao">
      <h2 className="mb-3 text-[13px] font-semibold text-txt2">Esquecimento</h2>
      <div className="flex max-w-[560px] flex-col gap-3">
        <div className="it-linha"><span className="sub2">situação</span><b>{e.ativo ? "ligado" : "desligado"}</b></div>
        {campo("dias_arquivar", "dias sem uso até ARQUIVAR", "documento esquecido sai da busca mas revive ao ser usado (padrão 180 = 6 meses)")}
        {campo("dias_excluir_arquivado", "dias arquivado até APAGAR de vez", "arquivado encostado por mais que isto é excluído sem volta (padrão 365 = 1 ano)")}
        {campo("dias_carencia", "dias de carência ao apagar usuário", "janela para recriar o nome e desfazer; depois disto conta e dados somem (padrão 30)")}
        <div className="it-linha"><span className="sub2">origem dos valores</span><b>{Object.values(e.origem ?? {}).includes("tela") ? "tela (o que você salvar aqui)" : "padrão do servidor"}</b></div>
        <div className="it-linha"><span className="sub2">exige menos de</span><b>{e.min_acessos} acessos</b></div>
        <div className="it-linha"><span className="sub2">verifica a cada</span><b>{e.intervalo_minutos} minutos</b></div>
        <p className="dica m-0">arquivar não apaga: o documento volta ao ser usado. A exclusão definitiva só chega em quem já estava arquivado além da janela.</p>
        <div className="flex gap-2">
          <button id="btnSalvarEsquecimento" className="btn btn-primario self-start" disabled={salvando} onClick={() => void salvar()}>
            {salvando ? "salvando…" : "salvar"}
          </button>
          <button id="btnRodarDecay" className="btn self-start" disabled={rodando} onClick={() => void rodar()}>
            rodar agora (arquiva + faxina)
          </button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- sistema */

function Sistema() {
  const { toast } = useToast();
  const [h, setH] = useState<HealthResp | null>(null);
  const [c, setC] = useState<ConfigResp | null>(null);

  useEffect(() => {
    void get<HealthResp>("/health").then(setH).catch((e) => toast("health: " + (e as Error).message));
    void get<ConfigResp>("/config").then(setC).catch(() => undefined);
  }, [toast]);

  return (
    <div className="cartao">
      <h2 className="mb-3 text-[13px] font-semibold text-txt2">Sistema</h2>
      <div className="saude max-w-[520px]">
        <div className="it"><span className={"dot" + (h?.embedder === "ok" ? "" : " ruim")} /> motor de busca<span className="v">{h?.embedder ?? "?"}</span></div>
        <div className="it"><span className="dot" /> versão<span className="v mono">{h?.versao ?? c?.versao ?? "?"}</span></div>
        <div className="it"><span className="dot cinza" /> modelo de embedding<span className="v mono">{c?.modelo_embedding ?? "?"}</span></div>
      </div>
    </div>
  );
}
