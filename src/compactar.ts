/** Compactação de contexto (v3.0) — determinística, sem LLM, sem custo.
 *
 *  Ideia (a mesma da mini-compress do agente): a conversa antiga NÃO é jogada fora,
 *  ela vira LINHA CURTA; as últimas mensagens ficam VERBATIM; e nada nunca estoura o
 *  gateway — se mesmo assim não couber, descarta do mais antigo e AVISA quantos.
 *
 *  Orçamento (tokens estimados, heurística de 4 caracteres por token):
 *
 *     disponível = janela - reserva_da_resposta - ferramentas(specs) - system - pergunta
 *
 *  Regras fixas:
 *   - system prompt e pergunta atual NUNCA são comprimidos;
 *   - resultado de ferramenta antigo é cortado antes de qualquer descarte;
 *   - as referências (gaveta, doc_id) sobrevivem na linha resumida;
 *   - o plano devolve números (resumidas / cortadas / descartadas) para a tela avisar.
 */

export const CHARS_POR_TOKEN = 4;

/** estimativa de tokens de um texto (sem tokenizador: 4 caracteres por token) */
export function estimarTokens(texto: unknown): number {
  const t = typeof texto === "string" ? texto : texto === undefined || texto === null ? "" : JSON.stringify(texto);
  return Math.ceil(String(t).length / CHARS_POR_TOKEN);
}

/** quanto o payload inteiro custa: mensagens + as specs de ferramenta que vão junto */
export function custoDoPayload(mensagens: { content?: unknown }[], tools?: unknown): number {
  let n = 0;
  for (const m of mensagens) n += estimarTokens(m?.content ?? "") + 4; /* +4: papel/estrutura */
  if (tools) n += estimarTokens(tools) + 32;
  return n;
}

export type MsgChat = { role: "system" | "user" | "assistant" | "tool"; content: string; [k: string]: unknown };

export type Plano = {
  mensagens: MsgChat[];
  /** linhas antigas que viraram resumo de uma linha */
  resumidas: number;
  /** conteúdos de ferramenta cortados para caber */
  cortadas: number;
  /** mensagens jogadas fora (mais antigas primeiro) */
  descartadas: number;
  /** cabou no orçamento? */
  coube: boolean;
  /** tokens estimados do payload final */
  tokens: number;
  /** para quanto ficou o orçamento disponível */
  disponivel: number;
};

/** uma linha curta de uma mensagem antiga (papel + começo do texto) */
function linha(msg: MsgChat): string {
  const bruto = String(msg.content ?? "").replace(/\s+/g, " ").trim();
  /* ferramenta: preserva o que a resposta cita (gaveta/doc), não o texto todo */
  const t = msg.role === "tool" ? bruto.replace(/\s{2,}/g, " ") : bruto;
  return t.length > 160 ? `${msg.role}: ${t.slice(0, 160)}…` : `${msg.role}: ${t}`;
}

/** corta um conteúdo de ferramenta no teto, marcando que houve corte */
function aparar(texto: string, maxChars: number): string {
  if (texto.length <= maxChars) return texto;
  return `${texto.slice(0, maxChars)}\n…(cortado por orçamento de contexto)`;
}

export type PedidoDeOrçamento = {
  /** system prompt (intocável) */
  system: string;
  /** histórico da gaveta, da mais antiga para a mais nova (sem a pergunta atual) */
  historico: MsgChat[];
  /** pergunta atual (intocável) */
  pergunta: string;
  /** tokens que as specs de ferramenta custam */
  toolsTokens: number;
  /** janela total do modelo (detectada ou configurada) */
  janela: number;
  /** quanto deixar livre para a resposta */
  reserva: number;
  /** quantas mensagens recentes ficam verbatim */
  verbatim: number;
  /** teto de caracteres de cada resultado de ferramenta novo */
  tetoFerramenta?: number;
};

const LIMITE_FERRAMENTA_PADRAO = 6000;

