/* Minirag painel v2.0 — SPA tipada, falando a REST do próprio serviço.
   Sessão em sessionStorage com prazo de 12h. Nada de segredo em disco. */
"use strict";

/* ------------------------------------------------------------------ tipos */

type Gaveta = {
  tenant: string; memoria: string; chunks: number; docs: number;
  chunks_arquivados: number; primeiro_ingress: string | null; ultimo_ingress: string | null;
};
type GavetasResp = { operador: boolean; gavetas: Gaveta[]; documentos_fonte: number };

type DocItem = {
  doc_id: string; title: string; chunks: number; updated_at: string | null;
  chunks_arquivados: number;
};
type DocsResp = { tenant: string; memoria: string; total: number; docs: DocItem[] };

type Hit = {
  rank: number; score: number; chunk_id: number; doc_id: string;
  title: string; text: string; arquivado: boolean;
};
type SearchResp = { tenant: string; memoria: string; items: Hit[]; total: number };

type Job = {
  job_id: number; tenant: string; memoria: string; doc_id: string; title: string;
  status: string; chunks_total: number; chunks_feitos: number; erro: string | null;
  criado_em: string | null; finalizado_em: string | null;
};
type JobsResp = { resumo_por_status: Record<string, number>; jobs: Job[] };

type DocCompleto = {
  tenant: string; memoria: string; doc_id: string; title: string | null;
  content: string; size_bytes: number; origem: string;
  criado_em: string | null; atualizado_em: string | null;
};

type JobStatus = { job_id: number; status: string; chunks_feitos: number; chunks_total: number; erro: string | null };
type DecayResp = { arquivados_agora: number; docs_arquivados_agora: number; ativos: number; arquivados: number };

/* ---------------------------------------------------------------- helpers */

const $ = (s: string): any => document.querySelector(s);
const $$ = (s: string): any[] => [...document.querySelectorAll(s)];
const TTL_MS = 12 * 3600 * 1000; // sessão expira em 12h

const estado = {
  nome: sessionStorage.getItem("mr_nome") || "",
  key: sessionStorage.getItem("mr_key") || "",
  operador: sessionStorage.getItem("mr_op") === "1",
  tenant: sessionStorage.getItem("mr_tenant") || "",
  memoria: sessionStorage.getItem("mr_mem") || "",
  doc: null as string | null,
  novo: false,
  dirty: false,
  job: null as number | null,
  tFiltro: null as ReturnType<typeof setTimeout> | null,
};

async function api<T = any>(caminho: string, opts: RequestInit = {}): Promise<T> {
  const hdr: Record<string, string> = { Authorization: "B" + "earer " + estado.key };
  if (opts.body !== undefined) hdr["Content-Type"] = "application/json";
  const r = await fetch(caminho, { ...opts, headers: { ...hdr, ...(opts.headers as any) } });
  if (r.status === 401) { sair("segredo recusado — verifique nome e chave"); throw new Error("401"); }
  if (r.ok) {
    const ct = r.headers.get("content-type") || "";
    return (ct.includes("json") ? await r.json() : await r.text()) as T;
  }
  let detalhe = r.status + " " + r.statusText;
  try { const j = await r.json(); if (j.detail) detalhe = j.detail; } catch { /* corpo não-JSON */ }
  throw new Error(detalhe);
}

async function comAuthBaixar(caminho: string, nomeArquivo: string): Promise<void> {
  const r = await fetch(caminho, { headers: { Authorization: "B" + "earer " + estado.key } });
  if (!r.ok) throw new Error("download: HTTP " + r.status);
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nomeArquivo; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function toast(msg: string, ms = 3500): void {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("ver");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("ver"), ms);
}

const fmtData = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso), agora = new Date();
  const dia = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dif = Math.round((dia(agora) - dia(d)) / 86400000);
  const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (dif === 0) return "hoje " + hora;
  if (dif === 1) return "ontem " + hora;
  if (dif > 1 && dif < 7) return `há ${dif} dias`;
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
};
const onde = () => `${estado.tenant || "—"} : ${estado.memoria || "(padrão)"}`;
const qs = (o: Record<string, unknown>) => Object.entries(o)
  .filter(([, v]) => v !== undefined && v !== null && v !== "")
  .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

/* ------------------------------------------------------------------ views */

