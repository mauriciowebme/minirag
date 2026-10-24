/** Conversas em andamento (v3.0) — a conversa NÃO pertence ao componente.
 *
 *  Por quê: enquanto o agente trabalha (busca, ferramenta, modelo local devagar), você quer
 *  ir olhar a PÁGINA DE BUSCA ou outra gaveta sem perder o que está sendo processado. Se o
 *  estado morar dentro do React, desmontar a tela derruba a bolha e a fila.
 *
 *  Então: este módulo é puro TypeScript, sem import e sem React. Ele guarda o estado por
 *  conversa (`tenant|memoria`), roda a tarefa até o fim mesmo sem ninguém olhando, e avisa
 *  os ouvintes (o Chat) quando algo muda. Fechar a aba do navegador ainda cancela o pedido —
 *  isso é outro degrau (tarefa no servidor); aqui o objetivo é sobreviver à navegação no painel.
 */

export type EventoTransporte =
  | { tipo: "delta"; texto: string }
  /** v3.13: pedaço do raciocínio do modelo (estilo Open WebUI) */
  | { tipo: "raciocinio"; texto: string }
  /** v3.3: fotografia do texto acumulado no servidor (stream reanexável); o client usa
   *  como BASE e descarta o delta cujo efeito não passa dela (duplicata da corrida R2). */
  | { tipo: "parcial"; texto: string }
  | { tipo: "descartar" }
  /** v3.8: fala de caminho da rodada — mostra e FICA (pedido do dono) */
  | { tipo: "fala"; texto: string }
  | { tipo: "ferramenta"; servidor: string; nome: string; ok: boolean; ms: number }
  | { tipo: "fim"; dados: Record<string, unknown> }
  | { tipo: "erro"; detalhe: string };

/** quem sabe falar com o servidor (o Chat injeta; o teste injeta um falso) */
export type Transportar = (
  pedido: { pergunta: string; memoria: string; tenant?: string },
  onEvent: (e: EventoTransporte) => void,
) => Promise<Record<string, unknown>>;

/** o que a tela desenrola em "ferramentas chamadas" (mesmo formato que o servidor devolve) */
export type FerramentaLinha = { servidor: string; nome: string; ok: boolean; ms: number; args?: unknown; resumo?: string };

/** v3.15 — segmento do RASTRO DO TURNO, na ordem em que aconteceu (o jeito do IA_GO):
 *  o pensamento com o tempo dele, a fala de caminho e a ferramenta com o tempo dela.
 *  `vivo`/`inicio` só existem na tela enquanto o passo está acontecendo: o servidor devolve
 *  a trilha pronta, com o tempo medido, e ela substitui a montagem ao vivo no `fim`. */
export type SegmentoRastro =
  | { tipo: "pensamento"; texto: string; ms: number; vivo?: boolean; inicio?: number }
  | { tipo: "narracao"; texto: string }
  | { tipo: "ferramenta"; servidor: string; nome: string; ok: boolean; ms: number };

export type Linha = {
  id: string;
  papel: "user" | "assistant";
  texto: string;
  ferramentas: FerramentaLinha[];
  /** ainda não saiu para o modelo */
  naFila?: boolean;
  /** erro de envio */
  falha?: boolean;
  /** escrevendo em pedaços agora */
  escrevendo?: boolean;
  /** fala de caminho (rascunho da rodada virou balão fixo) */
  fala?: boolean;
  /** v3.13: o que o modelo pensou (mostrado recolhido, estilo Open WebUI) */
  raciocinio?: string;
  /** v3.15: a trilha do turno (pensamento / fala / ferramenta) na ordem real */
  rastro?: SegmentoRastro[];
  /** ms desde o começo do turno até o 1º pedaço de pensamento */
  raciocinioInicio?: number;
  /** ms desde o começo do turno até a resposta começar (fecha o "Pensou por Ns") */
  raciocinioFim?: number;
  aviso?: string | null;
  compacto?: string;
};

export type Estado = {
  msgs: Linha[];
  fila: { id: string; texto: string }[];
  rodando: boolean;
  /** a bolha que está sendo escrita agora (vazio = nenhuma) */
  vivo: string;
  /** desde quando esta tarefa corre, em epoch ms (0 = parada) — a tela mostra o tempo certo ao voltar */
  inicio: number;
};

