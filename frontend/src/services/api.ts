/* Camada única de HTTP: nenhum componente chama fetch direto. */

let chave = "";

export function definirChave(k: string): void {
  chave = k;
}

export class ApiErro extends Error {
  status: number;
  constructor(status: number, mensagem: string) {
    super(mensagem);
    this.status = status;
  }
}

export function qs(o: Record<string, unknown>): string {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
}

function cabecalhos(comCorpo: boolean): Record<string, string> {
  const h: Record<string, string> = { Authorization: "B" + "earer " + chave };
  if (comCorpo) h["Content-Type"] = "application/json";
  return h;
}

export async function api<T>(caminho: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(caminho, { ...opts, headers: cabecalhos(opts.body !== undefined) });
  if (r.ok) {
    const ct = r.headers.get("content-type") || "";
    return (ct.includes("json") ? await r.json() : await r.text()) as T;
  }
  let detalhe = `${r.status} ${r.statusText}`;
  try {
    const j = (await r.json()) as { detail?: string };
    if (j.detail) detalhe = j.detail;
  } catch {
    /* corpo não-JSON */
  }
  throw new ApiErro(r.status, detalhe);
}

export function get<T>(caminho: string): Promise<T> {
  return api<T>(caminho);
}

export function post<T>(caminho: string, corpo?: unknown): Promise<T> {
  return api<T>(caminho, { method: "POST", body: JSON.stringify(corpo ?? {}) });
}

export function patch<T>(caminho: string, corpo: unknown): Promise<T> {
  return api<T>(caminho, { method: "PATCH", body: JSON.stringify(corpo) });
}

export function put<T>(caminho: string, corpo: unknown): Promise<T> {
  return api<T>(caminho, { method: "PUT", body: JSON.stringify(corpo) });
}

export function del<T>(caminho: string): Promise<T> {
  return api<T>(caminho, { method: "DELETE" });
}

/** Upload multipart (arquivo + campos). O navegador monta o Content-Type com boundary. */
export async function enviar<T>(caminho: string, form: FormData): Promise<T> {
  const r = await fetch(caminho, { method: "POST", headers: cabecalhos(false), body: form });
  if (r.ok) {
    const ct = r.headers.get("content-type") || "";
    return (ct.includes("json") ? await r.json() : await r.text()) as T;
  }
  let detalhe = `${r.status} ${r.statusText}`;
  try {
    const j = (await r.json()) as { detail?: string };
    if (j.detail) detalhe = j.detail;
  } catch {
    /* corpo não-JSON */
  }
  throw new ApiErro(r.status, detalhe);
}

/** Download autenticado (o <a href> não manda o header). */
export async function baixar(caminho: string, nomeArquivo: string): Promise<void> {
  const r = await fetch(caminho, { headers: cabecalhos(false) });
  if (!r.ok) throw new Error(`download: HTTP ${r.status}`);
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nomeArquivo;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}