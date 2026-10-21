/* Convertedor de markdown para o painel: SÓ texto vira HTML — nada de HTML do
 * usuário é aceito. Tudo que entra passa por escape antes de qualquer marca,
 * então `<script>` escrito por alguém vira literal inofensivo na tela.
 * Sem dependência nova (o pacote `marked` foi descartado de propósito).
 *
 * Suporta: cabeçalhos (# a ####), negrito/itálico, código (`x` e bloco ```),
 * links [texto](http), listas com nível (ol e ul), citação (>), linha horizontal,
 * tabelas GFM e quebra de linha dentro do parágrafo. */

const ESCAPE = new Map<string, string>([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
]);

const escapar = (s: string): string => s.replace(/[&<>"]/g, (c) => ESCAPE.get(c) as string);

const MARCA = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const cabecalho = (ln: string): boolean => /^#{1,4}\s/.test(ln);

/** parte o texto em células de tabela (sem `|` do começo/fim) */
const celulas = (ln: string): string[] =>
  ln
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

/** linha de separador de tabela: `|---|:--:|` (exige pelo menos um traço por coluna) */
const separador = (ln: string): boolean => ln.includes("|") && ln.includes("-") && /^\s*\|?[\s|:-]+$/.test(ln);

function inline(escapado: string): string {
  let s = escapado;
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,!;:]|$)/g, "$1<i>$2</i>");
  /* link: só http(s) — `javascript:` e companhia ficam de fora por construção */
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return s;
}

type Item = { nivel: number; tag: string; texto: string };

/** transforma os itens planos em listas aninhadas: o filho vive DENTRO do <li> do pai */
function montarListas(itens: Item[]): string {
  let k = 0;

  /** grupo no nível `nivel` com a marca `tag`; para quando muda de marca ou desce de nível */
  function grupo(nivel: number, tag: string): string {
    const partes: string[] = [];
    while (k < itens.length) {
      const it = itens[k];
      if (it.nivel < nivel) break;
      if (it.nivel > nivel) break;
      if (it.tag !== tag) break;
      k++;
      let dentro = inline(it.texto);
      if (k < itens.length && itens[k].nivel > nivel) dentro += acima(nivel);
      partes.push(`<li>${dentro}</li>`);
    }
    return `<${tag}>${partes.join("")}</${tag}>`;
  }

  /** todos os grupos rebaixados que vêm agora (filhos do item anterior) */
  function acima(nivelPai: number): string {
    let out = "";
    while (k < itens.length && itens[k].nivel > nivelPai) out += grupo(itens[k].nivel, itens[k].tag);
    return out;
  }

  let out = "";
  while (k < itens.length) out += grupo(itens[k].nivel, itens[k].tag);
  return out;
}

export function mdParaHtml(md: string): string {
  const linhas = escapar(String(md ?? "")).split("\n");
  const out: string[] = [];
  let par: string[] = [];

  const fecharPar = (): void => {
    if (par.length) {
      out.push(`<p>${inline(par.join("\n")).replace(/\n/g, "<br>")}</p>`);
      par = [];
    }
  };

  let i = 0;
  while (i < linhas.length) {
    const ln = linhas[i];

    /* bloco de código ``` — o conteúdo NÃO recebe marca nenhuma, só escape */
    if (/^\s*```/.test(ln)) {
      fecharPar();
      const corpo: string[] = [];
      i++;
      while (i < linhas.length && !/^\s*```/.test(linhas[i])) corpo.push(linhas[i++]);
      i++; /* pula o fechamento */
      out.push(`<pre>${corpo.join("\n")}</pre>`);
      continue;
    }

    /* linha horizontal: --- ou *** sozinhos (a lista exige espaço depois da marca) */
    if (/^\s*([-*_])\1{2,}\s*$/.test(ln)) {
      fecharPar();
      out.push("<hr>");
      i++;
      continue;
    }

    if (cabecalho(ln)) {
      fecharPar();
      const m = /^(#{1,4})\s+(.*)$/.exec(ln) as RegExpExecArray;
      const n = m[1].length;
      out.push(`<h${n}>${inline(m[2])}</h${n}>`);
      i++;
      continue;
    }

    /* tabela GFM: cabeçalho + separador + linhas */
    if (ln.includes("|") && i + 1 < linhas.length && separador(linhas[i + 1])) {
      fecharPar();
      const cab = celulas(ln);
      i += 2;
      const linhasTabela: string[][] = [];
      while (i < linhas.length && linhas[i].includes("|") && linhas[i].trim()) {
        linhasTabela.push(celulas(linhas[i]));
        i++;
      }
      const head = cab.map((c) => `<th>${inline(c)}</th>`).join("");
      const body = linhasTabela
        .map((r) => {
          const cel = cab.map((_, k) => `<td>${inline(r[k] ?? "")}</td>`).join("");
          return `<tr>${cel}</tr>`;
        })
        .join("");
      out.push(`<div class="rola"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
      continue;
    }

    /* run de lista: junta as linhas seguidas (com continuação indentada) e monta a árvore */
    const m = MARCA.exec(ln);
    if (m) {
      fecharPar();
      const itens: Item[] = [];
      while (i < linhas.length) {
        const atual = linhas[i];
        const mm = MARCA.exec(atual);
        if (mm) {
          itens.push({ nivel: Math.floor(mm[1].length / 2), tag: /^\d/.test(mm[2]) ? "ol" : "ul", texto: mm[3] });
          i++;
          /* continuação do item: linha seguinte, mais recuada, sem marca */
          while (i < linhas.length && linhas[i].trim() && !MARCA.test(linhas[i]) && !cabecalho(linhas[i]) && /^\s{2,}\S/.test(linhas[i])) {
            itens[itens.length - 1].texto += " " + linhas[i].trim();
            i++;
          }
          continue;
        }
        break; /* linha em branco ou texto solto: acabou a lista */
      }
      out.push(montarListas(itens));
      continue;
    }

    /* citação — a linha já passou pelo escape, então o `>` chegou como `&gt;` */
    if (/^\s*&gt;\s?/.test(ln)) {
      fecharPar();
      const cita: string[] = [];
      while (i < linhas.length && /^\s*&gt;\s?/.test(linhas[i])) cita.push(linhas[i++].replace(/^\s*&gt;\s?/, ""));
      out.push(`<blockquote>${inline(cita.join(" "))}</blockquote>`);
      continue;
    }

    if (!ln.trim()) {
      fecharPar();
      i++;
      continue;
    }

    par.push(ln);
    i++;
  }
  fecharPar();
  return out.join("");
}
