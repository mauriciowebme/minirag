/** Erros HTTP no formato do FastAPI: {"detail": "mensagem"}. */
export class HttpError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

export const erro400 = (d: string) => new HttpError(400, d);
export const erro401 = (d: string) => new HttpError(401, d);
export const erro403 = (d: string) => new HttpError(403, d);
export const erro404 = (d: string) => new HttpError(404, d);
export const erro409 = (d: string) => new HttpError(409, d);
export const erro413 = (d: string) => new HttpError(413, d);
export const erro422 = (d: string) => new HttpError(422, d);
export const erro429 = (d: string) => new HttpError(429, d);

/** Data no formato da v1.x (isoformat de datetime com fuso UTC). */
export function iso(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().replace("Z", "+00:00");
}