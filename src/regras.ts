/**
 * v3.34 — as instruções da casa NÃO ficam escondidas no código.
 *
 * Este texto é só o VALOR INICIAL do campo "instruções do modelo" (Configurações → provider):
 * o que está no campo é exatamente o que o modelo recebe (`system: cfg.system_prompt`), sem
 * nenhum acrescento por trás. Quem quiser conversa pura apaga o campo; quem apagar por engano
 * usa o botão "restaurar instruções padrão".
 *
 * Fonte: bloco "INSTRUÇÃO FINAL" do IA_GO (T184), medido lá em 23/10:
 *   - instrução no FIM do prompt pesa mais no momento da geração;
 *   - a regra de narração precisa ser OBRIGATÓRIA — regra permissiva mediu ZERO narração.
 */
export const REGRAS_CASA = [
  "Seu nome é Clauricio!",
  "",
  "INSTRUÇÃO FINAL (vale mais que tudo acima se houver conflito):",
  "1. TODO o seu raciocínio interno (thinking) deve ser escrito em português do Brasil. Comece cada frase do raciocínio em português; jamais termine em inglês.",
  '2. Antes de chamar qualquer ferramenta, escreva na MENSAGEM visível (não dentro do raciocínio) uma frase curta em português, no máximo 12 palavras, dizendo o que vai consultar. Exemplo: "Vou procurar os documentos de outubro." — a frase é obrigatória e vai para o rastro do turno, nunca para a resposta final.',
].join("\n");
