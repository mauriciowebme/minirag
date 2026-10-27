/** v3.3: tarefas de chat que sobrevivem à conexão — estado no banco, texto espelhado
 *  a cada delta, reanexar pelo barril de eventos. Criado por POST /chat/tarefa (app.ts). */
import { randomUUID } from "node:crypto";
import { q } from "./db";
import { responderChat, gerarTituloAutomatico } from "./provider";
import { tenantFor, type Usuario, log } from "./config";

/* ---- barril de eventos (nasce aqui; Task 4 consome no SSE reanexável) ----
   Eventos ao vivo não dependem do banco: notificar é síncrono e por fora da
   cadeia `grava`. `fim`/`erro` só saem DEPOIS do UPDATE final — quem recebe
   `fim` e logo em seguida consulta GET /chat/tarefa/:id já vê estado coerente. */
type Ouvinte = (e: unknown) => void;
const barris = new Map<string, Set<Ouvinte>>();

export function assinarTarefa(id: string, fn: Ouvinte): () => void {
  let s = barris.get(id);
  if (!s) {
    s = new Set();
    barris.set(id, s);
  }
  s.add(fn);
  return () => {
    s!.delete(fn);
    if (!s!.size) barris.delete(id);
  };
}

export function notificarTarefa(id: string, e: unknown): void {
  barris.get(id)?.forEach((fn) => {
    try {
      fn(e);
    } catch {
      /* ouvinte morto não derruba a tarefa */
    }
  });
}

/* v3.18 (T001): registro vivo do "parar" — o AbortController da chamada em curso, por tarefa.
   morre junto com o processamento; cancelarTarefa aborta, responderChat preserva o parcial. */
const controles = new Map<string, AbortController>();

/** v3.18 (T001): parar uma tarefa. A regra de dono é a mesma do reanexar (verTarefa:
   id + tenant; operador via tenantFor). Tarefa que já acabou: ok=true, vivia=false —
   não se cancela fantasma, e a tela limpa o estado dela pelo `fim` que já viu. */
export async function cancelarTarefa(u: Usuario, id: string, tenantArg?: string | null): Promise<{ achou: boolean; vivia: boolean }> {
  const t = await verTarefa(u, id, tenantArg ?? null);
  if (!t) return { achou: false, vivia: false };
  const vivia = String(t.status) === "rodando";
  controles.get(id)?.abort();
  return { achou: true, vivia };
}

/** Cria a tarefa no banco e dispara o processamento sem bloquear o request.
 *  `u` (autenticado) vem por closure — sem reconstituir Usuario do banco.
 *  O `.catch` no disparo é OBRIGATÓRIO: Node 22 mata o processo em rejeição solta
 *  (o projeto não tem handler global de unhandledRejection). */
export async function criarTarefa(
  u: Usuario,
  b: { pergunta: string; memoria: string; tenant?: string | null; provedor?: string; modelo?: string },
  rodar: (id: string, u: Usuario) => Promise<void>,
): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO chat_tarefas (id, tenant, memoria, pergunta, provedor, modelo) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, tenantFor(u, b.tenant ?? null), b.memoria, b.pergunta, b.provedor ?? "", b.modelo ?? ""],
  );
  queueMicrotask(() => {
    void rodar(id, u).catch((e) => log(`tarefa ${id}: disparo falhou: ${String(e)}`));
  });
  return id;
}

/* ---- consultas (Task 3) — SQL mora no domínio, não em app.ts ---- */

export async function listarTarefas(u: Usuario, opts: { memoria: string; tenant?: string | null }) {
  const r = await q(
    `SELECT id, pergunta, status, parcial, criado_em, atualizado_em FROM chat_tarefas
     WHERE tenant = $1 AND memoria = $2 AND status = 'rodando' ORDER BY criado_em`,
    [tenantFor(u, opts.tenant ?? null), opts.memoria],
  );
  return { tarefas: r.rows };
}

