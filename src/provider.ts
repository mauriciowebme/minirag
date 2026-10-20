/** Provider de linguagem do Chat (v2.7) + a conversa em si.
 *
 *  Regras aceitas pelo dono:
 *   - a chave é guardada no servidor e devolvida SEMPRE mascarada;
 *   - sem provider o Chat fica desligado (a Busca continua);
 *   - cada usuário tem a sua configuração; o operador pode gravar o padrão global
 *     (escopo '*'), usado por quem não configurou nada.
 */
import { Usuario, tenantFor } from "./config";
import { erro409, erro422 } from "./errors";
import { q } from "./db";
import { search } from "./service";

export type TipoProvider = "litellm" | "openai" | "ollama";

type Linha = {
  escopo: string;
  tipo: TipoProvider;
  base_url: string;
  modelo: string;
  chave: string;
  temperatura: number;
  trechos: number;
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
  trechos: number;
  ativo: boolean;
};

const GLOBAL = "*";

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
       trechos INT NOT NULL DEFAULT 6,
       ativo BOOLEAN NOT NULL DEFAULT true,
       atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  await q(
    `CREATE TABLE IF NOT EXISTS chat_mensagens (
       id BIGSERIAL PRIMARY KEY,
       tenant TEXT NOT NULL,
       memoria TEXT NOT NULL DEFAULT '',
       papel TEXT NOT NULL,
       texto TEXT NOT NULL,
       fontes JSONB,
       criado_em TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  await q(`CREATE INDEX IF NOT EXISTS chat_tenant_idx ON chat_mensagens (tenant, memoria, id)`);
}

/** Config efetiva do usuário: a dele, senão a global. null = chat desligado. */
export async function resolverProvider(tenant: string): Promise<CfgResolvida | null> {
  const r = await q<Linha>(
    `SELECT * FROM provider_config WHERE escopo IN ($1, $2) ORDER BY (escopo = $1) DESC LIMIT 1`,
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
    trechos: Number(l.trechos),
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
    trechos: l ? Number(l.trechos) : 6,
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
    trechos?: unknown;
    ativo?: unknown;
    global?: unknown;
  },
) {
  const tipo: TipoProvider =
    body.tipo === "openai" ? "openai" : body.tipo === "ollama" ? "ollama" : "litellm";
  const baseUrl = String(body.base_url ?? "").trim().replace(/\/+$/, "");
  const modelo = String(body.modelo ?? "").trim();
  if (!baseUrl && body.ativo !== false) throw erro422("base_url é obrigatória");
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw erro422("base_url deve começar com http:// ou https://");
  if (body.ativo !== false && !modelo) throw erro422("modelo é obrigatório");

  const usaGlobal = Boolean(body.global);
  if (usaGlobal && !user.operador) throw erro409("só o operador grava o padrão global");
  const escopo = usaGlobal ? GLOBAL : tenantFor(user);

  const anterior = await q<Linha>(`SELECT * FROM provider_config WHERE escopo = $1`, [escopo]);
  const chaveNova = body.chave === undefined || body.chave === null || body.chave === "***"
    ? anterior.rows[0]?.chave ?? ""
    : String(body.chave);

  const temperatura = body.temperatura === undefined ? 0.2 : Number(body.temperatura);
  if (!Number.isFinite(temperatura) || temperatura < 0 || temperatura > 1) {
    throw erro422("temperatura deve estar entre 0 e 1");
  }
  const trechos = body.trechos === undefined ? 6 : Number(body.trechos);
  if (!Number.isInteger(trechos) || trechos < 1 || trechos > 20) {
    throw erro422("trechos deve estar entre 1 e 20");
  }

  await q(
    `INSERT INTO provider_config (escopo, tipo, base_url, modelo, chave, temperatura, trechos, ativo, atualizado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (escopo) DO UPDATE SET
       tipo = EXCLUDED.tipo, base_url = EXCLUDED.base_url, modelo = EXCLUDED.modelo,
       chave = EXCLUDED.chave, temperatura = EXCLUDED.temperatura, trechos = EXCLUDED.trechos,
       ativo = EXCLUDED.ativo, atualizado_em = now()`,
    [escopo, tipo, baseUrl, modelo, chaveNova, temperatura, trechos, body.ativo !== false],
  );
  return verProvider(user, usaGlobal ? undefined : user.tenant);
}

type Mensagem = { role: "system" | "user" | "assistant"; content: string };

/** Chama o provider (OpenAI-compatível) sem streaming. */
export async function chamarModelo(
  cfg: { base_url: string; modelo: string; chave: string; temperatura: number; tipo: TipoProvider },
  mensagens: Mensagem[],
  timeoutMs = 60_000,
): Promise<{ texto: string; ms: number }> {
  const inicio = Date.now();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.chave) headers.authorization = "B" + "earer " + cfg.chave;
  let r: Response;
  try {
    r = await fetch(`${cfg.base_url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cfg.modelo,
        messages: mensagens,
        temperature: cfg.temperatura,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? `provider nao respondeu em ${timeoutMs / 1000}s` : (e as Error).message;
    throw erro422(`nao consegui falar com o provider: ${msg}`);
  }
  const texto = await r.text();
  if (!r.ok) {
    throw erro422(`provider respondeu ${r.status}: ${texto.slice(0, 200)}`);
  }
  let json: any;
  try {
    json = JSON.parse(texto);
  } catch {
    throw erro422(`resposta do provider nao e JSON: ${texto.slice(0, 120)}`);
  }
  const conteudo =
    json?.choices?.[0]?.message?.content ??
    json?.message?.content ?? // ollama /api/chat
    "";
  if (!conteudo) throw erro422("provider respondeu sem texto");
  return { texto: String(conteudo).trim(), ms: Date.now() - inicio };
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
    20_000,
  );
  return { ok: true, ms: r.ms, modelo, resposta: r.texto.slice(0, 120) };
}

