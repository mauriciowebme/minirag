/** Telas geradas pelo agente (v3.23) — o "generative UI" do chat.
 *
 *  Ideia aceita pelo dono (26/10): quando o pedido é visual — gráfico, painel,
 *  comparativo, tabela, formulário, simulação — o agente gera uma PÁGINA HTML
 *  completa (CSS e JS inline) e ela aparece no chat como um card com preview
 *  FUNCIONAL: botão clica, campo digita, gráfico desenha; além de tela cheia,
 *  código e download do `.html`.
 *
 *  Regras (não são detalhe, são o desenho):
 *   - a página roda em iframe `sandbox` SEM `allow-same-origin`: o HTML gerado
 *     não lê chave, cookie nem storage do painel, e não fala com a API daqui;
 *   - nada de CDN: a tela tem de funcionar offline (SVG/CSS/JS puro);
 *   - teto de tamanho e de telas por turno: tela é resposta, não despejo de arquivo;
 *   - o HTML NUNCA volta inteiro para o modelo (gastaria a janela à toa): o
 *     resultado da ferramenta é uma linha curta, e o texto da tela viaja no
 *     campo `tela` do resultado, só para a camada do chat.
 */
import { erro422 } from "./errors";

export type Tela = { id: string; titulo: string; html: string };

/** teto do HTML de UMA tela (caracteres) — acima disso, divida em telas menores */
export const MAX_TELA_CHARS = 200_000;
/** quantas telas um mesmo turno pode exibir (o card ocupa a tela; mais que isso vira ruído) */
export const MAX_TELAS_TURNO = 3;

const CSS_BASE = [
  ":root{color-scheme:light dark}",
  "*{box-sizing:border-box}",
  "body{margin:0;padding:16px;font:15px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1f2328;background:#fff}",
  "h1,h2,h3{line-height:1.25;margin:0 0 .6em}",
  "table{border-collapse:collapse;width:100%}",
  "th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left}",
  "th{background:#f6f8fa}",
  "button{font:inherit;padding:7px 14px;border-radius:8px;border:1px solid #d0d7de;background:#f6f8fa;cursor:pointer}",
  "button:hover{background:#eef1f4}",
  "input,select,textarea{font:inherit;padding:6px 8px;border:1px solid #d0d7de;border-radius:8px}",
  "@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}th,td{border-color:#30363d}th{background:#161b22}button{background:#21262d;border-color:#30363d;color:#e6edf3}button:hover{background:#30363d}input,select,textarea{background:#0d1117;border-color:#30363d;color:#e6edf3}}",
].join("\n");

const escaparAtributo = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** v3.24 — o `html` de um JSON de argumentos AINDA EM CONSTRUÇÃO, já desescapado.
 *
 *  Pedido do dono (27/10): "queria muito poder ver o streaming digitando o código do
 *  preview, do jeito que está eu não vejo". O modelo escreve os argumentos da
 *  ferramenta em pedaços; aqui a gente lê o campo `html` desse JSON parcial e devolve
 *  o texto legível até onde ele chegou — escape cortado no meio (`\` ou `\u12`) para
 *  antes, sem inventar caractere que ainda não chegou. */
export function htmlParcial(bruto: string): string {
  const achado = /"(?:html|conteudo|codigo)"\s*:\s*"/i.exec(bruto);
  if (!achado) return "";
  let i = achado.index + achado[0].length;
  const saida: string[] = [];
  while (i < bruto.length) {
    const ch = bruto[i];
    if (ch === "\\") {
      const nx = bruto[i + 1];
      if (nx === undefined) break; /* escape pela metade: espera o próximo pedaço */
      if (nx === "n") { saida.push("\n"); i += 2; continue; }
      if (nx === "t") { saida.push("\t"); i += 2; continue; }
      if (nx === "r") { saida.push("\r"); i += 2; continue; }
      if (nx === "b") { saida.push("\b"); i += 2; continue; }
      if (nx === "f") { saida.push("\f"); i += 2; continue; }
      if (nx === "u") {
        const hex = bruto.slice(i + 2, i + 6);
        if (hex.length < 4) break; /* \uXXXX incompleto */
        saida.push(String.fromCharCode(parseInt(hex, 16)));
        i += 6;
        continue;
      }
      saida.push(nx); /* \" \\ \/ e qualquer escape simples */
      i += 2;
      continue;
    }
    if (ch === '"') break; /* fim do valor: o que vem depois não é código */
    saida.push(ch);
    i++;
  }
  return saida.join("");
}

/** página inteira a partir de um pedaço: garante charset/viewport e uma base legível */
function documentoCompleto(html: string, titulo: string): string {
  const corpo = html.trim();
  if (/<html[\s>]/i.test(corpo)) {
    /* página completa: só completa o que costuma faltar (charset e viewport) */
    let doc = corpo;
    if (!/<meta[^>]+charset/i.test(doc)) {
      doc = /<head[^>]*>/i.test(doc)
        ? doc.replace(/<head[^>]*>/i, (m) => `${m}\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">`)
        : doc.replace(/<html[^>]*>/i, (m) => `${m}\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>`);
    }
    return doc;
  }
  return [
    "<!doctype html>",
    '<html lang="pt-BR">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escaparAtributo(titulo)}</title>`,
    `<style>\n${CSS_BASE}\n</style>`,
    "</head>",
    "<body>",
    corpo,
    "</body>",
    "</html>",
  ].join("\n");
}

/** valida e normaliza o que o modelo mandou; recusa cedo o que não é tela */
export function montarTela(bruto: { titulo?: unknown; html?: unknown }): Tela {
  const titulo = String(bruto?.titulo ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "Tela";
  const html = String(bruto?.html ?? "");
  if (!html.trim()) throw erro422("html vazio: gere a página inteira (HTML + CSS + JS) do que quer mostrar");
  if (html.length > MAX_TELA_CHARS) {
    throw erro422(`html grande demais (${html.length} caracteres; o teto é ${MAX_TELA_CHARS}). Divida em telas menores.`);
  }
  if (!/[<][a-zA-Z!/]/.test(html)) {
    throw erro422("html inválido: mande marcação de verdade (ex.: <div>, <svg>, <table>), não texto solto");
  }
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return { id, titulo, html: documentoCompleto(html, titulo) };
}

/** o que o MODELO vê do resultado: uma linha, sem o HTML (economiza a janela) */
export function resumoTela(t: Tela): string {
  return `TELA EXIBIDA no chat: "${t.titulo}" (${t.html.length} caracteres de HTML). O card já está na tela do usuário — NÃO repita o HTML na resposta; diga em uma frase o que a tela mostra.`;
}
