/** Usuários no BANCO (v2.7): criar/desativar pela tela, chave gerada e mostrada 1x.
 *
 *  O env (MINIRAG_USERS / MINIRAG_OPERADOR) continua valendo como SEMENTE: no boot
 *  cada entrada é inserida se ainda não existir. Depois disso o banco é a verdade —
 *  desativar pela tela vale até para quem veio do env.
 *
 *  A chave NUNCA é gravada em claro: guardamos sha256 + os 4 últimos caracteres
 *  (só para o painel mostrar "sk-…4f2a"). Comparação em tempo constante.
 */
import crypto from "node:crypto";
import { OPERADOR, USERS, Usuario, log } from "./config";
import { erro409, erro422, erro404, erro403 } from "./errors";
import { q } from "./db";

export type Papel = "usuario" | "operador";

type Linha = {
  nome: string;
  chave_hash: string;
  chave_hint: string;
  papel: Papel;
  ativo: boolean;
  criado_em: string;
  atualizado_em: string;
};

/** cache por hash da chave -> usuário (autenticação é O(1) e não bate no banco) */
const porHash = new Map<string, { nome: string; papel: Papel }>();
let ativos: string[] = [];
let operadores: string[] = [];

export function hashChave(chave: string): string {
  return crypto.createHash("sha256").update(chave, "utf8").digest("hex");
}

export function gerarChave(): string {
  // 24 bytes = 32 caracteres url-safe; comparável a uma chave de API comum
  return `mr_${crypto.randomBytes(24).toString("base64url")}`;
}

export function validarNome(nome: string): string {
  const n = (nome ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(n)) {
    throw erro422("nome deve ter 2-32 caracteres: letras sem acento, números, ponto, hífen ou _");
  }
  return n;
}

export async function initUsuarios(): Promise<void> {
  await q(
    `CREATE TABLE IF NOT EXISTS usuarios (
       nome TEXT PRIMARY KEY,
       chave_hash TEXT NOT NULL UNIQUE,
       chave_hint TEXT NOT NULL DEFAULT '',
       papel TEXT NOT NULL DEFAULT 'usuario',
       ativo BOOLEAN NOT NULL DEFAULT true,
       criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
       atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );

  // semente do env: entra só uma vez (ON CONFLICT não mexe em quem já existe)
  const sementes: Array<[string, string, Papel]> = [
    ...OPERADOR.map(([n, k]) => [n, k, "operador"] as [string, string, Papel]),
    ...USERS.map(([n, k]) => [n, k, "usuario"] as [string, string, Papel]),
  ];
  let novas = 0;
  for (const [nome, chave, papel] of sementes) {
    const r = await q(
      // DO NOTHING sem alvo: se a MESMA chave já existe sob outro nome (rotação
      // feita pelo painel), o que conflita é chave_hash — e o boot quebrava nesse caso
      `INSERT INTO usuarios (nome, chave_hash, chave_hint, papel)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [nome, hashChave(chave), chave.slice(-4), papel],
    );
    novas += r.rowCount ?? 0;
  }
  if (novas) log(`usuarios: ${novas} semeado(s) do env`);
  await recarregarUsuarios();
}

/** Recarrega o cache em memória (chamado no boot e depois de cada mudança). */
export async function recarregarUsuarios(): Promise<void> {
  const r = await q<Linha>(`SELECT * FROM usuarios ORDER BY nome`);
  porHash.clear();
  ativos = [];
  operadores = [];
  for (const u of r.rows) {
    if (!u.ativo) continue;
    porHash.set(u.chave_hash, { nome: u.nome, papel: u.papel });
    ativos.push(u.nome);
    if (u.papel === "operador") operadores.push(u.nome);
  }
  log(`usuarios: ${ativos.length} ativo(s) (${operadores.length} operador)`);
}

/** Autentica pelo hash da chave. null = não é usuário ativo. */
export function usuarioPorChave(chave: string): Usuario | null {
  const token = chave.trim();
  if (!token) return null;
  const h = hashChave(token);
  const u = porHash.get(h);
  if (u) return { tenant: u.nome, operador: u.papel === "operador" };
  /* sem fallback para o env: desativar/trocar a chave pela tela tem de valer de imediato
     (initUsuarios sempre roda antes do servidor ouvir) */
  return null;
}

export function nomesUsuarios(): string[] {
  return [...ativos];
}

export function nomesOperadores(): string[] {
  return [...operadores];
}

export function estaAtivo(nome: string): boolean {
  return ativos.includes(nome);
}

export type UsuarioPublico = {
  nome: string;
  papel: Papel;
  ativo: boolean;
  chave_hint: string;
  criado_em: string;
  origem_env: boolean;
  gavetas: number;
  documentos: number;
  ultimo: string | null;
};

export async function listarUsuarios(): Promise<UsuarioPublico[]> {
  const r = await q<Linha>(
    `SELECT * FROM usuarios ORDER BY (papel = 'operador') DESC, nome`,
  );
  const dados = await q<{ tenant: string; docs: string; gavetas: string; ultimo: string | null }>(
    `SELECT tenant, count(DISTINCT doc_id) AS docs, count(DISTINCT memoria) AS gavetas,
            max(ingested_at) AS ultimo
     FROM chunks GROUP BY tenant`,
  );
  const porTenant = new Map(dados.rows.map((d) => [d.tenant, d]));
  const doEnv = new Set([...USERS.map(([n]) => n), ...OPERADOR.map(([n]) => n)]);
  return r.rows.map((u) => {
    const d = porTenant.get(u.nome);
    return {
      nome: u.nome,
      papel: u.papel,
      ativo: u.ativo,
      chave_hint: u.chave_hint,
      criado_em: u.criado_em,
      origem_env: doEnv.has(u.nome),
      gavetas: Number(d?.gavetas ?? 0),
      documentos: Number(d?.docs ?? 0),
      ultimo: d?.ultimo ?? null,
    };
  });
}