/** Monta o payload que vai para o modelo, cabendo no orçamento. */
export function montarPayload(p: PedidoDeOrçamento): Plano {
  const tetoFerramenta = p.tetoFerramenta ?? LIMITE_FERRAMENTA_PADRAO;
  const disponivel = Math.max(1, Math.floor(p.janela - p.reserva - p.toolsTokens));
  const system: MsgChat[] = p.system.trim() ? [{ role: "system", content: p.system }] : [];
  const atual: MsgChat[] = [{ role: "user", content: p.pergunta }];

  let historico = p.historico.map((m) => ({ ...m }));
  /* resultado de ferramenta grande no histórico é o primeiro a ser aparado */
  let cortadas = 0;
  for (let i = historico.length - 1; i >= 0; i--) {
    const m = historico[i];
    if ((m.role === "tool" || m.role === "assistant") && m.content.length > tetoFerramenta) {
      m.content = aparar(m.content, tetoFerramenta);
      cortadas++;
    }
  }

  const fixo = custoDoPayload([...system, ...atual]);
  let resumidas = 0;
  let descartadas = 0;

  /** comprime o que está fora da cauda verbatim e recalcula */
  const ajustar = (): { corpo: MsgChat[]; custo: number } => {
    const guardaDe = Math.max(0, historico.length - Math.max(0, p.verbatim));
    const corpo: MsgChat[] = [];
    resumidas = 0;
    for (let i = 0; i < historico.length; i++) {
      if (i < guardaDe) {
        corpo.push({ role: historico[i].role === "tool" ? "assistant" : historico[i].role, content: linha(historico[i]) });
        resumidas++;
      } else {
        corpo.push(historico[i]);
      }
    }
    return { corpo, custo: custoDoPayload([...system, ...corpo, ...atual]) };
  };

  /* 1) resume as antigas e vê se cabe */
  let { corpo, custo } = ajustar();
  /* 2) não coube: joga fora do mais antigo (o verbatim da cauda segura por último) */
  while (custo > disponivel && historico.length > 0) {
    historico = historico.slice(1);
    descartadas++;
    ({ corpo, custo } = ajustar());
  }
  /* 3) nem sem histórico cabe: o system + a pergunta vão sozinhos (avisa `coube: false`) */
  if (custo > disponivel) {
    corpo = [];
    return {
      mensagens: [...system, ...atual],
      resumidas: 0,
      cortadas,
      descartadas,
      coube: false,
      tokens: custoDoPayload([...system, ...atual]),
      disponivel,
    };
  }

  return {
    mensagens: [...system, ...corpo, ...atual],
    resumidas,
    cortadas,
    descartadas,
    coube: true,
    tokens: custo,
    disponivel,
  };
}

/** Aperta UMA rodada do loop de ferramentas: resultado velho de ferramenta encolhe antes de qualquer descarte. */
export function apertarRodada(
  mensagens: MsgChat[],
  orc: { janela: number; reserva: number; toolsTokens: number; verbatim: number },
): { mensagens: MsgChat[]; cortadas: number; descartadas: number; tokens: number; disponivel: number } {
  const disponivel = Math.max(1, Math.floor(orc.janela - orc.reserva - orc.toolsTokens));
  const copia = mensagens.map((m) => ({ ...m }));
  let cortadas = 0;
  let descartadas = 0;

  const custo = () => custoDoPayload(copia) + Math.max(0, orc.toolsTokens);

  /* 1) conteúdos de ferramenta: os mais antigos viram as primeiras vítimas (400 chars) */
  for (let i = 0; i < copia.length - 1 && custo() > disponivel; i++) {
    if (copia[i].role === "tool" && copia[i].content.length > 400) {
      copia[i].content = aparar(copia[i].content, 400);
      cortadas++;
    }
  }
  /* 2) mensagens antigas (mantém system na frente + cauda verbatim + última) */
  const cauda = Math.max(1, Math.min(orc.verbatim, copia.length - 2));
  while (custo() > disponivel && copia.length > 2 + cauda) {
    /* remove a primeira não-system */
    const idx = copia.findIndex((m, i) => i > 0 && m.role !== "system" && copia.length - 1 - i >= cauda);
    if (idx < 0) break;
    copia.splice(idx, 1);
    descartadas++;
  }
  return { mensagens: copia, cortadas, descartadas, tokens: custo(), disponivel };
}
