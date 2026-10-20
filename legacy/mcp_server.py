"""Camada MCP (Model Context Protocol) sobre a logica do minirag.

Servidor STREAMABLE HTTP stateless: cada chamada e um POST /mcp com uma
requisicao JSON-RPC 2.0; a resposta e JSON direto (sem SSE, sem sessao,
sem Mcp-Session-Id). Auth = o MESMO Bearer da API REST (nivel 1); a
memoria (nivel 2) vai nos argumentos da tool.

Metodos aceitos:
  initialize                  -> handshake (devolve protocolVersion/capabilities)
  notifications/*             -> aceitos e ignorados (202 sem corpo)
  ping                        -> {}
  tools/list                  -> as 6 tools do RAG
  tools/call                  -> executa; exige Bearer valido

Este modulo NAO importa api no topo (seria ciclo: api importa mcp_server).
As funcoes de negocio sao resolvidas com import lazy dentro do handler —
no momento do pedido, api ja esta 100% carregado.

Ferramentas usadas pelas tools = as MESMAS funcoes da REST (api.search,
api.enqueue_ingest, api.list_docs, api.delete_doc...); nenhuma regra
duplicada. Embedding ~0,5s em CPU: execucao em asyncio.to_thread para
nao travar o event loop (igual ao que a REST faz via threadpool).
"""
import asyncio
import json

from fastapi import Request
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

PROTOCOLOS_SUPORTADOS = ("2025-06-18", "2025-03-10", "2024-11-05")
SERVER_INFO = {"name": "minirag", "version": "1.11.0"}

# Schemas JSON (inputSchema) das tools — args viram o corpo da REST
TOOLS = [
    {
        "name": "health",
        "description": "Status do servidor RAG: dimensao do modelo de embedding e numero de usuarios ativos.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "search",
        "description": "Busca semantica na memoria do chamador. Retorna chunks com score (similaridade coseno). min_score default 0.55.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "texto da busca (max 2000 chars)"},
                "k": {"type": "integer", "description": "maximo de resultados (1-50; default 5)"},
                "min_score": {"type": "number", "description": "piso de similaridade 0-1 (default 0.55)"},
                "memoria": {"type": "string", "description": "gaveta dentro do login (default '')"},
                "include_archived": {"type": "boolean", "description": "buscar tambem nos arquivados (revive o chunk achado)"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "ingest",
        "description": "Enfileira um documento para ingestao (nao trava: responde job_id na hora). Acompanhe com ingest_status.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "doc_id": {"type": "string", "description": "id do doc (regravar o mesmo doc_id substitui o antigo)"},
                "title": {"type": "string"},
                "content": {"type": "string", "description": "texto do doc (max 500000 chars)"},
                "memoria": {"type": "string", "description": "gaveta dentro do login (default '')"},
            },
            "required": ["doc_id", "content"],
        },
    },
    {
        "name": "ingest_status",
        "description": "Status de um job de ingestao: na_fila | processando | concluido | erro | cancelado (+ progresso de chunks).",
        "inputSchema": {
            "type": "object",
            "properties": {"job_id": {"type": "integer"}},
            "required": ["job_id"],
        },
    },
    {
        "name": "list_docs",
        "description": "Lista os documentos do chamador em uma memoria (doc_id, titulo, chunks, atualizado_em).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "memoria": {"type": "string", "description": "gaveta dentro do login (default '')"},
                "include_archived": {"type": "boolean"},
            },
        },
    },
    {
        "name": "delete_doc",
        "description": "Apaga DEFINITIVAMENTE um doc (chunks + jobs na fila) na memoria do chamador. 409 se estiver processando.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "doc_id": {"type": "string"},
                "memoria": {"type": "string", "description": "gaveta dentro do login (default '')"},
            },
            "required": ["doc_id"],
        },
    },
]


def _result(msg_id, result):
    return JSONResponse(content={"jsonrpc": "2.0", "id": msg_id, "result": result})


def _error(msg_id, code, message):
    return JSONResponse(content={"jsonrpc": "2.0", "id": msg_id,
                                 "error": {"code": code, "message": message}})


def _tool_error(text):
    """Erro dentro de tools/call vira resultado com isError (linguagem MCP)."""
    return {"content": [{"type": "text", "text": text}], "isError": True}


def _tool_ok(data):
    return {"content": [{"type": "text",
                         "text": json.dumps(data, ensure_ascii=False, default=str)}],
            "isError": False}


