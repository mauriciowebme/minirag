/**
 * Conversor de documentos: recebe o arquivo ORIGINAL e devolve o texto que vai
 * para o índice (chunks) — o original fica guardado em `arquivos`.
 *
 * Tipos aceitos na primeira fase: pdf, docx, xlsx, csv, html, txt, md.
 * Regra: nunca fingir conversão. Tipo não suportado ou PDF sem texto = erro claro.
 */
import { CONFIG } from "./config";
import { erro422 } from "./errors";
import { ocrImagem, ocrPdf } from "./ocr";

export const LIMITE_BYTES = 15 * 1024 * 1024; // 15 MB por arquivo (decisão do dono)

export type Tipo = "texto" | "pdf" | "docx" | "planilha" | "html" | "csv" | "imagem";

export type ArquivoInfo = {
  ext: string; // sem ponto, minúscula
  mime: string;
  tipo: Tipo;
  /** pode ser editado na tela (texto puro) */
  editavel: boolean;
  nome: string;
};

const MIMES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

const EXT_POR_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv",
  "application/csv": "csv",
  "text/html": "html",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/x-markdown": "md",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/tiff": "tiff",
};

const EXTS_IMAGEM = new Set(["png", "jpg", "jpeg", "webp", "tif", "tiff"]);

export const LISTA_ACEITOS = "pdf, docx, xlsx, csv, html, txt, md, png, jpg, webp, tiff";

/** Extensão do nome (sem ponto, minúscula). */
export function extensaoDe(nome: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec((nome ?? "").trim());
  return m ? m[1].toLowerCase() : "";
}

export function infoArquivo(nome: string, mimeInformado?: string | null): ArquivoInfo {
  const limpo = (nome ?? "").trim();
  let ext = extensaoDe(limpo);
  const mime = (mimeInformado ?? "").toLowerCase();
  if (!ext && mime && EXT_POR_MIME[mime]) ext = EXT_POR_MIME[mime];

  const base = { ext, nome: limpo, mime: MIMES[ext] ?? (mime || "application/octet-stream") };

  if (ext === "pdf") return { ...base, tipo: "pdf", editavel: false };
  if (EXTS_IMAGEM.has(ext)) return { ...base, tipo: "imagem", editavel: false };
  if (ext === "docx") return { ...base, tipo: "docx", editavel: false };
  if (ext === "xlsx" || ext === "xlsm") return { ...base, tipo: "planilha", editavel: false };
  if (ext === "csv") return { ...base, tipo: "csv", editavel: true };
  if (ext === "html" || ext === "htm") return { ...base, tipo: "html", editavel: false };
  if (ext === "md" || ext === "markdown" || ext === "txt" || ext === "text") {
    return { ...base, tipo: "texto", editavel: true };
  }

  if (ext === "xls" || ext === "doc" || ext === "ppt") {
    throw erro422(
      `formato .${ext} (Office antigo) não é suportado — abra no Word/Excel e salve como ` +
        `${ext === "xls" ? ".xlsx" : ext === "doc" ? ".docx" : ".pptx"} antes de enviar`,
    );
  }
  throw erro422(
    ext
      ? `tipo .${ext} não suportado — aceitos: ${LISTA_ACEITOS}`
      : `não deu para saber o tipo do arquivo "${limpo}" — aceitos: ${LISTA_ACEITOS}`,
  );
}

/** Nome → doc_id estável (o "mesmo nome" substitui o documento). */
export function docIdDe(nome: string): string {
  const semExt = (nome ?? "").replace(/\.[A-Za-z0-9]{1,8}$/, "");
  const slug = semExt
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return slug || "documento";
}

/* ------------------------------------------------------------- conversões */

function normalizar(t: string): string {
  return t
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t\u00a0]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function entidades(s: string): string {
  const mapa: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
    "&ndash;": "–",
    "&mdash;": "—",
  };
  return s
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&[a-z#0-9]+;/gi, (m) => mapa[m.toLowerCase()] ?? m);
}

