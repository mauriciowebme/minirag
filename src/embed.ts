/** Cliente do embedder (processo Python filho): textos -> strings de vetor. */
import { CONFIG, log } from "./config";

type RespostaEmbed = { dim: number; vectors: string[]; ms: number };

let dimConhecida = 0;
let disponivel = false;

export function embedderDisponivel(): boolean {
  return disponivel;
}

export function embedderDim(): number {
  return dimConhecida;
}

async function post(url: string, body: unknown, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

/** Espera o embedder responder /health (modelo carregado). */
export async function esperarEmbedder(tentativas = 120, intervalo = 2000): Promise<boolean> {
  for (let i = 1; i <= tentativas; i++) {
    try {
      const r = await fetch(`${CONFIG.embedderUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) {
        const j = (await r.json()) as { dim?: number };
        dimConhecida = Number(j.dim ?? 0);
        disponivel = true;
        log(`embedder pronto (dim=${dimConhecida})`);
        return true;
      }
    } catch {
      /* ainda subindo */
    }
    if (i % 10 === 0) log(`aguardando embedder (${i}/${tentativas})`);
    await new Promise((r) => setTimeout(r, intervalo));
  }
  disponivel = false;
  return false;
}

export async function marcarEmbedder(ok: boolean): Promise<void> {
  disponivel = ok;
  if (!ok) return;
  try {
    const r = await fetch(`${CONFIG.embedderUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const j = (await r.json()) as { dim?: number };
      dimConhecida = Number(j.dim ?? dimConhecida);
    }
  } catch {
    /* ignore */
  }
}

/** Gera os literais de vetor para N textos. */
export async function embedTexts(texts: string[]): Promise<string[]> {
  if (!texts.length) return [];
  const corpo = { texts };
  let ultimo: unknown = null;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      // 500 palavras em CPU levam ~6s; 256 textos podem levar minutos
      const r = await post(`${CONFIG.embedderUrl}/embed`, corpo, 20 * 60 * 1000);
      if (!r.ok) throw new Error(`embedder HTTP ${r.status}`);
      const j = (await r.json()) as RespostaEmbed;
      if (Number(j.dim)) dimConhecida = Number(j.dim);
      disponivel = true;
      if (!j.vectors || j.vectors.length !== texts.length) {
        throw new Error(`embedder devolveu ${j.vectors?.length} vetores para ${texts.length} textos`);
      }
      return j.vectors;
    } catch (e) {
      ultimo = e;
      log(`embed falhou (tentativa ${tentativa}/3): ${(e as Error).message}`);
      await new Promise((r2) => setTimeout(r2, 1500 * tentativa));
    }
  }
  disponivel = false;
  throw new Error(`embedder indisponivel: ${(ultimo as Error)?.message ?? ultimo}`);
}

export async function embedUm(texto: string): Promise<string> {
  const [v] = await embedTexts([texto]);
  return v;
}