export async function verTarefa(u: Usuario, id: string, tenantArg?: string | null) {
  /* filtro por tenant OBRIGATÓRIO: id só é 404 se não existir OU pertencer a outro
   * tenant — senão vazaria `parcial` entre tenants no reanexar. */
  const r = await q(
    `SELECT * FROM chat_tarefas WHERE id = $1 AND tenant = $2`,
    [id, tenantFor(u, tenantArg ?? null)],
  );
  return r.rows[0] ?? null;
}

/** Executa a tarefa: upsert de parcial a cada delta; responderChat já grava
 *  chat_mensagens no fim (provider.ts:750) — aqui só fechamos a tarefa.
 *  `tenant: t.tenant` (o da linha): operador criou para outro tenant → o arg é
 *  reaplicado via tenantFor; login comum ignora arg e cai no próprio (== linha). */
export async function rodarTarefa(id: string, u: Usuario): Promise<void> {
  let parcial = "";
  /* writes de parcial em cadeia: `void q()` solto por delta pode chegar fora de
   * ordem e UMA gravação atrasada pode amassar o UPDATE final (parcial de meio de
   * rodada > resposta completa). A fila promise serializa; o `await grava` antes do
   * UPDATE terminou dreneia tudo que ficou para trás. */
  let grava = Promise.resolve();
  const espelhar = (texto: string) => {
    grava = grava
      .then(async () => {
        await q(`UPDATE chat_tarefas SET parcial = $1, atualizado_em = now() WHERE id = $2`, [texto, id]);
      })
      .catch((e) => log(`tarefa ${id}: espelho parcial falhou: ${e.message}`));
  };
  const ctrl = new AbortController();
  controles.set(id, ctrl);
  try {
    const t = (await q(`SELECT * FROM chat_tarefas WHERE id = $1`, [id])).rows[0];
    if (!t) return;
    const resp = await responderChat(
      u,
      { pergunta: t.pergunta, memoria: t.memoria, tenant: t.tenant, provedor: String(t.provedor ?? ""), modelo: String(t.modelo ?? "") },
      (e) => {
        if (e.tipo === "delta") {
          parcial += String(e.texto ?? "");
          espelhar(parcial);
        } else if (e.tipo === "descartar" || e.tipo === "fala") {
          parcial = "";
          /* o rascunho da rodada (que agora e FALA fixa na tela, v3.8) tem que sumir do
           * espelho tambem, senao quem reanexar nesse intervalo replaya rascunho + resposta */
          espelhar("");
        }
        notificarTarefa(id, e); // barril (Task 4) — ao vivo, independente do banco
      },
      /* v3.18 (T001): o "parar" derruba a chamada do provider em curso */
      { sinal: ctrl.signal },
    );
    await grava; // drena a fila ANTES do UPDATE final (ver nota acima)
    await q(
      `UPDATE chat_tarefas SET status = 'terminou', parcial = $1, ferramentas = $2::jsonb, aviso = $3, telas = $4::jsonb, atualizado_em = now() WHERE id = $5`,
      [resp.resposta, JSON.stringify(resp.ferramentas ?? []), resp.aviso ?? null, JSON.stringify(resp.telas ?? []), id],
    );
    notificarTarefa(id, { tipo: "fim", dados: resp });
    /* v3.18 (T016): primeira troca de uma gaveta nomeada ganha título automático —
       nunca bloqueia nem derruba a resposta (gerarTituloAutomatico engole os próprios erros). */
    if (!resp.cancelada) {
      void gerarTituloAutomatico(u, { tenant: t.tenant, memoria: t.memoria, pergunta: t.pergunta, resposta: String(resp.resposta ?? "") })
        .catch((e) => log(`tarefa ${id}: titulo automatico falhou: ${String(e)}`));
    }
  } catch (e) {
    await grava;
    await q(
      `UPDATE chat_tarefas SET status = 'falhou', aviso = $1, atualizado_em = now() WHERE id = $2`,
      [String((e as Error).message ?? "a tarefa falhou"), id],
    ).catch(() => {});
    notificarTarefa(id, { tipo: "erro", detalhe: String((e as Error).message ?? "a tarefa falhou") });
  } finally {
    controles.delete(id);
  }
}
