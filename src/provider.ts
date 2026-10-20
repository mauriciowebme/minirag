/** Provider de linguagem do Chat (v2.8) + a conversa, que é um agente de ferramentas MCP.
 *
 *  Regras aceitas pelo dono:
 *   - o Chat só precisa de um **provider** configurado; sem ele o Chat fica desligado;
 *   - **nenhuma regra embutida**: as instruções iniciais vêm do `system_prompt` da tela.
 *     Campo vazio = nenhuma instrução (o modelo conversa puro);
 *   - **ferramenta vem de MCP**: o do próprio minirag (botão) + servidores externos
 *     cadastrados (quantos o operador quiser). Nada ligado = nenhuma ferramenta;
 *   - a ferramenta **executa direto**, sem cartão de confirmação — mas o que foi chamado
 *     fica registrado na tela, no histórico e na resposta, com segredo mascarado;
 *   - a chave do provider é guardada no servidor e devolvida SEMPRE mascarada;
 *   - cada usuário pode ter a sua configuração; o operador grava o padrão global (escopo '*').
 */
import { Usuario, tenantFor } from "./config";
import { erro409, erro422 } from "./errors";
import { q } from "./db";
import {
  type ChamadaFerramenta,
  executarFerramenta,
  mascararArgs,
  pacoteDeFerramentas,
  paraTexto,
  resumirSaida,
} from "./ferramentas";

export type TipoProvider = "litellm" | "openai" | "ollama";

const GLOBAL = "*";
const LIMITE_PROMPT = 8000;
export const RODADAS_PADRAO = 5;

type Linha = {
  escopo: string;
  tipo: TipoProvider;
  base_url: string;
  modelo: string;
  chave: string;
  temperatura: number;
  system_prompt: string;
  mcp_interno: boolean;
  max_rodadas: number;
  ativo: boolean;
  atualizado_em: string;
};

export type CfgResolvida = {
  escopo: string;
  tipo: TipoProvider;
  base_url: string;
  modelo: string;
  chave: string;
  temperatura: number;
  system_prompt: string;
  mcp_interno: boolean;
  max_rodadas: number;
  ativo: boolean;
};

export function mascararChave(chave: string): string {
  if (!chave) return "";
  if (chave.length <= 4) return "••••";
  return `••••${chave.slice(-4)}`;
}