function mostrar(nome: string): void {
  $$("main section").forEach((s: any) => (s.hidden = true));
  $("#v" + nome.charAt(0).toUpperCase() + nome.slice(1)).hidden = false;
  $$(".aba").forEach((b: any) => b.classList.toggle("ativa", b.dataset.view === nome));
}
$$(".aba").forEach((b: any) =>
  b.addEventListener("click", () => { mostrar(b.dataset.view); (REC as any)[b.dataset.view](); }));
const REC: Record<string, () => void> = {
  gavetas: () => { void carregarGavetas(); },
  arquivos: () => { void carregarDocs(); },
  buscar: () => {},
  jobs: () => { void carregarJobs(); },
  editor: () => {},
};

/* ------------------------------------------------------------------ login */

function guardarEscopo(): void {
  sessionStorage.setItem("mr_tenant", estado.tenant);
  sessionStorage.setItem("mr_mem", estado.memoria);
}

async function entrar(ev?: Event): Promise<void> {
  if (ev) ev.preventDefault();
  const nome = $("#loginNome").value.trim(), key = $("#loginKey").value.trim();
  if (!nome || !key) { $("#loginErro").textContent = "preencha nome e segredo"; return; }
  estado.key = key;
  $("#btnEntrar").disabled = true;
  try {
    const g = await api<GavetasResp>("/gavetas");
    estado.nome = nome; estado.operador = !!g.operador;
    estado.tenant = nome; estado.memoria = "";
    sessionStorage.setItem("mr_nome", nome);
    sessionStorage.setItem("mr_key", key);
    sessionStorage.setItem("mr_op", g.operador ? "1" : "0");
    sessionStorage.setItem("mr_ts", String(Date.now()));
    guardarEscopo(); aposLogin();
  } catch (e) {
    if ((e as Error).message !== "401") $("#loginErro").textContent = (e as Error).message;
  } finally { $("#btnEntrar").disabled = false; }
}

function aposLogin(): void {
  document.body.classList.remove("fora");
  $("#loginErro").textContent = "";
  $("#vLogin").hidden = true;
  $("#nav").hidden = false; $("#userbox").hidden = false; $("#rodape").hidden = false;
  $("#quo").textContent = estado.nome;
  $("#chipEscopo").innerHTML = estado.operador
    ? '<span class="chip op">operador · vê tudo</span>'
    : '<span class="chip">tenant</span>';
  api<{ versao?: string }>("/health").then((h) => ($("#ver").textContent = "versão " + (h.versao || "?"))).catch(() => {});
  mostrar("gavetas"); void carregarGavetas();
}

function sair(msg: string): void {
  if (estado.dirty && !confirm("há edição não salva — sair mesmo assim?")) return;
  estado.dirty = false;
  sessionStorage.clear();
  document.body.classList.add("fora");
  $("#abaEditor").hidden = true;
  $("#nav").hidden = true; $("#userbox").hidden = true; $("#rodape").hidden = true;
  $("#vLogin").hidden = false;
  $$("main section").forEach((s: any) => (s.hidden = s.id !== "vLogin"));
  $("#loginKey").value = "";
  if (msg) $("#loginErro").textContent = msg;
}

$("#formLogin").addEventListener("submit", entrar);
$("#btnSair").addEventListener("click", () => sair(""));
$("#btnOlho").addEventListener("click", () => {
  const c = $("#loginKey"), b = $("#btnOlho");
  const oculto = c.type === "password";
  c.type = oculto ? "text" : "password";
  b.textContent = oculto ? "ocultar" : "ver";
  b.setAttribute("aria-label", oculto ? "ocultar segredo" : "mostrar segredo");
  c.focus();
});
window.addEventListener("beforeunload", (e) => {
  if (estado.dirty) { e.preventDefault(); e.returnValue = ""; }
});

/* ---------------------------------------------------------------- gavetas */