/* ------------------------------------------------------------------- chat */

export type Fonte = { doc_id: string; title: string; score: number; trecho: string };

const SISTEMA = [
  "Você é o assistente de memória de documentos do minirag.",
  "Responda em português do Brasil, curto e direto.",
  "Use SOMENTE os trechos fornecidos. Se eles não responderem, diga que não encontrou nos documentos e sugira reformular a pergunta.",
  "Nunca invente número, data ou nome que não esteja nos trechos.",
  "Ao usar um trecho, cite o documento entre colchetes, por exemplo [contrato-2026].",
].join(" ");

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

  const busca = await search(
    {
      query: pergunta,
      k: cfg.trechos,
      min_score: 0.35,
      memoria,
      include_archived: false,
      tenant: body.tenant ?? null,
    },
    user,
  );

  const fontes: Fonte[] = (busca.items ?? []).map((h: any) => ({
    doc_id: h.doc_id,
    title: h.title ?? h.doc_id,
    score: Number(h.score ?? 0),
    trecho: String(h.text ?? "").slice(0, 400),
  }));

  if (!fontes.length) {
    const resposta =
      "Não achei nada sobre isso nos documentos desta gaveta. Tente outras palavras ou confira se o assunto já foi enviado.";
    await gravarMensagens(tenant, memoria, pergunta, resposta, []);
    return { resposta, fontes: [], modelo: cfg.modelo, provider: cfg.escopo, buscou: 0, ms: 0 };
  }

  const contexto = fontes
    .map((f, i) => `[${f.doc_id}]\ntrecho ${i + 1} (similaridade ${f.score.toFixed(2)}):\n${f.trecho}`)
    .join("\n\n");

  const r = await chamarModelo(cfg, [
    { role: "system", content: SISTEMA },
    { role: "user", content: `Trechos dos documentos:\n\n${contexto}\n\nPergunta: ${pergunta}` },
  ]);

  await gravarMensagens(tenant, memoria, pergunta, r.texto, fontes);
  return {
    resposta: r.texto,
    fontes,
    modelo: cfg.modelo,
    provider: cfg.escopo,
    buscou: fontes.length,
    ms: r.ms,
  };
}

async function gravarMensagens(
  tenant: string,
  memoria: string,
  pergunta: string,
  resposta: string,
  fontes: Fonte[],
): Promise<void> {
  await q(
    `INSERT INTO chat_mensagens (tenant, memoria, papel, texto, fontes) VALUES ($1, $2, 'user', $3, NULL)`,
    [tenant, memoria, pergunta],
  );
  await q(
    `INSERT INTO chat_mensagens (tenant, memoria, papel, texto, fontes) VALUES ($1, $2, 'assistant', $3, $4::jsonb)`,
    [tenant, memoria, resposta, JSON.stringify(fontes)],
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
    `SELECT id, papel, texto, fontes, criado_em FROM chat_mensagens
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
      fontes: m.fontes ?? [],
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