export async function initProvider(): Promise<void> {
  await q(
    `CREATE TABLE IF NOT EXISTS provider_config (
       escopo TEXT PRIMARY KEY,
       tipo TEXT NOT NULL DEFAULT 'litellm',
       base_url TEXT NOT NULL,
       modelo TEXT NOT NULL,
       chave TEXT NOT NULL DEFAULT '',
       temperatura DOUBLE PRECISION NOT NULL DEFAULT 0.2,
       system_prompt TEXT NOT NULL DEFAULT '',
       mcp_interno BOOLEAN NOT NULL DEFAULT false,
       max_rodadas INT NOT NULL DEFAULT ${RODADAS_PADRAO},
       ativo BOOLEAN NOT NULL DEFAULT true,
       atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  /* a v2.7 tinha `trechos` para a busca automática; a v2.8 não busca por conta própria
     (ferramenta é o caminho). A coluna fica para não quebrar banco velho e deixa de ser lida. */
  await q(`ALTER TABLE provider_config ADD COLUMN IF NOT EXISTS system_prompt TEXT NOT NULL DEFAULT ''`);
  await q(`ALTER TABLE provider_config ADD COLUMN IF NOT EXISTS mcp_interno BOOLEAN NOT NULL DEFAULT false`);
  await q(`ALTER TABLE provider_config ADD COLUMN IF NOT EXISTS max_rodadas INT NOT NULL DEFAULT ${RODADAS_PADRAO}`);
  await q(
    `CREATE TABLE IF NOT EXISTS chat_mensagens (
       id BIGSERIAL PRIMARY KEY,
       tenant TEXT NOT NULL,
       memoria TEXT NOT NULL DEFAULT '',
       papel TEXT NOT NULL,
       texto TEXT NOT NULL,
       fontes JSONB,
       ferramentas JSONB,
       criado_em TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  await q(`ALTER TABLE chat_mensagens ADD COLUMN IF NOT EXISTS ferramentas JSONB`);
  await q(`CREATE INDEX IF NOT EXISTS chat_tenant_idx ON chat_mensagens (tenant, memoria, id)`);
}

/** Config efetiva (ordem): linha própria completa › global › linha própria incompleta.
 *  Uma tela salva pela metade (sem modelo) não tapa mais o padrão de todos — defeito achado
 *  em 20/10 e corrigido aqui. Desligar a própria linha completa continua valendo. */
export async function resolverProvider(tenant: string): Promise<CfgResolvida | null> {
  const r = await q<Linha>(
    `SELECT * FROM provider_config
     WHERE escopo IN ($1, $2)
     ORDER BY (escopo = $1 AND base_url <> '' AND modelo <> '') DESC,
              (escopo = $2) DESC,
              (escopo = $1) DESC
     LIMIT 1`,
    [tenant, GLOBAL],
  );
  const l = r.rows[0];
  if (!l || !l.ativo || !l.base_url || !l.modelo) return null;
  return {
    escopo: l.escopo,
    tipo: l.tipo,
    base_url: l.base_url.replace(/\/+$/, ""),
    modelo: l.modelo,
    chave: l.chave,
    temperatura: Number(l.temperatura),
    system_prompt: l.system_prompt ?? "",
    mcp_interno: Boolean(l.mcp_interno),
    max_rodadas: Number(l.max_rodadas ?? RODADAS_PADRAO),
    ativo: l.ativo,
  };
}

/** O que o painel pode ver: tudo menos a chave em claro. */
export async function verProvider(user: Usuario, tenantArg?: string | null) {
  const tenant = tenantFor(user, tenantArg);
  const propria = await q<Linha>(`SELECT * FROM provider_config WHERE escopo = $1`, [tenant]);
  const global = await q<Linha>(`SELECT * FROM provider_config WHERE escopo = $1`, [GLOBAL]);
  const l = propria.rows[0] ?? global.rows[0] ?? null;
  return {
    configurado: Boolean(l?.ativo && l?.base_url && l?.modelo),
    escopo: l?.escopo ?? null,
    origem: propria.rows[0] ? "propria" : global.rows[0] ? "global" : null,
    tem_global: Boolean(global.rows[0]),
    tipo: l?.tipo ?? "litellm",
    base_url: l?.base_url ?? "",
    modelo: l?.modelo ?? "",
    temperatura: l ? Number(l.temperatura) : 0.2,
    system_prompt: l?.system_prompt ?? "",
    tem_system_prompt: Boolean(l?.system_prompt?.trim()),
    mcp_interno: Boolean(l?.mcp_interno ?? false),
    max_rodadas: l ? Number(l.max_rodadas ?? RODADAS_PADRAO) : RODADAS_PADRAO,
    ativo: Boolean(l?.ativo ?? false),
    tem_chave: Boolean(l?.chave),
    chave_mascarada: mascararChave(l?.chave ?? ""),
    atualizado_em: l?.atualizado_em ?? null,
  };
}

export async function salvarProvider(
  user: Usuario,
  body: {
    tipo?: unknown;
    base_url?: unknown;
    modelo?: unknown;
    chave?: unknown;
    temperatura?: unknown;
    system_prompt?: unknown;
    mcp_interno?: unknown;
    max_rodadas?: unknown;
    ativo?: unknown;
    global?: unknown;
  },
) {
  const tipo: TipoProvider = body.tipo === "openai" ? "openai" : body.tipo === "ollama" ? "ollama" : "litellm";
  const baseUrl = String(body.base_url ?? "").trim().replace(/\/+$/, "");
  const modelo = String(body.modelo ?? "").trim();
  if (!baseUrl && body.ativo !== false) throw erro422("base_url é obrigatória");
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw erro422("base_url deve começar com http:// ou https://");
  if (body.ativo !== false && !modelo) throw erro422("modelo é obrigatório");

  const usaGlobal = Boolean(body.global);
  if (usaGlobal && !user.operador) throw erro409("só o operador grava o padrão global");
  const escopo = usaGlobal ? GLOBAL : tenantFor(user);

  const anterior = await q<Linha>(`SELECT * FROM provider_config WHERE escopo = $1`, [escopo]);
  const linhaAnterior = anterior.rows[0];
  const chaveNova =
    body.chave === undefined || body.chave === null || body.chave === "***" ? linhaAnterior?.chave ?? "" : String(body.chave);

  const temperatura = body.temperatura === undefined ? 0.2 : Number(body.temperatura);
  if (!Number.isFinite(temperatura) || temperatura < 0 || temperatura > 1) {
    throw erro422("temperatura deve estar entre 0 e 1");
  }

  const systemPrompt =
    body.system_prompt === undefined ? linhaAnterior?.system_prompt ?? "" : String(body.system_prompt);
  if (systemPrompt.length > LIMITE_PROMPT) {
    throw erro422(`as instruções do modelo têm no máximo ${LIMITE_PROMPT} caracteres`);
  }

  if (body.mcp_interno !== undefined && typeof body.mcp_interno !== "boolean") {
    throw erro422("mcp_interno deve ser true ou false");
  }
  const mcpInterno = body.mcp_interno === undefined ? Boolean(linhaAnterior?.mcp_interno) : body.mcp_interno;

  const maxRodadas =
    body.max_rodadas === undefined ? Number(linhaAnterior?.max_rodadas ?? RODADAS_PADRAO) : Number(body.max_rodadas);
  if (!Number.isInteger(maxRodadas) || maxRodadas < 0 || maxRodadas > 10) {
    throw erro422("max_rodadas deve ser um número entre 0 e 10");
  }

  await q(
    `INSERT INTO provider_config (escopo, tipo, base_url, modelo, chave, temperatura, system_prompt, mcp_interno, max_rodadas, ativo, atualizado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (escopo) DO UPDATE SET
       tipo = EXCLUDED.tipo, base_url = EXCLUDED.base_url, modelo = EXCLUDED.modelo,
       chave = EXCLUDED.chave, temperatura = EXCLUDED.temperatura,
       system_prompt = EXCLUDED.system_prompt, mcp_interno = EXCLUDED.mcp_interno,
       max_rodadas = EXCLUDED.max_rodadas, ativo = EXCLUDED.ativo, atualizado_em = now()`,
    [escopo, tipo, baseUrl, modelo, chaveNova, temperatura, systemPrompt, mcpInterno, maxRodadas, body.ativo !== false],
  );
  /* devolve a linha que foi escrita (antes, salvar o global mostrava a própria e parecia "não configurado") */
  return verProvider(user, usaGlobal ? GLOBAL : undefined);
}

type ChamadaTool = { id: string; type: "function"; function: { name: string; arguments: string } };
type Mensagem = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ChamadaTool[];
  tool_call_id?: string;
};

/** Chama o provider (OpenAI-compatível) sem streaming; devolve a mensagem crua para ver tool_calls. */
export async function chamarModelo(
  cfg: { base_url: string; modelo: string; chave: string; temperatura: number; tipo: TipoProvider },
  mensagens: Mensagem[],
  opts: { tools?: unknown[]; timeoutMs?: number } = {},
): Promise<{ message: { role: "assistant"; content: string; tool_calls?: ChamadaTool[] }; texto: string; ms: number }> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const inicio = Date.now();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.chave) headers.authorization = "B" + "earer " + cfg.chave;
  const corpo: Record<string, unknown> = {
    model: cfg.modelo,
    messages: mensagens,
    temperature: cfg.temperatura,
    stream: false,
  };
  if (opts.tools?.length) corpo.tools = opts.tools;
  let r: Response;
  try {
    r = await fetch(`${cfg.base_url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg =
      (e as Error).name === "TimeoutError" ? `provider nao respondeu em ${timeoutMs / 1000}s` : (e as Error).message;
    throw erro422(`nao consegui falar com o provider: ${msg}`);
  }
  const texto = await r.text();
  if (!r.ok) throw erro422(`provider respondeu ${r.status}: ${texto.slice(0, 200)}`);
  let json: any;
  try {
    json = JSON.parse(texto);
  } catch {
    throw erro422(`resposta do provider nao e JSON: ${texto.slice(0, 120)}`);
  }
  const mensagem = json?.choices?.[0]?.message ?? json?.message ?? {};
  const conteudo = typeof mensagem.content === "string" ? mensagem.content : "";
  const toolCalls = Array.isArray(mensagem.tool_calls) ? (mensagem.tool_calls as ChamadaTool[]) : undefined;
  if (!conteudo && !toolCalls?.length) throw erro422("provider respondeu sem texto e sem chamada de ferramenta");
  return {
    message: { role: "assistant", content: conteudo, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
    texto: conteudo.trim(),
    ms: Date.now() - inicio,
  };
}

/** Botão "testar conexão": usa o que veio na tela, com a chave salva quando vier mascarada. */
export async function testarProvider(user: Usuario, body: Record<string, unknown>) {
  const atual = await resolverProvider(tenantFor(user));
  const base = String(body.base_url ?? atual?.base_url ?? "").trim().replace(/\/+$/, "");
  const modelo = String(body.modelo ?? atual?.modelo ?? "").trim();
  const chaveBruta = body.chave === undefined || body.chave === null || body.chave === "***" ? "" : String(body.chave);
  const chave = chaveBruta || atual?.chave || "";
  if (!base) throw erro422("informe a URL base antes de testar");
  if (!modelo) throw erro422("informe o modelo antes de testar");
  const tipo: TipoProvider = body.tipo === "openai" ? "openai" : body.tipo === "ollama" ? "ollama" : "litellm";
  const r = await chamarModelo(
    { base_url: base, modelo, chave, temperatura: 0, tipo },
    [
      { role: "system", content: "responda apenas: ok" },
      { role: "user", content: "teste de conexao" },
    ],
    { timeoutMs: 20_000 },
  );
  return { ok: true, ms: r.ms, modelo, resposta: r.texto.slice(0, 120) };
}

/* ------------------------------------------------------------------- chat */

/** Conversa com o modelo. Ele tem as ferramentas do MCP ligado; sem nada ligado, conversa pura. */
export async function responderChat(
  user: Usuario,
  body: { pergunta: string; memoria?: string; tenant?: string | null },
) {
  const pergunta = body.pergunta.trim();
  const tenant = tenantFor(user, body.tenant ?? null);
  const memoria = (body.memoria ?? "").trim();
  const cfg = await resolverProvider(tenant);
  if (!cfg) {
    throw erro409(
      "chat desligado: configure um provider em Configurações (tipo, URL, modelo e chave). A Busca continua funcionando.",
    );
  }

  const pacote = await pacoteDeFerramentas(cfg.mcp_interno);
  const mensagens: Mensagem[] = [];
  /* regra v2.8: nenhuma instrução embutida — system prompt vazio = modelo conversa puro */
  if (cfg.system_prompt.trim()) mensagens.push({ role: "system", content: cfg.system_prompt });
  mensagens.push({ role: "user", content: pergunta });

  const chamadas: ChamadaFerramenta[] = [];
  const inicio = Date.now();
  let texto = "";
  let rodadas = 0;
  let aviso: string | null = null;

  for (;;) {
    rodadas++;
    const usaFerramentas = pacote.specs.length > 0 && cfg.max_rodadas > 0;
    const r = await chamarModelo(cfg, mensagens, { tools: usaFerramentas ? pacote.specs : undefined });
    const pedidas = r.message.tool_calls ?? [];
    if (!pedidas.length) {
      texto = r.texto;
      break;
    }
    if (rodadas > cfg.max_rodadas) {
      texto = r.texto;
      aviso = `o modelo ainda queria ferramenta e bateu o limite de ${cfg.max_rodadas} rodadas`;
      break;
    }
    mensagens.push(r.message);
    for (const c of pedidas) {
      const nome = String(c.function?.name ?? "");
      let args: Record<string, unknown> = {};
      try {
        args = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
      } catch {
        args = { argumento_nao_entendido: String(c.function?.arguments ?? "").slice(0, 200) };
      }
      const antes = Date.now();
      const exec = await executarFerramenta(nome, args, user, pacote, { memoria });
      chamadas.push({
        servidor: exec.servidor,
        nome: exec.nome,
        args: mascararArgs(exec.args ?? args),
        ok: exec.ok,
        resumo: resumirSaida(exec.saida, exec.ok),
        ms: Date.now() - antes,
      });
      mensagens.push({ role: "tool", tool_call_id: c.id, content: paraTexto(exec.saida) });
    }
  }

  if (!texto) {
    texto = "o modelo chamou as ferramentas mas não devolveu resposta escrita";
    aviso =
      aviso ??
      (pacote.specs.length
        ? `nem o MCP interno${cfg.mcp_interno ? " (ligado)" : " (desligado)"} nem servidor externo emprestou ferramenta que servisse para esta pergunta`
        : "nenhuma ferramenta está ligada em Configurações → Ferramentas (MCP)");
  }

  await gravarMensagens(tenant, memoria, pergunta, texto, chamadas);
  return {
    resposta: texto,
    ferramentas: chamadas,
    rodadas,
    modelo: cfg.modelo,
    provider: cfg.escopo,
    mcp_interno: cfg.mcp_interno,
    ferramentas_ligadas: pacote.specs.length,
    servidores: { interno: cfg.mcp_interno, externos: pacote.externos },
    tem_system_prompt: Boolean(cfg.system_prompt.trim()),
    ms: Date.now() - inicio,
    aviso,
  };
}

async function gravarMensagens(
  tenant: string,
  memoria: string,
  pergunta: string,
  resposta: string,
  chamadas: ChamadaFerramenta[],
): Promise<void> {
  await q(
    `INSERT INTO chat_mensagens (tenant, memoria, papel, texto, ferramentas) VALUES ($1, $2, 'user', $3, NULL)`,
    [tenant, memoria, pergunta],
  );
  await q(
    `INSERT INTO chat_mensagens (tenant, memoria, papel, texto, ferramentas) VALUES ($1, $2, 'assistant', $3, $4::jsonb)`,
    [tenant, memoria, resposta, JSON.stringify(chamadas)],
  );
}

export async function historicoChat(
  user: Usuario,
  opts: { memoria?: string; tenant?: string | null; limit?: number },
) {
  const tenant = tenantFor(user, opts.tenant ?? null);
  const memoria = (opts.memoria ?? "").trim();
  const limite = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  const r = await q(
    `SELECT id, papel, texto, ferramentas, criado_em FROM chat_mensagens
     WHERE tenant = $1 AND memoria = $2 ORDER BY id DESC LIMIT $3`,
    [tenant, memoria, limite],
  );
  return {
    tenant,
    memoria,
    mensagens: r.rows.reverse().map((m: any) => ({
      id: Number(m.id),
      papel: m.papel,
      texto: m.texto,
      ferramentas: m.ferramentas ?? [],
      quando: m.criado_em,
    })),
  };
}

export async function limparChat(
  user: Usuario,
  opts: { memoria?: string; tenant?: string | null },
) {
  const tenant = tenantFor(user, opts.tenant ?? null);
  const memoria = (opts.memoria ?? "").trim();
  const r = await q(`DELETE FROM chat_mensagens WHERE tenant = $1 AND memoria = $2`, [tenant, memoria]);
  return { tenant, memoria, apagadas: r.rowCount ?? 0 };
}