async function carregarGavetas(): Promise<void> {
  const grid = $("#gavetasGrid");
  grid.innerHTML = '<p class="dica">carregando…</p>';
  try {
    const g = await api<GavetasResp>("/gavetas");
    $("#gavetasInfo").textContent =
      `${g.gavetas.length} gaveta(s) · ${g.documentos_fonte} documento(s) com fonte guardada`;
    grid.innerHTML = "";
    if (!g.gavetas.length) {
      grid.innerHTML = '<div class="vazio"><div class="tit">Nenhuma memória ainda</div>' +
        "Crie uma nota ou envie um arquivo na aba Arquivos.</div>";
      return;
    }
    for (const gav of g.gavetas) {
      const el = document.createElement("div");
      el.className = "gaveta";
      el.innerHTML = `<div class="nome"><span></span></div>
        <div class="nums"></div>
        <div class="acoesG">
          <button class="sutil mini g-x" title="baixar esta gaveta em zip">⬇ zip</button>
          <button class="perigo mini g-ap" title="apagar a gaveta inteira">apagar</button>
        </div>`;
      el.querySelector(".nome span")!.textContent =
        (g.operador ? gav.tenant + " ▸ " : "") + (gav.memoria || "(padrão)");
      el.querySelector(".nums")!.innerHTML =
        `<span><b>${gav.docs}</b> arquivo(s)</span>` +
        `<span><b>${gav.chunks}</b> chunks</span>` +
        `<span>${gav.chunks_arquivados ? gav.chunks_arquivados + " arquiv." : "tudo ativo"}</span>` +
        `<span>último ${fmtData(gav.ultimo_ingress)}</span>`;
      el.addEventListener("click", () => {
        estado.tenant = gav.tenant; estado.memoria = gav.memoria;
        guardarEscopo(); mostrar("arquivos"); void carregarDocs();
      });
      el.querySelector(".g-x")!.addEventListener("click", (ev) => {
        ev.stopPropagation(); void exportarGaveta(gav.tenant, gav.memoria);
      });
      el.querySelector(".g-ap")!.addEventListener("click", (ev) => {
        ev.stopPropagation(); void apagarGaveta(gav.tenant, gav.memoria, gav.docs);
      });
      grid.appendChild(el);
    }
  } catch (e) { grid.innerHTML = ""; toast("gavetas: " + (e as Error).message); }
}

$("#btnAtualizarGav").addEventListener("click", () => void carregarGavetas());
$("#btnDecay").addEventListener("click", async () => {
  const alvo = estado.operador ? "TODOS os tenants (global)" : `só o tenant ${estado.nome}`;
  if (!confirm("Rodar decay agora sobre " + alvo + "?")) return;
  try {
    const r = await api<DecayResp>("/decay", { method: "POST", body: JSON.stringify({}) });
    toast(`decay: ${r.docs_arquivados_agora} doc(s) arquivados agora · ` +
          `ativos ${r.ativos} · arquivados ${r.arquivados}`);
    void carregarGavetas();
  } catch (e) { toast("decay: " + (e as Error).message); }
});

async function exportarGaveta(tenant: string, memoria: string): Promise<void> {
  try {
    const nome = (memoria || "gaveta").replace(/[^\w.-]/g, "_") + ".zip";
    await comAuthBaixar(`/gavetas/${encodeURIComponent(memoria)}/export.zip?` +
      qs({ tenant: estado.operador ? tenant : undefined }), nome);
    toast("zip gerado ✓");
  } catch (e) { toast((e as Error).message); }
}

async function apagarGaveta(tenant: string, memoria: string, docs: number | string): Promise<void> {
  const rotulo = (estado.operador ? tenant + " ▸ " : "") + (memoria || "(padrão)");
  if (!confirm(`APAGAR a gaveta ${rotulo} inteira (${docs} arquivo(s), chunks, fontes e jobs na fila)?`)) return;
  if (!confirm("Tem certeza? Isso NÃO tem como desfazer no painel.")) return;
  try {
    const r = await api<any>(`/gavetas/${encodeURIComponent(memoria)}?` +
      qs({ tenant: estado.operador ? tenant : undefined }), { method: "DELETE" });
    toast(`gaveta apagada: ${r.chunks_apagados} chunks, ${r.fontes_apagadas} fontes`);
    if (estado.memoria === memoria && estado.tenant === tenant) { estado.memoria = ""; guardarEscopo(); }
    void carregarGavetas();
  } catch (e) { toast((e as Error).message); }
}
$("#btnApagarGaveta").addEventListener("click", () => void apagarGaveta(estado.tenant, estado.memoria, "?"));

/* --------------------------------------------------------------- arquivos */

