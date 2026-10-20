/** Fastify: rotas REST, MCP, painel estático e /health. */
import fs from "node:fs";
import path from "node:path";
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CONFIG, tenantFor } from "./config";
import { HttpError, iso } from "./errors";
import { authenticate, ipCliente } from "./auth";
import { embedderDim, embedderDisponivel } from "./embed";
import { detectarOcr, ocrDisponivel } from "./ocr";
import { enqueueIngest, IngestBody } from "./ingest";
import { runDecay } from "./decay";
import {
  atualizarFerramentas,
  atualizarServidor,
  apagarServidor,
  criarServidor,
  definirHealth,
  listarServidores,
} from "./ferramentas";
import { mcpHandler } from "./mcp";
import { contarUso, configPublica, dadosPainel } from "./dashboard";
import {
  atualizarUsuario,
  criarUsuario,
  exigirOperador,
  listarUsuarios,
  nomesOperadores,
  nomesUsuarios,
  novaChaveUsuario,
  removerUsuario,
} from "./usuarios";
import {
  historicoChat,
  limparChat,
  responderChat,
  salvarProvider,
  testarProvider,
  verProvider,
} from "./provider";
import multipart from "@fastify/multipart";
import { LIMITE_BYTES } from "./conversor";
import {
  cancelJob,
  deleteDoc,
  deleteGaveta,
  exportGaveta,
  getArquivoOriginal,
  getDocument,
  jobParaUsuario,
  listDocs,
  criarGaveta,
  listGavetas,
  listJobs,
  nomeArquivo,
  patchArquivado,
  patchDocument,
  putDocument,
  retryJob,
  search,
  uploadArquivo,
} from "./service";

/* --------------------------------------------------------------- validação */

function vString(v: unknown, campo: string, opts: {
  obrigatorio?: boolean; min?: number; max?: number; def?: string;
} = {}): string {
  if (v === undefined || v === null) {
    if (opts.obrigatorio) throw new HttpError(422, `campo obrigatorio: ${campo}`);
    return opts.def ?? "";
  }
  if (typeof v !== "string") throw new HttpError(422, `${campo} deve ser texto`);
  if (opts.min !== undefined && v.length < opts.min) {
    throw new HttpError(422, `${campo}: minimo de ${opts.min} caractere(s)`);
  }
  if (opts.max !== undefined && v.length > opts.max) {
    throw new HttpError(422, `${campo}: maximo de ${opts.max} caracteres`);
  }
  return v;
}