type Conversa = Estado & { ouvintes: Set<() => void> };

let seq = 0;
/* v3.15 — o rastro do turno (o jeito do IA_GO). As três ajudas abaixo montam a trilha ao
 *  vivo, na ordem dos eventos; no `fim` a trilha do servidor (com tempo medido) substitui. */
function fecharPensamento(b: Linha): void {
  const r = b.rastro ?? [];
  const ultimo = r.length ? r[r.length - 1] : null;
  if (ultimo && ultimo.tipo === "pensamento" && ultimo.vivo) {
    ultimo.vivo = false;
    ultimo.ms = Math.max(0, Date.now() - (ultimo.inicio ?? Date.now()));
  }
}

/** emenda o pedaço de raciocínio no bloco aberto da rodada, ou abre um bloco novo */
function acrescentarPensamento(b: Linha, pedaco: string): void {
  const r = (b.rastro ??= []);
  const ultimo = r.length ? r[r.length - 1] : null;
  if (ultimo && ultimo.tipo === "pensamento" && ultimo.vivo) ultimo.texto += pedaco;
  else r.push({ tipo: "pensamento", texto: pedaco, ms: 0, vivo: true, inicio: Date.now() });
}

/** acrescenta uma linha fechada à trilha (fala de caminho ou ferramenta) */
function acrescentar(b: Linha, s: SegmentoRastro): void {
  (b.rastro ??= []).push(s);
}

/** a trilha autoritativa do servidor tem o tempo medido de cada passo; sem ela (servidor
 *  mais velho), fica a montagem ao vivo da tela */
function adotarRastro(b: Linha, r: Record<string, unknown>): boolean {
  const trilha = Array.isArray(r.rastro) ? (r.rastro as SegmentoRastro[]) : [];
  if (!trilha.length) return false;
  b.rastro = trilha.map((s) => ({ ...s }));
  return true;
}

const proximoId = () => `c${Date.now().toString(36)}-${++seq}`;

const conversas = new Map<string, Conversa>();

function nova(): Conversa {
  return { msgs: [], fila: [], rodando: false, vivo: "", inicio: 0, ouvintes: new Set() };
}

export function chaveConversa(tenant: string, memoria: string): string {
  return `${tenant || "-"}|${memoria || "-"}`;
}

function pega(chave: string): Conversa {
  let c = conversas.get(chave);
  if (!c) {
    c = nova();
    conversas.set(chave, c);
  }
  return c;
}

function notifica(chave: string): void {
  const c = conversas.get(chave);
  if (!c) return;
  /* cópia rasa: o React exige referência nova para re-renderizar */
  c.ouvintes.forEach((f) => {
    try {
      f();
    } catch {
      /* ouvinte morto (tela desmontada) nunca interrompe o processamento */
    }
  });
}

/** fotografia imutável do estado (o que o Chat renderiza) */
export function estado(chave: string): Estado {
  const c = pega(chave);
  return { msgs: c.msgs.slice(), fila: c.fila.slice(), rodando: c.rodando, vivo: c.vivo, inicio: c.inicio };
}

/** dá para assinar mesmo com a tela fechada: o trabalho continua e a tela volta quando quiser */
export function assinar(chave: string, fn: () => void): () => void {
  const c = pega(chave);
  c.ouvintes.add(fn);
  return () => c.ouvintes.delete(fn);
}

/** o histórico carregado do servidor entra na conversa sem atropelar o que está vivo */
export function semear(chave: string, msgs: Linha[]): void {
  const c = pega(chave);
  const vivo = c.msgs.filter((m) => m.escrevendo || m.naFila);
  c.msgs = [...msgs, ...vivo];
  notifica(chave);
}

/** empurra para o modelo: entra na fila da gaveta e sai uma por vez, na ordem */
export function enviar(chave: string, texto: string, memoria: string, tenant: string | undefined, transportar: Transportar): string {
  const c = pega(chave);
  const id = proximoId();
  c.msgs.push({ id, papel: "user", texto, ferramentas: [], naFila: true });
  c.fila.push({ id, texto });
  notifica(chave);
  void bombeia(chave, memoria, tenant, transportar);
  return id;
}