async function carregarDocs(): Promise<void> {
  if (!estado.tenant) { toast("escolha uma gaveta primeiro"); mostrar("gavetas"); return; }
  $("#arqOnde").textContent = "— " + onde();
  $("#arqTotal").textContent = "";
  const tb = $("#arqTabela tbody");
  tb.innerHTML = '<tr class="linha-carregando"><td colspan="6">carregando…</td></tr>';
  try {
    const d = await api<DocsResp>("/docs?" + qs({
      memoria: estado.memoria, tenant: estado.tenant,
      include_archived: $("#arqMostrarArq").checked ? "true" : "",
      q: $("#arqFiltro").value.trim(), limit: 500,
    }));
    tb.innerHTML = "";
    $("#arqTotal").textContent = `${d.total} arquivo(s)`;
    if (!d.docs.length) {
      tb.innerHTML = '<tr class="linha-vazia"><td colspan="6">' +
        ($("#arqFiltro").value.trim() ? "nenhum arquivo com esse filtro</td></tr>"
          : "gaveta vazia — use <b>nova nota</b> ou arraste arquivos acima</td></tr>");
      return;
    }
    for (const doc of d.docs) {
      const arquivado = doc.chunks_arquivados > 0;
      const tr = document.createElement("tr");
      if (arquivado) tr.className = "arquivado";
      tr.innerHTML = `<td></td>
        <td data-rot="doc_id"><span class="tcode"></span></td>
        <td data-rot="estado"><span class="tag"></span></td>
        <td class="num" data-rot="chunks"></td>
        <td data-rot="atualizado"></td>
        <td class="acoes"><span class="acoes-linha"></span></td>`;
      tr.children[0].textContent = doc.title || "(sem título)";
      tr.querySelector(".tcode")!.textContent = doc.doc_id;
      const tag = tr.querySelector(".tag")!;
      tag.classList.add(arquivado ? "arquivado" : "ativo");
      tag.textContent = arquivado ? "arquivado" : "ativo";
      tr.children[3].textContent = String(doc.chunks);
      tr.children[4].textContent = fmtData(doc.updated_at);
      const ac = tr.querySelector(".acoes-linha")!;
      const bt = (rotulo: string, classe: string, titulo: string, fn: () => void) => {
        const b = document.createElement("button");
        b.textContent = rotulo; b.className = classe;
        b.title = titulo; b.setAttribute("aria-label", titulo);
        b.addEventListener("click", fn);
        ac.appendChild(b);
        return b;
      };
      bt("abrir", "a-br", "abrir no editor", () => void abrirEditor(doc.doc_id));
      bt("baixar", "", "baixar o arquivo original",
        () => void comAuthBaixar(`/documents/${encodeURIComponent(doc.doc_id)}/raw?` +
          qs({ memoria: estado.memoria, tenant: estado.tenant }),
          doc.doc_id.replace(/[^\w.-]/g, "_") + ".txt").catch((e) => toast((e as Error).message)));
      bt("⧉", "", "copiar o doc_id",
        () => void navigator.clipboard.writeText(doc.doc_id).then(
          () => toast("doc_id copiado ✓"), () => toast("copiar falhou — " + doc.doc_id)));
      bt(arquivado ? "reviver" : "arquivar",
        arquivado ? "reviver" : "arquivar",
        arquivado ? "voltar a usar este documento" : "tirar da memória ativa (sem apagar)",
        async () => {
          try {
            await api(`/documents/${encodeURIComponent(doc.doc_id)}/arquivado?` +
              qs({ memoria: estado.memoria }), { method: "PATCH",
              body: JSON.stringify({ arquivado: !arquivado,
                tenant: estado.operador ? estado.tenant : undefined }) });
            toast(arquivado ? "documento revivido ✓" : "documento arquivado ✓");
            void carregarDocs();
          } catch (e) { toast((e as Error).message); }
        });
      bt("apagar", "apagar", "apagar para sempre (chunks + fonte)",
        async () => {
          if (!confirm(`APAGAR definitivamente "${doc.doc_id}" (${doc.chunks} chunks + fonte)?`)) return;
          try {
            const r = await api<any>(`/docs/${encodeURIComponent(doc.doc_id)}?` +
              qs({ memoria: estado.memoria, tenant: estado.operador ? estado.tenant : undefined }),
              { method: "DELETE" });
            toast(`apagado: ${r.chunks_apagados} chunks` + (r.fonte_apagada ? " + fonte" : ""));
            void carregarDocs();
          } catch (e) { toast((e as Error).message); }
        });
      tb.appendChild(tr);
    }
  } catch (e) { tb.innerHTML = ""; toast("docs: " + (e as Error).message); }
}

