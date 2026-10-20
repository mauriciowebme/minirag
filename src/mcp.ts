/** MCP sobre POST /mcp — JSON-RPC 2.0 stateless, mesmas 6 tools da v1.x. */
import { Usuario } from "./config";
import { HttpError } from "./errors";
import { deleteDoc, jobParaUsuario, listDocs, search } from "./service";
import { enqueueIngest } from "./ingest";
import { CONFIG } from "./config";

const PROTOCOLOS = ["2025-06-18", "2025-03-10", "2024-11-05"];
const SERVER_INFO = { name: "minirag", version: CONFIG.versao };

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const TOOLS: Tool[] = [
  {
    name: "health",
    description:
      "Status do servidor RAG: dimensao do modelo de embedding e numero de usuarios ativos.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search",
    description:
      "Busca semantica na memoria do chamador. Retorna chunks com score (similaridade coseno). min_score default 0.55.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "texto da busca (max 2000 chars)" },
        k: { type: "integer", description: "maximo de resultados (1-50; default 5)" },
        min_score: { type: "number", description: "piso de similaridade 0-1 (default 0.55)" },
        memoria: { type: "string", description: "gaveta dentro do login (default '')" },
        include_archived: {
          type: "boolean",
          description: "buscar tambem nos arquivados (revive o chunk achado)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "ingest",
    description:
      "Enfileira um documento para ingestao (nao trava: responde job_id na hora). Acompanhe com ingest_status.",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "string", description: "id do doc (regravar o mesmo doc_id substitui o antigo)" },
        title: { type: "string" },
        content: { type: "string", description: "texto do doc (max 500000 chars)" },
        memoria: { type: "string", description: "gaveta dentro do login (default '')" },
      },
      required: ["doc_id", "content"],
    },
  },
  {
    name: "ingest_status",
    description:
      "Status de um job de ingestao: na_fila | processando | concluido | erro | cancelado (+ progresso de chunks).",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "integer" } },
      required: ["job_id"],
    },
  },
  {
    name: "list_docs",
    description:
      "Lista os documentos do chamador em uma memoria (doc_id, titulo, chunks, atualizado_em).",
    inputSchema: {
      type: "object",
      properties: {
        memoria: { type: "string", description: "gaveta dentro do login (default '')" },
        include_archived: { type: "boolean" },
      },
    },
  },
  {
    name: "delete_doc",
    description:
      "Apaga DEFINITIVAMENTE um doc (chunks + jobs na fila) na memoria do chamador. 409 se estiver processando.",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "string" },
        memoria: { type: "string", description: "gaveta dentro do login (default '')" },
      },
      required: ["doc_id"],
    },
  },
];

const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const falha = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
const toolOk = (data: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  isError: false,
});
const toolErro = (text: string) => ({ content: [{ type: "text", text }], isError: true });

function initialize(params: Row) {
  const pedido = params.protocolVersion as string | undefined;
  const versao = pedido && PROTOCOLOS.includes(pedido) ? pedido : PROTOCOLOS[0];
  return {
    protocolVersion: versao,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions:
      "RAG semantico multi-tenant. Tools: search (busca), ingest (doc entra na fila), " +
      "ingest_status (progresso), list_docs, delete_doc, health.",
  };
}

type Row = Record<string, any>;

async function executarTool(
  name: string,
  args: Row,
  user: Usuario,
  deps: { health: () => unknown },
) {
  switch (name) {
    case "health":
      return deps.health();
    case "search":
      if (typeof args.query !== "string" || !args.query.trim()) {
        throw new Error("parametros invalidos: campo obrigatorio: query");
      }
      return search(args as never, user);
    case "ingest":
      if (typeof args.doc_id !== "string" || typeof args.content !== "string") {
        throw new Error("parametros invalidos: doc_id e content sao obrigatorios");
      }
      return enqueueIngest(args as never, user.tenant);
    case "ingest_status": {
      const jobId = Number(args.job_id);
      return jobParaUsuario(jobId, user, undefined);
    }
    case "list_docs":
      return listDocs(
        { memoria: args.memoria ?? "", include_archived: Boolean(args.include_archived) },
        user,
      );
    case "delete_doc":
      return deleteDoc(args.doc_id, args.memoria ?? "", null, user);
    default:
      throw new Error(`tool desconhecida: ${name}`);
  }
}

export type McpDeps = {
  health: () => unknown;
  autenticar: () => Usuario; // lança HttpError 401/429
};

/** Resposta com status HTTP próprio (auth falhou = 401, não 200). */
type RespostaHttp = { httpStatus: number; body: unknown };
const comStatus = (httpStatus: number, body: unknown): RespostaHttp => ({ httpStatus, body });
const ehRespostaHttp = (v: unknown): v is RespostaHttp =>
  typeof v === "object" && v !== null && "httpStatus" in (v as Record<string, unknown>);

/** Despacha uma mensagem JSON-RPC. null = notificação (202 sem corpo). */
export async function despachar(msg: any, deps: McpDeps): Promise<unknown | null> {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return falha(msg && typeof msg === "object" ? msg.id : null, -32600, "requisicao JSON-RPC 2.0 invalida");
  }
  const { method, id } = msg;
  const params: Row = msg.params ?? {};

  if (method.startsWith("notifications/")) return null;
  if (method === "initialize") return ok(id, initialize(params));
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });

  if (method === "tools/call") {
    let user: Usuario;
    try {
      user = deps.autenticar();
    } catch (e) {
      const err = e as HttpError;
      return comStatus(err.status ?? 401, falha(id, -32001, err.detail ?? String(e)));
    }
    try {
      const resultado = await executarTool(params.name, params.arguments ?? {}, user, deps);
      return ok(id, toolOk(resultado));
    } catch (e) {
      if (e instanceof HttpError) return ok(id, toolErro(`erro ${e.status}: ${e.detail}`));
      return ok(id, toolErro(String((e as Error).message ?? e)));
    }
  }
  return falha(id, -32601, `metodo nao suportado: ${method}`);
}

/** POST /mcp — uma mensagem ou lote; resposta JSON pura. */
export async function mcpHandler(corpo: any, deps: McpDeps) {
  if (Array.isArray(corpo)) {
    const respostas: unknown[] = [];
    let status = 200;
    for (const item of corpo) {
      const r = await despachar(item, deps);
      if (r === null) continue;
      if (ehRespostaHttp(r)) {
        status = r.httpStatus;
        respostas.push(r.body);
      } else {
        respostas.push(r);
      }
    }
    return respostas.length ? { status, body: respostas } : { status: 202, body: null };
  }
  const r = await despachar(corpo, deps);
  if (r === null) return { status: 202, body: null };
  if (ehRespostaHttp(r)) return { status: r.httpStatus, body: r.body };
  return { status: 200, body: r };
}