def _initialize(params):
    requested = params.get("protocolVersion")
    version = requested if requested in PROTOCOLOS_SUPORTADOS else PROTOCOLOS_SUPORTADOS[0]
    return {
        "protocolVersion": version,
        "capabilities": {"tools": {"listChanged": False}},
        "serverInfo": SERVER_INFO,
        "instructions": ("RAG semantico multi-tenant. Tools: search (busca), "
                         "ingest (doc entra na fila), ingest_status (progresso), "
                         "list_docs, delete_doc, health."),
    }


async def _execute_tool(name, args, user):
    """Chama a funcao de negocio do api.py DIRETO (sem HTTP interno).

    user = o dict do authenticate() da REST (nivel 1); memoria (nivel 2)
    vem nos args. Nada de estado global: chamadas concorrentes seguem
    isoladas por tenant.
    """
    import api

    if name == "health":
        return api.health()
    if name == "search":
        body = api.SearchBody(**args)
        return await asyncio.to_thread(api.search, body, user)
    if name == "ingest":
        body = api.IngestBody(**args)
        return api.enqueue_ingest(body, user["tenant"])
    if name == "ingest_status":
        job_id = int(args["job_id"])
        def _status():
            with api.connect() as conn:
                with conn.cursor() as cur:
                    return api.job_status(cur, job_id, user["tenant"])
        st = await asyncio.to_thread(_status)
        if st is None:
            raise LookupError("job nao existe (ou e de outro usuario)")
        return st
    if name == "list_docs":
        # SEMPRE por nome: a REST ganhou parametros novos (tenant) e chamadas
        # posicionais silenciosamente reiam o dict user no lugar errado.
        return await asyncio.to_thread(
            api.list_docs, memoria=args.get("memoria", ""),
            include_archived=bool(args.get("include_archived", False)),
            user=user)
    if name == "delete_doc":
        return await asyncio.to_thread(
            api.delete_doc, doc_id=args["doc_id"],
            memoria=args.get("memoria", ""), user=user)
    raise LookupError("tool desconhecida: %s" % name)


async def _handle(request: Request, msg):
    """Despacha uma requisicao JSON-RPC. Retorna Response ou None (notification)."""
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" \
            or not isinstance(msg.get("method"), str):
        return _error(msg.get("id") if isinstance(msg, dict) else None,
                      -32600, "requisicao JSON-RPC 2.0 invalida")

    method = msg["method"]
    msg_id = msg.get("id")
    params = msg.get("params") or {}

    if method.startswith("notifications/"):
        return None  # notification: sem resposta (202)

    if method == "initialize":
        return _result(msg_id, _initialize(params))
    if method == "ping":
        return _result(msg_id, {})
    if method == "tools/list":
        return _result(msg_id, {"tools": TOOLS})

    if method == "tools/call":
        from fastapi import HTTPException
        from api import authenticate  # lazy: api ja carregado
        try:
            user = authenticate(request)
        except HTTPException as e:
            return JSONResponse(status_code=e.status_code,
                                content={"jsonrpc": "2.0", "id": msg_id,
                                         "error": {"code": -32001,
                                                   "message": str(e.detail)}})
        name = params.get("name")
        args = params.get("arguments") or {}
        try:
            result = await _execute_tool(name, args, user)
            return _result(msg_id, _tool_ok(result))
        except HTTPException as e:
            return _result(msg_id, _tool_error("erro %d: %s" % (e.status_code, e.detail)))
        except ValidationError as e:
            return _result(msg_id, _tool_error("parametros invalidos: %s" % e))
        except (LookupError, KeyError, TypeError, ValueError) as e:
            return _result(msg_id, _tool_error(str(e)))
        except Exception as e:  # nunca derruba o servidor por erro de tool
            return _result(msg_id, _tool_error("erro interno: %s" % e))

    return _error(msg_id, -32601, "metodo nao suportado: %s" % method)


async def mcp_endpoint(request: Request):
    """POST /mcp — um (ou um lote de) JSON-RPC por chamada, resposta JSON."""
    try:
        body = await request.json()
    except Exception:
        return _error(None, -32700, "corpo nao e JSON valido")

    if isinstance(body, list):  # batch JSON-RPC
        responses = []
        for item in body:
            r = await _handle(request, item)
            if r is not None:
                responses.append(json.loads(r.body.decode()))
        if not responses:
            return Response(status_code=202)
        return JSONResponse(content=responses)

    r = await _handle(request, body)
    if r is None:
        return Response(status_code=202)
    return r