$("#arqMostrarArq").addEventListener("change", () => void carregarDocs());
$("#arqFiltro").addEventListener("input", () => {
  if (estado.tFiltro) clearTimeout(estado.tFiltro);
  estado.tFiltro = setTimeout(() => void carregarDocs(), 350);
});
$("#btnNovaNota").addEventListener("click", () => {
  const box = $("#novaNotaBox");
  box.hidden = !box.hidden;
  if (!box.hidden) {
    $("#novaNotaNome").value = "nota-" + new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
    $("#novaNotaNome").focus(); $("#novaNotaNome").select();
  }
});
$("#btnCancelarNota").addEventListener("click", () => { $("#novaNotaBox").hidden = true; });
$("#btnCriarNota").addEventListener("click", () => {
  const nome = $("#novaNotaNome").value.trim().replace(/\s+/g, "-");
  if (!nome) { toast("dê um nome à nota"); return; }
  $("#novaNotaBox").hidden = true;
  void abrirEditor(null, nome);
});
$("#novaNotaNome").addEventListener("keydown", (e: KeyboardEvent) =>
  e.key === "Enter" && $("#btnCriarNota").click());
$("#btnExport").addEventListener("click", () => void exportarGaveta(estado.tenant, estado.memoria));

async function subirArquivos(lista: File[]): Promise<void> {
  if (!lista || !lista.length) return;
  mostrar("arquivos");
  let ok = 0, falha = 0;
  for (const f of lista) {
    try {
      const texto = await f.text();
      const r = await api<any>("/ingest", { method: "POST", body: JSON.stringify({
        doc_id: f.name, title: f.name, content: texto, memoria: estado.memoria,
        tenant: estado.operador ? estado.tenant : undefined }) });
      ok++;
      toast(`⬆ ${f.name}: na fila (job ${r.job_id}, ${r.chunks_total} chunk[s])`, 2500);
    } catch (e) { falha++; toast(`⬆ ${f.name}: ${(e as Error).message}`, 5000); }
  }
  if (lista.length > 1) toast(`upload: ${ok} enviado(s), ${falha} com erro`, 5000);
  void carregarDocs();
}

$("#arquivoInput").addEventListener("change", async (ev: Event) => {
  const alvo = ev.target as HTMLInputElement;
  const lista = Array.from(alvo.files || []);
  alvo.value = "";
  await subirArquivos(lista);
});
const dz = $("#dropzone");
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e: DragEvent) => {
  e.preventDefault(); dz.classList.add("hot");
}));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e: DragEvent) => {
  e.preventDefault(); dz.classList.remove("hot");
}));
dz.addEventListener("drop", (e: DragEvent) => void subirArquivos(Array.from(e.dataTransfer?.files || [])));
dz.addEventListener("click", () => $("#arquivoInput").click());

/* ----------------------------------------------------------------- editor */

function marcarDirty(): void {
  estado.dirty = true;
  $("#edStatus").innerHTML = '<span class="ponto"></span>não salvo';
}
function contarPalavras(): void {
  const t = $("#edConteudo").value.trim();
  $("#edConta").textContent = (t ? t.split(/\s+/).length : 0) + " palavras";
}
$("#edConteudo").addEventListener("input", () => { marcarDirty(); contarPalavras(); });
$("#edTitulo").addEventListener("input", marcarDirty);

