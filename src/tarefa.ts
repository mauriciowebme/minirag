/** v3.3: tarefas de chat que sobrevivem à conexão — estado no banco, texto espelhado
 *  a cada delta, reanexar pelo barril de eventos. Criado por POST /chat/tarefa (app.ts). */
import { randomUUID } from "node:crypto";
import { q } from "./db";
import { responderChat } from "./provider";
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

/** Cria a tarefa no banco e dispara o processamento sem bloquear o request.
 *  `u` (autenticado) vem por closure — sem reconstituir Usuario do banco.
 *  O `.catch` no disparo é OBRIGATÓRIO: Node 22 mata o processo em rejeição solta
 *  (o projeto não tem handler global de unhandledRejection). */
export async function criarTarefa(
  u: Usuario,
  b: { pergunta: string; memoria: string; tenant?: string | null },
  rodar: (id: string, u: Usuario) => Promise<void>,
): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO chat_tarefas (id, tenant, memoria, pergunta) VALUES ($1, $2, $3, $4)`,
    [id, tenantFor(u, b.tenant ?? null), b.memoria, b.pergunta],
  );
  queueMicrotask(() => {
    void rodar(id, u).catch((e) => log(`tarefa ${id}: disparo falhou: ${String(e)}`));
  });
  return id;
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
  try {
    const t = (await q(`SELECT * FROM chat_tarefas WHERE id = $1`, [id])).rows[0];
    if (!t) return;
    const resp = await responderChat(
      u,
      { pergunta: t.pergunta, memoria: t.memoria, tenant: t.tenant },
      (e) => {
        if (e.tipo === "delta") {
          parcial += String(e.texto ?? "");
          espelhar(parcial);
        } else if (e.tipo === "descartar") {
          parcial = "";
          /* o rascunho descartado tem que sumir do banco também, senão quem
           * reanexar nesse intervalo replaya texto que ia ser jogado fora */
          espelhar("");
        }
        notificarTarefa(id, e); // barril (Task 4) — ao vivo, independente do banco
      },
    );
    await grava; // drena a fila ANTES do UPDATE final (ver nota acima)
    await q(
      `UPDATE chat_tarefas SET status = 'terminou', parcial = $1, ferramentas = $2::jsonb, aviso = $3, atualizado_em = now() WHERE id = $4`,
      [resp.resposta, JSON.stringify(resp.ferramentas ?? []), resp.aviso ?? null, id],
    );
    notificarTarefa(id, { tipo: "fim", dados: resp });
  } catch (e) {
    await grava;
    await q(
      `UPDATE chat_tarefas SET status = 'falhou', aviso = $1, atualizado_em = now() WHERE id = $2`,
      [String((e as Error).message ?? "a tarefa falhou"), id],
    ).catch(() => {});
    notificarTarefa(id, { tipo: "erro", detalhe: String((e as Error).message ?? "a tarefa falhou") });
  }
}