function vInt(v: unknown, campo: string, def: number, min: number, max: number): number {
  if (v === undefined || v === null || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new HttpError(422, `${campo} deve ser inteiro`);
  if (n < min || n > max) throw new HttpError(422, `${campo} deve estar entre ${min} e ${max}`);
  return n;
}

function vFloat(v: unknown, campo: string, def: number): number {
  if (v === undefined || v === null || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new HttpError(422, `${campo} deve estar entre 0 e 1`);
  return n;
}

function vBool(v: unknown, def = false): boolean {
  if (v === undefined || v === null || v === "") return def;
  if (typeof v === "boolean") return v;
  return ["1", "true", "sim", "yes", "on"].includes(String(v).trim().toLowerCase());
}

function corpo(req: FastifyRequest): Record<string, any> {
  const b = req.body;
  if (b === null || typeof b !== "object" || Array.isArray(b)) {
    throw new HttpError(422, "corpo deve ser um objeto JSON");
  }
  return b as Record<string, any>;
}

/* ------------------------------------------------------------------- app */

export function criarApp(): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: Math.max(4 * 1024 * 1024, CONFIG.maxContentChars * 3),
    trustProxy: true,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ detail: err.detail });
    }
    const status = (err as any).statusCode;
    if (status === 413) {
      return reply.code(413).send({ detail: "corpo maior que o limite do servidor" });
    }
    if (status && status < 500) {
      return reply.code(status).send({ detail: (err as Error).message });
    }
    if ((err as any).code === "FST_ERR_CTP_INVALID_JSON_BODY") {
      return reply.code(400).send({ detail: "corpo nao e JSON valido" });
    }
    process.stdout.write(`[minirag] erro ${req.method} ${req.url}: ${(err as Error).stack}\n`);
    return reply.code(500).send({ detail: "erro interno" });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ detail: "Not Found" });
  });

  // CORS (mesmas origens configuradas da v1.x)
  app.addHook("onRequest", async (req, reply) => {
    const origem = req.headers.origin;
    if (origem && CONFIG.corsOrigins.includes(origem)) {
      reply.header("access-control-allow-origin", origem);
      reply.header("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
      reply.header("access-control-allow-headers", "Authorization, Content-Type");
      reply.header("vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      reply.code(204).send();
    }
  });

  /* upload de arquivo: multipart só na rota /arquivos (teto = 15 MB do conversor) */
  void app.register(multipart, { limits: { fileSize: LIMITE_BYTES, files: 1, fields: 10 } });

  const ip = (req: FastifyRequest) =>
    ipCliente(req.headers as Record<string, unknown>, req.ip ?? "?");

  const usuario = (req: FastifyRequest) =>
    authenticate(req.headers.authorization, ip(req));

  const health = () => ({
    status: "ok",
    dim: embedderDim(),
    usuarios: nomesUsuarios().length,
    operador: nomesOperadores().length > 0,
    versao: CONFIG.versao,
    embedder: embedderDisponivel() ? "ok" : "fora",
    ocr: ocrDisponivel() === null ? "?" : ocrDisponivel() ? "ok" : "fora",
  });

  /* ------------------------------------------------------------- básicas */

  definirHealth(health); // ferramenta interna do chat usa o mesmo health da rota
  app.get("/health", async () => health());

  app.get("/", async (_req, reply) => reply.code(302).header("location", "/painel/").send());

  /* -------------------------------------------------------------- ingest */

  app.post("/ingest", async (req, reply) => {
    const u = usuario(req);
    const b = corpo(req);
    const body: IngestBody = {
      doc_id: vString(b.doc_id, "doc_id", { obrigatorio: true, min: 1, max: 500 }),
      title: b.title === undefined || b.title === null ? null : vString(b.title, "title", { max: 500 }),
      content: vString(b.content, "content", {
        obrigatorio: true, min: 1, max: CONFIG.maxContentChars,
      }),
      memoria: vString(b.memoria, "memoria", { max: 128, def: "" }),
      tenant: b.tenant ?? null,
    };
    const r = await enqueueIngest(body, (await import("./config")).tenantFor(u, b.tenant as string));
    return reply.code(202).send(r);
  });

  /* ------------------------------------------------------ arquivo original */

  /** POST /arquivos (multipart, campo "arquivo"): guarda o original, converte e enfileira. */
  app.post("/arquivos", async (req, reply) => {
    const u = usuario(req);
    if (!req.isMultipart()) {
      throw new HttpError(422, "envie como multipart/form-data no campo 'arquivo' (ou use POST /ingest com texto)");
    }
    const campos: Record<string, string> = {};
    let enviado: { nome: string; mime: string; buf: Buffer } | null = null;
    try {
      for await (const parte of req.parts()) {
        if (parte.type === "file") {
          if (enviado) {
            await parte.toBuffer(); // segundo arquivo: descarta (1 por request)
            continue;
          }
          const pedacos: Buffer[] = [];
          for await (const pedaco of parte.file) pedacos.push(pedaco as Buffer);
          enviado = {
            nome: (parte.filename ?? "").trim(),
            mime: parte.mimetype ?? "",
            buf: Buffer.concat(pedacos),
          };
        } else if (typeof parte.value === "string") {
          campos[parte.fieldname] = parte.value;
        }
      }
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT") {
        throw new HttpError(413, `arquivo maior que ${Math.round(LIMITE_BYTES / 1024 / 1024)} MB`);
      }
      throw e;
    }
    if (!enviado) throw new HttpError(422, "nenhum arquivo recebido no campo 'arquivo'");
    if (!enviado.nome) throw new HttpError(422, "arquivo sem nome — envie com o nome do arquivo");

    const r = await uploadArquivo(
      {
        nome: enviado.nome,
        mime: enviado.mime,
        conteudo: enviado.buf,
        memoria: campos.memoria ?? "",
        tenant: campos.tenant ?? null,
        doc_id: campos.doc_id ?? null,
        title: campos.title ?? null,
      },
      u,
    );
    return reply.code(r.substituiu ? 200 : 201).send(r);
  });

  app.get("/ingest/:jobId", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const qs = req.query as Record<string, string>;
    return jobParaUsuario(Number(p.jobId), u, qs.tenant ?? "");
  });

  /* -------------------------------------------------------------- search */

  app.post("/search", async (req) => {
    const u = usuario(req);
    const b = corpo(req);
    const body = {
      query: vString(b.query, "query", { obrigatorio: true, min: 1, max: CONFIG.maxQueryChars }),
      k: vInt(b.k, "k", CONFIG.topK, 1, 50),
      min_score: vFloat(b.min_score, "min_score", CONFIG.minScore),
      memoria: vString(b.memoria, "memoria", { max: 128, def: "" }),
      include_archived: vBool(b.include_archived),
      tenant: b.tenant ?? null,
    };
    const r = await search(body, u);
    if (r.total) void contarUso("buscas");
    return r;
  });

  /* ---------------------------------------------------------------- docs */

  app.get("/docs", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    return listDocs(
      {
        memoria: s.memoria ?? "",
        include_archived: vBool(s.include_archived),
        tenant: s.tenant ?? "",
        q: s.q ?? "",
        limit: s.limit ? Number(s.limit) : 0,
        offset: s.offset ? Number(s.offset) : 0,
      },
      u,
    );
  });

  app.delete("/docs/:docId", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    return deleteDoc(p.docId, s.memoria ?? "", s.tenant ?? "", u);
  });

  /* ----------------------------------------------------------- agregados */

  app.post("/gavetas", async (req, reply) => {
    const u = usuario(req);
    const b = corpo(req);
    const memoria = vString(b.memoria, "memoria", { obrigatorio: true, min: 1, max: 120 });
    const tenant = tenantFor(u, (b.tenant as string) ?? null);
    return reply.code(201).send(await criarGaveta(tenant, memoria));
  });

  app.get("/gavetas", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    return listGavetas(u, s.tenant ?? "");
  });

  app.get("/jobs", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    return listJobs(
      {
        status: s.status ?? "",
        tenant: s.tenant ?? "",
        limit: s.limit ? Number(s.limit) : 50,
      },
      u,
    );
  });

  /* ---------------------------------------------------- gaveta: zip/delete */

  app.get("/gavetas/:memoria/export.zip", async (req, reply) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    const { buffer, nome } = await exportGaveta(p.memoria, s.tenant ?? "", u);
    return reply
      .code(200)
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${nome}.zip"`)
      .send(buffer);
  });

  app.delete("/gavetas/:memoria", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    return deleteGaveta(p.memoria, s.tenant ?? "", u);
  });

  /* ----------------------------------------------------------- documents */

  app.get("/documents/:docId", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    return getDocument(p.docId, s.memoria ?? "", s.tenant ?? "", u);
  });

  app.get("/documents/:docId/raw", async (req, reply) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    const d = await getDocument(p.docId, s.memoria ?? "", s.tenant ?? "", u);
    const nome = nomeArquivo(d.title ?? d.doc_id, "documento");
    return reply
      .code(200)
      .header("content-type", "text/plain; charset=utf-8")
      .header("content-disposition", `attachment; filename="${nome}.txt"`)
      .send(d.content);
  });

  app.get("/documents/:docId/arquivo", async (req, reply) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    const a = await getArquivoOriginal(p.docId, s.memoria ?? "", s.tenant ?? "", u);
    const nome = nomeArquivo(a.nome || p.docId, "documento");
    return reply
      .code(200)
      .header("content-type", a.mime || "application/octet-stream")
      .header("content-disposition", `attachment; filename="${nome}"`)
      .header("content-length", String(a.conteudo.length))
      .send(a.conteudo);
  });

  app.put("/documents/:docId", async (req, reply) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const b = corpo(req);
    const r = await putDocument(
      p.docId,
      {
        content: vString(b.content, "content", {
          obrigatorio: true, min: 1, max: CONFIG.maxContentChars,
        }),
        title: b.title === undefined || b.title === null ? null : vString(b.title, "title", { max: 500 }),
        memoria: vString(b.memoria, "memoria", { max: 128, def: "" }),
        tenant: b.tenant ?? null,
      },
      u,
    );
    return reply.code(202).send(r);
  });

  app.patch("/documents/:docId/arquivado", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    const b = corpo(req);
    if (typeof b.arquivado !== "boolean") throw new HttpError(422, "arquivado deve ser booleano");
    return patchArquivado(p.docId, b.arquivado, s.memoria ?? "", b.tenant ?? null, u);
  });

  app.patch("/documents/:docId", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    const b = corpo(req);
    return patchDocument(
      p.docId,
      {
        title: b.title === undefined || b.title === null ? null : vString(b.title, "title", { max: 500 }),
        novo_doc_id:
          b.novo_doc_id === undefined || b.novo_doc_id === null
            ? null
            : vString(b.novo_doc_id, "novo_doc_id", { max: 200 }),
        destino_memoria:
          b.destino_memoria === undefined || b.destino_memoria === null
            ? null
            : vString(b.destino_memoria, "destino_memoria", { max: 128 }),
        tenant: b.tenant ?? null,
      },
      s.memoria ?? "",
      u,
    );
  });

  /* ---------------------------------------------------------------- jobs */

  app.post("/jobs/:jobId/cancel", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    return cancelJob(Number(p.jobId), s.tenant ?? "", u);
  });

  app.post("/jobs/:jobId/retry", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    return retryJob(Number(p.jobId), s.tenant ?? "", u);
  });

  /* --------------------------------------------------------------- decay */

  app.post("/decay", async (req) => {
    const u = usuario(req);
    const b = corpo(req);
    const dias = b.dias === undefined || b.dias === null ? null : vInt(b.dias, "dias", 0, 0, 36500);
    const min = b.min_acessos === undefined || b.min_acessos === null
      ? null
      : vInt(b.min_acessos, "min_acessos", 0, 0, 1_000_000);
    const alvo = (await import("./config")).isOperador(u) ? null : u.tenant;
    return runDecay(dias, min, alvo);
  });

  /* ------------------------------------------------------------- painel */

  /** Números do acervo em uma chamada (o Painel não faz 6 requisições). */
  app.get("/dashboard", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    return dadosPainel(u, s.tenant ?? "");
  });

  /** Limites e esquecimento para a tela de Configurações (sem segredo). */
  app.get("/config", async (req) => {
    usuario(req);
    return configPublica();
  });

  /* ----------------------------------------------------------- usuários */

  app.get("/usuarios", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    return { usuarios: await listarUsuarios() };
  });

  app.post("/usuarios", async (req, reply) => {
    const u = usuario(req);
    exigirOperador(u);
    const b = corpo(req);
    const r = await criarUsuario(vString(b.nome, "nome", { obrigatorio: true, max: 64 }), b.papel);
    return reply.code(201).send(r);
  });

  app.patch("/usuarios/:nome", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    const p = req.params as Record<string, string>;
    const b = corpo(req);
    return atualizarUsuario(p.nome, { ativo: b.ativo, papel: b.papel });
  });

  /** Gera chave nova: o operador para qualquer um, o comum só para si. */
  app.post("/usuarios/:nome/chave", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const alvo = p.nome.trim().toLowerCase();
    if (!u.operador && alvo !== u.tenant) throw new HttpError(403, "voce so pode trocar a sua propria chave");
    return novaChaveUsuario(alvo);
  });

  app.delete("/usuarios/:nome", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    const p = req.params as Record<string, string>;
    return removerUsuario(p.nome);
  });

  /* ----------------------------------------------------- provider do chat */

  app.get("/config/provider", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    return verProvider(u, s.tenant ?? "");
  });

  app.put("/config/provider", async (req) => {
    const u = usuario(req);
    return salvarProvider(u, corpo(req));
  });

  app.post("/config/provider/testar", async (req) => {
    const u = usuario(req);
    return testarProvider(u, corpo(req));
  });

  /* ------------------------------------------------------- servidores MCP */

  app.get("/config/mcp", async (req) => {
    usuario(req);
    return { servidores: await listarServidores() };
  });

  app.post("/config/mcp", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    return criarServidor(corpo(req));
  });

  app.patch("/config/mcp/:nome", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    const s = req.params as Record<string, string>;
    return atualizarServidor(s.nome, corpo(req));
  });

  app.delete("/config/mcp/:nome", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    const s = req.params as Record<string, string>;
    return apagarServidor(s.nome);
  });

  app.post("/config/mcp/testar", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    const b = corpo(req);
    return atualizarFerramentas(String(b.nome ?? ""), u);
  });

  /* ------------------------------------------------------------------ chat */

  app.post("/chat", async (req) => {
    const u = usuario(req);
    const b = corpo(req);
    const r = await responderChat(u, {
      pergunta: vString(b.pergunta, "pergunta", { obrigatorio: true, min: 1, max: CONFIG.maxQueryChars }),
      memoria: vString(b.memoria, "memoria", { max: 128, def: "" }),
      tenant: b.tenant ?? null,
    });
    void contarUso("chats");
    return r;
  });

  app.get("/chat", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    return historicoChat(u, {
      memoria: s.memoria ?? "",
      tenant: s.tenant ?? "",
      limit: s.limit ? Number(s.limit) : 40,
    });
  });

  app.delete("/chat", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    return limparChat(u, { memoria: s.memoria ?? "", tenant: s.tenant ?? "" });
  });

  /* ----------------------------------------------------------------- MCP */

  app.post("/mcp", async (req, reply) => {
    const r = await mcpHandler(req.body, {
      health,
      autenticar: () =>
        authenticate((req.headers.authorization as string) ?? "", ip(req)),
    });
    if (r.status === 202) return reply.code(202).send();
    return reply.code(r.status).send(r.body);
  });

  /* -------------------------------------------------------------- painel */

  const tipos: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
  };

  app.get("/painel", async (_req, reply) =>
    reply.code(302).header("location", "/painel/").send(),
  );

  app.get("/painel/*", async (req, reply) => {
    const wildcard = (req.params as Record<string, string>)["*"] ?? "";
    const rel = wildcard === "" ? "index.html" : wildcard;
    const alvo = path.resolve(CONFIG.painelDir, rel);
    if (!alvo.startsWith(path.resolve(CONFIG.painelDir))) {
      return reply.code(404).send({ detail: "Not Found" });
    }
    let arquivo = alvo;
    if (fs.existsSync(arquivo) && fs.statSync(arquivo).isDirectory()) {
      arquivo = path.join(arquivo, "index.html");
    }
    if (!fs.existsSync(arquivo)) {
      // SPA: rota desconhecida cai no index
      arquivo = path.join(CONFIG.painelDir, "index.html");
      if (!fs.existsSync(arquivo)) return reply.code(404).send({ detail: "Not Found" });
    }
    const ext = path.extname(arquivo).toLowerCase();
    return reply
      .code(200)
      .header("content-type", tipos[ext] ?? "application/octet-stream")
      .send(fs.createReadStream(arquivo));
  });

  return app;
}

export { iso };