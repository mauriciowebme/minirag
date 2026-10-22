/** MCP sobre POST /mcp — JSON-RPC 2.0 stateless, espelho das rotas REST. */
import { Usuario, tenantFor } from "./config";
import { HttpError } from "./errors";
import {
  criarGaveta,
  deleteDoc,
  deleteGaveta,
  getArquivoOriginal,
  jobParaUsuario,
  listDocs,
  listGavetas,
  listJobs,
  patchArquivado,
  patchDocument,
  putDocument,
  search,
  uploadArquivo,
} from "./service";
import { enqueueIngest } from "./ingest";
import { CONFIG } from "./config";
import { healthAtual } from "./ferramentas";
import { criarUsuario, listarUsuarios, exigirOperador, removerUsuario } from "./usuarios";
import { escreverEsquecimento, lerEsquecimento } from "./esquecimento";
import { alvoMaquina, criarPareamento, listarMaquinas, rodar } from "./maquinas";
import { responderChat, salvarProvider, testarProvider, verProvider } from "./provider";
import {
  atualizarFerramentas,
  atualizarServidor,
  apagarServidor,
  criarServidor,
  listarServidores,
} from "./ferramentas";

/** As ferramentas que o Chat pode chamar: todas do MCP, menos o próprio chat (recursivo). */
export function toolsParaChat(): Tool[] {
  return TOOLS.filter((t) => t.name !== "chat");
}