function htmlParaTexto(html: string): string {
  return entidades(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<h([1-6])[^>]*>/gi, (_m, n) => "\n" + "#".repeat(Number(n)) + " ")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<t[dh][^>]*>/gi, " | ")
      .replace(/<[^>]+>/g, " "),
  );
}

/** CSV/RFC4180 simples, com aspas e quebra dentro de aspas. */
function cssLinhas(texto: string, sep: string): string[][] {
  const linhas: string[][] = [];
  let campo = "";
  let linha: string[] = [];
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else aspas = false;
      } else campo += c;
      continue;
    }
    if (c === '"') aspas = true;
    else if (c === sep) {
      linha.push(campo);
      campo = "";
    } else if (c === "\n") {
      linha.push(campo);
      linhas.push(linha);
      linha = [];
      campo = "";
    } else if (c !== "\r") campo += c;
  }
  if (campo.length || linha.length) {
    linha.push(campo);
    linhas.push(linha);
  }
  return linhas.filter((l) => l.some((v) => v.trim().length));
}

function csvParaTexto(conteudo: string): string {
  const amostra = conteudo.slice(0, 4000);
  const sep = [",", ";", "\t"].sort((a, b) => amostra.split(b).length - amostra.split(a).length)[0] || ",";
  const linhas = cssLinhas(conteudo, sep);
  if (!linhas.length) return "";
  const cabecalho = linhas[0].map((c, i) => c.trim() || `coluna_${i + 1}`);
  const corpo = linhas.slice(1, 20_001);
  const partes: string[] = [`colunas: ${cabecalho.join(" | ")}`, ""];
  for (const l of corpo) {
    partes.push(cabecalho.map((h, i) => `${h}: ${(l[i] ?? "").trim()}`).join(" | "));
  }
  if (linhas.length > corpo.length + 1) partes.push(`(mais ${linhas.length - corpo.length - 1} linha(s) não indexadas)`);
  return partes.join("\n");
}

type PdfJs = {
  getDocument: (o: Record<string, unknown>) => { promise: Promise<any> };
};

async function pdfParaTexto(buf: Buffer): Promise<string> {
  /* pdfjs-dist (legacy, CJS): o pdf-parse 1.1.1 embutia um pdf.js de 2016 que
     recusa PDFs atuais com "bad XRef entry" (medido: fpdf2, Word, LibreOffice) */
  const pdfjs = require("pdfjs-dist/legacy/build/pdf.js") as PdfJs;
  let texto: string;
  try {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false,
    }).promise;
    const partes: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const pagina = await doc.getPage(i);
      const conteudo = await pagina.getTextContent();
      partes.push(
        (conteudo.items as { str?: string }[]).map((it) => it.str ?? "").join(" ").replace(/\s+/g, " ").trim(),
      );
    }
    if (typeof doc.destroy === "function") await doc.destroy();
    texto = normalizar(partes.filter(Boolean).join("\n\n"));
  } catch (e) {
    throw erro422(`PDF ilegível (${(e as Error).message})`);
  }
  /* sem camada de texto (menos de 20 caracteres) = provável digitalização:
     quem decide tentar OCR é extrairTexto, que sabe se o leitor está lá */
  return texto.length >= 20 ? texto : "";
}

async function docxParaTexto(buf: Buffer): Promise<string> {
  const mammoth = require("mammoth") as {
    convertToHtml: (o: { buffer: Buffer }) => Promise<{ value: string; messages: unknown[] }>;
  };
  try {
    /* HTML → texto: o markdown do mammoth escapa pontuação (vira "\.", "\-") e suja o índice */
    const r = await mammoth.convertToHtml({ buffer: buf });
    return normalizar(htmlParaTexto(r.value ?? ""));
  } catch (e) {
    throw erro422(`DOCX ilegível (${(e as Error).message})`);
  }
}

type ExcelJS = {
  Workbook: new () => {
    xlsx: { load: (b: Buffer | ArrayBuffer) => Promise<unknown> };
    worksheets: {
      name: string;
      rowCount: number;
      eachRow: (cb: (row: { values: unknown[] }, n: number) => void) => void;
    }[];
  };
};