export async function criarUsuario(
  nomeBruto: string,
  papelBruto: unknown,
): Promise<{ nome: string; papel: Papel; chave: string; aviso: string }> {
  const nome = validarNome(nomeBruto);
  const papel: Papel = papelBruto === "operador" ? "operador" : "usuario";
  const existe = await q(`SELECT 1 FROM usuarios WHERE nome = $1`, [nome]);
  if (existe.rowCount) throw erro409(`usuario '${nome}' ja existe`);
  const chave = gerarChave();
  await q(
    `INSERT INTO usuarios (nome, chave_hash, chave_hint, papel) VALUES ($1, $2, $3, $4)`,
    [nome, hashChave(chave), chave.slice(-4), papel],
  );
  await recarregarUsuarios();
  return {
    nome,
    papel,
    chave,
    aviso: "guarde esta chave agora: ela nao aparece de novo",
  };
}

/** Só operador. Não deixa desativar/rebaixar o último operador ativo. */
export async function atualizarUsuario(
  nomeBruto: string,
  body: { ativo?: unknown; papel?: unknown },
): Promise<{ nome: string; ativo: boolean; papel: Papel }> {
  const nome = nomeBruto.trim().toLowerCase();
  const atual = await q<Linha>(`SELECT * FROM usuarios WHERE nome = $1`, [nome]);
  if (!atual.rowCount) throw erro404(`usuario '${nome}' nao existe`);
  const u = atual.rows[0];

  if (body.ativo !== undefined && typeof body.ativo !== "boolean") {
    throw erro422("ativo deve ser true ou false");
  }
  const ativo = body.ativo === undefined ? u.ativo : body.ativo;
  const papel: Papel =
    body.papel === "operador" ? "operador" : body.papel === "usuario" ? "usuario" : u.papel;

  const perdeOperador = u.papel === "operador" && (papel !== "operador" || !ativo);
  if (perdeOperador && operadores.filter((o) => o !== nome).length === 0) {
    throw erro409("este e o ultimo operador ativo: crie outro antes de rebaixar ou desativar");
  }

  await q(
    `UPDATE usuarios SET ativo = $2, papel = $3, atualizado_em = now() WHERE nome = $1`,
    [nome, ativo, papel],
  );
  await recarregarUsuarios();
  return { nome, ativo, papel };
}

/** Gera chave nova e devolve em claro UMA vez (o painel mostra e descarta). */
export async function novaChaveUsuario(nomeBruto: string): Promise<{ nome: string; chave: string; aviso: string }> {
  const nome = nomeBruto.trim().toLowerCase();
  const existe = await q(`SELECT 1 FROM usuarios WHERE nome = $1`, [nome]);
  if (!existe.rowCount) throw erro404(`usuario '${nome}' nao existe`);
  const chave = gerarChave();
  await q(
    `UPDATE usuarios SET chave_hash = $2, chave_hint = $3, atualizado_em = now() WHERE nome = $1`,
    [nome, hashChave(chave), chave.slice(-4)],
  );
  await recarregarUsuarios();
  return { nome, chave, aviso: "chave nova: a anterior parou de funcionar agora" };
}

/** Apaga só usuário sem documento (senão o acervo fica órfão). */
export async function removerUsuario(nomeBruto: string): Promise<{ nome: string; removido: boolean }> {
  const nome = nomeBruto.trim().toLowerCase();
  const docs = await q(`SELECT count(*) AS n FROM chunks WHERE tenant = $1`, [nome]);
  if (Number(docs.rows[0]?.n ?? 0) > 0) {
    throw erro409("usuario tem documentos: apague as gavetas dele antes de remover");
  }

  // v3.2.3: mesma guarda do PATCH. Sem isto, apagar o último operador deixava a
  // plataforma sem admin — e como a política passou a ser "só o admin vem do env",
  // não haveria mais semente para recriá-lo no próximo boot.
  const linha = await q(`SELECT papel, ativo FROM usuarios WHERE nome = $1`, [nome]);
  if (!linha.rowCount) throw erro404(`usuario '${nome}' nao existe`);
  const alvo = linha.rows[0] as { papel: Papel; ativo: boolean };
  if (alvo.papel === "operador" && alvo.ativo && operadores.filter((o) => o !== nome).length === 0) {
    throw erro409("este e o ultimo operador ativo: crie outro antes de apagar");
  }

  const r = await q(`DELETE FROM usuarios WHERE nome = $1`, [nome]);
  if (!r.rowCount) throw erro404(`usuario '${nome}' nao existe`);
  await recarregarUsuarios();
  return { nome, removido: true };
}

/** Guarda de rota: usuário comum não mexe em contas. */
export function exigirOperador(u: Usuario): void {
  if (!u.operador) throw erro403("somente o operador pode gerenciar usuarios");
}