async function abrirEditor(docId: string | null, novoNome?: string): Promise<void> {
  estado.doc = docId || novoNome || null;
  estado.novo = !docId;
  estado.dirty = false;
  $("#edRenameBox").hidden = true;
  $("#edPreview").hidden = true;
  $("#edConteudo").hidden = false;
  $("#btnPreview").textContent = "prévia";
  $("#abaEditor").hidden = false; mostrar("editor");
  $("#edOnde").textContent = "— " + onde() + " · " + (estado.doc || "");
  if (estado.novo) {
    $("#edTitulo").value = estado.doc;
    $("#edConteudo").value = "";
    $("#edStatus").textContent = "nota nova";
    $("#btnSalvar").textContent = "criar & reindexar";
    $("#btnRenomear").disabled = true;
  } else {
    $("#btnSalvar").textContent = "salvar & reindexar";
    $("#btnRenomear").disabled = false;
    $("#edStatus").textContent = "carregando…";
    try {
      const d = await api<DocCompleto>(`/documents/${encodeURIComponent(docId as string)}?` +
        qs({ memoria: estado.memoria, tenant: estado.tenant }));
      $("#edTitulo").value = d.title || "";
      $("#edConteudo").value = d.content;
      $("#edStatus").textContent = `fonte ${d.origem} · ${d.size_bytes} bytes · ` +
        `atualizado ${fmtData(d.atualizado_em)}`;
    } catch (e) {
      $("#edStatus").textContent = "";
      $("#edConteudo").value = "";
      toast("sem fonte para abrir: " + (e as Error).message);
    }
  }
  contarPalavras();
  $("#edConteudo").focus();
}

function fecharEditor(): void {
  if (estado.dirty && !confirm("descartar a edição não salva?")) return;
  estado.dirty = false;
  $("#abaEditor").hidden = true;
  mostrar("arquivos"); void carregarDocs();
}
$("#btnCancelarEd").addEventListener("click", fecharEditor);

$("#btnSalvar").addEventListener("click", async () => {
  if (!estado.doc) return;
  const conteudo = $("#edConteudo").value;
  if (!conteudo.trim()) { toast("conteúdo vazio"); return; }
  const titulo = $("#edTitulo").value || null;
  try {
    let r: any;
    if (estado.novo) {
      r = await api<any>("/ingest", { method: "POST", body: JSON.stringify({
        doc_id: estado.doc, title: titulo || estado.doc, content: conteudo,
        memoria: estado.memoria, tenant: estado.operador ? estado.tenant : undefined }) });
      estado.novo = false;
      $("#btnSalvar").textContent = "salvar & reindexar";
      $("#btnRenomear").disabled = false;
    } else {
      r = await api<any>(`/documents/${encodeURIComponent(estado.doc)}?` +
        qs({ memoria: estado.memoria }), { method: "PUT", body: JSON.stringify({
          content: conteudo, title: titulo, memoria: estado.memoria,
          tenant: estado.operador ? estado.tenant : undefined }) });
    }
    estado.dirty = false;
    void acompanhar(r.job_id);
  } catch (e) { toast("salvar: " + (e as Error).message); }
});

async function acompanhar(jobId: number): Promise<void> {
  $("#btnSalvar").disabled = true;
  for (let i = 0; i < 400; i++) {
    let st: JobStatus;
    try { st = await api<JobStatus>(`/ingest/${jobId}?` + qs({ tenant: estado.operador ? estado.tenant : "" })); }
    catch { break; }
    $("#edStatus").textContent = `reindexando ${st.chunks_feitos}/${st.chunks_total} · ${st.status}`;
    if (st.status === "concluido") { $("#edStatus").textContent = "salvo e reindexado ✓"; toast("salvo e reindexado ✓"); break; }
    if (st.status === "erro") { toast("job com erro: " + (st.erro || "?")); break; }
    if (st.status === "cancelado") break;
    await new Promise((res) => setTimeout(res, 3000));
  }
  $("#btnSalvar").disabled = false;
}

$("#btnRenomear").addEventListener("click", () => {
  const box = $("#edRenameBox");
  box.hidden = !box.hidden;
  if (!box.hidden) { $("#edNovoId").value = ""; $("#edNovaGaveta").value = ""; $("#edNovoId").focus(); }
});
$("#btnFecharRename").addEventListener("click", () => { $("#edRenameBox").hidden = true; });
$("#btnAplicarRename").addEventListener("click", async () => {
  if (!estado.doc) return;
  const novo = $("#edNovoId").value.trim(), dest = $("#edNovaGaveta").value.trim();
  if (!novo && !dest) { toast("nada para mudar"); return; }
  try {
    const r = await api<any>(`/documents/${encodeURIComponent(estado.doc)}?` +
      qs({ memoria: estado.memoria }), { method: "PATCH", body: JSON.stringify({
        novo_doc_id: novo || null, destino_memoria: dest || null,
        tenant: estado.operador ? estado.tenant : undefined }) });
    toast(`ok: ${r.doc_id} → gaveta ${r.memoria || "(padrão)"}`);
    if (r.movido && r.memoria !== estado.memoria) {
      estado.dirty = false; $("#abaEditor").hidden = true;
      mostrar("arquivos"); void carregarDocs();
    } else {
      estado.doc = r.doc_id;
      $("#edOnde").textContent = "— " + onde() + " · " + r.doc_id;
      $("#edRenameBox").hidden = true;
    }
  } catch (e) { toast("renomear: " + (e as Error).message); }
});