/** Executa uma ferramenta interna no MESMO processo — é o mesmo caminho do POST /mcp, sem HTTP. */
export async function chamarToolInterna(name: string, args: Record<string, unknown>, user: Usuario) {
  if (!TOOLS.some((t) => t.name === name)) throw new Error(`tool desconhecida: ${name}`);
  const deps: McpDeps = { health: healthAtual, autenticar: () => user };
  return executarTool(name, args ?? {}, user, deps);
}

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
  {
    name: "upload_file",
    description:
      "Envia um ARQUIVO (pdf, docx, xlsx, csv, html, txt, md ou imagem png/jpg/webp/tiff) em base64: guarda o original, extrai o texto e enfileira. Imagem e PDF escaneado sao lidos por OCR (aviso: OCR erra numero). Mesmo nome na mesma gaveta substitui o anterior.",
    inputSchema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "nome do arquivo com extensao (ex: contrato.pdf)" },
        conteudo_base64: { type: "string", description: "bytes do arquivo em base64 (max 15 MB)" },
        mime: { type: "string", description: "content-type, opcional (o servidor deduz pela extensao)" },
        memoria: { type: "string", description: "gaveta dentro do login (default '')" },
        doc_id: { type: "string", description: "id do doc; vazio = derivado do nome do arquivo" },
        title: { type: "string" },
        tenant: { type: "string", description: "alvo do operador; ignorado para login comum" },
      },
      required: ["nome", "conteudo_base64"],
    },
  },
  {
    name: "get_file",
    description:
      "Devolve o ARQUIVO ORIGINAL guardado (nome, mime, tipo, tamanho e conteudo_base64). 404 quando o doc foi criado como texto puro.",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "string" },
        memoria: { type: "string", description: "gaveta dentro do login (default '')" },
        tenant: { type: "string", description: "alvo do operador; ignorado para login comum" },
      },
      required: ["doc_id"],
    },
  },
  {
    name: "edit_doc",
    description:
      "Edita o TEXTO de um documento existente e reindexa (202). Em doc vindo de arquivo de texto, o original guardado acompanha a edicao.",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "string" },
        content: { type: "string", description: "texto novo (max 500000 chars)" },
        title: { type: "string" },
        memoria: { type: "string", description: "gaveta dentro do login (default '')" },
        tenant: { type: "string", description: "alvo do operador; ignorado para login comum" },
      },
      required: ["doc_id", "content"],
    },
  },
  {
    name: "rename_doc",
    description:
      "Renomeia o doc_id e/ou muda o titulo e/ou move para outra gaveta, sem reindexar. 409 se o doc tem job processando.",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "string" },
        novo_doc_id: { type: "string" },
        title: { type: "string" },
        destino_memoria: { type: "string", description: "gaveta de destino (default: a mesma)" },
        memoria: { type: "string", description: "gaveta atual (default '')" },
        tenant: { type: "string", description: "alvo do operador; ignorado para login comum" },
      },
      required: ["doc_id"],
    },
  },
  {
    name: "archive_doc",
    description: "Arquiva ou revive um documento inteiro (sem apagar nada).",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "string" },
        arquivado: { type: "boolean", description: "true arquiva, false revive" },
        memoria: { type: "string", description: "gaveta dentro do login (default '')" },
        tenant: { type: "string", description: "alvo do operador; ignorado para login comum" },
      },
      required: ["doc_id", "arquivado"],
    },
  },
  {
    name: "list_gavetas",
    description:
      "Mapa de usuarios e gavetas com contagem de documentos e chunks. Operador ve tudo; login comum ve so o proprio.",
    inputSchema: {
      type: "object",
      properties: {
        tenant: { type: "string", description: "filtra um usuario (so operador)" },
      },
    },
  },
  {
    name: "create_gaveta",
    description: "Cria uma gaveta vazia (para receber documentos depois).",
    inputSchema: {
      type: "object",
      properties: {
        memoria: { type: "string", description: "nome da gaveta" },
        tenant: { type: "string", description: "dono (so operador; comum cria na propria)" },
      },
      required: ["memoria"],
    },
  },
  {
    name: "delete_gaveta",
    description: "Apaga a gaveta inteira (chunks + fontes + arquivos originais + jobs na fila). 409 se ha job processando.",
    inputSchema: {
      type: "object",
      properties: {
        memoria: { type: "string" },
        tenant: { type: "string", description: "dono (obrigatorio quando o operador apaga gaveta alheia)" },
      },
      required: ["memoria"],
    },
  },
  {
    name: "chat",
    description:
      "Pergunta para o chat do minirag. O modelo responde com o provider configurado, as instrucoes do system prompt e as ferramentas ligadas (mcp interno + servidores externos); devolve a resposta e o que foi chamado.",
    inputSchema: {
      type: "object",
      properties: {
        pergunta: { type: "string", description: "a pergunta (max 2000 chars)" },
        memoria: { type: "string", description: "gaveta do historico (default '')" },
        tenant: { type: "string", description: "dono da gaveta (so operador)" },
      },
      required: ["pergunta"],
    },
  },
  {
    name: "listar_usuarios",
    description: "Lista os usuarios do servidor (nome, papel, ativo, documentos). Somente operador.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "criar_usuario",
    description:
      "Cria um usuario e devolve a chave em claro UMA UNICA VEZ (guarde na hora). Somente operador.",
    inputSchema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "2-32 chars: letras sem acento, numeros, . _ -" },
        papel: { type: "string", enum: ["usuario", "operador"] },
      },
      required: ["nome"],
    },
  },
  {
    name: "apagar_usuario",
    description:
      "Agenda a exclusao de um usuario: login desliga na hora, os dados dele somem depois da carencia configuravel (default 30 dias). Recriar o nome dentro da janela desfaz. Somente operador.",
    inputSchema: {
      type: "object",
      properties: { nome: { type: "string" } },
      required: ["nome"],
    },
  },
  {
    name: "esquecimento",
    description:
      "Numeros do esquecimento (dias_arquivar, dias_excluir_arquivado, dias_carencia). acao=ver | definir. Somente operador.",
    inputSchema: {
      type: "object",
      properties: {
        acao: { type: "string", enum: ["ver", "definir"] },
        dias_arquivar: { type: "integer", description: "sem uso ha N dias vira ARQUIVADO (default 180 = 6 meses)" },
        dias_excluir_arquivado: { type: "integer", description: "arquivado ha mais de N dias e apagado de verdade (default 365)" },
        dias_carencia: { type: "integer", description: "janela para desfazer o apagar de um usuario (default 30)" },
      },
      required: ["acao"],
    },
  },
  {
    name: "config_provider",
    description:
      "Provider de linguagem do chat (LiteLLM/OpenAI/Ollama). acao=ver | salvar | testar. A chave nunca volta em claro.",
    inputSchema: {
      type: "object",
      properties: {
        acao: { type: "string", enum: ["ver", "salvar", "testar"] },
        tipo: { type: "string", enum: ["litellm", "openai", "ollama"] },
        base_url: { type: "string", description: "ex.: https://litellm.exemplo.com/v1" },
        modelo: { type: "string" },
        chave: { type: "string", description: "omita para manter a chave ja salva" },
        temperatura: { type: "number" },
        system_prompt: { type: "string", description: "instrucoes iniciais do modelo; vazio = nenhuma instrucao" },
        mcp_interno: { type: "boolean", description: "ligar as ferramentas do proprio minirag no chat" },
        max_rodadas: { type: "integer", description: "rodadas de ferramenta por pergunta (0-10; default 5)" },
        ativo: { type: "boolean" },
        global: { type: "boolean", description: "gravar como padrao global (so operador)" },
      },
      required: ["acao"],
    },
  },
  {
    name: "listar_mcp",
    description:
      "Servidores MCP externos cadastrados para dar ferramentas ao chat (nome, url, ativo, n de ferramentas). O cabecalho de acesso nunca volta em claro.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "gerir_mcp",
    description:
      "Cuida dos servidores MCP do chat. acao=criar | atualizar | apagar | testar (testar lista as ferramentas). Somente operador.",
    inputSchema: {
      type: "object",
      properties: {
        acao: { type: "string", enum: ["criar", "atualizar", "apagar", "testar"] },
        nome: { type: "string", description: "2-32 caracteres, sem '__'" },
        url: { type: "string", description: "endereco http(s) do servidor MCP" },
        cabecalho: { type: "string", description: "Authorization: Bearer xxx ou o token cru; omita para manter" },
        ativo: { type: "boolean" },
      },
      required: ["acao", "nome"],
    },
  },
  {
    name: "list_jobs",
    description: "Fila de ingestao com resumo por status (na_fila | processando | concluido | erro | cancelado).",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        tenant: { type: "string", description: "filtra um usuario (so operador)" },
        limit: { type: "integer", description: "default 50, max 200" },
      },
    },
  },
  {
    name: "gerar_pareamento",
    description:
      "Cria um token de pareamento de maquina (uso unico, expira em ~15 min). O cliente da maquina usa esse token uma vez e ganha o token definitivo. Maquina nasce presa ao usuario que gerou.",
    inputSchema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "apelido da maquina (letras, numeros, - . _)" },
        tenant: { type: "string", description: "so operador: para quem sera a maquina" },
      },
      required: ["nome"],
    },
  },
  {
    name: "maquinas_online",
    description: "Lista as maquinas do usuario com estado online (host, so, desde, ativo).",
    inputSchema: {
      type: "object",
      properties: {
        tenant: { type: "string", description: "so operador: mira outro usuario; sem tenant o operador ve todas" },
      },
    },
  },
  {
    name: "rodar_comando",
    description:
      "Executa um comando de shell numa maquina DO USUARIO (fora do ar ou de outro dono = erro). Responde {exit, stdout, stderr, ms}. Tudo fica auditado.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        cmd: { type: "string", description: "comando de shell (ate 4000 chars)" },
        timeout: { type: "integer", description: "segundos aguardando; default 30, max 120" },
        tenant: { type: "string", description: "so operador: dono da maquina" },
      },
      required: ["host", "cmd"],
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
      "RAG semantico multi-tenant com processador de documentos. Tools: search (busca), " +
      "ingest (texto na fila), ingest_status (progresso), list_docs, delete_doc, health, " +
      "upload_file (pdf/docx/xlsx/csv/html/txt/md em base64), get_file (original guardado), " +
      "edit_doc (edita texto e reindexa), rename_doc (renomeia/move/titulo), archive_doc, " +
      "list_gavetas, create_gaveta, delete_gaveta, list_jobs, chat (usa as ferramentas ligadas), " +
      "listar_usuarios e criar_usuario (operador), config_provider (provider do chat), " +
      "listar_mcp e gerir_mcp (servidores MCP que dão ferramentas ao chat).",
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
      return deleteDoc(args.doc_id, args.memoria ?? "", args.tenant ?? null, user);
    case "upload_file": {
      if (typeof args.nome !== "string" || typeof args.conteudo_base64 !== "string") {
        throw new Error("parametros invalidos: nome e conteudo_base64 sao obrigatorios");
      }
      const b64 = args.conteudo_base64.replace(/^data:[^;]+;base64,/, "");
      if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new Error("conteudo_base64 invalido");
      const buf = Buffer.from(b64, "base64");
      if (!buf.length) throw new Error("conteudo_base64 vazio");
      return uploadArquivo(
        {
          nome: args.nome,
          mime: args.mime ?? null,
          conteudo: buf,
          memoria: args.memoria ?? "",
          tenant: args.tenant ?? null,
          doc_id: args.doc_id ?? null,
          title: args.title ?? null,
        },
        user,
      );
    }
    case "get_file": {
      const a = await getArquivoOriginal(args.doc_id, args.memoria ?? "", args.tenant ?? null, user);
      return {
        doc_id: args.doc_id,
        nome: a.nome,
        mime: a.mime,
        tipo: a.tipo,
        tamanho: a.tamanho,
        conteudo_base64: Buffer.from(a.conteudo).toString("base64"),
      };
    }
    case "edit_doc":
      return putDocument(
        args.doc_id,
        {
          content: args.content,
          title: args.title ?? null,
          memoria: args.memoria ?? "",
          tenant: args.tenant ?? null,
        },
        user,
      );
    case "rename_doc":
      return patchDocument(
        args.doc_id,
        {
          novo_doc_id: args.novo_doc_id ?? null,
          title: args.title,
          destino_memoria: args.destino_memoria ?? null,
          tenant: args.tenant ?? null,
        },
        args.memoria ?? "",
        user,
      );
    case "archive_doc":
      return patchArquivado(
        args.doc_id,
        Boolean(args.arquivado),
        args.memoria ?? "",
        args.tenant ?? null,
        user,
      );
    case "list_gavetas":
      return listGavetas(user, args.tenant ?? undefined);
    case "create_gaveta":
      return criarGaveta(tenantFor(user, args.tenant ?? null), args.memoria);
    case "delete_gaveta":
      return deleteGaveta(args.memoria, args.tenant ?? null, user);
    case "chat":
      if (typeof args.pergunta !== "string" || !args.pergunta.trim()) {
        throw new Error("parametros invalidos: campo obrigatorio: pergunta");
      }
      return responderChat(user, {
        pergunta: args.pergunta,
        memoria: args.memoria ?? "",
        tenant: args.tenant ?? null,
      });
    case "listar_usuarios":
      exigirOperador(user);
      return { usuarios: await listarUsuarios() };
    case "criar_usuario":
      exigirOperador(user);
      if (typeof args.nome !== "string") throw new Error("parametros invalidos: campo obrigatorio: nome");
      return criarUsuario(args.nome, args.papel);
    case "apagar_usuario":
      exigirOperador(user);
      if (typeof args.nome !== "string") throw new Error("parametros invalidos: campo obrigatorio: nome");
      return removerUsuario(args.nome);
    case "esquecimento": {
      exigirOperador(user);
      const acao = String(args.acao ?? "ver");
      if (acao === "ver") return lerEsquecimento();
      if (acao === "definir") return escreverEsquecimento(args);
      throw new Error("acao invalida: use ver | definir");
    }
    case "config_provider": {
      const acao = String(args.acao ?? "ver");
      if (acao === "ver") return verProvider(user, args.tenant ?? null);
      if (acao === "salvar") return salvarProvider(user, args);
      if (acao === "testar") return testarProvider(user, args);
      throw new Error("acao invalida: use ver | salvar | testar");
    }
    case "listar_mcp":
      return { servidores: await listarServidores() };
    case "gerir_mcp": {
      exigirOperador(user);
      const acao = String(args.acao ?? "");
      if (acao === "criar") return criarServidor(args);
      if (acao === "atualizar") return atualizarServidor(String(args.nome ?? ""), args);
      if (acao === "apagar") return apagarServidor(String(args.nome ?? ""));
      if (acao === "testar") return atualizarFerramentas(String(args.nome ?? ""), user);
      throw new Error("acao invalida: use criar | atualizar | apagar | testar");
    }
    case "list_jobs":
      return listJobs(
        {
          status: args.status ?? undefined,
          tenant: args.tenant ?? null,
          limit: args.limit === undefined ? undefined : Number(args.limit),
        },
        user,
      );
    case "gerar_pareamento":
      return criarPareamento(user, alvoMaquina(user, args.tenant), String(args.nome ?? ""));
    case "maquinas_online": {
      const alvo = user.operador ? String(args.tenant ?? "").trim() || null : user.tenant;
      return listarMaquinas(alvo);
    }
    case "rodar_comando":
      return rodar(
        user,
        alvoMaquina(user, args.tenant),
        String(args.host ?? ""),
        String(args.cmd ?? ""),
        args.timeout === undefined || args.timeout === null ? undefined : Number(args.timeout),
        "mcp",
      );
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