async function planilhaParaTexto(buf: Buffer): Promise<string> {
  const ExcelJSMod = require("exceljs") as { default?: ExcelJS } & ExcelJS;
  const Excel = (ExcelJSMod.default ?? ExcelJSMod) as ExcelJS;
  const wb = new Excel.Workbook();
  try {
    await wb.xlsx.load(buf);
  } catch (e) {
    throw erro422(`planilha ilegível (${(e as Error).message})`);
  }
  const partes: string[] = [];
  for (const ws of wb.worksheets) {
    partes.push(`## Planilha: ${ws.name}`);
    let n = 0;
    let cabecalho: string[] = [];
    ws.eachRow((row, idx) => {
      if (n > 20_000) return;
      const vals = (row.values as unknown[]).slice(1).map((v) => {
        if (v === null || v === undefined) return "";
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (typeof v === "object") {
          const o = v as Record<string, unknown>;
          if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((x) => x.text ?? "").join("");
          if (typeof o.text === "string") return o.text;
          if (typeof o.result !== "undefined") return String(o.result);
          if (typeof o.hyperlink === "string") return o.hyperlink;
          return "";
        }
        return String(v);
      });
      const limpos = vals.map((v) => v.trim());
      if (!limpos.some(Boolean)) return;
      if (idx === 1) {
        cabecalho = limpos.map((v, i) => v || `coluna_${i + 1}`);
        partes.push(`colunas: ${cabecalho.join(" | ")}`, "");
        return;
      }
      n++;
      partes.push(cabecalho.length ? cabecalho.map((h, i) => `${h}: ${limpos[i] ?? ""}`).join(" | ") : limpos.join(" | "));
    });
    if (n > 20_000) partes.push(`(linhas acima do limite de 20.000 não indexadas)`);
    partes.push("");
  }
  return partes.join("\n");
}

export type TextoExtraido = {
  texto: string;
  /** true quando o texto veio de OCR (imagem ou PDF escaneado) */
  ocr: boolean;
  /** páginas lidas pelo OCR (0 quando não houve OCR) */
  paginas: number;
};

/** Texto extraído do arquivo, já normalizado e validado contra os limites. */
export async function extrairTexto(buf: Buffer, info: ArquivoInfo): Promise<TextoExtraido> {
  if (!buf?.length) throw erro422("arquivo vazio");
  if (buf.length > LIMITE_BYTES) {
    throw erro422(`arquivo maior que ${Math.round(LIMITE_BYTES / 1024 / 1024)} MB`);
  }

  let texto: string;
  let ocr = false;
  let paginas = 0;
  switch (info.tipo) {
    case "imagem": {
      const r = await ocrImagem(buf);
      texto = normalizar(r.texto);
      ocr = true;
      paginas = r.paginas;
      break;
    }
    case "pdf": {
      texto = await pdfParaTexto(buf);
      if (!texto) {
        /* PDF digitalizado: rasteriza e lê por página (limite no lado Python) */
        const r = await ocrPdf(buf);
        texto = normalizar(r.texto);
        ocr = true;
        paginas = r.paginas;
      }
      break;
    }
    case "docx":
      texto = await docxParaTexto(buf);
      break;
    case "planilha":
      texto = normalizar(await planilhaParaTexto(buf));
      break;
    case "csv":
      texto = normalizar(csvParaTexto(buf.toString("utf8")));
      break;
    case "html":
      texto = normalizar(htmlParaTexto(buf.toString("utf8")));
      break;
    default:
      texto = normalizar(buf.toString("utf8").replace(/^\uFEFF/, ""));
  }

  if (!texto.trim()) {
    throw erro422(
      info.tipo === "imagem"
        ? "não saiu texto desta imagem — parece foto sem texto (paisagem, foto de produto). " +
          "Descreva no nome do arquivo ou use uma nota de texto."
        : "não saiu texto deste arquivo (vazio?)",
    );
  }
  if (texto.length > CONFIG.maxContentChars) {
    throw erro422(
      `texto extraído grande demais: ${texto.length} caracteres ` +
        `(limite ${CONFIG.maxContentChars}). Divida o documento.`,
    );
  }
  return { texto, ocr, paginas };
}