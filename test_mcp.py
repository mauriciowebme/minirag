import json, urllib.request, sys

BASE = "http://localhost:8000"
import os
KEY = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TESTKEY", "")
BEARER = "B" + "earer "  # literal montado: mascara nao corrompe concatenação
H = {"Content-Type": "application/json", "Authorization": BEARER + KEY}
HDR_NOAUTH = {"Content-Type": "application/json"}

def post(path, payload, headers=H):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read().decode()) if r.status != 202 else None
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())

def rpc(id_, method, params=None, headers=H):
    p = {"jsonrpc": "2.0", "id": id_, "method": method}
    if params is not None:
        p["params"] = params
    return post("/mcp", p, headers)

def check(label, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + label + (" | " + extra if extra else ""))
    if not cond:
        print("     >>>", extra)

# 1. initialize
s, r = rpc(1, "initialize", {"protocolVersion": "2025-03-10", "capabilities": {},
                             "clientInfo": {"name": "probe", "version": "0"}})
check("initialize", s == 200 and r["result"]["serverInfo"]["name"] == "minirag",
      str(r)[:200])
ver = r["result"]["protocolVersion"] if s == 200 else None
check("initialize ecoa versao pedida", ver == "2025-03-10", str(ver))

# 2. notification (sem id) -> 202 sem corpo
s, r = rpc(2, "notifications/initialized")
check("notifications/* -> 202", s == 202, str(r)[:100])

# 3. ping
s, r = rpc(3, "ping")
check("ping", s == 200 and "result" in r, str(r)[:100])

# 4. tools/list
s, r = rpc(4, "tools/list")
names = [t["name"] for t in r["result"]["tools"]] if s == 200 else []
check("tools/list tem 6 tools", sorted(names) == sorted(
      ["health", "search", "ingest", "ingest_status", "list_docs", "delete_doc"]), str(names))

# 5. tools/call health SEM auth -> erro JSON-RPC 401
s, r = rpc(5, "tools/call", {"name": "health"}, headers=HDR_NOAUTH)
check("tools/call sem Bearer -> 401", s == 401 and "error" in r, str(r)[:150])

# 6. tools/call health com auth
s, r = rpc(6, "tools/call", {"name": "health"})
text = r["result"]["content"][0]["text"] if s == 200 else ""
check("tools/call health", s == 200 and json.loads(text)["dim"] == 768, str(r)[:150])

# 7. ingest via MCP
s, r = rpc(7, "tools/call", {"name": "ingest", "arguments": {
    "doc_id": "mcp-teste-1", "title": "Teste MCP",
    "content": "O Hermes compacta o contexto quando a janela enche. O mini-compress faz isso de forma deterministica, sem LLM.",
    "memoria": "mcp-gaveta"}})
text = r["result"]["content"][0]["text"] if s == 200 else "{}"
job = json.loads(text) if s == 200 else {}
check("tools/call ingest -> job_id na fila", s == 200 and job.get("status") == "na_fila", str(r)[:200])

# 8. aguarda worker concluir
import time
status = None
for _ in range(30):
    s, r = rpc(8, "tools/call", {"name": "ingest_status",
                                 "arguments": {"job_id": job.get("job_id")}})
    text = r["result"]["content"][0]["text"] if s == 200 else "{}"
    status = json.loads(text)
    if status.get("status") in ("concluido", "erro"):
        break
    time.sleep(2)
check("ingest_status -> concluido", status.get("status") == "concluido", str(status)[:200])

# 9. search via MCP (gaveta certa)
s, r = rpc(9, "tools/call", {"name": "search", "arguments": {
    "query": "como o Hermes lida com a janela de contexto cheia", "memoria": "mcp-gaveta"}})
text = r["result"]["content"][0]["text"] if s == 200 else "{}"
res = json.loads(text)
check("search MCP acha o doc", s == 200 and res.get("total", 0) >= 1, str(res)[:200])

# 10. isolamento: search na gaveta errada = 0 hits
s, r = rpc(10, "tools/call", {"name": "search", "arguments": {
    "query": "como o Hermes lida com a janela de contexto cheia", "memoria": "outra"}})
text = r["result"]["content"][0]["text"] if s == 200 else "{}"
res = json.loads(text)
check("isolamento por memoria (0 hits na gaveta errada)", res.get("total") == 0, str(res)[:150])

# 11. list_docs
s, r = rpc(11, "tools/call", {"name": "list_docs", "arguments": {"memoria": "mcp-gaveta"}})
text = r["result"]["content"][0]["text"] if s == 200 else "{}"
res = json.loads(text)
check("list_docs mostra o doc", any(d["doc_id"] == "mcp-teste-1" for d in res.get("docs", [])), str(res)[:150])

# 12. delete_doc
s, r = rpc(12, "tools/call", {"name": "delete_doc", "arguments": {
    "doc_id": "mcp-teste-1", "memoria": "mcp-gaveta"}})
text = r["result"]["content"][0]["text"] if s == 200 else "{}"
res = json.loads(text)
check("delete_doc apaga", res.get("chunks_apagados", 0) >= 1, str(res)[:150])

# 13. search depois do delete = 0
s, r = rpc(13, "tools/call", {"name": "search", "arguments": {
    "query": "janela de contexto cheia", "memoria": "mcp-gaveta"}})
text = r["result"]["content"][0]["text"] if s == 200 else "{}"
res = json.loads(text)
check("search pos-delete = 0 hits", res.get("total") == 0, str(res)[:150])

# 14. metodo desconhecido
s, r = rpc(14, "foo/bar")
check("metodo desconhecido -> -32601", s == 200 and r.get("error", {}).get("code") == -32601, str(r)[:120])

# 15. tool error vira isError (parametros invalidos)
s, r = rpc(15, "tools/call", {"name": "search", "arguments": {}})
text = r["result"]["content"][0]["text"] if s == 200 else ""
check("args invalidos -> isError=true (nao crash)", s == 200 and r["result"].get("isError") is True, str(text)[:120])

# 16. REST continua viva (search direto)
req = urllib.request.Request(BASE + "/search",
    data=json.dumps({"query": "oi", "memoria": "mcp-gaveta"}).encode(),
    headers=H, method="POST")
with urllib.request.urlopen(req, timeout=60) as resp:
    rest = json.loads(resp.read().decode())
check("REST /search continua funcionando", "items" in rest, str(rest)[:100])

print("\nFIM")
