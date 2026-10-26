/* v3.19 — providers múltiplos. O `provider_config` (escopo único) continua sendo o
 * "padrão" da casa; aqui mora a LISTA de provedores nomeados que o usuário pode
 * cadastrar e escolher na hora da conversa. Descoberta de modelos segue o padrão
 * medido no Hermes (catálogo com refresh) e no Open WebUI (conexões + /v1/models):
 * batemos em `<base>/models`; se não houver, tentamos `<base>/v1/models`; por
 * último `<base>/api/tags` (Ollama nativo). A lista volta com a resposta `fim`
 * e fica em cache na linha (o painel mostra "cacheado em ..."). */

import { erro409, erro422 } from "./errors";
import { q } from "./db";
import { tenantFor, type Usuario } from "./config";
import { mascararChave } from "./provider";

const GLOBAL = "*";
type Linha = Record<string, any>;

export type ProvedorPub = {
  id: number;
  nome: string;
  tipo: string;
  base_url: string;
  modelo: string;
  chave_mascarada: string;
  ativo: boolean;
  padrao: boolean;
  escopo: string;
  modelos: string[];
  modelos_em: string | null;
};

export async function initProvedores(): Promise<void> {
  await q(
    `CREATE TABLE IF NOT EXISTS provedores (
       id BIGSERIAL PRIMARY KEY,
       escopo TEXT NOT NULL,
       nome TEXT NOT NULL,
       tipo TEXT NOT NULL DEFAULT 'litellm',
       base_url TEXT NOT NULL,
       chave TEXT NOT NULL DEFAULT '',
       modelo TEXT NOT NULL DEFAULT '',
       temperatura DOUBLE PRECISION NOT NULL DEFAULT 0.2,
       system_prompt TEXT NOT NULL DEFAULT '',
       mcp_interno BOOLEAN NOT NULL DEFAULT true,
       max_rodadas INT NOT NULL DEFAULT 5,
       ativo BOOLEAN NOT NULL DEFAULT true,
       padrao BOOLEAN NOT NULL DEFAULT false,
       modelos JSONB NOT NULL DEFAULT '[]'::jsonb,
       modelos_em TIMESTAMPTZ,
       atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
       UNIQUE (escopo, nome))`,
  );
  await q(`CREATE INDEX IF NOT EXISTS provedores_escopo_idx ON provedores (escopo, padrao, ativo)`);
  /* memória/orçamento do provedor nomeado: mesma prateleira do provider_config */
  await q(`ALTER TABLE provedores ADD COLUMN IF NOT EXISTS memoria_turnos INT NOT NULL DEFAULT 12`);
  await q(`ALTER TABLE provedores ADD COLUMN IF NOT EXISTS verbatim_turnos INT NOT NULL DEFAULT 4`);
  await q(`ALTER TABLE provedores ADD COLUMN IF NOT EXISTS reserva_tokens INT NOT NULL DEFAULT 1024`);
  await q(`ALTER TABLE provedores ADD COLUMN IF NOT EXISTS contexto_tokens INT`);
  await q(`ALTER TABLE provedores ADD COLUMN IF NOT EXISTS contexto_detectado INT`);
  await q(`ALTER TABLE provedores ADD COLUMN IF NOT EXISTS silencio_s INT NOT NULL DEFAULT 0`);
  /* a tarefa em curso precisa lembrar qual provedor/modelo o usuário escolheu */
  await q(`ALTER TABLE chat_tarefas ADD COLUMN IF NOT EXISTS provedor TEXT NOT NULL DEFAULT ''`);
  await q(`ALTER TABLE chat_tarefas ADD COLUMN IF NOT EXISTS modelo TEXT NOT NULL DEFAULT ''`);
  /* v3.19: a resposta guarda quem respondeu — o "via X" sobrevive ao reabrir a conversa */
  await q(`ALTER TABLE chat_mensagens ADD COLUMN IF NOT EXISTS provedor TEXT`);
  await q(`ALTER TABLE chat_mensagens ADD COLUMN IF NOT EXISTS modelo TEXT NOT NULL DEFAULT ''`);
}

function limpaTipo(v: unknown): string {
  return v === "openai" ? "openai" : v === "ollama" ? "ollama" : "litellm";
}