$("#btnPreview").addEventListener("click", () => {
  const p = $("#edPreview"), ta = $("#edConteudo");
  if (!p.hidden) { p.hidden = true; ta.hidden = false; $("#btnPreview").textContent = "prévia"; return; }
  p.innerHTML = mdParaHtml(ta.value);
  p.hidden = false; ta.hidden = true;
  $("#btnPreview").textContent = "editar";
});

function mdParaHtml(txt: string): string {
  let s = esc(txt);
  s = s.replace(/^### (.*)$/gm, "<h3>$1</h3>")
       .replace(/^## (.*)$/gm, "<h2>$1</h2>")
       .replace(/^# (.*)$/gm, "<h1>$1</h1>")
       .replace(/```([\s\S]*?)```/g, (_m, c) => `<pre>${c}</pre>`)
       .replace(/`([^`]+)`/g, "<code>$1</code>")
       .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
       .replace(/\*([^*]+)\*/g, "<i>$1</i>")
       .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
       .replace(/^- (.*)$/gm, "• $1")
       .replace(/\n{2,}/g, "</p><p>")
       .replace(/\n/g, "<br>");
  return "<p>" + s + "</p>";
}

document.addEventListener("keydown", (e: KeyboardEvent) => {
  const noEditor = !$("#vEditor").hidden;
  if (e.key === "Escape" && noEditor) { e.preventDefault(); fecharEditor(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (noEditor) $("#btnSalvar").click();
  }
});

/* ----------------------------------------------------------------- buscar */

$("#busScore").addEventListener("input", () =>
  ($("#busScoreOut").textContent = Number($("#busScore").value).toFixed(2)));

$("#btnBuscar").addEventListener("click", async () => {
  const q = $("#busQuery").value.trim();
  if (!q) return;
  $("#busOnde").textContent = "— " + onde();
  $("#busResultado").innerHTML = '<p class="dica">buscando…</p>';
  const minScore = Number($("#busScore").value);
  try {
    const r = await api<SearchResp>("/search", { method: "POST", body: JSON.stringify({
      query: q, k: Number($("#busK").value) || 8, min_score: minScore,
      memoria: estado.memoria, include_archived: $("#busArq").checked,
      tenant: estado.operador ? estado.tenant : undefined }) });
    const box = $("#busResultado");
    box.innerHTML = "";
    const cab = document.createElement("p");
    cab.className = "dica";
    cab.textContent = `${r.total} resultado(s)` +
      ($("#busArq").checked ? " · arquivados achados foram revividos" : "");
    box.appendChild(cab);
    if (!r.total) {
      box.innerHTML += `<div class="vazio"><div class="tit">Nada acima de ${minScore.toFixed(2)}</div>` +
        "Baixe o score mínimo — o texto pode estar lá, só fora do corte.</div>";
      return;
    }
    for (const it of r.items) {
      const el = document.createElement("div");
      el.className = "hit";
      el.innerHTML = `<div class="topo-hit"><span class="score"></span>
        <b class="t"></b><span class="meta"></span>
        <button class="sutil mini abrir-doc">abrir</button></div><p class="x"></p>`;
      el.querySelector(".score")!.textContent = it.score.toFixed(3);
      el.querySelector(".t")!.textContent = it.title || it.doc_id;
      el.querySelector(".meta")!.textContent = it.doc_id +
        (it.arquivado ? " · estava arquivado" : "");
      el.querySelector(".x")!.textContent = it.text;
      el.querySelector(".abrir-doc")!.addEventListener("click", () => void abrirEditor(it.doc_id));
      box.appendChild(el);
    }
  } catch (e) { $("#busResultado").innerHTML = ""; toast("busca: " + (e as Error).message); }
});
$("#busQuery").addEventListener("keydown", (e: KeyboardEvent) =>
  e.key === "Enter" && $("#btnBuscar").click());

/* ------------------------------------------------------------------- jobs */

const TAG_JOB: Record<string, string> = { concluido: "ativo", erro: "erro", processando: "processando",
  na_fila: "fila", cancelado: "arquivado" };
const ROT_JOB: Record<string, string> = { concluido: "concluído" };

async function carregarJobs(): Promise<void> {
  const st = $("#jobStatus").value;
  const tb = $("#jobsTabela tbody");
  tb.innerHTML = '<tr class="linha-carregando"><td colspan="8">carregando…</td></tr>';
  try {
    const j = await api<JobsResp>("/jobs?" + qs({
      limit: 80, status: st, tenant: estado.operador ? estado.tenant : estado.nome }));
    $("#jobsInfo").textContent = Object.entries(j.resumo_por_status)
      .map(([k, v]) => `${ROT_JOB[k] || k}: ${v}`).join("   ·   ") || "sem jobs";
    tb.innerHTML = "";
    if (!j.jobs.length) {
      tb.innerHTML = '<tr class="linha-vazia"><td colspan="8">fila vazia</td></tr>';
      return;
    }
    for (const job of j.jobs) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="num" data-rot="job"></td>
        <td data-rot="tenant"></td><td data-rot="gaveta"></td>
        <td data-rot="doc_id"><span class="tcode"></span></td>
        <td data-rot="estado"><span class="tag"></span></td>
        <td class="num" data-rot="progresso"></td>
        <td data-rot="erro"><span class="erro-cel"></span></td>
        <td class="acoes"><span class="acoes-linha"></span></td>`;
      tr.children[0].textContent = String(job.job_id);
      tr.children[1].textContent = job.tenant;
      tr.children[2].textContent = job.memoria || "(padrão)";
      tr.querySelector(".tcode")!.textContent = job.doc_id;
      const tag = tr.querySelector(".tag")!;
      tag.classList.add(TAG_JOB[job.status] || "fila");
      tag.textContent = ROT_JOB[job.status] || job.status.replace("_", " ");
      tr.children[5].textContent = `${job.chunks_feitos}/${job.chunks_total}`;
      const ec = tr.querySelector(".erro-cel") as HTMLElement;
      ec.textContent = job.erro || "";
      if (job.erro) ec.title = job.erro;
      const ac = tr.querySelector(".acoes-linha")!;
      const bt = (rotulo: string, classe: string, fn: () => void) => {
        const b = document.createElement("button");
        b.textContent = rotulo; b.className = classe;
        b.addEventListener("click", fn); ac.appendChild(b);
      };
      if (job.status === "na_fila") {
        bt("cancelar", "mini", async () => {
          try {
            await api(`/jobs/${job.job_id}/cancel?` +
              qs({ tenant: estado.operador ? job.tenant : "" }), { method: "POST" });
            toast("job cancelado"); void carregarJobs();
          } catch (e) { toast((e as Error).message); }
        });
      }
      if (job.status === "erro" || job.status === "cancelado") {
        bt("retentar", "mini", async () => {
          try {
            await api(`/jobs/${job.job_id}/retry?` +
              qs({ tenant: estado.operador ? job.tenant : "" }), { method: "POST" });
            toast("job reenfileirado"); void carregarJobs();
          } catch (e) { toast((e as Error).message); }
        });
      }
      tb.appendChild(tr);
    }
  } catch (e) { tb.innerHTML = ""; toast("jobs: " + (e as Error).message); }
}
$("#btnJobs").addEventListener("click", () => void carregarJobs());
$("#jobStatus").addEventListener("change", () => void carregarJobs());

/* ------------------------------------------------------------------- boot */

const tsSalvo = Number(sessionStorage.getItem("mr_ts") || 0);
if (estado.key && estado.nome && Date.now() - tsSalvo < TTL_MS) {
  $("#loginErro").textContent = "restaurando sessão…";
  api<GavetasResp>("/gavetas").then((g) => {
    estado.operador = !!g.operador;
    if (!estado.tenant) estado.tenant = estado.nome;
    aposLogin();
  }).catch(() => sair("sessão expirada ou chave inválida"));
} else if (estado.key) {
  sair("sessão passou de 12h — entre de novo");
}