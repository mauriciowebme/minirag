/** Autenticação: Bearer, escopo de tenant/operador e freio de força bruta. */
import crypto from "node:crypto";
import { CONFIG, Usuario, isOperador } from "./config";
import { erro401, erro429 } from "./errors";
import { usuarioPorChave } from "./usuarios";

const falhas = new Map<string, number[]>();

export function ipCliente(headers: Record<string, unknown>, socketIp: string): string {
  const xff = headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  if (typeof raw === "string" && raw.trim()) return raw.split(",")[0].trim();
  return socketIp;
}

function loginBloqueado(ip: string): number {
  const agora = Date.now() / 1000;
  const lista = (falhas.get(ip) ?? []).filter((t) => agora - t < CONFIG.loginJanelaSeg);
  falhas.set(ip, lista);
  if (lista.length >= CONFIG.loginMaxFalhas) {
    return Math.floor(CONFIG.loginJanelaSeg - (agora - lista[0])) + 1;
  }
  return 0;
}

const iguais = (a: string, b: string): boolean => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

/** Valida o Bearer. Lança 401/429 (o handler converte em {"detail": ...}). */
export function authenticate(authorization: string | undefined, ip: string): Usuario {
  const espera = loginBloqueado(ip);
  if (espera) throw erro429(`muitas tentativas de chave; tente de novo em ${espera}s`);

  let token = (authorization ?? "").trim();
  if (token.startsWith("Bearer ")) token = token.slice(7);
  token = token.trim();
  if (!token) throw erro401("falta o cabecalho de autorizacao (Bearer)");

  /* v2.7: usuários vivem no banco (criados pela tela); o env só semeia no boot.
     `usuarioPorChave` compara sha256 e devolve null para chave/usuário inativo. */
  const achado = usuarioPorChave(token);
  if (achado) {
    falhas.delete(ip);
    return achado;
  }
  const lista = falhas.get(ip) ?? [];
  lista.push(Date.now() / 1000);
  falhas.set(ip, lista);
  throw erro401("chave nao habilitada");
}

export { isOperador };