function validaBase(v: unknown): string {
  const base = String(v ?? "").trim().replace(/\/+$/, "");
  if (!base) throw erro422("base_url é obrigatória");
  if (!/^https?:\/\//i.test(base)) throw erro422("base_url deve começar com http:// ou https://");
  return base;
}

function paraPub(l: Linha): ProvedorPub {
  return {
    id: Number(l.id),
    nome: String(l.nome),
    tipo: String(l.tipo),
    base_url: String(l.base_url),
    modelo: String(l.modelo),
    chave_mascarada: mascararChave(String(l.chave ?? "")),
    ativo: Boolean(l.ativo),
    padrao: Boolean(l.padrao),
    escopo: String(l.escopo),
    modelos: Array.isArray(l.modelos) ? (l.modelos as string[]).map(String) : [],
    modelos_em: l.modelos_em ? new Date(l.modelos_em).toISOString() : null,
  };
}

/** O que o usuário pode ver: linhas do próprio escopo + global, chave mascarada. */
export async function listarProvedores(user: Usuario, tenantArg?: string | null): Promise<ProvedorPub[]> {
  const escopo = tenantFor(user, tenantArg ?? null);
  const r = await q<Linha>(`SELECT * FROM provedores WHERE escopo = ANY($1) ORDER BY padrao DESC, nome`, [
    escopo === GLOBAL ? [GLOBAL] : [escopo, GLOBAL],
  ]);
  return r.rows.map(paraPub);
}

type CorpoProvedor = {
  nome?: unknown;
  tipo?: unknown;
  base_url?: unknown;
  chave?: unknown;
  modelo?: unknown;
  temperatura?: unknown;
  system_prompt?: unknown;
  global?: unknown;
  mcp_interno?: unknown;
  max_rodadas?: unknown;
  ativo?: unknown;
  padrao?: unknown;
  tenant?: unknown;
};

/** Cria ou substitui um provedor nomeado. Só o operador escreve (mesma regra do provider). */
export async function salvarProvedor(user: Usuario, corpo: CorpoProvedor): Promise<ProvedorPub> {
  if (!user.operador) throw erro409("só o operador cadastra provedores");
  /* escopo como no provider da casa: tenant:"global" = "*" (visível a todos);
   * tenant:"<nome>" = linha daquele tenant; sem tenant = linha do próprio operador. */
  const alvo = String(corpo.tenant ?? "").trim();
  const escopo = alvo === "global" || corpo.global === true ? GLOBAL : user.operador ? tenantFor(user, alvo) : user.tenant;
  const nome = String(corpo.nome ?? "").trim();
  if (!nome || nome.length > 60) throw erro422("nome do provedor é obrigatório (até 60 caracteres)");
  const base = validaBase(corpo.base_url);
  const modelo = String(corpo.modelo ?? "").trim();
  const temperatura = corpo.temperatura === undefined ? 0.2 : Number(corpo.temperatura);
  if (!Number.isFinite(temperatura) || temperatura < 0 || temperatura > 1) throw erro422("temperatura deve estar entre 0 e 1");
  const maxRodadas = corpo.max_rodadas === undefined ? 5 : Number(corpo.max_rodadas);
  if (!Number.isInteger(maxRodadas) || maxRodadas < 0 || maxRodadas > 60) throw erro422("max_rodadas deve ser 0–60");
  const prompt = corpo.system_prompt === undefined ? "" : String(corpo.system_prompt);
  if (prompt.length > 8000) throw erro422("instruções com no máximo 8000 caracteres");

  const anterior = await q<Linha>(`SELECT * FROM provedores WHERE escopo = $1 AND nome = $2`, [escopo, nome]);
  const l = anterior.rows[0];
  const chave =
    corpo.chave === undefined || corpo.chave === null || corpo.chave === "***" ? String(l?.chave ?? "") : String(corpo.chave);
  const padraoDesejado = corpo.padrao === undefined ? Boolean(l?.padrao) : Boolean(corpo.padrao);
  if (ativoDe(corpo, l) && !l && !modelo) {
    // o primeiro provedor ativo precisa de modelo (senão o chat não tem para quem falar)
    throw erro422("modelo é obrigatório");
  }
  void padraoDesejado; // aplicado adiante

  const r = await q<Linha>(
    `INSERT INTO provedores (escopo, nome, tipo, base_url, chave, modelo, temperatura, system_prompt, mcp_interno, max_rodadas, ativo, padrao, atualizado_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (escopo, nome) DO UPDATE SET
       tipo=$3, base_url=$4, chave=$5, modelo=$6, temperatura=$7, system_prompt=$8,
       mcp_interno=$9, max_rodadas=$10, ativo=$11, padrao=$12, atualizado_em=now()
     RETURNING *`,
    [
      escopo,
      nome,
      limpaTipo(corpo.tipo),
      base,
      chave,
      modelo,
      temperatura,
      prompt,
      corpo.mcp_interno === undefined ? (l ? Boolean(l.mcp_interno) : true) : Boolean(corpo.mcp_interno),
      maxRodadas,
      corpo.ativo === undefined ? true : Boolean(corpo.ativo),
      false, // "padrão" é um por escopo: movido por definirPadrao
    ],
  );
  if (corpo.padrao === true) await definirPadraoNoEscopo(escopo, Number(r.rows[0].id));
  else if (corpo.padrao === undefined && l?.padrao) await q(`UPDATE provedores SET padrao = true WHERE id = $1`, [Number(l.id)]);
  const volta = await q<Linha>(`SELECT * FROM provedores WHERE id = $1`, [Number(r.rows[0].id)]);
  return paraPub(volta.rows[0]);
}

function ativoDe(corpo: CorpoProvedor, l: Linha | undefined): boolean {
  return corpo.ativo === undefined ? (l ? Boolean(l.ativo) : true) : Boolean(corpo.ativo);
}

async function definirPadraoNoEscopo(escopo: string, id: number): Promise<void> {
  await q(`UPDATE provedores SET padrao = false WHERE escopo = $1 AND id <> $2`, [escopo, id]);
  await q(`UPDATE provedores SET padrao = true WHERE id = $2 AND escopo = $1`, [escopo, id]);
}

/** Marca como padrão do escopo (um por escopo). A escolha do chat não depende disso. */
export async function definirPadrao(user: Usuario, id: number, tenantArg?: string | null): Promise<ProvedorPub> {
  if (!user.operador) throw erro409("só o operador define o padrão");
  const escopo = tenantFor(user, tenantArg ?? null);
  const r = await q<Linha>(`SELECT * FROM provedores WHERE id = $1 AND escopo = ANY($2)`, [
    id,
    user.operador ? [escopo, GLOBAL] : [escopo],
  ]);
  const l = r.rows[0];
  if (!l) throw erro409("provedor não encontrado");
  await definirPadraoNoEscopo(String(l.escopo), id);
  return paraPub(l);
}

export async function apagarProvedor(user: Usuario, id: number): Promise<{ ok: boolean }> {
  if (!user.operador) throw erro409("só o operador apaga provedores");
  const r = await q<Linha>(
    `DELETE FROM provedores WHERE id = $1 AND escopo = ANY($2) RETURNING id`,
    [id, [user.tenant, GLOBAL]],
  );
  if (!r.rows[0]) throw erro409("provedor não encontrado");
  return { ok: true };
}

/** Descoberta: `GET <base>/models` → `GET <base>/v1/models` → `GET <base>/api/tags`.
 *  8s de teto; erros viram resposta honesta, nunca queda do painel. */
export async function descobrirModelos(base: string, chave: string, tipo?: string): Promise<string[]> {
  const limpo = base.replace(/\/+$/, "");
  const alvos: Array<{ url: string; Extrai: (j: any) => string[] }> =
    tipo === "ollama"
      ? [
          { url: `${limpo}/api/tags`, Extrai: (j) => (Array.isArray(j?.models) ? j.models.map((m: any) => String(m?.name ?? "")) : []) },
          { url: `${limpo}/models`, Extrai: extraiOpenAI },
          { url: `${limpo}/v1/models`, Extrai: extraiOpenAI },
        ]
      : [
          { url: `${limpo}/models`, Extrai: extraiOpenAI },
          { url: `${limpo}/v1/models`, Extrai: extraiOpenAI },
        ];
  for (const alvo of alvos) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(alvo.url, {
        headers: chave ? { authorization: `Bearer ${chave}` } : {},
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!resp.ok) continue;
      const j = await resp.json();
      const lista = [...new Set(alvo.Extrai(j).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      if (lista.length) return lista;
    } catch {
      /* tenta o próximo alvo */
    }
  }
  return [];
}

function extraiOpenAI(j: any): string[] {
  const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
  return arr.map((m: any) => String(m?.id ?? m?.name ?? "")).filter(Boolean);
}

/** Descobrir e gravar o cache na linha. Sem id = descoberta avulsa (formulário antes de salvar). */
export async function provarModelos(
  user: Usuario,
  corpo: { id?: unknown; base_url?: unknown; chave?: unknown; tipo?: unknown },
): Promise<{ modelos: string[]; em: string; id: number | null; janela_detectada?: number | null }> {
  if (!user.operador) throw erro409("só o operador descobre modelos");
  const id = corpo.id === undefined || corpo.id === null || corpo.id === "" ? null : Number(corpo.id);
  let base = "";
  let chave = "";
  let tipo: string | undefined;
  if (id !== null) {
    const r = await q<Linha>(`SELECT * FROM provedores WHERE id = $1 AND escopo = ANY($2)`, [id, [user.tenant, GLOBAL]]);
    const l = r.rows[0];
    if (!l) throw erro409("provedor não encontrado");
    base = String(l.base_url);
    chave = corpo.chave === undefined || corpo.chave === "***" || corpo.chave === "" ? String(l.chave ?? "") : String(corpo.chave);
    tipo = String(l.tipo);
  } else {
    base = validaBase(corpo.base_url);
    chave = String(corpo.chave ?? "");
    tipo = corpo.tipo ? limpaTipo(corpo.tipo) : undefined;
  }
  const modelos = await descobrirModelos(base, chave, tipo);
  const em = new Date().toISOString();
  if (id !== null) await q(`UPDATE provedores SET modelos = $2::jsonb, modelos_em = now() WHERE id = $1`, [id, JSON.stringify(modelos)]);
  return { modelos, em, id };
}