/** cancela antes de sair (se já estiver escrevendo, cancela a próxima, não a viva) */
export function cancelar(chave: string, id: string): void {
  const c = pega(chave);
  c.fila = c.fila.filter((x) => x.id !== id);
  c.msgs = c.msgs.filter((m) => m.id !== id);
  notifica(chave);
}

/** limpar a conversa da tela (o servidor apaga o histórico; aqui sobra o que estiver vivo) */
export function limpar(chave: string): void {
  const c = pega(chave);
  c.msgs = c.msgs.filter((m) => m.escrevendo);
  c.fila = [];
  notifica(chave);
}

export function temTrabalho(chave: string): boolean {
  const c = pega(chave);
  return c.rodando || c.fila.length > 0;
}

/** v3.3: tarefa que está viva no servidor (a aba fechou no meio e voltou). */
export type TarefaViva = { id: string; pergunta: string; parcial: string };

/** Adota uma tarefa viva no servidor: bolha do usuário + bolha escrevendo desde o parcial.
 *  A pergunta ainda NÃO está no histórico (o servidor só grava as mensagens no fim), por
 *  isso ela é empurrada aqui. `correr` é injetado — quem sabe religar em queda de rede é
 *  o transporte (Chat.tsx); conversa.ts continua puro, sem conhecer fetch. */
export async function reativar(
  chave: string,
  tarefa: TarefaViva,
  correr: (id: string, onEvent: (e: EventoTransporte) => void) => Promise<Record<string, unknown> | null>,
): Promise<void> {
  const c = pega(chave);
  if (c.rodando) return; // já há trabalho local na frente: não atropela
  c.rodando = true;
  c.inicio = Date.now();
  const vivoId = proximoId();
  c.vivo = vivoId;
  c.msgs.push(
    { id: proximoId(), papel: "user", texto: tarefa.pergunta, ferramentas: [] },
    { id: vivoId, papel: "assistant", texto: tarefa.parcial, ferramentas: [], escrevendo: true },
  );
  notifica(chave);

  let bruto = tarefa.parcial;
  let base = bruto.length; // tamanho da última fotografia confirmada pelo servidor (R2)
  let falou = false;
  let erro = "";
  const caixa: { dados: Record<string, unknown> | null } = { dados: null };
  try {
    const saida = await correr(tarefa.id, (e) => {
      const bolha = c.msgs.find((m) => m.id === vivoId);
      if (!bolha) return;
      if (e.tipo === "parcial") {
        const foto = String(e.texto ?? "");
        if (foto.length > bruto.length) bruto = foto;
        base = Math.max(base, bruto.length);
        bolha.texto = bruto;
      } else if (e.tipo === "delta") {
        const pedaco = String(e.texto ?? "");
        if (bruto.length >= base) {
          bruto += pedaco;
          bolha.texto = bruto;
          if (bolha.raciocinio && bolha.raciocinioFim === undefined) bolha.raciocinioFim = Math.max(0, Date.now() - c.inicio);
          fecharPensamento(bolha);
        } // abaixo da base: o delta já está contido na fotografia — descarta (R2)
      } else if (e.tipo === "raciocinio") {
        bolha.raciocinio = (bolha.raciocinio ?? "") + String(e.texto ?? "");
        if (bolha.raciocinioInicio === undefined) bolha.raciocinioInicio = Math.max(0, Date.now() - c.inicio);
        acrescentarPensamento(bolha, String(e.texto ?? ""));
      } else if (e.tipo === "fala") {
        const txt = String(e.texto ?? "");
        if (txt) {
          falou = true;
          if (bolha.raciocinio && bolha.raciocinioFim === undefined) bolha.raciocinioFim = Math.max(0, Date.now() - c.inicio);
          /* v3.15: a fala de caminho virou LINHA DO RASTRO (o jeito do IA_GO) — a trilha do
             turno conta a história no mesmo lugar, em vez de soltar balão no meio da tela */
          fecharPensamento(bolha);
          acrescentar(bolha, { tipo: "narracao", texto: txt });
          bruto = ""; base = 0; bolha.texto = "";
        }
      } else if (e.tipo === "ferramenta") {
        if (bolha.raciocinio && bolha.raciocinioFim === undefined) bolha.raciocinioFim = Math.max(0, Date.now() - c.inicio);
        fecharPensamento(bolha);
        acrescentar(bolha, { tipo: "ferramenta", servidor: String(e.servidor), nome: String(e.nome), ok: Boolean(e.ok), ms: Number(e.ms) });
        bolha.ferramentas.push({ servidor: String(e.servidor), nome: String(e.nome), ok: Boolean(e.ok), ms: Number(e.ms), args: {}, resumo: "" });
      } else if (e.tipo === "fim") {
        caixa.dados = e.dados;
      } else if (e.tipo === "erro") {
        erro = String(e.detalhe ?? "a tarefa falhou");
      }
      notifica(chave);
    });
    const bolha = c.msgs.find((m) => m.id === vivoId);
    if (bolha) {
      const r = caixa.dados ?? saida ?? { resposta: bruto };
      bolha.texto = erro ? "não consegui responder: " + erro : String(r.resposta ?? bruto);
      if (!bolha.raciocinio && r.raciocinio) bolha.raciocinio = String(r.raciocinio);
      fecharPensamento(bolha);
      /* v3.15: a trilha do servidor manda (tem o tempo medido de cada passo) */
      const trilhou = adotarRastro(bolha, r);
      /* servidor sem stream (ou reanexar de tarefa): as falas vêm no remanescente do `fim`
         e ainda viram balão quando não existe trilha que as hospede */
      const fl = Array.isArray(r.falas) ? (r.falas as string[]) : [];
      if (fl.length && !falou && !trilhou) {
        const idx = c.msgs.findIndex((m) => m.id === vivoId);
        fl.forEach((txt, k) =>
          c.msgs.splice(idx < 0 ? c.msgs.length : idx + k, 0, {
            id: vivoId + "f" + k, papel: "assistant", texto: String(txt), ferramentas: [], fala: true,
          }),
        );
      }
      bolha.ferramentas = (r.ferramentas as FerramentaLinha[]) ?? bolha.ferramentas;
      bolha.aviso = (r.aviso as string) ?? null;
      bolha.compacto = (r.compacto as string) ?? undefined;
      bolha.escrevendo = false;
      bolha.falha = Boolean(erro);
    }
  } catch (e) {
    const bolha = c.msgs.find((m) => m.id === vivoId);
    if (bolha) {
      bolha.escrevendo = false;
      bolha.falha = true;
      bolha.texto = "não consegui responder: " + (e as Error).message;
    }
  } finally {
    c.rodando = false;
    c.inicio = 0;
    c.vivo = "";
    notifica(chave);
  }
}

