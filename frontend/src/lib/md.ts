/* Convertedor de markdown para o painel: SÓ texto vira HTML — nada de HTML do
 * usuário é aceito. Tudo que entra passa por escape antes de qualquer marca,
 * então `<script>` escrito por alguém vira literal inofensivo na tela.
 * Sem dependência nova (o pacote `marked` foi descartado de propósito).
 *
 * Suporta: cabeçalhos (# a ####), negrito/itálico, código (`x` e bloco ```),
 * links [texto](http), listas com nível (ol e ul), citação (>), linha horizontal,
 * tabelas GFM e quebra de linha dentro do parágrafo.
 * v3.18: imagens (T007), bloco de código com idioma + botão copiar (T009) e realce de sintaxe
 * leve por heurística (T010) — sem highlight.js: 300 KB de pacote para colorir 4 classes não se paga. */

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
  /* imagem ANTES do link: a sintaxe dela começa com a do link (T007). http(s) ou data:image
     base64 — nada de javascript:, nada de protocol-relative; o alt já veio escapado. */
  s = s.replace(/!\[([^\]]*)\]\((https?:[^)\s]+|data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]+)\)/g, '<img src="$2" alt="$1" class="chat-img" loading="lazy">');
  /* link: só http(s) — `javascript:` e companhia ficam de fora por construção */
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return s;
}

/** v3.18 (T010): realce de sintaxe HEURÍSTICO, uma passada só, sobre texto JÁ ESCAPADO —
   por isso casa `&quot;` em vez de aspas duplas. Classes: hl-str/hl-com/hl-kw/hl-num.
   Não é parser: uma aspa torta numa string exótica desenha um trecho colorido a mais, e é
   só tinta — o conteúdo escapado nunca vira HTML de origem duvidosa. */
function destacar(codigoEscapado: string, lang: string): string {
  /* cerca sem idioma não ganha tinta: contrato v2.9 "dentro do bloco nada é marca" */
  if (!(lang || "").trim()) return codigoEscapado;
  const KW =
    "const|let|var|function|return|if|else|elif|for|while|class|new|import|export|from|async|await|" +
    "def|true|false|True|False|null|nil|None|this|try|catch|except|finally|throw|switch|case|break|" +
    "continue|public|private|static|int|string|float|bool|void|struct|enum|interface|type|extends|" +
    "SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|JOIN";
  const RE = new RegExp(
    "(&quot;[^\\n]*?&quot;|'[^'\\n]*'|`[^`\\n]*?`)" + "|(//[^\\n]*|#[^\\n]*|/\\*[\\s\\S]*?\\*/)" +
    "|\\b(" + KW + ")\\b|\\b(\\d[\\d._]*)\\b",
    "g",
  );
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(codigoEscapado))) {
    out += codigoEscapado.slice(last, m.index);
    if (m[1]) out += `<span class="hl-str">${m[1]}</span>`;
    else if (m[2]) out += `<span class="hl-com">${m[2]}</span>`;
    else if (m[3]) out += `<span class="hl-kw">${m[3]}</span>`;
    else out += `<span class="hl-num">${m[4]}</span>`;
    last = m.index + m[0].length;
  }
  return out + codigoEscapado.slice(last);
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

    /* bloco de código ``` — o conteúdo NÃO recebe marca de texto; v3.18 (T009/T010) ganha
       barra com idioma, botão copiar (delegado na tela) e realce por heurística dentro do <pre> */
    if (/^\s*```/.test(ln)) {
      fecharPar();
      const lang = (/^\s*```([A-Za-z0-9+#._-]{1,20})/.exec(ln)?.[1] ?? "").toLowerCase();
      const corpo: string[] = [];
      i++;
      while (i < linhas.length && !/^\s*```/.test(linhas[i])) corpo.push(linhas[i++]);
      i++; /* pula o fechamento */
      out.push(
        `<div class="chat-bloco"><div class="chat-bloco-topo"><span>${lang || "código"}</span>` +
          `<button type="button" class="chat-pre-copiar" title="copiar este bloco">copiar</button></div>` +
          `<pre>${destacar(corpo.join("\n"), lang)}</pre></div>`,
      );
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
