/**
 * Cliente do OCR (roda dentro do processo do embedder, em 127.0.0.1).
 * Node manda os bytes em base64 e recebe o texto — nenhum binário novo aqui.
 */
import { CONFIG, log } from "./config";
import { erro422 } from "./errors";

export type OcrResposta = { texto: string; paginas: number; motor: string; ms: number };

/** Quanto tempo o OCR pode levar antes de desistir (PDF de 6 páginas ~ 75s). */
const TIMEOUT_MS = 6 * 60 * 1000;

let ocrAtivo: boolean | null = null;

export function ocrDisponivel(): boolean | null {
  return ocrAtivo;
}

/** Consulta /health do embedder para saber se o OCR está instalado. */
export async function detectarOcr(): Promise<boolean> {
  try {
    const r = await fetch(`${CONFIG.embedderUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return (ocrAtivo = false);
    const j = (await r.json()) as { ocr?: boolean };
    ocrAtivo = Boolean(j.ocr);
    if (ocrAtivo) log("OCR disponível (imagem e PDF escaneado)");
    return ocrAtivo;
  } catch {
    return (ocrAtivo = false);
  }
}

async function chamar(corpo: Record<string, unknown>): Promise<OcrResposta> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(`${CONFIG.embedderUrl}/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw erro422(`OCR indisponível (${(e as Error).message}) — envie a versão com texto`);
  } finally {
    clearTimeout(t);
  }
  if (!r.ok) {
    let detalhe = `${r.status}`;
    try {
      const j = (await r.json()) as { detail?: string };
      if (j.detail) detalhe = j.detail;
    } catch {
      /* corpo não-JSON */
    }
    throw erro422(detalhe);
  }
  return (await r.json()) as OcrResposta;
}

/** Foto/print/captura de tela → texto. */
export function ocrImagem(buf: Buffer): Promise<OcrResposta> {
  return chamar({ imagem_base64: buf.toString("base64") });
}

/** PDF sem camada de texto (escaneado) → texto, com limite de páginas. */
export function ocrPdf(buf: Buffer, paginasMax?: number): Promise<OcrResposta> {
  return chamar({
    pdf_base64: buf.toString("base64"),
    ...(paginasMax ? { paginas_max: paginasMax } : {}),
  });
}