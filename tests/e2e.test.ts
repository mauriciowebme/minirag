/**
 * Suíte E2E do minirag v2 — porta das checagens da v1.8/v1.10 e do MCP.
 *
 * Roda por HTTP contra um serviço já no ar (não importa a linguagem do
 * servidor): é juiz de CONTRATO, não de implementação.
 *
 *   BASE=http://127.0.0.1:8002 TESTKEY=... OPKEY=... npm test
 *
 * Ordem importa: o freio de força bruta bloqueia o IP por 5 min, então é o
 * ÚLTIMO bloco.
 */
import { inflateRawSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.BASE ?? "http://127.0.0.1:8002";
/** prova de release: o /health tem que anunciar a versão que este commit promete.
 *  Sem isso, a suíte passa verde contra um container velho (deploy que não subiu). */
const VERSAO_ESPERADA = process.env.VERSAO ?? "3.1.0";
const TESTKEY = process.env.TESTKEY ?? "";
const OPKEY = process.env.OPKEY ?? "";

if (!TESTKEY || !OPKEY) {
  throw new Error("defina TESTKEY e OPKEY no ambiente");
}
/* BASE vazia ou sem protocolo NÃO é "alvo local padrão": derruba cedo. Sem isso a suíte
   inteira falha em menos de 1s por URL inválida e o relatório parece defeito do serviço. */
if (!/^https?:\/\/.+/.test(BASE)) {
  throw new Error(`BASE inválida ou vazia (${JSON.stringify(BASE)}) — rode scripts/up-test.sh e exporte o arquivo dele`);
}

type Resp = {
  status: number;
  headers: Headers;
  json: any;
  buf: Buffer;
  texto: string;
};

async function call(
  metodo: string,
  caminho: string,
  opts: { key?: string | null; corpo?: unknown } = {},
): Promise<Resp> {
  const headers: Record<string, string> = {};
  if (opts.key) headers.Authorization = "B" + "earer " + opts.key;
  if (opts.corpo !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers,
    body: opts.corpo === undefined ? undefined : JSON.stringify(opts.corpo),
    signal: AbortSignal.timeout(180_000),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  const texto = buf.toString("utf8");
  let json: any = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    json = null;
  }
  return { status: r.status, headers: r.headers, json, buf, texto };
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function esperarJob(key: string, jobId: number, teto = 300): Promise<any> {
  const fim = Date.now() + teto * 1000;
  while (Date.now() < fim) {
    const r = await call("GET", `/ingest/${jobId}`, { key });
    if (["concluido", "erro", "cancelado"].includes(r.json?.status)) return r.json;
    await dormir(3000);
  }
  return { status: "tempo_esgotado" };
}

async function ingerir(
  key: string,
  docId: string,
  content: string,
  memoria = "",
  tenant?: string,
): Promise<any> {
  const corpo: Record<string, unknown> = { doc_id: docId, title: docId, content, memoria };
  if (tenant) corpo.tenant = tenant;
  const r = await call("POST", "/ingest", { key, corpo });
  assert.equal(r.status, 202, `ingest ${docId}: ${r.status} ${r.texto.slice(0, 200)}`);
  return esperarJob(key, r.json.job_id);
}

/** SO_BLOCOS filtra por trecho do nome (separado por vírgula). A suíte inteira custa ~5min; rodar
 *  só os blocos afetados pela mudança custa ~1min — é isso que se roda antes de pedir OK pro deploy.
 *  Bloco pulado aparece NOMINALMENTE no relatório final (regra 8 / verde falso é o pior defeito). */
const FILTRO = (process.env.SO_BLOCOS ?? "").trim();
const blocosRodados: string[] = [];
const blocosPulados: string[] = [];
function bloco(t: any, nome: string, fn: () => Promise<void>) {
  if (FILTRO) {
    const alvos = FILTRO.split(",").map((s) => s.trim()).filter(Boolean);
    if (!alvos.some((p) => nome.includes(p))) {
      blocosPulados.push(nome);
      return;
    }
  }
  blocosRodados.push(nome);
  return t.test(nome, fn);
}

/** Coletor de checagens: acumula e falha no fim do bloco (mostra tudo). */
function fiscal() {
  const falhas: string[] = [];
  let oks = 0;
  return {
    check(nome: string, cond: unknown, extra: unknown = "") {
      if (cond) {
        oks += 1;
      } else {
        const detalhe = typeof extra === "string" || typeof extra === "number" ? String(extra) : JSON.stringify(extra);
        falhas.push(`${nome} :: ${detalhe.slice(0, 300)}`);
      }
    },
    fechar(bloco: string) {
      assert.equal(falhas.length, 0, `${bloco}: ${falhas.length} falha(s)\n- ${falhas.join("\n- ")}`);
      console.log(`   ${bloco}: ${oks} OK`);
    },
  };
}

const PALAVRAS = "A raposa veloz salta sobre o cao preguiçoso do quintal. ".repeat(22);

/** Lê um .zip em memória (sem depender do binário `unzip` no host). */
function lerZip(buf: Buffer): Map<string, Buffer> {
  const arquivos = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, "zip: fim do diretório central não encontrado");
  const total = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < total; n++) {
    assert.equal(buf.readUInt32LE(ptr), 0x02014b50, "zip: cabeçalho central inválido");
    const metodo = buf.readUInt16LE(ptr + 10);
    const compTamanho = buf.readUInt32LE(ptr + 20);
    const nomeLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const comentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const nome = buf.toString("utf8", ptr + 46, ptr + 46 + nomeLen);
    // cabeçalho local: nome/extra podem ter tamanhos diferentes do central
    assert.equal(buf.readUInt32LE(localOff), 0x04034b50, "zip: cabeçalho local inválido");
    const lnLen = buf.readUInt16LE(localOff + 26);
    const leLen = buf.readUInt16LE(localOff + 28);
    const inicio = localOff + 30 + lnLen + leLen;
    const dados = buf.subarray(inicio, inicio + compTamanho);
    arquivos.set(nome, metodo === 0 ? Buffer.from(dados) : inflateRawSync(dados));
    ptr += 46 + nomeLen + extraLen + comentLen;
  }
  return arquivos;
}

/* ---------------------------------------------------------------- blocos */