/** dispara a próxima da fila quando estiver livre */
async function bombeia(chave: string, memoria: string, tenant: string | undefined, transportar: Transportar): Promise<void> {
  const c = pega(chave);
  if (c.rodando) return;
  const item = c.fila.shift();
  if (!item) {
    notifica(chave);
    return;
  }
  c.rodando = true;
  c.inicio = Date.now();
  const alvo = c.msgs.find((m) => m.id === item.id);
  if (alvo) alvo.naFila = false;
  notifica(chave);

  const vivoId = proximoId();
  c.vivo = vivoId;
  c.msgs.push({ id: vivoId, papel: "assistant", texto: "", ferramentas: [], escrevendo: true });
  let bruto = "";
  let falou = false; // se os balões chegaram pelo stream, o `fim` nao re-insere (nem duplica)
  /* caixa mutável: o evento `fim` escreve aqui por dentro do closure */
  const caixa: { dados: Record<string, unknown> | null } = { dados: null };
  let erro = "";
  try {
    const saida = await transportar({ pergunta: item.texto, memoria, ...(tenant ? { tenant } : {}) }, (e) => {
      const bolha = c.msgs.find((m) => m.id === vivoId);
      if (!bolha) return;
      if (e.tipo === "delta") {
        bruto += String(e.texto ?? "");
        bolha.texto = bruto;
        if (bolha.raciocinio && bolha.raciocinioFim === undefined) bolha.raciocinioFim = Math.max(0, Date.now() - c.inicio);
        fecharPensamento(bolha);
      } else if (e.tipo === "raciocinio") {
        bolha.raciocinio = (bolha.raciocinio ?? "") + String(e.texto ?? "");
        if (bolha.raciocinioInicio === undefined) bolha.raciocinioInicio = Math.max(0, Date.now() - c.inicio);
        acrescentarPensamento(bolha, String(e.texto ?? ""));
      } else if (e.tipo === "fala") {
        /* a rodada chamou ferramenta e falou no caminho: o texto deixa de ser rascunho
           e vira BALÃO PRÓPRIO, cravado antes da bolha viva (conversa corrida, v3.8) */
        const txt = String(e.texto ?? "");
        if (txt) {
          falou = true;
          if (bolha.raciocinio && bolha.raciocinioFim === undefined) bolha.raciocinioFim = Math.max(0, Date.now() - c.inicio);
          /* v3.15: a fala de caminho virou LINHA DO RASTRO (o jeito do IA_GO) */
          fecharPensamento(bolha);
          acrescentar(bolha, { tipo: "narracao", texto: txt });
          bruto = "";
          bolha.texto = "";
        }
      } else if (e.tipo === "descartar") {
        bruto = "";
        bolha.texto = "";
      } else if (e.tipo === "ferramenta") {
        if (bolha.raciocinio && bolha.raciocinioFim === undefined) bolha.raciocinioFim = Math.max(0, Date.now() - c.inicio);
        fecharPensamento(bolha);
        acrescentar(bolha, { tipo: "ferramenta", servidor: String(e.servidor), nome: String(e.nome), ok: Boolean(e.ok), ms: Number(e.ms) });
        bolha.ferramentas.push({ servidor: String(e.servidor), nome: String(e.nome), ok: Boolean(e.ok), ms: Number(e.ms), args: {}, resumo: "" });
      } else if (e.tipo === "fim") {
        caixa.dados = e.dados;
      } else if (e.tipo === "erro") {
        erro = String(e.detalhe ?? "o chat falhou");
      }
      notifica(chave);
    });
    const bolha = c.msgs.find((m) => m.id === vivoId);
    if (bolha) {
      const r = caixa.dados ?? saida ?? { resposta: bruto, ferramentas: [] };
      bolha.texto = erro ? "não consegui responder: " + erro : String(r.resposta ?? bruto);
      if (!bolha.raciocinio && r.raciocinio) bolha.raciocinio = String(r.raciocinio);
      fecharPensamento(bolha);
      /* v3.15: a trilha do servidor manda (tem o tempo medido de cada passo) */
      const trilhou = adotarRastro(bolha, r);
      /* servidor sem stream (ou reanexar de tarefa): as falas vêm no remanescente do `fim`
         e ainda viram balão quando não existe trilha que as hospede */
      const fl = Array.isArray(r.falas) ? (r.falas as string[]) : [];
      if (fl.length && !falou && !trilhou) {
        const idx = c.msgs.findIndex((m) => m.id === vivoId);
        fl.forEach((txt, k) =>
          c.msgs.splice(idx < 0 ? c.msgs.length : idx + k, 0, {
            id: vivoId + "f" + k, papel: "assistant", texto: String(txt), ferramentas: [], fala: true,
          }),
        );
      }
      bolha.ferramentas = (r.ferramentas as FerramentaLinha[]) ?? bolha.ferramentas;
      bolha.aviso = (r.aviso as string) ?? null;
      /* quem desenha o aviso da compactação é a tela; o transporte entrega a linha pronta */
      bolha.compacto = (r.compacto as string) ?? undefined;
      bolha.escrevendo = false;
      bolha.falha = Boolean(erro);
    }
  } catch (e) {
    const bolha = c.msgs.find((m) => m.id === vivoId);
    if (bolha) {
      bolha.escrevendo = false;
      bolha.falha = true;
      bolha.texto = "não consegui responder: " + (e as Error).message;
    }
  } finally {
    c.rodando = false;
    c.inicio = 0;
    c.vivo = "";
    notifica(chave);
    if (c.fila.length) void bombeia(chave, memoria, tenant, transportar);
  }
}