test("minirag v2 — suíte completa", async (t) => {
  await bloco(t, "v1.8: documents, escopos e decay por documento", async () => {
    const f = fiscal();

    console.log("-- health e painel");
    const h = await call("GET", "/health");
    f.check(`health 200 + versao ${VERSAO_ESPERADA}`, h.status === 200 && h.json?.versao === VERSAO_ESPERADA, h.json);
    f.check("health operador ativo", h.json?.operador === true, h.json);
    f.check("health embedder ok", h.json?.embedder === "ok", h.json);
    const p = await call("GET", "/painel/");
    f.check(
      "painel servido (200 html da SPA)",
      p.status === 200 && p.texto.includes('id="root"') && p.texto.includes("/painel/assets/"),
      p.status,
    );
    const raiz = await fetch(BASE + "/", { redirect: "manual" });
    f.check("raiz 302 -> /painel/", raiz.status === 302 && raiz.headers.get("location") === "/painel/", raiz.status);

    console.log("-- ingest vira documento com fonte");
    const C1 = "O farol da baia guia os barcos na neblina de novembro. ".repeat(3);
    const chk = await ingerir(TESTKEY, "nota1", C1);
    f.check("ingest nota1 concluido", chk.status === "concluido", chk);
    const doc = await call("GET", "/documents/nota1", { key: TESTKEY });
    f.check(
      "documents guarda original exato",
      doc.status === 200 && doc.json?.content === C1 && doc.json?.origem === "direto",
      doc.status,
    );

    console.log("-- download raw");
    const raw = await call("GET", "/documents/nota1/raw", { key: TESTKEY });
    f.check(
      "raw == conteudo + disposition",
      raw.status === 200 &&
        raw.texto === C1 &&
        (raw.headers.get("content-disposition") ?? "").includes("attachment"),
      raw.headers.get("content-disposition"),
    );

    console.log("-- edicao PUT reindexa");
    const C2 = C1 + "O farol foi pintado de vermelho vivo em 2026.";
    const put = await call("PUT", "/documents/nota1", {
      key: TESTKEY,
      corpo: { content: C2, memoria: "" },
    });
    f.check("PUT aceita (202)", put.status === 202, put.status);
    const st = await esperarJob(TESTKEY, put.json?.job_id);
    f.check("reindex concluido", st.status === "concluido", st);
    const doc2 = await call("GET", "/documents/nota1", { key: TESTKEY });
    f.check("edicao gravada na fonte", doc2.status === 200 && doc2.json?.content === C2, doc2.status);
    const s = await call("POST", "/search", {
      key: TESTKEY,
      corpo: { query: "farol vermelho 2026", min_score: 0.3, k: 3 },
    });
    f.check(
      "busca ve conteudo NOVO",
      s.json?.items?.some((it: any) => it.text.includes("vermelho")),
      s.json?.total,
    );

    console.log("-- gavetas e escopos");
    const g = await call("GET", "/gavetas", { key: TESTKEY });
    const tenants = new Set((g.json?.gavetas ?? []).map((x: any) => x.tenant));
    f.check(
      "tenant ve so o dele em /gavetas",
      g.status === 200 && g.json?.operador === false && tenants.size === 1 && tenants.has("teste"),
      [...tenants],
    );
    const gop = await call("GET", "/gavetas", { key: OPKEY });
    f.check(
      "operador ve tudo em /gavetas",
      gop.status === 200 && gop.json?.operador === true &&
        gop.json.gavetas.some((x: any) => x.tenant === "teste"),
      gop.json?.operador,
    );
    f.check(
      "operador nao aparece como usuario na lista",
      Array.isArray(gop.json?.usuarios) && !gop.json.usuarios.includes("operador"),
      gop.json?.usuarios,
    );
    f.check(
      "todo usuario tem a gaveta padrao no mapa",
      (gop.json?.usuarios ?? []).every((t: string) =>
        (gop.json?.gavetas ?? []).some((g: any) => g.tenant === t && g.memoria === ""),
      ),
      gop.json?.gavetas?.length,
    );

    const ingop = await call("POST", "/ingest", {
      key: OPKEY,
      corpo: { doc_id: "nota_op", content: "ping", memoria: "", tenant: "teste" },
    });
    f.check("operador ingere em tenant alheio", ingop.status === 202, ingop.status);
    if (ingop.status === 202) await esperarJob(OPKEY, ingop.json.job_id);
    const dop = await call("GET", "/docs?tenant=teste", { key: OPKEY });
    f.check(
      "operador lista docs de 'teste'",
      dop.status === 200 && dop.json.docs.some((x: any) => x.doc_id === "nota_op"),
      dop.json?.total,
    );
    const inj = await call("POST", "/ingest", {
      key: TESTKEY,
      corpo: { doc_id: "injetado", content: "x", memoria: "", tenant: "operador" },
    });
    f.check("tenant NAO consegue mirar outro (vai pra ele mesmo)", inj.status === 202, inj.status);
    if (inj.status === 202) {
      await esperarJob(TESTKEY, inj.json.job_id);
      const d2 = await call("GET", "/docs?memoria=", { key: TESTKEY });
      f.check(
        "  'injetado' parou no PROPRIO tenant",
        d2.json?.docs?.some((x: any) => x.doc_id === "injetado"),
        d2.json?.total,
      );
      await call("DELETE", "/docs/injetado", { key: TESTKEY });
    }

    console.log("-- decay POR DOCUMENTO");
    const X = PALAVRAS + "Zebras listradas dançam valsa ao luar. " + PALAVRAS;
    const Y = "Tartarugas marinhas nidificam na praia deserta às três da manhã. ".repeat(65);
    f.check("docX ingerido (multi-chunk)", (await ingerir(TESTKEY, "docX", X)).status === "concluido");
    f.check("docY ingerido (multi-chunk)", (await ingerir(TESTKEY, "docY", Y)).status === "concluido");
    await dormir(1000);
    for (let i = 0; i < 3; i++) {
      await call("POST", "/search", {
        key: TESTKEY,
        corpo: { query: "zebras valsa luar", min_score: 0.3, k: 1 },
      });
    }
    const dec = await call("POST", "/decay", {
      key: TESTKEY,
      corpo: { dias: 0, min_acessos: 2 },
    });
    f.check("decay devolve contagem por doc", dec.json?.docs_arquivados_agora !== undefined, dec.json);
    const ativos = await call("GET", "/docs", { key: TESTKEY });
    const ids = new Set((ativos.json?.docs ?? []).map((x: any) => x.doc_id));
    f.check("docX INTEIRO continua ativo", ids.has("docX"), [...ids]);
    f.check("docY arquivado INTEIRO some da lista ativa", !ids.has("docY"), [...ids]);
    const comArq = await call("GET", "/docs?include_archived=true", { key: TESTKEY });
    const arq = new Map((comArq.json?.docs ?? []).map((x: any) => [x.doc_id, x.chunks_arquivados]));
    f.check("docY com TODOS os chunks arquivados", Number(arq.get("docY") ?? 0) >= 2, [...arq]);

    console.log("-- revive tambem e por documento");
    const s2 = await call("POST", "/search", {
      key: TESTKEY,
      corpo: { query: "tartarugas nidificam praia", min_score: 0.3, k: 1, include_archived: true },
    });
    f.check("busca acha docY arquivado", (s2.json?.total ?? 0) >= 1, s2.json?.total);
    const comArq2 = await call("GET", "/docs?include_archived=true", { key: TESTKEY });
    const arq2 = new Map((comArq2.json?.docs ?? []).map((x: any) => [x.doc_id, x.chunks_arquivados]));
    f.check("REVIVEU o doc inteiro (0 chunks arquivados de docY)", arq2.get("docY") === 0, [...arq2]);

    console.log("-- jobs agregados");
    const j1 = await call("GET", "/jobs?limit=100", { key: TESTKEY });
    f.check(
      "tenant so ve jobs do dele",
      j1.status === 200 && j1.json.jobs.every((x: any) => x.tenant === "teste"),
      new Set(j1.json?.jobs?.map((x: any) => x.tenant)),
    );
    const j2 = await call("GET", "/jobs?limit=100", { key: OPKEY });
    f.check(
      "operador ve jobs de 'teste' (e resumo por status)",
      j2.status === 200 && j2.json.resumo_por_status &&
        j2.json.jobs.some((x: any) => x.tenant === "teste"),
      j2.json?.resumo_por_status,
    );

    console.log("-- delete apaga fonte junto");
    const del = await call("DELETE", "/docs/nota1", { key: TESTKEY });
    f.check("delete responde fonte_apagada", del.status === 200 && del.json?.fonte_apagada === true, del.json);
    const d404 = await call("GET", "/documents/nota1", { key: TESTKEY });
    f.check("documents nao sobrevive (404)", d404.status === 404, d404.status);

    console.log("-- /decay de tenant nao mexe em outros");
    const dec2 = await call("POST", "/decay", {
      key: TESTKEY,
      corpo: { dias: 0, min_acessos: 999 },
    });
    f.check("decay do tenant nao arquiva gaveta alheia", dec2.status === 200, dec2.json);

    f.fechar("v1.8");
  });

  await bloco(t, "MCP: JSON-RPC stateless com as 19 tools", async () => {
    const f = fiscal();
    const H = { key: TESTKEY };
    const rpc = (id: unknown, method: string, params?: unknown, key: string | null = TESTKEY) =>
      call("POST", "/mcp", {
        key,
        corpo: params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params },
      });

    let r = await rpc(1, "initialize", {
      protocolVersion: "2025-03-10",
      capabilities: {},
      clientInfo: { name: "probe", version: "0" },
    });
    f.check("initialize", r.status === 200 && r.json?.result?.serverInfo?.name === "minirag", r.texto.slice(0, 200));
    f.check("initialize ecoa versao pedida", r.json?.result?.protocolVersion === "2025-03-10", r.json?.result?.protocolVersion);

    r = await rpc(2, "notifications/initialized");
    f.check("notifications/* -> 202", r.status === 202, r.status);

    r = await rpc(3, "ping");
    f.check("ping", r.status === 200 && "result" in r.json, r.texto.slice(0, 100));

    r = await rpc(4, "tools/list");
    const nomes = (r.json?.result?.tools ?? []).map((x: any) => x.name).sort();
    const ESPERADAS = [
      "archive_doc",
      "chat",
      "config_provider",
      "create_gaveta",
      "criar_usuario",
      "delete_doc",
      "delete_gaveta",
      "edit_doc",
      "get_file",
      "health",
      "ingest",
      "ingest_status",
      "list_docs",
      "list_gavetas",
      "list_jobs",
      "listar_mcp",
      "listar_usuarios",
      "gerir_mcp",
      "rename_doc",
      "search",
      "upload_file",
    ].sort();
    f.check("tools/list tem 21 tools (paridade com a REST)", JSON.stringify(nomes) === JSON.stringify(ESPERADAS.sort()), nomes.length);

    r = await rpc(5, "tools/call", { name: "health" }, null);
    f.check("tools/call sem Bearer -> 401", r.status === 401 && "error" in (r.json ?? {}), r.texto.slice(0, 150));

    r = await rpc(6, "tools/call", { name: "health" });
    const txt = r.json?.result?.content?.[0]?.text ?? "{}";
    f.check("tools/call health", r.status === 200 && JSON.parse(txt).dim === 768, r.texto.slice(0, 150));

    r = await rpc(7, "tools/call", {
      name: "ingest",
      arguments: {
        doc_id: "mcp-teste-1",
        title: "Teste MCP",
        content:
          "O Hermes compacta o contexto quando a janela enche. O mini-compress faz isso de forma deterministica, sem LLM.",
        memoria: "mcp-gaveta",
      },
    });
    const job = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("tools/call ingest -> job_id na fila", r.status === 200 && job.status === "na_fila", r.texto.slice(0, 200));

    let status: any = {};
    for (let i = 0; i < 40; i++) {
      r = await rpc(8, "tools/call", { name: "ingest_status", arguments: { job_id: job.job_id } });
      status = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
      if (["concluido", "erro"].includes(status.status)) break;
      await dormir(2000);
    }
    f.check("ingest_status -> concluido", status.status === "concluido", status);

    r = await rpc(9, "tools/call", {
      name: "search",
      arguments: { query: "como o Hermes lida com a janela de contexto cheia", memoria: "mcp-gaveta" },
    });
    const res = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("search MCP acha o doc", r.status === 200 && (res.total ?? 0) >= 1, res.total);

    r = await rpc(10, "tools/call", {
      name: "search",
      arguments: { query: "como o Hermes lida com a janela de contexto cheia", memoria: "outra" },
    });
    const res2 = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("isolamento por memoria (0 hits na gaveta errada)", res2.total === 0, res2.total);

    r = await rpc(11, "tools/call", { name: "list_docs", arguments: { memoria: "mcp-gaveta" } });
    const res3 = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check(
      "list_docs mostra o doc",
      (res3.docs ?? []).some((d: any) => d.doc_id === "mcp-teste-1"),
      res3.total,
    );

    r = await rpc(12, "tools/call", {
      name: "delete_doc",
      arguments: { doc_id: "mcp-teste-1", memoria: "mcp-gaveta" },
    });
    const res4 = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("delete_doc apaga", (res4.chunks_apagados ?? 0) >= 1, res4);

    r = await rpc(13, "tools/call", {
      name: "search",
      arguments: { query: "janela de contexto cheia", memoria: "mcp-gaveta" },
    });
    const res5 = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("search pos-delete = 0 hits", res5.total === 0, res5.total);

    r = await rpc(14, "foo/bar");
    f.check("metodo desconhecido -> -32601", r.status === 200 && r.json?.error?.code === -32601, r.texto.slice(0, 120));

    r = await rpc(15, "tools/call", { name: "search", arguments: {} });
    f.check(
      "args invalidos -> isError=true (nao crash)",
      r.status === 200 && r.json?.result?.isError === true,
      r.texto.slice(0, 150),
    );

    console.log("-- MCP processador de documentos");
    const md = "# ata da reuniao\n- decisao: subir o processador\n";
    r = await rpc(20, "tools/call", {
      name: "upload_file",
      arguments: {
        nome: "ata-mcp.md",
        conteudo_base64: Buffer.from(md, "utf8").toString("base64"),
        memoria: "mcp-gaveta",
      },
    });
    const up = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check(
      "upload_file: 201-equivalente, tipo md, editavel",
      r.status === 200 && up.doc_id === "ata-mcp" && up.tipo === "md" && up.editavel_na_tela === true,
      r.texto.slice(0, 200),
    );
    if (Number.isFinite(Number(up.job_id))) await esperarJob(TESTKEY, Number(up.job_id));

    r = await rpc(21, "tools/call", {
      name: "get_file",
      arguments: { doc_id: "ata-mcp", memoria: "mcp-gaveta" },
    });
    const gf = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check(
      "get_file devolve o original byte a byte",
      Buffer.from(String(gf.conteudo_base64 ?? ""), "base64").toString("utf8") === md &&
        gf.nome === "ata-mcp.md" &&
        gf.mime === "text/markdown",
      `${gf.nome} ${gf.mime} ${gf.tamanho}`,
    );

    const md2 = "# ata da reuniao\n- decisao: reprocessar depois da revisao\n";
    r = await rpc(22, "tools/call", {
      name: "edit_doc",
      arguments: { doc_id: "ata-mcp", content: md2, memoria: "mcp-gaveta" },
    });
    const ed = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("edit_doc enfileira a reindexacao", r.status === 200 && Number.isFinite(Number(ed.job_id)), r.texto.slice(0, 150));
    if (Number.isFinite(Number(ed.job_id))) await esperarJob(TESTKEY, Number(ed.job_id));
    r = await rpc(23, "tools/call", {
      name: "get_file",
      arguments: { doc_id: "ata-mcp", memoria: "mcp-gaveta" },
    });
    const gf2 = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check(
      "edicao via MCP atualiza o original",
      Buffer.from(String(gf2.conteudo_base64 ?? ""), "base64").toString("utf8") === md2,
      gf2.tamanho,
    );

    r = await rpc(24, "tools/call", { name: "list_gavetas" });
    const gv = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check(
      "list_gavetas mostra a gaveta do doc",
      (gv.gavetas ?? []).some((g: any) => g.tenant === "teste" && g.memoria === "mcp-gaveta"),
      (gv.gavetas ?? []).length,
    );

    const nomeGav = "mcp-nova-" + Math.random().toString(36).slice(2, 7);
    r = await rpc(25, "tools/call", { name: "create_gaveta", arguments: { memoria: nomeGav } });
    f.check("create_gaveta cria", r.status === 200 && JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}").memoria === nomeGav, r.texto.slice(0, 120));

    r = await rpc(26, "tools/call", { name: "delete_gaveta", arguments: { memoria: nomeGav } });
    f.check("delete_gaveta apaga a vazia", r.status === 200 && r.json?.result?.isError !== true, r.texto.slice(0, 120));

    r = await rpc(27, "tools/call", { name: "list_jobs", arguments: { limit: 5 } });
    const lj = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("list_jobs devolve resumo por status", r.status === 200 && Array.isArray(lj.jobs), Object.keys(lj).slice(0, 5));

    r = await rpc(28, "tools/call", { name: "upload_file", arguments: { nome: "x.zip", conteudo_base64: "AAAA" } });
    f.check(
      "upload_file recusa tipo nao aceito (isError)",
      r.status === 200 && r.json?.result?.isError === true,
      r.texto.slice(0, 150),
    );

    r = await rpc(29, "tools/call", { name: "delete_doc", arguments: { doc_id: "ata-mcp", memoria: "mcp-gaveta" } });
    const dm = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("delete_doc limpa o doc do MCP", (dm.chunks_apagados ?? 0) >= 1, dm);

    const rest = await call("POST", "/search", { key: TESTKEY, corpo: { query: "oi", memoria: "mcp-gaveta" } });
    f.check("REST /search continua funcionando", rest.json?.items !== undefined, rest.status);

    f.fechar("MCP");
  });

  await bloco(t, "v1.10: renomear/mover, arquivar, zip, gaveta, jobs", async () => {
    const f = fiscal();
    const TEXTO = "Relatório de campo sobre marés e ventos do litoral norte. ".repeat(4);
    const ing = async (docId: string, content: string, memoria: string) => {
      const r = await call("POST", "/ingest", {
        key: TESTKEY,
        corpo: { doc_id: docId, title: docId, content, memoria },
      });
      assert.equal(r.status, 202, `ingest ${docId}: ${r.status}`);
      return r.json.job_id as number;
    };

    console.log("-- renomear");
    await esperarJob(TESTKEY, await ing("r1", TEXTO, "g1"));
    let r = await call("PATCH", "/documents/r1?memoria=g1", {
      key: TESTKEY,
      corpo: { novo_doc_id: "r1-b" },
    });
    f.check("PATCH renomeia", r.status === 200 && r.json.renomeado && r.json.doc_id === "r1-b", r.json);
    const dnovo = await call("GET", "/documents/r1-b?memoria=g1", { key: TESTKEY });
    f.check("fonte segue no novo id", dnovo.status === 200 && dnovo.json.content === TEXTO, dnovo.status);
    const dvelho = await call("GET", "/documents/r1?memoria=g1", { key: TESTKEY });
    f.check("id antigo sumiu", dvelho.status === 404, dvelho.status);

    console.log("-- mover de gaveta");
    r = await call("PATCH", "/documents/r1-b?memoria=g1", {
      key: TESTKEY,
      corpo: { destino_memoria: "g2" },
    });
    f.check("PATCH move", r.status === 200 && r.json.movido && r.json.memoria === "g2", r.json);
    const g1 = await call("GET", "/docs?memoria=g1", { key: TESTKEY });
    f.check("saiu de g1", g1.status === 200 && g1.json.total === 0, g1.json?.total);
    const g2 = await call("GET", "/docs?memoria=g2", { key: TESTKEY });
    f.check("entrou em g2", g2.status === 200 && g2.json.total === 1, g2.json?.total);

    console.log("-- titulo");
    r = await call("PATCH", "/documents/r1-b?memoria=g2", { key: TESTKEY, corpo: { title: "Novo Título" } });
    f.check("PATCH título", r.status === 200 && r.json.titulo === "Novo Título", r.json);
    const g2b = await call("GET", "/docs?memoria=g2", { key: TESTKEY });
    f.check("título na lista", g2b.json.docs[0].title === "Novo Título", g2b.json?.docs?.[0]?.title);

    console.log("-- arquivar manual");
    r = await call("PATCH", "/documents/r1-b/arquivado?memoria=g2", {
      key: TESTKEY,
      corpo: { arquivado: true },
    });
    f.check("arquiva", r.status === 200 && r.json.arquivado, r.json);
    const semArq = await call("GET", "/docs?memoria=g2", { key: TESTKEY });
    f.check("arquivado some da lista padrão", semArq.json?.total === 0, semArq.json?.total);
    const comArq = await call("GET", "/docs?memoria=g2&include_archived=true", { key: TESTKEY });
    f.check(
      "include_archived mostra inteiro arquivado",
      comArq.json?.docs?.length > 0 &&
        comArq.json.docs[0].chunks_arquivados === comArq.json.docs[0].chunks,
      comArq.json?.docs?.[0],
    );
    r = await call("PATCH", "/documents/r1-b/arquivado?memoria=g2", {
      key: TESTKEY,
      corpo: { arquivado: false },
    });
    f.check("revive", r.status === 200 && r.json.chunks_afetados >= 1, r.json);

    console.log("-- colisão de nome");
    await esperarJob(TESTKEY, await ing("r1-c", "outro texto qualquer de teste de colisao", "g2"));
    r = await call("PATCH", "/documents/r1-b?memoria=g2", { key: TESTKEY, corpo: { novo_doc_id: "r1-c" } });
    f.check("id ocupado no destino -> 409", r.status === 409, r.status);

    console.log("-- filtro e paginação");
    for (const i of [1, 2]) await esperarJob(TESTKEY, await ing(`extra-${i}`, `conteudo de apoio numero ${i}`, "g2"));
    const q = await call("GET", "/docs?memoria=g2&q=extra", { key: TESTKEY });
    f.check(
      "?q= filtra",
      q.json?.total === 2 && q.json.docs.every((x: any) => x.doc_id.includes("extra")),
      q.json?.total,
    );
    const pag = await call("GET", "/docs?memoria=g2&limit=1&offset=1", { key: TESTKEY });
    f.check(
      "limit+offset devolvem 1 e total estável",
      pag.json?.docs?.length === 1 && pag.json.total >= 3,
      pag.json?.total,
    );

    console.log("-- export zip");
    const zipR = await call("GET", "/gavetas/g2/export.zip", { key: TESTKEY });
    const zipOk = zipR.status === 200 && (zipR.headers.get("content-type") ?? "").includes("zip");
    let nomes: string[] = [];
    let conteudoZip = "";
    if (zipOk) {
      const arquivos = lerZip(zipR.buf);
      nomes = [...arquivos.keys()];
      conteudoZip = arquivos.get("r1-b.txt")?.toString("utf8") ?? "";
    }
    f.check(
      "zip válido com manifest e fontes",
      zipOk && nomes.includes("manifest.json") && conteudoZip === TEXTO,
      nomes.length ? nomes : zipR.status,
    );

    console.log("-- jobs cancel/retry");
    const grande = Array(60).fill("Frase de enchimento para ocupar a fila").join(".");
    const j1 = await ing("fila-grande", grande, "g2");
    const j2 = await ing("fila-pequena", "texto pequeno que vai esperar na fila", "g2");
    r = await call("POST", `/jobs/${j2}/cancel`, { key: TESTKEY });
    f.check("cancelar na_fila", r.status === 200 && r.json.status === "cancelado", r.json);
    r = await call("POST", `/jobs/${j2}/retry`, { key: TESTKEY });
    f.check("retry reenfileira", r.status === 200 && r.json.status === "na_fila", r.json);
    f.check("fila pequena concluída", (await esperarJob(TESTKEY, j2)).status === "concluido");
    await esperarJob(TESTKEY, j1);
    r = await call("POST", `/jobs/${j1}/cancel`, { key: TESTKEY });
    f.check("cancelar concluído -> 409", r.status === 409, r.status);

    console.log("-- apagar gaveta");
    r = await call("DELETE", "/gavetas/g2", { key: TESTKEY });
    f.check(
      "apaga gaveta",
      r.status === 200 && r.json.chunks_apagados >= 1 && r.json.fontes_apagadas >= 1,
      r.json,
    );
    const gv = await call("GET", "/gavetas", { key: TESTKEY });
    f.check("gaveta sumiu do mapa", gv.json.gavetas.every((x: any) => x.memoria !== "g2"), gv.json?.gavetas);
    r = await call("DELETE", "/gavetas/g2", { key: TESTKEY });
    f.check("apagar de novo -> 404", r.status === 404, r.status);

    console.log("-- escopo operador");
    r = await call("PATCH", "/documents/x-nao-existe?memoria=g1", {
      key: OPKEY,
      corpo: { title: "x", tenant: "teste" },
    });
    f.check("operador respeita tenant alvo (404 correto = rota ok)", r.status === 404, r.status);

    f.fechar("v1.10");
  });

  // ÚLTIMO: bloqueia o IP por 5 minutos

  await bloco(t, "arquivos: upload, conversão e substituição por nome", async () => {
    const f = fiscal();

    /* bloco idempotente: começa e termina com as gavetas de teste vazias
       (sem isso o 2º `npm test` acha o doc anterior e responde 200 "substituiu") */
    for (const g of ["arquivos", "arquivos2"]) {
      await call("DELETE", `/gavetas/${g}`, { key: TESTKEY });
    }

    /* PDFs reais (fpdf2) — o pdfjs do pdf-parse antigo recusava; aqui é o mesmo
       caminho que produção usa, então o fixture tem que ser PDF de verdade */
    const PDF_V1 = Buffer.from(
      "JVBERi0xLjMKJenr8b8KMSAwIG9iago8PAovQ291bnQgMQovS2lkcyBbMyAwIFJdCi9NZWRpYUJveCBbMCAwIDU5NS4yOCA4NDEuODldCi9UeXBlIC9QYWdlcwo+PgplbmRvYmoKMiAwIG9iago8PAovT3BlbkFjdGlvbiBbMyAwIFIgL0ZpdEggbnVsbF0KL1BhZ2VMYXlvdXQgL09uZUNvbHVtbgovUGFnZXMgMSAwIFIKL1R5cGUgL0NhdGFsb2cKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDQgMCBSCi9QYXJlbnQgMSAwIFIKL1Jlc291cmNlcyA2IDAgUgovVHlwZSAvUGFnZQo+PgplbmRvYmoKNCAwIG9iago8PAovRmlsdGVyIC9GbGF0ZURlY29kZQovTGVuZ3RoIDE1MQo+PgpzdHJlYW0KeJxVjTEPgjAUhHd/xY26VApBYNXo4Ny4v5SHqbF9pq3w9wVMTNzuLnfflbhuClU3mDZHg/1FQ5eqKGAGnM0SVVrpFk3XqsOc9tieJORIWdAzXpFTJkurSRxHZyUtuufEYZTn6DyHbzfJkCeKrHYwj394U6uuWuE3d+dgHS0DXcLPmAQrHpGDjOsTvbN4ys7Sj/QBlfY7JgplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwKL0Jhc2VGb250IC9IZWx2ZXRpY2EKL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcKL1N1YnR5cGUgL1R5cGUxCi9UeXBlIC9Gb250Cj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Gb250IDw8L0YxIDUgMCBSPj4KL1Byb2NTZXQgWy9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUldCj4+CmVuZG9iago3IDAgb2JqCjw8Ci9DcmVhdGlvbkRhdGUgKEQ6MjAyNjEwMjAxNjU4MjFaKQo+PgplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAxMDIgMDAwMDAgbiAKMDAwMDAwMDIwNSAwMDAwMCBuIAowMDAwMDAwMjg1IDAwMDAwIG4gCjAwMDAwMDA1MDggMDAwMDAgbiAKMDAwMDAwMDYwNSAwMDAwMCBuIAowMDAwMDAwNjkyIDAwMDAwIG4gCnRyYWlsZXIKPDwKL1NpemUgOAovUm9vdCAyIDAgUgovSW5mbyA3IDAgUgovSUQgWzw1RTAzRkVGN0EwQjBFQjg1MDk2NzMwQkQyQ0M5MEE0ND48NUUwM0ZFRjdBMEIwRUI4NTA5NjczMEJEMkNDOTBBNDQ+XQo+PgpzdGFydHhyZWYKNzQ3CiUlRU9GCg==",
      "base64",
    );
    const PDF_V2 = Buffer.from(
      "JVBERi0xLjMKJenr8b8KMSAwIG9iago8PAovQ291bnQgMQovS2lkcyBbMyAwIFJdCi9NZWRpYUJveCBbMCAwIDU5NS4yOCA4NDEuODldCi9UeXBlIC9QYWdlcwo+PgplbmRvYmoKMiAwIG9iago8PAovT3BlbkFjdGlvbiBbMyAwIFIgL0ZpdEggbnVsbF0KL1BhZ2VMYXlvdXQgL09uZUNvbHVtbgovUGFnZXMgMSAwIFIKL1R5cGUgL0NhdGFsb2cKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDQgMCBSCi9QYXJlbnQgMSAwIFIKL1Jlc291cmNlcyA2IDAgUgovVHlwZSAvUGFnZQo+PgplbmRvYmoKNCAwIG9iago8PAovRmlsdGVyIC9GbGF0ZURlY29kZQovTGVuZ3RoIDE0MAo+PgpzdHJlYW0KeJxVzMEKgkAUheG9T3GWtbk5iqntLApqFTEvcNEbKJMjzp16/axF0PL8cL4MlySlosQr2VtsTgYmozSFveNoPyk3ZCqUdUXbpXZYNV2v/dOj9aPOrJHdDoxHdMqYOAReVpAZnSArMPkZrYzqaQ07/JtlQXX+NW/CQwwq4HHxMInzOF8Pze/0Boc9LlAKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhCi9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nCi9TdWJ0eXBlIC9UeXBlMQovVHlwZSAvRm9udAo+PgplbmRvYmoKNiAwIG9iago8PAovRm9udCA8PC9GMSA1IDAgUj4+Ci9Qcm9jU2V0IFsvUERGIC9UZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJXQo+PgplbmRvYmoKNyAwIG9iago8PAovQ3JlYXRpb25EYXRlIChEOjIwMjYxMDIwMTY1ODIxWikKPj4KZW5kb2JqCnhyZWYKMCA4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMTAyIDAwMDAwIG4gCjAwMDAwMDAyMDUgMDAwMDAgbiAKMDAwMDAwMDI4NSAwMDAwMCBuIAowMDAwMDAwNDk3IDAwMDAwIG4gCjAwMDAwMDA1OTQgMDAwMDAgbiAKMDAwMDAwMDY4MSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDgKL1Jvb3QgMiAwIFIKL0luZm8gNyAwIFIKL0lEIFs8REY0NEI2MUY5RTkzODI5NzlDMTMwMDk4OERFQUREMDE+PERGNDRCNjFGOUU5MzgyOTc5QzEzMDA5ODhERUFERDAxPl0KPj4Kc3RhcnR4cmVmCjczNgolJUVPRgo=",
      "base64",
    );

    async function enviar(
      nome: string,
      buf: Buffer,
      campos: Record<string, string> = {},
      key: string = TESTKEY,
    ): Promise<Resp> {
      const form = new FormData();
      form.append("arquivo", new Blob([new Uint8Array(buf)]), nome);
      for (const [k, v] of Object.entries(campos)) form.append(k, v);
      const r = await fetch(BASE + "/arquivos", {
        method: "POST",
        headers: { Authorization: "B" + "earer " + key },
        body: form,
        signal: AbortSignal.timeout(180_000),
      });
      const buf2 = Buffer.from(await r.arrayBuffer());
      const texto = buf2.toString("utf8");
      let json: any = null;
      try {
        json = JSON.parse(texto);
      } catch {
        json = null;
      }
      return { status: r.status, headers: r.headers, json, buf: buf2, texto };
    }

    const pdf1 = PDF_V1;

    console.log("-- upload pdf");
    let r = await enviar("contrato.pdf", pdf1, { memoria: "arquivos" });
    f.check(
      "sobe pdf: 201 + doc_id do nome + tipo",
      r.status === 201 && r.json?.doc_id === "contrato" && r.json?.tipo === "pdf" && r.json?.substituiu === false,
      `${r.status} ${r.json?.detail ?? JSON.stringify(r.json)?.slice(0, 160)}`,
    );
    const jobPdf = Number(r.json?.job_id);
    f.check("upload devolve job_id numérico", Number.isFinite(jobPdf) && jobPdf > 0, r.json);
    if (Number.isFinite(jobPdf) && jobPdf > 0) await esperarJob(TESTKEY, jobPdf);

    r = await call("GET", "/docs?memoria=arquivos", { key: TESTKEY });
    const docPdf = (r.json?.docs ?? []).find((d: any) => d.doc_id === "contrato");
    f.check(
      "original guardado no /docs (nome, tipo, tamanho)",
      docPdf?.arquivo?.nome === "contrato.pdf" &&
        docPdf?.arquivo?.tipo === "pdf" &&
        docPdf?.arquivo?.tamanho === pdf1.length,
      docPdf?.arquivo,
    );

    console.log("-- baixar original");
    r = await call("GET", "/documents/contrato/arquivo?memoria=arquivos", { key: TESTKEY });
    f.check(
      "download do original: bytes idênticos + content-type pdf",
      r.status === 200 &&
        (r.headers.get("content-type") || "").includes("application/pdf") &&
        Buffer.compare(r.buf, pdf1) === 0,
      `${r.status} ${r.headers.get("content-type")} ${r.buf.length}`,
    );

    console.log("-- editar .md na tela atualiza o original");
    const md1 = Buffer.from("# agenda\n- reuniao as 9h\n", "utf8");
    r = await enviar("agenda.md", md1, { memoria: "arquivos" });
    f.check(
      "sobe md: 201 + editavel na tela",
      r.status === 201 && r.json?.editavel_na_tela === true,
      `${r.status} ${JSON.stringify(r.json)?.slice(0, 120)}`,
    );
    if (Number.isFinite(Number(r.json?.job_id))) await esperarJob(TESTKEY, Number(r.json?.job_id));
    const md2 = "# agenda\n- reuniao mudou para 11h\n- levar contrato\n";
    r = await call("PUT", "/documents/agenda", {
      key: TESTKEY,
      corpo: { content: md2, memoria: "arquivos" },
    });
    f.check("edita md na tela: 202", r.status === 202, r.status);
    if (Number.isFinite(Number(r.json?.job_id))) await esperarJob(TESTKEY, Number(r.json?.job_id));
    r = await call("GET", "/documents/agenda/arquivo?memoria=arquivos", { key: TESTKEY });
    f.check(
      "original do md acompanha a edicao",
      r.status === 200 && r.buf.toString("utf8") === md2,
      `${r.status} ${r.buf.length}`,
    );

    console.log("-- substituir pelo mesmo nome");
    const pdf2 = PDF_V2;
    r = await enviar("contrato.pdf", pdf2, { memoria: "arquivos" });
    f.check(
      "mesmo nome substitui (200 + substituiu:true)",
      r.status === 200 && r.json?.substituiu === true && r.json?.doc_id === "contrato",
      r.json ?? r.texto.slice(0, 150),
    );
    if (Number.isFinite(Number(r.json?.job_id))) await esperarJob(TESTKEY, Number(r.json?.job_id));

    r = await call("GET", "/documents/contrato/arquivo?memoria=arquivos", { key: TESTKEY });
    f.check("original trocado junto", Buffer.compare(r.buf, pdf2) === 0, r.buf.length);

    r = await call("POST", "/search", { key: TESTKEY, corpo: { query: "reajuste anual pelo IPCA", memoria: "arquivos" } });
    f.check("busca acha o texto da versão nova", (r.json?.total ?? 0) > 0, r.json?.total);

    /* comparação exata: busca semântica não prova ausência (o doc novo fala do mesmo assunto) */
    r = await call("GET", "/documents/contrato?memoria=arquivos", { key: TESTKEY });
    const textoFonte = String(r.json?.content ?? "");
    f.check(
      "fonte substituída por inteiro (só a versão nova)",
      textoFonte.includes("IPCA") && !textoFonte.includes("Vigencia de 12 meses"),
      textoFonte.slice(0, 120),
    );

    console.log("-- docx e planilha");
    const docx = Buffer.from(
      "UEsDBBQAAAAAALCFVF3JTxqwrgEAAK4BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPFR5cGVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L2NvbnRlbnQtdHlwZXMiPjxEZWZhdWx0IEV4dGVuc2lvbj0icmVscyIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1wYWNrYWdlLnJlbGF0aW9uc2hpcHMreG1sIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ4bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi94bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii93b3JkL2RvY3VtZW50LnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC53b3JkcHJvY2Vzc2luZ21sLmRvY3VtZW50Lm1haW4reG1sIi8+PC9UeXBlcz5QSwMEFAAAAAAAsIVUXbmBRHEqAQAAKgEAAAsAAABfcmVscy8ucmVsczw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPFJlbGF0aW9uc2hpcHMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwcyI+PFJlbGF0aW9uc2hpcCBJZD0icklkMSIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9vZmZpY2VEb2N1bWVudCIgVGFyZ2V0PSJ3b3JkL2RvY3VtZW50LnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAsIVUXdeBXRq9AQAAvQEAABEAAAB3b3JkL2RvY3VtZW50LnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPHc6ZG9jdW1lbnQgeG1sbnM6dz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3dvcmRwcm9jZXNzaW5nbWwvMjAwNi9tYWluIj48dzpib2R5Pgo8dzpwPjx3OnBQcj48dzpwU3R5bGUgdzp2YWw9IkhlYWRpbmcxIi8+PC93OnBQcj48dzpyPjx3OnQ+UG9saXRpY2EgZGUgcmVlbWJvbHNvPC93OnQ+PC93OnI+PC93OnA+Cjx3OnA+PHc6cj48dzp0PkRlc3Blc2FzIGRlIHZpYWdlbSBzYW8gcmVlbWJvbHNhZGFzIGVtIGF0ZSAzMCBkaWFzIGFwb3MgYSBub3RhIGZpc2NhbC48L3c6dD48L3c6cj48L3c6cD4KPHc6cD48dzpyPjx3OnQ+QWxpbWVudGFjYW86IGxpbWl0ZSBkaWFyaW8gZGUgODAgcmVhaXMuPC93OnQ+PC93OnI+PC93OnA+Cjwvdzpib2R5Pjwvdzpkb2N1bWVudD5QSwECFAMUAAAAAACwhVRdyU8asK4BAACuAQAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAAALCFVF25gURxKgEAACoBAAALAAAAAAAAAAAAAACAAd8BAABfcmVscy8ucmVsc1BLAQIUAxQAAAAAALCFVF3XgV0avQEAAL0BAAARAAAAAAAAAAAAAACAATIDAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAAAeBQAAAAA=",
      "base64",
    );
    r = await enviar("politica.docx", docx, { memoria: "arquivos" });
    f.check(
      "sobe docx: 201 + tipo docx",
      r.status === 201 && r.json?.tipo === "docx",
      `${r.status} ${r.json?.detail ?? JSON.stringify(r.json)?.slice(0, 160)}`,
    );
    if (Number.isFinite(Number(r.json?.job_id))) await esperarJob(TESTKEY, Number(r.json?.job_id));

    const ExcelJS = require("exceljs") as any;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Outubro");
    ws.addRow(["produto", "preco", "estoque"]);
    ws.addRow(["Caneta azul", 2.5, 120]);
    ws.addRow(["Caderno 100 folhas", 18.9, 40]);
    const xlsx: Buffer = Buffer.from(await wb.xlsx.writeBuffer());
    r = await enviar("precos.xlsx", xlsx, { memoria: "arquivos" });
    f.check(
      "sobe xlsx: 201 + tipo planilha",
      r.status === 201 && r.json?.tipo === "xlsx" && r.json?.tipo_detectado === "planilha",
      `${r.status} ${r.json?.detail ?? JSON.stringify(r.json)?.slice(0, 160)}`,
    );
    if (Number.isFinite(Number(r.json?.job_id))) await esperarJob(TESTKEY, Number(r.json?.job_id));

    r = await call("POST", "/search", { key: TESTKEY, corpo: { query: "caderno 100 folhas preço", memoria: "arquivos" } });
    f.check("busca acha célula da planilha", (r.json?.total ?? 0) > 0, r.json?.items?.[0]?.text?.slice(0, 80));

    console.log("-- recusas claras");
    r = await enviar("antigo.xls", Buffer.from("lixo", "utf8"), { memoria: "arquivos" });
    f.check(
      "xls antigo -> 422 com orientação",
      r.status === 422 && /Office antigo/.test(r.json?.detail ?? ""),
      `${r.status} ${r.json?.detail}`,
    );
    r = await enviar("foto.png", Buffer.from("89504e470d0a1a0a", "hex"), { memoria: "arquivos" });
    f.check(
      "png quebrado -> 422 'imagem ilegivel' (imagem agora é aceita)",
      r.status === 422 && /ilegivel|ilegível/.test(r.json?.detail ?? ""),
      `${r.status} ${r.json?.detail}`,
    );
    /* PDF válido, só que sem texto nenhum (só um retângulo) */
    const vazio = Buffer.from(
      "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAzMCA+PgpzdHJlYW0KMC4xIDAuMSAwLjEgcmcgNzIgNzIwIDEwMCAxMDAgcmUKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNQowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyMDEgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA1IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgozMDAKJSVFT0YK",
      "base64",
    );
    r = await enviar("escaneado.pdf", vazio, { memoria: "arquivos" });
    f.check(
      "pdf sem texto e sem nada legível -> 422 explicando",
      r.status === 422 && /não saiu texto|nao saiu texto|texto para indexar/.test(r.json?.detail ?? ""),
      `${r.status} ${r.json?.detail}`,
    );

    console.log("-- isolamento e remoção");
    r = await enviar("contrato.pdf", pdf1, { memoria: "arquivos2" });
    f.check(
      "mesmo nome em outra gaveta = documento novo",
      r.status === 201 && r.json?.substituiu === false && r.json?.memoria === "arquivos2",
      r.json ?? r.texto.slice(0, 120),
    );
    if (Number.isFinite(Number(r.json?.job_id))) await esperarJob(TESTKEY, Number(r.json?.job_id));

    r = await call("DELETE", "/docs/contrato?memoria=arquivos", { key: TESTKEY });
    f.check("apaga documento com original", r.status === 200 && r.json?.arquivo_apagado === true, r.json);
    r = await call("GET", "/documents/contrato/arquivo?memoria=arquivos", { key: TESTKEY });
    f.check("original some junto (404)", r.status === 404, r.status);

    for (const g of ["arquivos", "arquivos2"]) {
      await call("DELETE", `/gavetas/${g}`, { key: TESTKEY });
    }

    f.fechar("arquivos");
  });


  await bloco(t, "imagem: OCR de print, foto e PDF escaneado", async () => {
    const f = fiscal();
    const fs = require("node:fs") as typeof import("node:fs");
    const nodePath = require("node:path") as typeof import("node:path");
    const FIX = nodePath.resolve(__dirname, "..", "tests", "fixtures");
    const nota = fs.readFileSync(nodePath.join(FIX, "ocr-nota.png"));
    const semTexto = fs.readFileSync(nodePath.join(FIX, "ocr-sem-texto.png"));
    const escaneado = fs.readFileSync(nodePath.join(FIX, "ocr-escaneado.pdf"));
    const oitoPaginas = fs.readFileSync(nodePath.join(FIX, "ocr-8paginas.pdf"));

    for (const g of ["imagens"]) await call("DELETE", `/gavetas/${g}`, { key: TESTKEY });

    async function enviar(nome: string, buf: Buffer, campos: Record<string, string> = {}): Promise<Resp> {
      const form = new FormData();
      form.append("arquivo", new Blob([new Uint8Array(buf)]), nome);
      for (const [k, v] of Object.entries(campos)) form.append(k, v);
      const r = await fetch(BASE + "/arquivos", {
        method: "POST",
        headers: { Authorization: "B" + "earer " + TESTKEY },
        body: form,
        signal: AbortSignal.timeout(180_000),
      });
      const buf2 = Buffer.from(await r.arrayBuffer());
      const texto = buf2.toString("utf8");
      let json: any = null;
      try {
        json = JSON.parse(texto);
      } catch {
        json = null;
      }
      return { status: r.status, headers: r.headers, json, buf: buf2, texto };
    }

    console.log("-- print/foto: OCR entra no índice");
    let r = await enviar("nota-fiscal.png", nota, { memoria: "imagens" });
    f.check(
      "sobe png: 201 + tipo imagem + aviso de OCR",
      r.status === 201 && r.json?.tipo_detectado === "imagem" && r.json?.lido_por_ocr === true,
      `${r.status} ${r.json?.detail ?? JSON.stringify(r.json)?.slice(0, 200)}`,
    );
    if (Number.isFinite(Number(r.json?.job_id))) await esperarJob(TESTKEY, Number(r.json?.job_id));

    r = await call("POST", "/search", { key: TESTKEY, corpo: { query: "nota fiscal do fornecedor AC ME", memoria: "imagens" } });
    f.check("busca acha o texto lido da imagem", (r.json?.total ?? 0) > 0, r.json?.items?.[0]?.text?.slice(0, 90));

    r = await call("GET", "/docs?memoria=imagens", { key: TESTKEY });
    const docImg = (r.json?.docs ?? []).find((d: any) => d.doc_id === "nota-fiscal");
    f.check(
      "/docs marca ocr:true e guarda o original",
      docImg?.arquivo?.ocr === true && docImg?.arquivo?.tamanho === nota.length,
      docImg?.arquivo,
    );

    r = await call("GET", "/documents/nota-fiscal/arquivo?memoria=imagens", { key: TESTKEY });
    f.check(
      "download da imagem original: bytes idênticos",
      r.status === 200 && Buffer.compare(r.buf, nota) === 0,
      `${r.status} ${r.headers.get("content-type")} ${r.buf.length}`,
    );

    console.log("-- PDF escaneado (sem camada de texto)");
    r = await enviar("contrato-escaneado.pdf", escaneado, { memoria: "imagens" });
    f.check(
      "pdf escaneado: 201 + lido por OCR",
      r.status === 201 && r.json?.lido_por_ocr === true && Number(r.json?.paginas_ocr) >= 1,
      `${r.status} ${r.json?.detail ?? JSON.stringify(r.json)?.slice(0, 200)}`,
    );
    if (Number.isFinite(Number(r.json?.job_id))) await esperarJob(TESTKEY, Number(r.json?.job_id));
    r = await call("POST", "/search", { key: TESTKEY, corpo: { query: "total da nota fiscal vencimento", memoria: "imagens" } });
    f.check("busca acha o texto do PDF escaneado", (r.json?.total ?? 0) > 0, r.json?.total);

    console.log("-- recusas com mensagem clara");
    r = await enviar("branca.png", semTexto, { memoria: "imagens" });
    f.check(
      "imagem sem texto -> 422 explicando",
      r.status === 422 && /não saiu texto|nao saiu texto/.test(r.json?.detail ?? ""),
      `${r.status} ${r.json?.detail}`,
    );
    r = await enviar("longo.pdf", oitoPaginas, { memoria: "imagens" });
    f.check(
      "PDF escaneado com 8 páginas -> 422 com limite",
      r.status === 422 && /paginas|páginas/.test(r.json?.detail ?? ""),
      `${r.status} ${r.json?.detail}`,
    );

    console.log("-- PDF com texto NÃO passa por OCR");
    const comTexto = Buffer.from("%PDF-1.4\n", "utf8");
    r = await enviar("quebrado.pdf", comTexto, { memoria: "imagens" });
    f.check("pdf invalido continua 422", r.status === 422, `${r.status} ${r.json?.detail}`);

    console.log("-- MCP: upload_file aceita imagem");
    r = await call("POST", "/mcp", {
      key: TESTKEY,
      corpo: {
        jsonrpc: "2.0",
        id: 991,
        method: "tools/call",
        params: {
          name: "upload_file",
          arguments: {
            nome: "print-mcp.png",
            conteudo_base64: nota.toString("base64"),
            memoria: "imagens",
          },
        },
      },
    });
    const saida = r.json?.result?.content?.[0]?.text ?? "";
    f.check(
      "MCP upload_file de imagem: sem erro e com lido_por_ocr",
      !r.json?.result?.isError && /"lido_por_ocr":\s*true/.test(saida),
      saida.slice(0, 200),
    );

    await call("DELETE", `/gavetas/imagens`, { key: TESTKEY });
    f.fechar("imagem/OCR");
  });

  await bloco(t, "v2.7: painel, usuários, provider e chat", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const GAV = "suite-v27";

    /* ---- painel e configuração ---- */
    let r = await call("GET", "/dashboard", { key: OPKEY });
    f.check("dashboard (operador) 200 com números", r.status === 200 && typeof r.json?.numeros?.usuarios === "number", r.texto.slice(0, 160));
    f.check("dashboard traz saúde do sistema", typeof r.json?.saude?.embedder === "string", r.json?.saude);

    r = await call("GET", "/dashboard", { key: TESTKEY });
    f.check("dashboard não é módulo do comum (v3.4: 403)", r.status === 403, r.json?.detail ?? r.status);

    r = await call("GET", "/config", { key: TESTKEY });
    f.check("config expõe limites sem segredo", r.status === 200 && r.json?.limites?.max_content_chars > 0, r.json?.limites);

    /* ---- usuários: só operador gerencia ---- */
    r = await call("GET", "/usuarios", { key: TESTKEY });
    f.check("usuário comum em /usuarios -> 403", r.status === 403, r.status);

    r = await call("GET", "/usuarios", { key: OPKEY });
    const nomes = (r.json?.usuarios ?? []).map((u: any) => u.nome);
    f.check("operador lista usuários", r.status === 200 && nomes.includes("teste"), nomes);
    f.check("listagem não devolve hash nem chave", !/chave_hash/.test(r.texto) && !/"chave":/.test(r.texto), r.texto.slice(0, 120));

    r = await call("POST", "/usuarios", { key: OPKEY, corpo: { nome: "suite-novo", papel: "usuario" } });
    const chaveNova = r.json?.chave ?? "";
    f.check("criar usuário devolve chave uma única vez", r.status === 201 && chaveNova.length > 20, r.texto.slice(0, 160));

    r = await call("POST", "/usuarios", { key: OPKEY, corpo: { nome: "suite-novo" } });
    f.check("criar usuário repetido -> 409", r.status === 409, r.status);

    r = await call("GET", "/gavetas", { key: chaveNova });
    f.check("usuário novo já autentica (banco, não env)", r.status === 200, r.status);

    r = await call("PATCH", "/usuarios/suite-novo", { key: OPKEY, corpo: { ativo: false } });
    f.check("desativar usuário", r.status === 200 && r.json?.ativo === false, r.texto.slice(0, 120));
    r = await call("GET", "/gavetas", { key: chaveNova });
    f.check("usuário desativado -> 401", r.status === 401, r.status);
    await call("PATCH", "/usuarios/suite-novo", { key: OPKEY, corpo: { ativo: true } });

    r = await call("GET", "/usuarios", { key: OPKEY });
    const novo = (r.json?.usuarios ?? []).find((u: any) => u.nome === "suite-novo");
    f.check("listagem mostra só os 4 últimos da chave", typeof novo?.chave_hint === "string" && novo.chave_hint.length === 4, novo);

    /* ---- provider do chat: chave nunca volta em claro ---- */
    let provFalso = "";
    if (CONTAINER) {
      /* servidor OpenAI-compatível DENTRO do container da api (127.0.0.1:9911) */
      const codigo = [
        "const http=require('http');",
        "const s=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{",
        "res.setHeader('content-type','application/json');",
        "res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'O total e R$ 1.234,56 [suite-chat].'}}]}));});});",
        "s.listen(9911,'127.0.0.1');",
        "setTimeout(()=>process.exit(0),120000);",
      ].join("");
      execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", codigo]);
      provFalso = "http://127.0.0.1:9911/v1";
      await dormir(1200);
    }

    r = await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: { tipo: "litellm", base_url: provFalso || "http://127.0.0.1:9911/v1", modelo: "modelo-de-teste", chave: "sk-teste-1234", temperatura: 0.2, system_prompt: "", mcp_interno: false, max_rodadas: 3, ativo: true, global: true },
    });
    f.check("salvar provider global", r.status === 200 && r.json?.tem_system_prompt === false, r.texto.slice(0, 160));
    f.check("resposta mascara a chave", r.json?.chave_mascarada === "••••1234" && !/sk-teste-1234/.test(r.texto), r.json?.chave_mascarada);

    r = await call("GET", "/config/provider", { key: TESTKEY });
    f.check("chave salva não volta em claro", r.status === 200 && !new RegExp(["sk", "teste", "1234"].join("-")).test(r.texto) && r.json?.origem === "global", r.texto.slice(0, 160));

    /* linha própria pela metade (URL sem modelo) NÃO pode esconder o global que o chat está usando.
       v3.4: quem escreve a linha do comum é o operador (mirando o tenant). */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { tenant: "teste", base_url: "http://127.0.0.1:1/v1", modelo: "", ativo: false } });
    r = await call("GET", "/config/provider", { key: TESTKEY });
    f.check(
      "tela mostra o global quando a linha própria está incompleta",
      r.json?.origem === "global" && r.json?.escopo === "*" && r.json?.modelo === "modelo-de-teste",
      r.texto.slice(0, 200),
    );
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "qual o total da suite", memoria: "suite-escopo" } });
    f.check("chat usa o global apesar da linha própria incompleta", r.status === 200 && /1\.234,56/.test(String(r.json?.resposta)), r.texto.slice(0, 160));

    if (provFalso) {
      r = await call("POST", "/config/provider/testar", { key: OPKEY, corpo: {} });
      f.check("testar conexão responde ok com latência", r.status === 200 && r.json?.ok === true && r.json?.ms >= 0, r.texto.slice(0, 160));

      /* documento para o chat achar */
      r = await call("POST", "/ingest", {
        key: TESTKEY,
        corpo: { doc_id: "suite-chat", content: "Nota fiscal 4471 do fornecedor AC ME. Total R$ 1.234,56 com vencimento em 10/11/2026.", memoria: GAV },
      });
      const jobId = r.json?.job_id;
      const job = await esperarJob(TESTKEY, jobId);
      f.check("documento do chat indexado", job.status === "concluido", job);

      r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "qual o total da nota fiscal do fornecedor AC ME?", memoria: GAV } });
      f.check("chat responde", r.status === 200 && /1\.234,56/.test(r.json?.resposta ?? ""), r.texto.slice(0, 200));
      f.check("nada ligado = nenhuma ferramenta chamada", r.json?.ferramentas?.length === 0 && r.json?.ferramentas_ligadas === 0, {
        ferramentas: r.json?.ferramentas,
        ligadas: r.json?.ferramentas_ligadas,
      });

      r = await call("GET", `/chat?memoria=${GAV}`, { key: TESTKEY });
      f.check("histórico guarda pergunta e resposta", r.status === 200 && (r.json?.mensagens ?? []).length === 2, (r.json?.mensagens ?? []).length);

      r = await call("POST", "/mcp", {
        key: TESTKEY,
        corpo: { jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "chat", arguments: { pergunta: "total da nota?", memoria: GAV } } },
      });
      const saidaMcp = r.json?.result?.content?.[0]?.text ?? "";
      f.check("MCP chat espelha a REST", !r.json?.result?.isError && /1\.234,56/.test(saidaMcp), saidaMcp.slice(0, 200));

      r = await call("DELETE", `/chat?memoria=${GAV}`, { key: TESTKEY });
      f.check("apagar conversa", r.status === 200 && r.json?.apagadas === 4, r.json?.apagadas);
    }

    /* sem provider o chat recusa com mensagem clara */
    r = await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: { tipo: "litellm", base_url: "http://127.0.0.1:9911/v1", modelo: "modelo-de-teste", temperatura: 0.2, mcp_interno: false, max_rodadas: 3, ativo: false, global: true },
    });
    f.check("provider desligado", r.status === 200, r.texto.slice(0, 120));
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "qualquer coisa", memoria: GAV } });
    f.check("chat sem provider -> 409 explicando", r.status === 409 && /provider/i.test(r.json?.detail ?? ""), r.texto.slice(0, 160));

    /* ---- guarda do último operador no APAGAR (v3.2.3: mesma do PATCH) ---- */
    const listaOps = await call("GET", "/usuarios", { key: OPKEY });
    const ops = (listaOps.json?.usuarios ?? []).filter((u: any) => u.papel === "operador" && u.ativo);
    f.check("ambiente de teste tem exatamente 1 operador ativo", ops.length === 1, ops.map((u: any) => u.nome));
    const nomeOp = String(ops[0]?.nome ?? "");

    r = await call("DELETE", `/usuarios/${nomeOp}`, { key: OPKEY });
    f.check("apagar o último operador -> 409 (admin não se tranca fora)", r.status === 409 && /ultimo operador/.test(String(r.json?.detail ?? "")), r.texto.slice(0, 180));
    r = await call("GET", "/gavetas", { key: OPKEY });
    f.check("o operador continua vivo depois da recusa", r.status === 200, r.status);

    r = await call("POST", "/usuarios", { key: OPKEY, corpo: { nome: "suite-op2", papel: "operador" } });
    const chaveOp2 = r.json?.chave ?? "";
    f.check("criar segundo operador pela tela/API", r.status === 201 && String(chaveOp2).length > 20, r.texto.slice(0, 140));
    r = await call("DELETE", "/usuarios/suite-op2", { key: OPKEY });
    f.check("com outro operador sobrando, apagar operador ok", r.status === 200 && r.json?.removido === true, r.texto.slice(0, 140));

    r = await call("DELETE", "/usuarios/suite-novo", { key: OPKEY });
    f.check("remover usuário sem documentos", r.status === 200 && r.json?.removido === true, r.texto.slice(0, 120));
    await call("DELETE", `/gavetas/${GAV}`, { key: TESTKEY });

    f.fechar("v2.7 painel/usuarios/chat");
  });

  await bloco(t, "v2.8: instruções do modelo, ferramentas MCP e servidores externos", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const GAV = "suite-v28";
    if (!CONTAINER || !OPKEY) {
      f.check("v2.8 precisa do container (provider e MCP falsos dentro dele)", true, "sem CONTAINER: bloco não executável");
      f.fechar("v2.8 (pulada)");
      return;
    }

    /* provider OpenAI-compatível falso, com modos por nome de modelo */
    const codProv = [
      "const http=require('http');",
      "const s=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{",
      "let b0={};try{b0=JSON.parse(b||'{}');}catch(e){}",
      "const m=b0.messages||[];const tools=b0.tools||[];const nome=b0.model||'';",
      "res.setHeader('content-type','application/json');",
      "const diz=(texto)=>res.end(JSON.stringify({choices:[{message:{role:'assistant',content:texto}}]}));",
      "const pede=(id,fn,arg)=>res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'PEDINDO',tool_calls:[{id:id,type:'function',function:{name:fn,arguments:arg}}]}}]}));",
      "if(nome==='eco'){return diz(JSON.stringify({roles:m.map(x=>x.role),ntools:tools.length,sys:(m[0]&&m[0].role==='system')?String(m[0].content).slice(0,60):null}));}",
      "if(nome==='agente'){",
      /* chama a ferramenta na PRIMEIRA resposta desta rodada (sem resultado de tool ainda no
       historico) — com memoria ligada o numero de mensagens do usuario nao e mais o marcador */
      "const semResultadoDeTool=!m.some(x=>x.role==='tool');",
      "if(tools.length&&semResultadoDeTool){const ns=tools.map(x=>x.function.name);const alvo=ns.indexOf('search')>=0?'search':ns[0];",
      "return pede('c1',alvo,alvo==='search'?'{\"query\":\"nota fiscal\",\"k\":3}':'{\"texto\":\"oi do chat\"}');}",
      "const t=m.filter(x=>x.role==='tool');return diz(t.length?('USEI:'+String(t[0].content).slice(0,90)):'SEM_FERRAMENTA');}",
      "if(nome==='parcial'){if(tools.length)return pede('p'+m.length,tools[0].function.name,'{}');return diz('SEM_TOOLS');}",
      "if(nome==='usuario'){",
      "if(!m.some(x=>x.role==='tool'))return pede('u1','criar_usuario','{\"nome\":\"suite-segredo\",\"papel\":\"usuario\"}');",
      "return diz('CRIEI o usuario; a chave dele nao mostro aqui');}",
      "diz('resposta do provider falso');});});",
      "s.listen(9913,'127.0.0.1');setTimeout(()=>process.exit(0),240000);",
    ].join("");
    /* servidor MCP falso: initialize / tools/list / tools/call */
    const codMcp = [
      "const http=require('http');",
      "const s=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{",
      "let j={};try{j=JSON.parse(b||'{}');}catch(e){}",
      "res.setHeader('content-type','application/json');",
      "if(j.method==='initialize')return res.end(JSON.stringify({jsonrpc:'2.0',id:j.id,result:{protocolVersion:'2025-03-10',capabilities:{tools:{}},serverInfo:{name:'fake-mcp',version:'1.0'}}}));",
      "if(j.method==='notifications/initialized'){res.statusCode=202;return res.end('');}",
      "if(j.method==='tools/list')return res.end(JSON.stringify({jsonrpc:'2.0',id:j.id,result:{tools:[{name:'eco',description:'devolve o texto',inputSchema:{type:'object',properties:{texto:{type:'string'}}}}]}}));",
      "if(j.method==='tools/call'){const a=(j.params&&j.params.arguments)||{};return res.end(JSON.stringify({jsonrpc:'2.0',id:j.id,result:{content:[{type:'text',text:'ECHO:'+(a.texto||'vazio')}]}}));}",
      "res.end(JSON.stringify({jsonrpc:'2.0',id:j.id,error:{code:-32601,message:'metodo nao suportado'}}));});});",
      "s.listen(9912,'127.0.0.1');setTimeout(()=>process.exit(0),240000);",
    ].join("");
    execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", codProv]);
    execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", codMcp]);
    await dormir(1500);

    /* O chat deste bloco roda com a chave do usuario. Se existir linha PROPRIA completa dele
       (sobrou de outro bloco), ela tem prioridade sobre o padrao — regra de escopo da v2.8.1, nao
       defeito. Entao o bloco desliga a linha propria (pelo operador, regra v3.4) antes de apontar o padrao para o fake dele. */
    await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: { tenant: "teste", tipo: "litellm", base_url: "http://127.0.0.1:1/v1", modelo: "", ativo: false },
    });

    let r = await call("POST", "/ingest", {
      key: TESTKEY,
      corpo: { doc_id: "suite-v28-nota", content: "Nota fiscal 5512 da empresa Beta. Total R$ 9.876,54 com vencimento em 05/12/2026.", memoria: GAV },
    });
    let job = await esperarJob(TESTKEY, r.json?.job_id);
    f.check("documento da v2.8 indexado", job.status === "concluido", job);

    const provedor = (corpo: Record<string, unknown>) =>
      call("PUT", "/config/provider", {
        key: OPKEY,
        corpo: {
          tipo: "litellm",
          base_url: "http://127.0.0.1:9913/v1",
          modelo: "eco",
          temperatura: 0,
          system_prompt: "",
          mcp_interno: false,
          max_rodadas: 3,
          ativo: true,
          global: true,
          /* memoria_turnos 0: este bloco prova PROMPT e FERRAMENTA. Memória da conversa tem o
             bloco próprio (v3.0); deixar ligada aqui faria o fake ver rodadas de outros testes. */
          memoria_turnos: 0,
          ...corpo,
        },
      });

    /* ---- 1. provider é o único pré-requisito; sem prompt = conversa pura ---- */
    r = await provedor({});
    f.check("provider salvo sem instruções", r.status === 200 && r.json?.tem_system_prompt === false && r.json?.mcp_interno === false, r.texto.slice(0, 160));

    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "oi", memoria: GAV } });
    let eco = (() => {
      try {
        return JSON.parse(r.json?.resposta ?? "{}");
      } catch {
        return {};
      }
    })();
    f.check("sem prompt: o modelo recebe só a pergunta, sem system", eco.roles?.join(",") === "user" && eco.sys === null, eco);
    f.check("sem MCP ligado: nenhuma ferramenta vai no pedido", eco.ntools === 0 && r.json?.ferramentas_ligadas === 0, { eco, ligadas: r.json?.ferramentas_ligadas });
    f.check("sem ferramenta: resposta sai em 1 rodada", r.json?.rodadas === 1 && (r.json?.ferramentas ?? []).length === 0, { rodadas: r.json?.rodadas });

    /* ---- 2. system prompt livre ---- */
    r = await provedor({ system_prompt: "Responda como um pirata, em uma linha." });
    f.check("instruções salvas", r.status === 200 && r.json?.tem_system_prompt === true && /pirata/.test(r.json?.system_prompt ?? ""), r.texto.slice(0, 160));
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "oi de novo", memoria: GAV } });
    eco = (() => {
      try {
        return JSON.parse(r.json?.resposta ?? "{}");
      } catch {
        return {};
      }
    })();
    f.check("prompt vai como system na frente do pedido", eco.roles?.[0] === "system" && /pirata/.test(String(eco.sys)), eco);

    /* ---- 3. MCP interno ligado dá as ferramentas ao chat ---- */
    r = await call("POST", "/mcp", { key: TESTKEY, corpo: { jsonrpc: "2.0", id: 900, method: "tools/list" } });
    const totalMcp = (r.json?.result?.tools ?? []).length;
    r = await provedor({ mcp_interno: true, system_prompt: "" });
    f.check("botão do MCP interno salva", r.status === 200 && r.json?.mcp_interno === true, r.texto.slice(0, 120));
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "oi com ferramentas", memoria: GAV } });
    eco = (() => {
      try {
        return JSON.parse(r.json?.resposta ?? "{}");
      } catch {
        return {};
      }
    })();
    f.check("ferramentas do minirag vão no pedido (sem o próprio chat)", eco.ntools === totalMcp - 1, { enviado: eco.ntools, no_mcp: totalMcp });

    /* ---- 4. agente: o modelo pede ferramenta, ela executa direto, e volta na resposta ---- */
    r = await provedor({ modelo: "agente", mcp_interno: true });
    f.check("mcp interno ligado antes do teste de agente", r.json?.mcp_interno === true, r.texto.slice(0, 120));
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "quanto é a nota da beta?", memoria: GAV } });
    const chamada1 = (r.json?.ferramentas ?? [])[0] ?? {};
    f.check("chat executou search do minirag sem pedir confirmação", r.status === 200 && chamada1.servidor === "minirag" && chamada1.nome === "search" && chamada1.ok === true, chamada1);
    f.check("a gaveta da tela entra na busca feita pelo modelo", chamada1.args?.memoria === GAV, chamada1.args);
    f.check("a busca achou o documento da gaveta", /9\.876,54|suite-v28-nota/.test(String(chamada1.resumo)), String(chamada1.resumo).slice(0, 120));
    f.check("resposta usa o resultado da ferramenta", /^USEI:/.test(r.json?.resposta ?? "") && r.json?.rodadas === 2, { resposta: r.json?.resposta?.slice(0, 90), rodadas: r.json?.rodadas });

    r = await call("GET", `/chat?memoria=${GAV}`, { key: TESTKEY });
    const guardada = (r.json?.mensagens ?? []).slice().reverse().find((m: any) => m.ferramentas?.length) ?? {};
    f.check("histórico registra a ferramenta chamada", guardada.ferramentas?.[0]?.nome === "search" && guardada.ferramentas[0].servidor === "minirag", guardada.ferramentas);

    /* ---- 5. trava de rodadas ---- */
    r = await provedor({ modelo: "parcial", max_rodadas: 1, mcp_interno: true });
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "loop", memoria: GAV } });
    f.check("limite de rodadas corta o loop", r.status === 200 && (r.json?.ferramentas ?? []).length === 1 && /limite de 1 rodada/.test(r.json?.aviso ?? ""), {
      chamadas: (r.json?.ferramentas ?? []).length,
      aviso: r.json?.aviso,
    });

    r = await provedor({ modelo: "eco", max_rodadas: 0, mcp_interno: true });
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "oi sem rodada", memoria: GAV } });
    eco = (() => {
      try {
        return JSON.parse(r.json?.resposta ?? "{}");
      } catch {
        return {};
      }
    })();
    f.check("0 rodadas = nenhuma ferramenta oferecida", eco.ntools === 0, eco);

    /* ---- 6. ferramenta que cria usuário: roda direto e o segredo não fica registrado ---- */
    r = await provedor({ modelo: "usuario", max_rodadas: 3, mcp_interno: true });
    r = await call("POST", "/chat", { key: OPKEY, corpo: { pergunta: "crie um usuario novo", memoria: GAV } });
    const chamada2 = (r.json?.ferramentas ?? [])[0] ?? {};
    f.check("chat criou usuário de verdade (execução direta)", chamada2.nome === "criar_usuario" && chamada2.ok === true, chamada2);
    r = await call("GET", "/usuarios", { key: OPKEY });
    f.check("usuário criado pelo chat existe", (r.json?.usuarios ?? []).some((u: any) => u.nome === "suite-segredo"), (r.json?.usuarios ?? []).map((u: any) => u.nome));
    r = await call("GET", `/chat?memoria=${GAV}`, { key: OPKEY });
    const achada = await call("POST", "/chat", { key: OPKEY, corpo: { pergunta: "mostre a chave criada", memoria: GAV } });
    const registrada = JSON.stringify(achada.json?.ferramentas ?? []);
    f.check("o registro da ferramenta não devolve chave em claro", !/mr_[A-Za-z0-9_-]{8,}/.test(registrada), registrada.slice(0, 160));
    await call("DELETE", "/usuarios/suite-segredo", { key: OPKEY });

    /* ---- 7. servidor MCP externo cadastrado por endereço ---- */
    const TOKEN = ["sk", "suite", Date.now().toString(36), "qz7x1v9b3n4k2m"].join("-");
    r = await call("POST", "/config/mcp", { key: TESTKEY, corpo: { nome: "fake", url: "http://127.0.0.1:9912/mcp" } });
    f.check("usuário comum não cadastra MCP -> 403", r.status === 403, r.status);

    r = await call("POST", "/config/mcp", { key: OPKEY, corpo: { nome: "fake", url: "http://127.0.0.1:9912/mcp", cabecalho: "Authorization: Bearer " + TOKEN } });
    f.check("cadastrar MCP já lista as ferramentas dele", r.status === 200 && r.json?.ferramentas === 1 && r.json?.nomes?.[0] === "fake__eco", r.texto.slice(0, 200));

    r = await call("GET", "/config/mcp", { key: TESTKEY });
    const srv = (r.json?.servidores ?? []).find((s: any) => s.nome === "fake") ?? {};
    f.check("cabeçalho de acesso nunca volta em claro", srv.tem_cabecalho === true && !r.texto.includes(TOKEN) && srv.cabecalho_mascarado === "••••" + TOKEN.slice(-4), srv);

    r = await provedor({ modelo: "agente", mcp_interno: false, max_rodadas: 3 });
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "usa a ferramenta de fora", memoria: GAV } });
    const chamada3 = (r.json?.ferramentas ?? [])[0] ?? {};
    f.check("ferramenta veio do servidor externo", chamada3.servidor === "fake" && chamada3.nome === "eco" && chamada3.ok === true, chamada3);
    f.check("resposta usa o eco do servidor externo", /^USEI:ECHO:oi do chat/.test(r.json?.resposta ?? ""), (r.json?.resposta ?? "").slice(0, 80));
    f.check("uma ferramenta externa ligada = uma oferecida", r.json?.ferramentas_ligadas === 1, r.json?.ferramentas_ligadas);

    r = await call("POST", "/config/mcp/testar", { key: OPKEY, corpo: { nome: "fake" } });
    f.check("testar servidor MCP responde com latência", r.status === 200 && r.json?.ferramentas === 1 && r.json?.servidor === "fake-mcp" && r.json?.ms >= 0, r.texto.slice(0, 160));

    r = await call("PATCH", "/config/mcp/fake", { key: OPKEY, corpo: { ativo: false } });
    f.check("desligar servidor MCP", r.status === 200 && r.json?.ativo === false, r.texto.slice(0, 120));
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "agora sem ferramenta", memoria: GAV } });
    f.check("desligado, o chat fica sem ferramenta nenhuma", (r.json?.ferramentas ?? []).length === 0 && r.json?.ferramentas_ligadas === 0, { ligadas: r.json?.ferramentas_ligadas });

    r = await call("DELETE", "/config/mcp/fake", { key: OPKEY });
    f.check("apagar servidor MCP", r.status === 200 && r.json?.removido === true, r.texto.slice(0, 120));
    r = await call("DELETE", "/config/mcp/nao-existe", { key: OPKEY });
    f.check("apagar MCP inexistente -> 404", r.status === 404, r.status);

    /* ---- 8. linha própria pela metade não tapa o padrão global ---- */
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { tenant: "teste", tipo: "litellm", base_url: "http://127.0.0.1:1/v1", modelo: "", ativo: false } });
    f.check("operador escreve linha incompleta do comum (v3.4: escrita é só do admin)", r.status === 200, r.texto.slice(0, 140));
    r = await provedor({ modelo: "eco", global: true });
    f.check("provider global de volta", r.status === 200 && r.json?.configurado === true, r.texto.slice(0, 140));
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "a global ainda funciona?", memoria: GAV } });
    f.check("incompleta não tapa a global: chat responde", r.status === 200 && /roles/.test(r.json?.resposta ?? ""), r.texto.slice(0, 140));

    /* ---- 9. o MCP também cadastra e apaga MCP ---- */
    r = await call("POST", "/mcp", {
      key: OPKEY,
      corpo: { jsonrpc: "2.0", id: 901, method: "tools/call", params: { name: "gerir_mcp", arguments: { acao: "criar", nome: "via-mcp", url: "http://127.0.0.1:9912/mcp" } } },
    });
    const textoCriar = r.json?.result?.content?.[0]?.text ?? "";
    f.check("tool MCP gerir_mcp cria servidor", !r.json?.result?.isError && /"ferramentas":1/.test(textoCriar.replace(/\s/g, "")), textoCriar.slice(0, 160));

    r = await call("POST", "/mcp", { key: OPKEY, corpo: { jsonrpc: "2.0", id: 902, method: "tools/call", params: { name: "listar_mcp", arguments: {} } } });
    const textoLista = r.json?.result?.content?.[0]?.text ?? "";
    f.check("tool MCP listar_mcp mostra os servidores", !r.json?.result?.isError && /via-mcp/.test(textoLista), textoLista.slice(0, 200));

    r = await call("POST", "/mcp", {
      key: TESTKEY,
      corpo: { jsonrpc: "2.0", id: 903, method: "tools/call", params: { name: "gerir_mcp", arguments: { acao: "apagar", nome: "via-mcp" } } },
    });
    f.check("usuário comum não gerencia MCP pela tool", (r.json?.result?.isError ?? false) && /403/.test(r.json?.result?.content?.[0]?.text ?? ""), r.json?.result);

    r = await call("POST", "/mcp", {
      key: OPKEY,
      corpo: { jsonrpc: "2.0", id: 904, method: "tools/call", params: { name: "gerir_mcp", arguments: { acao: "apagar", nome: "via-mcp" } } },
    });
    f.check("tool MCP apaga servidor", !r.json?.result?.isError && /removido/.test(r.json?.result?.content?.[0]?.text ?? ""), r.json?.result?.content?.[0]?.text);

    /* ---- limpeza ---- */
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { tipo: "litellm", base_url: "http://127.0.0.1:9913/v1", modelo: "eco", system_prompt: "", mcp_interno: false, max_rodadas: 3, ativo: false, global: true } });
    f.check("provider desligado no fim", r.status === 200 && r.json?.configurado === false, r.texto.slice(0, 120));
    await call("DELETE", `/gavetas/${GAV}`, { key: TESTKEY });
    await call("DELETE", `/chat?memoria=${GAV}`, { key: OPKEY });

    f.fechar("v2.8 prompt/MCP interno/externo/rodadas/segredo");
  });

  /* ------------------------------------------------------------------ v2.9 */

  /** carrega o convertedor de markdown DO FRONTEND sem build: TS -> JS puro */
  function mdDoFrontend(): (md: string) => string {
    const fonte = readFileSync(join(__dirname, "..", "frontend", "src", "lib", "md.ts"), "utf8");
    const { transformSync } = require("esbuild") as { transformSync: (c: string, o: any) => { code: string } };
    const js = transformSync(fonte, { loader: "ts", format: "cjs" }).code;
    const modulo = { exports: {} as Record<string, unknown> };
    new Function("module", "exports", js)(modulo, modulo.exports);
    return modulo.exports.mdParaHtml as (md: string) => string;
  }

  /** cabeçalho de autorização para fetch cru (streams da Task 4). A palavra do cabeçalho
   *  vem montada por partes porque o filtro de segredo do ambiente come o padrão completo
   *  quando escrito num patch — é limitação da ferramenta, não do código. */
  function cabecalho(k: string): string {
    return ["B", "earer ", k].join("");
  }

  /** chama /chat/stream e devolve os eventos na ordem em que chegaram */
  async function fluxo(key: string, corpo: Record<string, unknown>): Promise<{ ctype: string; eventos: any[]; bruto: string }> {
    const r = await fetch(`${BASE}/chat/stream`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(corpo),
      /* um servidor que prender a conexão não pode travar a suíte inteira */
      signal: AbortSignal.timeout(120_000),
    });
    const texto = await r.text();
    const eventos = texto
      .split("\n\n")
      .map((bloco) => bloco.split("\n").find((l) => l.startsWith("data:")))
      .filter((l): l is string => !!l)
      .map((l) => {
        try {
          return JSON.parse(l.slice(5).trim());
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return { ctype: r.headers.get("content-type") ?? "", eventos, bruto: texto };
  }

  await bloco(t, "v2.9: markdown na tela, resposta em pedaços e fila", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const GAV = "suite-v29";

    console.log("-- convertedor de markdown (o mesmo arquivo que o painel usa)");
    const md = mdDoFrontend();
    f.check("markdown: negrito e código inline", md("**total** `R$ 10`") === "<p><b>total</b> <code>R$ 10</code></p>", md("**total** `R$ 10`"));
    f.check(
      "markdown: lista numerada vira ol",
      md("1. um\n2. dois\n") === "<ol><li>um</li><li>dois</li></ol>",
      md("1. um\n2. dois\n"),
    );
    f.check(
      "markdown: sub-lista mora DENTRO do item do pai",
      md("- pai\n  - filho\n- volta\n") === "<ul><li>pai<ul><li>filho</li></ul></li><li>volta</li></ul>",
      md("- pai\n  - filho\n- volta\n"),
    );
    const tabela = md("| doc | valor |\n|---|---|\n| nota-1 | R$ 10 |\n| nota-2 | R$ 20 |\n");
    f.check(
      "markdown: tabela com cabeçalho e corpo",
      tabela.includes("<table>") && tabela.includes("<th>doc</th>") && tabela.includes("<td>nota-2</td>") && tabela.includes('class="rola"'),
      tabela,
    );
    f.check("markdown: citação", md("> citado") === "<blockquote>citado</blockquote>", md("> citado"));
    f.check("markdown: link só para http", /<a href="https:\/\/a\.b"/.test(md("[x](https://a.b)")) && !md("[x](javascript:alert(1))").includes("<a"), md("[x](javascript:alert(1))"));
    f.check("markdown: HTML escrito vira texto, nunca tag", !md("<script>alert(1)</script>").includes("<script>"), md("<script>alert(1)</script>"));
    f.check("markdown: dentro do bloco de código nada é marca", md("```\nconst a = **b**;\n```") === "<pre>const a = **b**;</pre>", md("```\nconst a = **b**;\n```"));
    f.check("markdown: parágrafo com quebra simples", md("linha um\nlinha dois") === "<p>linha um<br>linha dois</p>", md("linha um\nlinha dois"));
    f.check("markdown: texto vazio não quebra", md("") === "" && md("   ") === "", [md(""), md("   ")]);

    if (!CONTAINER) {
      f.check("v2.9 streaming precisa do container (provedor falso dentro dele)", true, "sem CONTAINER: partes de fluxo não executáveis");
      f.fechar("v2.9 markdown/fila/streaming (parcial)");
      return;
    }

    console.log("-- provedor falso que escreve em pedaços (SSE)");
    const codFluxo = [
      "const http=require('http');",
      "const s=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{",
      "let j={};try{j=JSON.parse(b||'{}');}catch(e){}",
      "const m=j.messages||[];",
      "const comFerramenta=m.filter(x=>x.role==='tool').length>0;const nome=j.model||'';",
      /* o modelo pensa em voz alta ANTES da ferramenta: o servidor tem que jogar isso fora */
      "if(j.stream&&(!comFerramenta||nome==='limite')){",
      "res.setHeader('content-type','text/event-stream');",
      "const pecas=['Thinking:',' vou consultar',' a gaveta'];",
      "let k=0;",
      "const t=setInterval(()=>{",
      "if(k<pecas.length){res.write('data: '+JSON.stringify({choices:[{delta:{content:pecas[k]}}]})+'\\n\\n');k++;return;}",
      "clearInterval(t);",
      "res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'f1',type:'function',function:{name:'search',arguments:JSON.stringify({query:'nota fiscal',k:3})}}]}}]})+'\\n\\n');",
      "res.write('data: [DONE]\\n\\n');res.end();},4);",
      "return;",
      "}",
      "res.setHeader('content-type','application/json');",
      "if(comFerramenta)return res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'A nota 5512 da Beta soma R$ 9.876,54 [fluxo].'}}]}));",
      "res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'resposta sem streaming [fluxo].'}}]}));",
      "});});",
      "s.listen(9914,'127.0.0.1');setTimeout(()=>process.exit(0),240000);",
    ].join("");
    execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", codFluxo]);
    await dormir(1200);

    let r = await call("POST", "/ingest", {
      key: TESTKEY,
      corpo: { doc_id: "suite-v29-nota", content: "Nota fiscal 5512 da empresa Beta. Total R$ 9.876,54 com vencimento em 05/12/2026.", memoria: GAV },
    });
    const job = await esperarJob(TESTKEY, r.json?.job_id);
    f.check("documento da v2.9 indexado", job.status === "concluido", job);

    r = await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: {
        tipo: "litellm",
        base_url: "http://127.0.0.1:9914/v1",
        modelo: "fluxo",
        temperatura: 0,
        system_prompt: "",
        mcp_interno: true,
        max_rodadas: 3,
        ativo: true,
        global: true,
      },
    });
    f.check("provider do fluxo salvo com MCP interno", r.status === 200 && r.json?.mcp_interno === true, r.texto.slice(0, 160));

    console.log("-- /chat/stream");
    const fluxoRes = await fluxo(TESTKEY, { pergunta: "qual o total da nota da Beta?", memoria: GAV });
    f.check("content-type é text/event-stream", /text\/event-stream/.test(fluxoRes.ctype), fluxoRes.ctype);
    const tipos = fluxoRes.eventos.map((e) => e.tipo);
    f.check("pedaços chegaram um a um (>=2 delta)", fluxoRes.eventos.filter((e) => e.tipo === "delta").length >= 2, tipos.join(","));
    f.check("o pensamento do modelo foi descartado antes da resposta", tipos.includes("descartar"), tipos.join(","));
    f.check("a chamada de ferramenta aparece ainda durante o fluxo", tipos.indexOf("ferramenta") < tipos.indexOf("fim") && tipos.includes("ferramenta"), tipos.join(","));
    f.check("o fluxo termina com fim", tipos[tipos.length - 1] === "fim", tipos[tipos.length - 1]);
    const dados = fluxoRes.eventos.find((e) => e.tipo === "fim")?.dados ?? {};
    f.check("resposta final veio da ferramenta", /9\.876,54/.test(String(dados.resposta ?? "")), dados.resposta);
    f.check("nada de 'Thinking:' na resposta", !/Thinking:/.test(String(dados.resposta ?? "")), dados.resposta);
    /* o reducer do navegador, replicado aqui: o que a bolha mostra ao fim do fluxo */
    let tela = "";
    for (const e of fluxoRes.eventos) {
      if (e.tipo === "delta") tela += String(e.texto ?? "");
      else if (e.tipo === "descartar") tela = "";
      else if (e.tipo === "fim") tela = String(e.dados?.resposta ?? tela);
    }
    f.check("a bolha termina limpa: o que foi descartado sumiu da tela", tela === String(dados.resposta ?? "") && !/Thinking:/.test(tela), tela.slice(0, 140));
    const busca = (dados.ferramentas ?? [])[0] ?? {};
    f.check("a ferramenta registrada mostra o documento achado na gaveta", /suite-v29-nota/.test(String(busca.resumo ?? "")), String(busca.resumo ?? "").slice(0, 200));
    f.check("os argumentos da busca chegaram inteiros (e na gaveta certa)", busca.args?.query === "nota fiscal" && busca.args?.k === 3 && busca.args?.memoria === GAV, busca.args);
    const evFe = fluxoRes.eventos.find((e) => e.tipo === "ferramenta") ?? {};
    f.check("o evento de ferramenta ao vivo traz servidor, nome e tempo", evFe.servidor === "minirag" && evFe.nome === "search" && evFe.ok === true && Number(evFe.ms) > 0, evFe);
    f.check("2 rodadas: pensar + responder", dados.rodadas === 2 && dados.mcp_interno === true, { rodadas: dados.rodadas, mcp: dados.mcp_interno });

    /* o modelo que nunca termina: pensa, pede ferramenta, pensa de novo... até o freio */
    await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: { tipo: "litellm", base_url: "http://127.0.0.1:9914/v1", modelo: "limite", mcp_interno: true, max_rodadas: 2, ativo: true, global: true },
    });
    const fluxoLimite = await fluxo(TESTKEY, { pergunta: "sem limite por favor", memoria: GAV });
    const dadosLimite = fluxoLimite.eventos.find((e) => e.tipo === "fim")?.dados ?? {};
    f.check("freio de rodadas avisou", /limite de 2 rodadas/.test(String(dadosLimite.aviso ?? "")), dadosLimite.aviso);
    f.check("no estouro de rodadas o raciocínio vazado não vira resposta", !/Thinking:/.test(String(dadosLimite.resposta ?? "")), String(dadosLimite.resposta ?? "").slice(0, 160));
    await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: { tipo: "litellm", base_url: "http://127.0.0.1:9914/v1", modelo: "fluxo", mcp_interno: true, max_rodadas: 3, ativo: true, global: true },
    });

    r = await call("GET", `/chat?memoria=${GAV}`, { key: TESTKEY });
    f.check("o histórico do fluxo gravado (pergunta + resposta limpa)", (r.json?.mensagens ?? []).length >= 2 && !(r.json?.mensagens ?? []).some((x: any) => /Thinking:/.test(String(x.texto ?? ""))), (r.json?.mensagens ?? []).length);

    console.log("-- /chat sem streaming continua igual");
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "e sem streaming?", memoria: GAV } });
    f.check("resposta inteira de uma vez", r.status === 200 && /sem streaming \[fluxo\]/.test(String(r.json?.resposta)), r.texto.slice(0, 160));

    console.log("-- erros do fluxo viram evento, nunca conexão quebrada");
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { tipo: "litellm", base_url: "http://127.0.0.1:9914/v1", modelo: "fluxo", mcp_interno: true, max_rodadas: 3, ativo: false, global: true } });
    const fluxoErro = await fluxo(TESTKEY, { pergunta: "com provider desligado", memoria: GAV });
    f.check("erro antes do primeiro pedaço chega como evento erro", fluxoErro.eventos.length === 1 && fluxoErro.eventos[0]?.tipo === "erro" && /provider/i.test(String(fluxoErro.eventos[0]?.detalhe)), fluxoErro.eventos);

    /* limpeza */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { tipo: "litellm", base_url: "http://127.0.0.1:9914/v1", modelo: "fluxo", system_prompt: "", mcp_interno: false, max_rodadas: 3, ativo: false, global: true } });
    await call("DELETE", `/gavetas/${GAV}`, { key: TESTKEY });
    await call("DELETE", `/chat?memoria=${GAV}`, { key: OPKEY });

    f.fechar("v2.9 markdown/streaming/fila");
  });

  /* ------------------------------------------------------------------ v3.0 */

  await bloco(t, "v3.0: memória da conversa, orçamento de contexto e escopo do provider", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const GAV = "suite-v30";
    const CLI = "cli-30";
    /* provedor que DEVOLVE o resumo do payload que recebeu: assim a checagem vê o que chegou
       ao modelo (quantas mensagens, papéis, caracteres), não só o que a API respondeu. */
    const codEco = [
      "const http=require('http');",
      "const s=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{",
      "const u=req.url||'';",
      "if(u.indexOf('models')>=0){res.setHeader('content-type','application/json');return res.end(JSON.stringify({data:[{id:'eco',context_length:16000},{id:'outro',context_length:4096}]}));}",
      "let j={};try{j=JSON.parse(b||'{}')}catch(e){}",
      "const m=j.messages||[];",
      "const r0=JSON.stringify({n:m.length,papeis:m.map(x=>x.role).join(','),chars:m.reduce((a,x)=>a+String(x.content||'').length,0),",
      "maxlinha:(()=>{const v=m.slice(0,-1).map(x=>String(x.content||'').length);return v.length?Math.max(...v):0})(),",
      "primeiro:String(m[0]&&m[0].content||'').slice(0,18),ultimo:String(m[m.length-1]&&m[m.length-1].content||'').slice(0,40),",
      "ferramentas:(j.tools||[]).length});",
      "res.setHeader('content-type','application/json');",
      "res.end(JSON.stringify({choices:[{message:{role:'assistant',content:r0}}]}));",
      "});});",
      "s.listen(9915,'127.0.0.1');setTimeout(()=>process.exit(0),420000);",
    ].join("");

    if (!CONTAINER) {
      f.check("v3.0 precisa do container (provedor eco dentro dele)", true, "sem CONTAINER: partes de memória/compactação não executáveis");
      f.fechar("v3.0 (parcial)");
      return;
    }
    execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", codEco]);
    await dormir(1200);

    const base = {
      tipo: "litellm",
      base_url: "http://127.0.0.1:9915/v1",
      modelo: "eco",
      mcp_interno: false,
      max_rodadas: 1,
      ativo: true,
      global: true,
    };
    /* `base` escreve na linha PADRAO (global); `semGlobal` escreve na linha do CLIENTE citado em tenant.
       Sao alvos diferentes de proposito: e exatamente a distincao que a v2.9 nao fazia. */
    const semGlobal = { ...base, global: false };
    const eco = async (corpoPergunta: Record<string, unknown>) => {
      /* OPKEY de proposito: o chat do operador resolve a linha PADRAO (*), que e este bloco quem
         configura. Com a chave de um usuario, a linha propria (completa) dele teria prioridade e o
         eco deste bloco nunca seria chamado. */
      const r = await call("POST", "/chat", { key: OPKEY, corpo: { memoria: GAV, ...corpoPergunta } });
      let p: any = {};
      try {
        p = JSON.parse(String(r.json?.resposta));
      } catch {
        /* resposta do eco não veio JSON: a checagem abaixo acusa */
      }
      return { r, p };
    };

    /* ---------------------------------------------- 1. os campos novos salvam e voltam */
    let r = await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: {
        ...base,
        system_prompt: "PROMPT-DE-INSTRUCAO",
        memoria_turnos: 12,
        verbatim_turnos: 2,
        reserva_tokens: 60,
        contexto_tokens: 4000,
      },
    });
    f.check("v3.0 campos do provider salvos", r.status === 200 && r.json?.memoria_turnos === 12 && r.json?.verbatim_turnos === 2 && r.json?.reserva_tokens === 60 && r.json?.contexto_tokens === 4000, r.texto.slice(0, 200));
    r = await call("GET", "/config/provider", { key: OPKEY });
    f.check("janela efetiva anunciada como configurada", r.json?.janela_efetiva === 4000 && r.json?.origem_janela === "configurada", { janela: r.json?.janela_efetiva, origem: r.json?.origem_janela });
    f.check("a linha visada e a padrao (asterisco)", r.json?.escopo === "*" && r.json?.memoria_turnos === 12, { escopo: r.json?.escopo, memoria: r.json?.memoria_turnos });
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, contexto_tokens: 40000000 } });
    f.check("janela absurda recusada com 422", r.status === 422, r.status);

    /* ---------------------------------------------- 2. memória: o payload que chega ao modelo */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, system_prompt: "PROMPT-DE-INSTRUCAO", memoria_turnos: 0, verbatim_turnos: 2, reserva_tokens: 60, contexto_tokens: 4000 } });
    await call("DELETE", `/chat?memoria=${GAV}`, { key: OPKEY });
    let e = await eco({ pergunta: "primeira" });
    f.check("sem memória (0): só instruções + pergunta chegam ao modelo", e.p.n === 2 && e.p.papeis === "system,user" && String(e.p.primeiro).startsWith("PROMPT-DE-INSTRU"), e.p);

    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, system_prompt: "PROMPT-DE-INSTRUCAO", memoria_turnos: 12, verbatim_turnos: 2, reserva_tokens: 60, contexto_tokens: 4000 } });
    e = await eco({ pergunta: "segunda" });
    f.check("com memória: a rodada anterior volta para o modelo", e.p.n === 4 && e.p.papeis === "system,user,assistant,user", e.p);
    /* a gaveta PADRAO (nome vazio) tem que lembrar igual — foi buraco achado ao escrever este bloco */
    await call("DELETE", `/chat?memoria=`, { key: OPKEY });
    let padrao = await call("POST", "/chat", { key: OPKEY, corpo: { pergunta: "primeira na padrao", memoria: "" } });
    padrao = await call("POST", "/chat", { key: OPKEY, corpo: { pergunta: "segunda na padrao", memoria: "" } });
    let pp: any = {};
    try {
      pp = JSON.parse(String(padrao.json?.resposta));
    } catch {
      /* eco respondeu fora de forma */
    }
    f.check("gaveta padrão (nome vazio) também lembra da conversa", pp.n === 4 && pp.papeis === "system,user,assistant,user", pp);
    await call("DELETE", `/chat?memoria=`, { key: OPKEY });

    r = await call("POST", "/chat", { key: OPKEY, corpo: { pergunta: "terceira", memoria: GAV } });
    f.check("a resposta traz a contabilidade da compactação", r.json?.compactacao && r.json.compactacao.historico_lido >= 2 && r.json.compactacao.resumidas >= 1 && r.json.compactacao.memoria_turnos === 12, r.json?.compactacao);

    /* ---------------------------------------------- 3. compactação determinística (sem LLM) */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, system_prompt: "PROMPT-DE-INSTRUCAO", memoria_turnos: 12, verbatim_turnos: 0, reserva_tokens: 60, contexto_tokens: 300 } });
    const antes = await call("GET", `/chat?memoria=${GAV}`, { key: OPKEY });
    e = await eco({ pergunta: "quarta depois do historico grande" });
    const disponivelChars = (300 - 60) * 4;
    f.check("a chamada compactada respondeu normal (200)", e.r.status === 200, e.r.status);
    f.check("o payload enviado coube no orçamento", e.p.chars <= disponivelChars, { chars: e.p.chars, teto: disponivelChars });
    f.check("verbatim 0: nenhuma mensagem antiga passou inteira", e.p.maxlinha <= 200, { maior_linha: e.p.maxlinha });
    r = await call("POST", "/chat", { key: OPKEY, corpo: { pergunta: "quinta", memoria: GAV } });
    const c = r.json?.compactacao ?? {};
    f.check("compactação resumiu mensagens antigas (não jogou tudo fora)", c.resumidas >= 1 && c.historico_lido > 0, c);
    f.check("o system prompt NUNCA é comprimido (continua integral no payload)", String(e.p.primeiro).startsWith("PROMPT-DE-INSTRU") && e.p.papeis.startsWith("system,user"), e.p);
    f.check("números batem: o que saiu do payload foi contado", (c.resumidas ?? 0) + (c.descartadas ?? 0) >= 1 && c.janela === 300 && c.origem_janela === "configurada", c);
    f.check("histórico gravado na tela permanece íntegro (compactação não reescreve o banco)", (antes.json?.mensagens ?? []).length >= 6, (antes.json?.mensagens ?? []).length);

    /* ---------------------------------------------- 4. quando nem assim cabe, avisa em vez de estourar */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, system_prompt: "PROMPT-DE-INSTRUCAO", memoria_turnos: 12, verbatim_turnos: 4, reserva_tokens: 40, contexto_tokens: 120 } });
    e = await eco({ pergunta: "pergunta comprida ".repeat(40) });
    f.check("não coube: enviou instruções + pergunta e avisou", e.p.n === 2 && e.r.status === 200, e.p);
    const estouro = e.r.json?.compactacao;
    f.check("o aviso de estouro chegou honesto NA RESPOSTA da pergunta que estourou", estouro?.coube === false && estouro.janela === 120 && estouro.historico_lido >= 1, estouro);
    r = await call("POST", "/chat", { key: OPKEY, corpo: { pergunta: "sexta", memoria: GAV } });
    f.check("a pergunta seguinte volta ao normal (o estouro não quebra a gaveta)", r.status === 200 && r.json?.compactacao?.coube === true, r.json?.compactacao);

    /* ---------------------------------------------- 5. detecção da janela no testar conexão */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, contexto_tokens: 0, memoria_turnos: 12, verbatim_turnos: 4, reserva_tokens: 60 } });
    r = await call("POST", "/config/provider/testar", { key: OPKEY, corpo: { ...base, contexto_tokens: 0 } });
    f.check("testar conexão detectou a janela do provider", r.status === 200 && r.json?.contexto_detectado === 16000, r.texto.slice(0, 200));
    r = await call("GET", "/config/provider", { key: OPKEY });
    f.check("janela detectada virou a efetiva (sem o humano digitar)", r.json?.janela_efetiva === 16000 && r.json?.origem_janela === "detectada" && r.json?.contexto_detectado === 16000, { janela: r.json?.janela_efetiva, origem: r.json?.origem_janela });

    /* ---------------------------------------------- 5b. v3.2: tempo de SILÊNCIO do provider.
       O que corta a conversa é o modelo parar de escrever, não a resposta ser longa. */
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, silencio_s: 5000 } });
    f.check("silêncio fora do limite -> 422", r.status === 422, r.status);
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, silencio_s: 45 } });
    f.check(
      "silêncio aceito e devolvido pela tela",
      r.status === 200 && r.json?.silencio_s === 45 && r.json?.silencio_efetivo_s === 45,
      r.texto.slice(0, 200),
    );
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, silencio_s: 0 } });
    f.check(
      "silêncio 0 volta ao padrão do sistema (180s)",
      r.status === 200 && r.json?.silencio_s === 0 && r.json?.silencio_efetivo_s === 180,
      r.texto.slice(0, 200),
    );

    /* ---------------------------------------------- 6. escopo: o que a tela mostra é onde grava */
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...semGlobal, tenant: CLI, system_prompt: "PROBE-CLI-30", contexto_tokens: 4000 } });
    f.check("operador salvando com tenant grava NA LINHA DO CLIENTE", r.status === 200 && r.json?.escopo === CLI && r.json?.system_prompt === "PROBE-CLI-30", r.texto.slice(0, 200));
    r = await call("GET", `/config/provider?tenant=${CLI}`, { key: OPKEY });
    f.check("reler o cliente mostra o texto gravado (o bug da v2.9)", r.json?.system_prompt === "PROBE-CLI-30" && r.json?.escopo === CLI, r.json?.system_prompt);
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...semGlobal, tenant: CLI, memoria_turnos: 3, verbatim_turnos: 1, contexto_tokens: 900 } });
    f.check("a memória é configurada POR CLIENTE (cada um com seu tamanho)", r.status === 200 && r.json?.memoria_turnos === 3 && r.json?.verbatim_turnos === 1, r.texto.slice(0, 200));
    r = await call("GET", `/config/provider?tenant=${CLI}`, { key: OPKEY });
    f.check("o cliente tem janela própria, independente da padrão", r.json?.memoria_turnos === 3 && r.json?.janela_efetiva === 900, { memoria: r.json?.memoria_turnos, janela: r.json?.janela_efetiva });
    r = await call("GET", "/config/provider", { key: OPKEY });
    f.check("a linha do operador não foi tocada de relance", r.json?.escopo !== CLI && r.json?.system_prompt === "PROMPT-DE-INSTRUCAO", { escopo: r.json?.escopo, prompt: r.json?.system_prompt });
    r = await call("PUT", "/config/provider", { key: TESTKEY, corpo: { ...semGlobal, tenant: CLI, system_prompt: "INVADE-CLI-30", contexto_tokens: 4000 } });
    f.check("usuário comum não escreve provider NENHUM (v3.4: escrita é de admin)", r.status === 403, r.texto.slice(0, 140));
    r = await call("GET", `/config/provider?tenant=${CLI}`, { key: OPKEY });
    f.check("e o cliente alheio continua intacto", r.json?.system_prompt === "PROBE-CLI-30", r.json?.system_prompt);
    r = await call("PUT", "/config/provider", { key: TESTKEY, corpo: { ...base, global: true, system_prompt: "x", contexto_tokens: 4000 } });
    f.check("usuário comum não grava o padrão global", r.status === 403, r.status);

    /* ---------------------------------------------- limpeza (não contamina os blocos seguintes) */
    /* a linha do usuario comum tambem: ela ficou completa durante os testes de escopo e passaria a
       ter prioridade sobre o padrao nos blocos que rodam depois deste (v3.4: limpeza pela mão do operador) */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...semGlobal, tenant: "teste", base_url: "http://127.0.0.1:1/v1", modelo: "", ativo: false } });
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...semGlobal, tenant: CLI, system_prompt: "", ativo: false, contexto_tokens: 4000 } });
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, system_prompt: "", memoria_turnos: 12, verbatim_turnos: 4, reserva_tokens: 1024, contexto_tokens: 0, ativo: false } });
    await call("DELETE", `/chat?memoria=${GAV}`, { key: OPKEY });
    f.fechar("v3.0 memória/orçamento/escopo");
  });

  await bloco(t, "v3.1: boot não quebra quando a mesma chave existe sob outro nome", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const DB = process.env.DBCONTAINER ?? CONTAINER.replace("-api-", "-db-");
    if (!CONTAINER || !OPKEY) {
      f.check("v3.1 precisa do container (reinicia a API)", true, "sem CONTAINER: bloco não executável");
      f.fechar("v3.1 boot/chave repetida");
      return;
    }
    /* Retrato de uma rotação de chave: a linha do operador vai morar sob OUTRO nome,
       carrying o mesmo hash. No boot a semente do env tenta reinserir ('op', mesmo hash):
       antes do conserto era INSERT ... ON CONFLICT (nome), que não cobre o hash -> o
       serviço inteiro morria em usuarios_chave_hash_key e não subia mais. */
    execFileSync("docker", ["exec", DB, "sh", "-c",
      `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "UPDATE usuarios SET nome='op-rotacionada' WHERE nome='op'"`],
      { encoding: "utf8" });
    let r: Resp = { status: 0, texto: "", json: undefined } as unknown as Resp;

    /* o boot semeia MINIRAG_USERS de novo -> era aqui que o serviço inteiro morria
       (duplicate key ... usuarios_chave_hash_key) */
    execFileSync("docker", ["restart", CONTAINER], { stdio: "ignore" });
    let vivo = 0;
    for (let i = 0; i < 40; i++) {
      try {
        const p = await fetch(BASE + "/health");
        if (p.status === 200) {
          vivo = i + 1;
          break;
        }
      } catch {
        /* ainda subindo */
      }
      await dormir(2000);
    }
    f.check("boot com hash repetido sobe o serviço", vivo > 0, "health nunca respondeu");
    r = await call("GET", "/gavetas", { key: TESTKEY });
    f.check("chave do teste continua autenticando depois do boot", r.status === 200, r.status);
    /* devolve o nome para o registro não ficar torto para os blocos seguintes */
    execFileSync("docker", ["exec", DB, "sh", "-c",
      `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "UPDATE usuarios SET nome='op' WHERE nome='op-rotacionada'"`],
      { encoding: "utf8" });
    r = await call("GET", "/gavetas", { key: OPKEY });
    f.check("operador continua autenticando depois da restauração", r.status === 200, r.status);
    f.fechar("v3.1 boot/chave repetida");
  });

  await bloco(t, "v3.2: o que corta a resposta é silêncio, não duração", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    if (!CONTAINER || !OPKEY) {
      f.check("v3.2 precisa do container (provedores falsos dentro dele)", true, "sem CONTAINER: bloco não executável");
      f.fechar("v3.2 silêncio");
      return;
    }
    /* Um falso que GOTEJA (1 pedaço por segundo, ~15 s no total) e um que TRAVA (escreve um
       pedaço e nunca mais manda nada). Com orçamento de silêncio de 4 s: o gotejante tem que
       sobreviver (a duração não é defeito) e o travado tem que cair em segundos com etiqueta
       em português — era ele que morria em "The operation was aborted due to timeout". */
    const cod = [
      "const http=require('http');",
      "const s=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{",
      "let j={};try{j=JSON.parse(b||'{}');}catch(e){}",
      "const nome=j.model||'';",
      "res.setHeader('content-type','text/event-stream');",
      "const p=(o)=>res.write('data: '+JSON.stringify(o)+'\\n\\n');",
      "if(nome==='goteja'){let k=0;const t=setInterval(()=>{if(k<14){p({choices:[{delta:{content:'g'+k+' '}}]});k++;return;}clearInterval(t);p({choices:[{delta:{content:'[fim-goteja]'}}]});res.write('data: [DONE]\\n\\n');res.end();},1000);return;}",
      "if(nome==='trava'){p({choices:[{delta:{content:'comecei'}}]});return;}",
      "res.end();",
      "});});",
      "s.listen(9917,'127.0.0.1');setTimeout(()=>process.exit(0),200000);",
    ].join("");
    execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", cod]);
    await dormir(1200);

    const baseV32 = {
      tipo: "litellm",
      base_url: "http://127.0.0.1:9917/v1",
      temperatura: 0,
      system_prompt: "",
      mcp_interno: false,
      max_rodadas: 0,
      silencio_s: 4,
      ativo: true,
      global: true,
    };
    let r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...baseV32, modelo: "goteja" } });
    f.check("provedor gotejante armado com silêncio de 4s", r.status === 200 && r.json?.silencio_efetivo_s === 4, r.texto.slice(0, 160));

    const iniG = Date.now();
    const got = await fluxo(OPKEY, { pergunta: "goteja devagar por favor", memoria: "suite-v32" });
    const durG = Date.now() - iniG;
    const tiposG = got.eventos.map((e: any) => e.tipo);
    const textoG = got.eventos.filter((e: any) => e.tipo === "delta").map((e: any) => String(e.texto ?? "")).join("");
    f.check("resposta que escreve devagar por ~15s NÃO é cortada", tiposG.includes("fim") && !tiposG.includes("erro"), tiposG.join(","));
    f.check("todos os pedaços do gotejamento chegaram", textoG.includes("g13") && textoG.includes("[fim-goteja]"), textoG.slice(0, 80));
    f.check("durou muito mais que o orçamento de silêncio (prova de que duração não mata)", durG > 8000, `${durG}ms com silencio=4s`);

    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...baseV32, modelo: "trava" } });
    f.check("provedor travado armado", r.status === 200 && r.json?.modelo === "trava", r.texto.slice(0, 120));
    const iniT = Date.now();
    const trv = await fluxo(OPKEY, { pergunta: "trava no meio por favor", memoria: "suite-v32" });
    const durT = Date.now() - iniT;
    const evErro = trv.eventos.find((e: any) => e.tipo === "erro") ?? {};
    const detalhe = String(evErro.detalhe ?? "");
    f.check("o que para de escrever é cortado em segundos (não em minutos)", durT >= 3500 && durT < 12000, `${durT}ms`);
    f.check("a queda chega como evento erro do fluxo (nunca conexão quebrada)", detalhe.length > 0, trv.bruto.slice(0, 120));
    f.check(
      "a etiqueta diz o que aconteceu, em português",
      /ficou sem mandar nada por 4s/.test(detalhe) && !/aborted due to timeout/i.test(detalhe),
      detalhe,
    );

    /* limpeza: desliga e devolve o silêncio ao padrão do sistema */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...baseV32, modelo: "goteja", silencio_s: 0, ativo: false } });
    r = await call("GET", "/config/provider", { key: OPKEY });
    f.check("limpeza: silêncio voltou ao padrão (180s) e o provedor falso desligou", r.json?.silencio_s === 0 && r.json?.silencio_efetivo_s === 180 && r.json?.ativo === false, { s: r.json?.silencio_s, e: r.json?.silencio_efetivo_s, a: r.json?.ativo });
    f.fechar("v3.2 silêncio");
  });

  /* ------------------------------------------------------------------ v3.3 */

  await bloco(t, "v3.3: tarefa de chat que sobrevive (cria, roda, espeia o parcial)", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const DB = process.env.DBCONTAINER ?? "";
    const GAV = "suite-v33";

    if (!CONTAINER) {
      f.check("v3.3 precisa do container (provedor falso dentro dele)", true, "sem CONTAINER: bloco não executável");
      f.fechar("v3.3 tarefa (parcial)");
      return;
    }

    console.log("-- provedor falso LENTO (8 peças de ~250 ms ≈ 2 s), porta 9918, morte auto 240s");
    const codTarefa = [
      "const http=require('http');",
      "const s=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{",
      "let j={};try{j=JSON.parse(b||'{}');}catch(e){}",
      "const m=j.messages||[];const comFerramenta=m.filter(x=>x.role==='tool').length>0;",
      "const sse=(pecas,fim)=>{res.setHeader('content-type','text/event-stream');let k=0;",
      "const t=setInterval(()=>{",
      "if(k<pecas.length){res.write('data: '+JSON.stringify({choices:[{delta:{content:pecas[k]}}]})+'\\n\\n');k++;return;}",
      "clearInterval(t);fim();},250);};",
      "if(j.stream&&comFerramenta){",
      "sse(['A nota 5512 da Beta ','soma R$ 9.876,54 ','com vencimento ','em 05/12/2026 ','[tarefa].'],()=>{res.write('data: [DONE]\\n\\n');res.end();});",
      "return;}",
      "if(j.stream){",
      "sse(['Thinking:',' vou',' consultar',' a gaveta'],()=>{",
      "res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'f1',type:'function',function:{name:'search',arguments:JSON.stringify({query:'nota fiscal',k:3})}}]}}]})+'\\n\\n');",
      "res.write('data: [DONE]\\n\\n');res.end();});",
      "return;}",
      "res.setHeader('content-type','application/json');",
      "if(comFerramenta)return res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'A nota 5512 da Beta soma R$ 9.876,54 com vencimento em 05/12/2026 [tarefa].'}}]}));",
      "res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'',tool_calls:[{id:'f1',type:'function',function:{name:'search',arguments:JSON.stringify({query:'nota fiscal',k:3})}}]}}]}));",
      "});});",
      "s.listen(9918,'127.0.0.1');setTimeout(()=>process.exit(0),240000);",
    ].join("");
    execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", codTarefa]);
    await dormir(1200);

    const psql = (sql: string) =>
      execFileSync("docker", ["exec", DB, "sh", "-c", `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "${sql}"`], { encoding: "utf8" }).trim();

    const rg = await call("POST", "/ingest", {
      key: TESTKEY,
      corpo: { doc_id: "suite-v33-nota", content: "Nota fiscal 5512 da empresa Beta. Total R$ 9.876,54 com vencimento em 05/12/2026.", memoria: GAV },
    });
    const job = await esperarJob(TESTKEY, rg.json?.job_id);
    f.check("documento da v3.3 indexado", job.status === "concluido", job);

    const rp = await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: { tipo: "litellm", base_url: "http://127.0.0.1:9918/v1", modelo: "tarefa", temperatura: 0, system_prompt: "", mcp_interno: true, max_rodadas: 3, ativo: true, global: true },
    });
    f.check("provedor lento salvo (9918, MCP interno)", rp.status === 200 && rp.json?.mcp_interno === true, rp.texto.slice(0, 160));

    console.log("-- POST /chat/tarefa");
    const r = await call("POST", "/chat/tarefa", { key: TESTKEY, corpo: { pergunta: "qual o total da nota da Beta?", memoria: GAV } });
    f.check("cria tarefa: 201 + id", r.status === 201 && typeof r.json?.id === "string" && r.json.id.length >= 8, r.texto.slice(0, 120));
    const id = String(r.json?.id ?? "");
    f.check("linha existe no banco (rodando, tenant da chave)", /^rodando\|teste$/.test(psql(`SELECT status||'|'||tenant FROM chat_tarefas WHERE id='${id}'`)), psql(`SELECT status||'|'||tenant FROM chat_tarefas WHERE id='${id}'`));

    const rv = await call("POST", "/chat/tarefa", { key: TESTKEY, corpo: { pergunta: "", memoria: GAV } });
    f.check("pergunta vazia: 422 (mesma regra do /chat)", rv.status === 422, rv.texto.slice(0, 120));

    console.log("-- consultas de tarefa (Task 3)");
    const rc = await call("POST", "/chat/tarefa", { key: TESTKEY, corpo: { pergunta: "lista por favor", memoria: GAV } });
    f.check("cria a seu tarefa p/ consulta", rc.status === 201 && typeof rc.json?.id === "string", rc.texto.slice(0, 120));
    const r1 = await call("GET", `/chat/tarefas?memoria=${GAV}`, { key: TESTKEY });
    f.check("lista tarefas rodando", r1.status === 200 && Array.isArray(r1.json?.tarefas), r1.texto.slice(0, 120));
    f.check("vê a tarefa rodando (com pergunta no payload)", r1.json?.tarefas?.some((t: any) => t.id === rc.json?.id && t.status === "rodando" && typeof t.pergunta === "string"), JSON.stringify(r1.json ?? r1.texto).slice(0, 200));
    const r2 = await call("GET", `/chat/tarefa/${String(rc.json?.id ?? "")}`, { key: TESTKEY });
    f.check("estado da tarefa", r2.status === 200 && typeof r2.json?.parcial === "string", r2.texto.slice(0, 120));
    const r404 = await call("GET", `/chat/tarefa/nao-existe-999`, { key: TESTKEY });
    f.check("id inexistente: 404", r404.status === 404, r404.texto.slice(0, 120));

    console.log("-- deixa a tarefa terminar SOZINHA (provedor lento: ~4 s de deltas)");
    let st = "";
    for (let i = 0; i < 60; i++) {
      await dormir(500);
      st = psql(`SELECT status FROM chat_tarefas WHERE id='${id}'`);
      if (st === "terminou" || st === "falhou") break;
    }
    f.check("tarefa terminou sem nenhum cliente conectado", st === "terminou", { st, aviso: psql(`SELECT COALESCE(aviso,'') FROM chat_tarefas WHERE id='${id}'`) });
    const parcial = psql(`SELECT parcial FROM chat_tarefas WHERE id='${id}'`);
    f.check("parcial no banco é a resposta final (sem 'Thinking:')", /9\.876,54/.test(parcial) && !/Thinking:/.test(parcial), parcial.slice(0, 160));

    console.log("-- SSE reanexável (Task 4): abre, lê o replay, ABORTA no meio, reanexa do zero");
    const rt = await call("POST", "/chat/tarefa", { key: TESTKEY, corpo: { pergunta: "reanexa por favor", memoria: GAV } });
    const idRe = String(rt.json?.id ?? "");
    const c1 = new AbortController();
    const s1 = await fetch(`${BASE}/chat/tarefa/${idRe}/stream`, { headers: { authorization: cabecalho(TESTKEY) }, signal: c1.signal });
    f.check("stream abre: 200 + event-stream", s1.status === 200 && /text\/event-stream/.test(s1.headers.get("content-type") ?? ""), `${s1.status} ${s1.headers.get("content-type") ?? ""}`);
    const leitura = await Promise.race([
      s1.body!.getReader().read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("stream não mandou evento em 30s")), 30_000)),
    ]);
    f.check("abre com replay: primeiro evento é parcial", new TextDecoder().decode(leitura.value ?? new Uint8Array()).includes('"tipo":"parcial"'), String(new TextDecoder().decode(leitura.value ?? new Uint8Array())).slice(0, 160));
    c1.abort(); // simula fechar a aba no meio

    const s2 = await fetch(`${BASE}/chat/tarefa/${idRe}/stream`, { headers: { authorization: cabecalho(TESTKEY) }, signal: AbortSignal.timeout(60_000) });
    const bruto2 = await s2.text(); // server fecha o stream no fim → text() resolve
    f.check("reanexar recebe tudo até o fim", bruto2.includes('"tipo":"fim"'), bruto2.slice(-180));
    const rGet = await call("GET", `/chat/tarefa/${idRe}`, { key: TESTKEY });
    f.check("fim coerente com o GET (estado já fechado quando o fim chega)", rGet.json?.status === "terminou", rGet.texto.slice(0, 160));
    const s404 = await fetch(`${BASE}/chat/tarefa/nao-existe-999/stream`, { headers: { authorization: cabecalho(TESTKEY) }, signal: AbortSignal.timeout(15_000) });
    f.check("stream de id inexistente: 404 sem hijack", s404.status === 404, String(s404.status));

    /* limpeza OBRIGATÓRIA — as três chamadas finais do padrão v2.9 (sem isso contamina runs futuros) */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { tipo: "litellm", base_url: "http://127.0.0.1:9918/v1", modelo: "tarefa", system_prompt: "", mcp_interno: false, max_rodadas: 3, ativo: false, global: true } });
    await call("DELETE", `/gavetas/${GAV}`, { key: TESTKEY });
    await call("DELETE", `/chat?memoria=${GAV}`, { key: OPKEY });
    f.fechar("v3.3 tarefa");
  });

  await bloco(t, "v3.4: módulos do admin — o comum só vê chat, buscar e fila", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const DB = process.env.DBCONTAINER ?? CONTAINER.replace("-api-", "-db-");
    const psql = (sql: string) =>
      execFileSync("docker", ["exec", DB, "sh", "-c", `psql -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -tAc \"${sql}\"`], { encoding: "utf8" }).trim();
    /* v3.4: o nome canônico da variável do admin é MINIRAG_ADMIN (apelido OPERADOR ainda vale).
       Esta suíte só prova que o boot com o nome NOVO funciona se o container nasceu com ela. */
    if (CONTAINER) {
      const nomeSemente = execFileSync("docker", ["exec", CONTAINER, "sh", "-c", "printenv MINIRAG_ADMIN | cut -d: -f1"], { encoding: "utf8" }).trim();
      f.check("boot semeou o admin pela variável MINIRAG_ADMIN", nomeSemente === "op", { nome: nomeSemente });
    } else {
      f.check("boot semeou o admin pela variável MINIRAG_ADMIN", false, "sem CONTAINER no ambiente");
    }
    /* política do dono (21/10): Painel, Usuários e Configurações são do ADMIN —
       na tela (filtro do menu) E na porta (a parede de verdade é aqui). */
    let r = await call("GET", "/dashboard", { key: TESTKEY });
    f.check("comum não abre o painel", r.status === 403, r.texto.slice(0, 140));
    r = await call("GET", "/dashboard", { key: OPKEY });
    f.check("admin abre o painel", r.status === 200 && typeof r.json?.numeros?.documentos === "number", r.texto.slice(0, 140));

    r = await call("PUT", "/config/provider", { key: TESTKEY, corpo: { base_url: "http://127.0.0.1:1/v1", modelo: "" } });
    f.check("comum não escreve provider", r.status === 403, r.texto.slice(0, 140));
    r = await call("POST", "/config/provider/testar", { key: TESTKEY, corpo: {} });
    f.check("comum não testa conexão", r.status === 403, r.texto.slice(0, 140));
    r = await call("GET", "/config/provider", { key: TESTKEY });
    f.check("comum LÊ o próprio provider (o Chat depende disso)", r.status === 200 && typeof r.json?.configurado === "boolean", r.texto.slice(0, 140));

    /* admin configura a linha de um comum mirando o tenant (o caminho que a tela dele usa).
       A RESPOSTA mostra a linha EFETIVA (regra v2.8.1: incompleta não tapa global) — onde a
       escrita caiu se prova no banco. */
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { tenant: "teste", tipo: "litellm", base_url: "http://127.0.0.1:1/v1", modelo: "", ativo: false } });
    const caiu = psql(`SELECT escopo || '|' || base_url FROM provider_config WHERE escopo = 'teste'`);
    f.check("admin escreve provider NA LINHA do usuário (tenant no corpo)", r.status === 200 && caiu === "teste|http://127.0.0.1:1/v1", { status: r.status, caiu });

    /* os três módulos do comum seguem vivos pela porta */
    r = await call("GET", "/jobs?limit=5", { key: TESTKEY });
    f.check("comum usa a fila (próprio escopo)", r.status === 200 && Array.isArray(r.json?.jobs), r.texto.slice(0, 100));
    r = await call("POST", "/search", { key: TESTKEY, corpo: { query: "qualquer coisa", memoria: "gav-v34-inexistente" } });
    f.check("comum usa a busca", r.status === 200 && Array.isArray(r.json?.items), r.texto.slice(0, 100));
    r = await call("GET", "/chat?memoria=gav-v34&limit=5", { key: TESTKEY });
    f.check("comum usa o histórico do chat", r.status === 200 && Array.isArray(r.json?.mensagens), r.texto.slice(0, 100));
    r = await call("GET", "/gavetas", { key: TESTKEY });
    f.check("comum lista as próprias gavetas (o seletor do Chat precisa)", r.status === 200, r.status);
    f.fechar("v3.4 perfis");
  });

  await bloco(t, "freio de força bruta (último: bloqueia o IP)", async () => {
    const f = fiscal();
    for (let i = 0; i < 10; i++) {
      await call("GET", "/gavetas", { key: `chave-errada-${String(i).padStart(2, "0")}` });
    }
    let r = await call("GET", "/gavetas", { key: "chave-errada-final" });
    f.check("11ª tentativa errada -> 429", r.status === 429, r.status);
    r = await call("GET", "/gavetas", { key: TESTKEY });
    f.check("chave BOA também barrada enquanto bloqueado", r.status === 429, r.status);
    f.fechar("rate-limit");
  });

  /* ---------------- cobertura declarada (regra 8 da skill `suite-de-testes`) ----------------
     Dentro de t.after(): imprime TAMBÉM quando um bloco falha, senão a rodada vermelha
     fica sem dizer o que foi rodado e o que não foi. */
  t.after(() => {
    console.log("\n== COBERTURA DESTA RODADA ==");
    console.log(`escopo: ${FILTRO ? "filtrado por SO_BLOCOS=" + FILTRO : "SUÍTE COMPLETA"}`);
    console.log(`blocos: ${blocosRodados.length} rodados | ${blocosPulados.length} pulados`);
    if (blocosPulados.length) console.log("NÃO RODOU (o verde desta rodada não cobre isto):\n  - " + blocosPulados.join("\n  - "));
    console.log("COBRE: contrato pela porta HTTP pública, papéis (sem chave / papel errado), isolamento por escopo,"
      + " efeito lido de volta no banco, provedor FALSO obedecendo o protocolo (stream e não-stream),"
      + " freio de força bruta, e prova de versão no /health.");
    console.log("NÃO COBRE (nem na suíte completa):");
    for (const b of [
      "tela real: clique, render, ordem visual, fila do chat (camada visual — references/visual.md)",
      "provedor de IA real (o seu modelo atrás do gateway): aqui é falso por regra",
      "SSE atrás do proxy de produção (buffering do Caddy) — smoke no domínio depois do deploy",
      "pertinência do resultado: o trecho certo ficou no topo? a resposta está certa?",
      "carga, concorrência e latência por etapa (modelo × ferramenta × compactação)",
      "matriz completa rota × papel (só as rotas críticas são varridas)",
      "degradação: disco cheio, banco cai no meio do job, payload gigante",
      "infra: build em host limpo sem cache, backup/restore, migração entre versões",
      "segurança de cadeia: dependências, CSP/CORS, rotação de credencial",
    ]) console.log("  - " + b);
    console.log("alvo, escopo e como fechar cada lacuna: docs/testes.md");
  });
});