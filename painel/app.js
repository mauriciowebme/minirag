/* Minirag painel v1.10 — SPA sem build, falando a REST do próprio serviço.
   Sessão em sessionStorage com prazo de 12h. Nada de segredo em disco. */
"use strict";

const $ = (s) => document.querySelector(s);
const TTL_MS = 12 * 3600 * 1000;   // sessão expira em 12h
const estado = {
  nome: sessionStorage.getItem("mr_nome") || "",
  key: sessionStorage.getItem("mr_key") || "",
  operador: sessionStorage.getItem("mr_op") === "1",
  tenant: sessionStorage.getItem("mr_tenant") || "",
  memoria: sessionStorage.getItem("mr_mem") || "",
  doc: null, novo: false, dirty: false, job: null, tFiltro: null,
};

async function api(caminho, opts = {}) {
  const hdr = { Authorization: "B" + "earer " + estado.key };
  if (opts.body !== undefined) hdr["Content-Type"] = "application/json";
  const r = await fetch(caminho, { ...opts, headers: { ...hdr, ...opts.headers } });
  if (r.status === 401) { sair("segredo recusado — verifique nome e chave"); throw new Error("401"); }
  if (r.ok) {
    const ct = r.headers.get("content-type") || "";
    return ct.includes("json") ? r.json() : r.text();
  }
  let detalhe = r.status + " " + r.statusText;
  try { const j = await r.json(); if (j.detail) detalhe = j.detail; } catch (e) {}
  throw new Error(detalhe);
}

async function comAuthBaixar(caminho, nomeArquivo) {
  const r = await fetch(caminho, { headers: { Authorization: "B" + "earer " + estado.key } });
  if (!r.ok) throw new Error("download: HTTP " + r.status);
  const blob = await r.blob(); const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = nomeArquivo;
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function toast(msg, ms = 3500) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("ver");
  clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove("ver"), ms);
}
const fmtData = (iso) => iso ? new Date(iso).toLocaleString("pt-BR",
  { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const onde = () => `${estado.tenant || "—"} : ${estado.memoria || "(padrão)"}`;
const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")
  .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
const esc = (s) => String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ------------------------------------------------------------------ views --
function mostrar(nome) {
  document.querySelectorAll("main section").forEach(s => s.hidden = true);
  $("#v" + nome.charAt(0).toUpperCase() + nome.slice(1)).hidden = false;
  document.querySelectorAll(".aba").forEach(b =>
    b.classList.toggle("ativa", b.dataset.view === nome));
}
document.querySelectorAll(".aba").forEach(b =>
  b.addEventListener("click", () => { mostrar(b.dataset.view); REC[b.dataset.view](); }));
const REC = {
  gavetas: carregarGavetas, arquivos: carregarDocs, buscar: () => {},
  jobs: carregarJobs, editor: () => {},
};

// ------------------------------------------------------------------ login --
function guardarEscopo() {
  sessionStorage.setItem("mr_tenant", estado.tenant);
  sessionStorage.setItem("mr_mem", estado.memoria);
}
async function entrar() {
  const nome = $("#loginNome").value.trim(), key = $("#loginKey").value.trim();
  if (!nome || !key) { $("#loginErro").textContent = "preencha nome e segredo"; return; }
  estado.key = key;
  try {
    const g = await api("/gavetas");
    estado.nome = nome; estado.operador = !!g.operador;
    estado.tenant = g.operador ? nome : nome; estado.memoria = "";
    sessionStorage.setItem("mr_nome", nome);
    sessionStorage.setItem("mr_key", key);
    sessionStorage.setItem("mr_op", g.operador ? "1" : "0");
    sessionStorage.setItem("mr_ts", String(Date.now()));
    guardarEscopo(); aposLogin();
  } catch (e) { if (e.message !== "401") $("#loginErro").textContent = e.message; }
}
function aposLogin() {
  document.body.classList.remove("fora");
  $("#loginErro").textContent = "";
  $("#vLogin").hidden = true; $("#nav").hidden = false;
  $("#quo").innerHTML = `${esc(estado.nome)} ` +
    (estado.operador ? '<span class="chip op">operador</span>' : '<span class="chip">tenant</span>');
  api("/health").then(h => $("#ver").textContent = "v" + (h.versao || "")).catch(() => {});
  mostrar("gavetas"); carregarGavetas();
}
function sair(msg) {
  if (estado.dirty && !confirm("há edição não salva — sair mesmo assim?")) return;
  estado.dirty = false;
  sessionStorage.clear();
  document.body.classList.add("fora");
  $("#abaEditor").hidden = true;
  $("#nav").hidden = true; $("#vLogin").hidden = false;
  document.querySelectorAll("main section").forEach(s => s.hidden = s.id !== "vLogin");
  if (msg) $("#loginErro").textContent = msg;
}
$("#btnEntrar").addEventListener("click", entrar);
$("#loginKey").addEventListener("keydown", e => e.key === "Enter" && entrar());
$("#loginNome").addEventListener("keydown", e => e.key === "Enter" && entrar());
$("#btnSair").addEventListener("click", () => sair(""));
window.addEventListener("beforeunload", (e) => {
  if (estado.dirty) { e.preventDefault(); e.returnValue = ""; }
});

// ---------------------------------------------------------------- gavetas --
async function carregarGavetas() {
  try {
    const g = await api("/gavetas");
    $("#gavetasInfo").textContent =
      `${g.gavetas.length} gaveta(s) · ${g.documentos_fonte} documento(s) com fonte guardada`;
    const grid = $("#gavetasGrid"); grid.innerHTML = "";
    if (!g.gavetas.length) {
      grid.innerHTML = '<p class="dica">Nenhuma memória ainda — crie uma nota ou faça upload na aba Arquivos.</p>';
      return;
    }
    for (const gav of g.gavetas) {
      const el = document.createElement("div"); el.className = "gaveta";
      el.innerHTML = `<div class="nome"></div><div class="nums"></div><div class="nums"></div>
        <div class="acoesG">
          <button class="linterna g-x">⬇ zip</button>
          <button class="linterna g-ap apagar">apagar gaveta</button>
        </div>`;
      el.children[0].textContent = (g.operador ? gav.tenant + " ▸ " : "") + (gav.memoria || "(padrão)");
      el.children[1].textContent = `${gav.docs} arquivo(s) · ${gav.chunks} chunks`;
      el.children[2].textContent = `vivos ${gav.chunks - gav.chunks_arquivados} · ` +
        `arquivados ${gav.chunks_arquivados} · último ${fmtData(gav.ultimo_ingress)}`;
      el.addEventListener("click", () => {
        estado.tenant = gav.tenant; estado.memoria = gav.memoria;
        guardarEscopo(); mostrar("arquivos"); carregarDocs();
      });
      el.querySelector(".g-x").addEventListener("click", (ev) => {
        ev.stopPropagation(); exportarGaveta(gav.tenant, gav.memoria);
      });
      el.querySelector(".g-ap").addEventListener("click", (ev) => {
        ev.stopPropagation(); apagarGaveta(gav.tenant, gav.memoria, gav.docs);
      });
      grid.appendChild(el);
    }
  } catch (e) { toast("gavetas: " + e.message); }
}
$("#btnAtualizarGav").addEventListener("click", carregarGavetas);
$("#btnDecay").addEventListener("click", async () => {
  const alvo = estado.operador ? "TODOS os tenants (global)" : `só o tenant ${estado.nome}`;
  if (!confirm("Rodar decay agora sobre " + alvo + "?")) return;
  try {
    const r = await api("/decay", { method: "POST", body: JSON.stringify({}) });
    toast(`decay: ${r.docs_arquivados_agora} doc(s) arquivados agora · ` +
          `ativos ${r.ativos} · arquivados ${r.arquivados}`);
    carregarGavetas();
  } catch (e) { toast("decay: " + e.message); }
});
async function exportarGaveta(tenant, memoria) {
  try {
    const nome = (memoria || "gaveta").replace(/[^\w.-]/g, "_") + ".zip";
    await comAuthBaixar(`/gavetas/${encodeURIComponent(memoria)}/export.zip?` +
      qs({ tenant: estado.operador ? tenant : undefined }), nome);
    toast("zip gerado ✓");
  } catch (e) { toast(e.message); }
}
async function apagarGaveta(tenant, memoria, docs) {
  const rotulo = (estado.operador ? tenant + " ▸ " : "") + (memoria || "(padrão)");
  if (!confirm(`APAGAR a gaveta ${rotulo} inteira (${docs} arquivo(s), chunks, fontes e jobs na fila)?`)) return;
  if (!confirm("Tem certeza? Isso NÃO tem como desfazer no painel.")) return;
  try {
    const r = await api(`/gavetas/${encodeURIComponent(memoria)}?` +
      qs({ tenant: estado.operador ? tenant : undefined }), { method: "DELETE" });
    toast(`gaveta apagada: ${r.chunks_apagados} chunks, ${r.fontes_apagadas} fontes`);
    if (estado.memoria === memoria && estado.tenant === tenant) { estado.memoria = ""; guardarEscopo(); }
    carregarGavetas();
  } catch (e) { toast(e.message); }
}
$("#btnApagarGaveta").addEventListener("click", () => apagarGaveta(estado.tenant, estado.memoria, "?"));

// --------------------------------------------------------------- arquivos --
async function carregarDocs() {
  if (!estado.tenant) { toast("escolha uma gaveta primeiro"); mostrar("gavetas"); return; }
  $("#arqOnde").textContent = "— " + onde();
  $("#arqTotal").textContent = "";
  try {
    const d = await api("/docs?" + qs({
      memoria: estado.memoria, tenant: estado.tenant,
      include_archived: $("#arqMostrarArq").checked ? "true" : "",
      q: $("#arqFiltro").value.trim(), limit: 500,
    }));
    const tb = $("#arqTabela tbody"); tb.innerHTML = "";
    $("#arqTotal").textContent = `${d.total} arquivo(s)`;
    for (const doc of d.docs) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="t"></td><td class="t tcode"></td><td class="num"></td>
        <td class="num"></td><td></td>
        <td class="acoes">
          <button class="linterna a-br">abrir</button>
          <button class="linterna a-bx">baixar</button>
          <button class="linterna a-cp" title="copiar doc_id">⧉</button>
          <button class="linterna a-ar"></button>
          <button class="linterna apagar a-del">apagar</button>
        </td>`;
      tr.children[0].textContent = doc.title || "(sem título)";
      tr.children[1].textContent = doc.doc_id;
      tr.children[2].textContent = doc.chunks;
      tr.children[3].textContent = doc.chunks_arquivados || "—";
      tr.children[4].textContent = fmtData(doc.updated_at);
      const arqBtn = tr.querySelector(".a-ar");
      const arquivado = doc.chunks_arquivados > 0;
      arqBtn.textContent = arquivado ? "reviver" : "arquivar";
      tr.querySelector(".a-br").addEventListener("click", () => abrirEditor(doc.doc_id));
      tr.querySelector(".a-bx").addEventListener("click", () =>
        comAuthBaixar(`/documents/${encodeURIComponent(doc.doc_id)}/raw?` +
          qs({ memoria: estado.memoria, tenant: estado.tenant }),
          doc.doc_id.replace(/[^\w.-]/g, "_") + ".txt").catch(e => toast(e.message)));
      tr.querySelector(".a-cp").addEventListener("click", () =>
        navigator.clipboard.writeText(doc.doc_id).then(() => toast("doc_id copiado ✓"),
          () => toast("copiar falhou — " + doc.doc_id)));
      arqBtn.addEventListener("click", async () => {
        try {
          await api(`/documents/${encodeURIComponent(doc.doc_id)}/arquivado?` +
            qs({ memoria: estado.memoria }), { method: "PATCH",
            body: JSON.stringify({ arquivado: !arquivado,
              tenant: estado.operador ? estado.tenant : undefined }) });
          toast(arquivado ? "documento revivido ✓" : "documento arquivado ✓");
          carregarDocs();
        } catch (e) { toast(e.message); }
      });
      tr.querySelector(".a-del").addEventListener("click", async () => {
        if (!confirm(`APAGAR definitivamente "${doc.doc_id}" (${doc.chunks} chunks + fonte)?`)) return;
        try {
          const r = await api(`/docs/${encodeURIComponent(doc.doc_id)}?` +
            qs({ memoria: estado.memoria, tenant: estado.operador ? estado.tenant : undefined }),
            { method: "DELETE" });
          toast(`apagado: ${r.chunks_apagados} chunks` + (r.fonte_apagada ? " + fonte" : ""));
          carregarDocs();
        } catch (e) { toast(e.message); }
      });
      tb.appendChild(tr);
    }
    if (!d.docs.length) tb.innerHTML =
      '<tr><td colspan="6" class="dica">nada aqui — filtro vazio ou gaveta sem arquivos</td></tr>';
  } catch (e) { toast("docs: " + e.message); }
}
$("#arqMostrarArq").addEventListener("change", carregarDocs);
$("#arqFiltro").addEventListener("input", () => {
  clearTimeout(estado.tFiltro);
  estado.tFiltro = setTimeout(carregarDocs, 350);
});
$("#btnNovaNota").addEventListener("click", () => {
  const box = $("#novaNotaBox");
  box.hidden = !box.hidden;
  if (!box.hidden) {
    $("#novaNotaNome").value = "nota-" + new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
    $("#novaNotaNome").focus(); $("#novaNotaNome").select();
  }
});
$("#btnCancelarNota").addEventListener("click", () => $("#novaNotaBox").hidden = true);
$("#btnCriarNota").addEventListener("click", () => {
  const nome = $("#novaNotaNome").value.trim().replace(/\s+/g, "-");
  if (!nome) { toast("dê um nome à nota"); return; }
  $("#novaNotaBox").hidden = true;
  abrirEditor(null, nome);
});
$("#novaNotaNome").addEventListener("keydown", e => e.key === "Enter" && $("#btnCriarNota").click());
$("#btnExport").addEventListener("click", () => exportarGaveta(estado.tenant, estado.memoria));
async function subirArquivos(lista) {
  if (!lista || !lista.length) return;
  mostrar("arquivos");
  let ok = 0, falha = 0;
  for (const f of lista) {
    try {
      const texto = await f.text();
      const r = await api("/ingest", { method: "POST", body: JSON.stringify({
        doc_id: f.name, title: f.name, content: texto, memoria: estado.memoria,
        tenant: estado.operador ? estado.tenant : undefined }) });
      ok++;
      toast(`⬆ ${f.name}: na fila (job ${r.job_id}, ${r.chunks_total} chunk[s])`, 2500);
    } catch (e) { falha++; toast(`⬆ ${f.name}: ${e.message}`, 5000); }
  }
  if (lista.length > 1) toast(`upload: ${ok} enviado(s), ${falha} com erro`, 5000);
  carregarDocs();
}
$("#arquivoInput").addEventListener("change", async (ev) => {
  const lista = Array.from(ev.target.files || []); ev.target.value = "";
  await subirArquivos(lista);
});
const dz = $("#dropzone");
["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, (e) => {
  e.preventDefault(); dz.classList.add("hot");
}));
["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, (e) => {
  e.preventDefault(); dz.classList.remove("hot");
}));
dz.addEventListener("drop", (e) => subirArquivos(Array.from(e.dataTransfer.files || [])));
dz.addEventListener("click", () => $("#arquivoInput").click());

// ------------------------------------------------------------------ editor --
function marcarDirty() { estado.dirty = true; $("#edStatus").textContent = "não salvo"; }
function contarPalavras() {
  const t = $("#edConteudo").value.trim();
  $("#edConta").textContent = (t ? t.split(/\s+/).length : 0) + " palavras";
}
$("#edConteudo").addEventListener("input", () => { marcarDirty(); contarPalavras(); });
$("#edTitulo").addEventListener("input", marcarDirty);

async function abrirEditor(doc_id, novoNome) {
  estado.doc = doc_id || novoNome || null;
  estado.novo = !doc_id;
  estado.dirty = false;
  $("#edRenameBox").hidden = true;
  $("#edPreview").hidden = true;
  $("#edConteudo").hidden = false;
  $("#abaEditor").hidden = false; mostrar("editor");
  $("#edOnde").textContent = "— " + onde() + " · " + (estado.doc || "");
  if (estado.novo) {
    $("#edTitulo").value = estado.doc;
    $("#edConteudo").value = "";
    $("#edStatus").textContent = "nota nova — salvar cria na gaveta";
    $("#btnSalvar").textContent = "criar & reindexar";
    $("#btnRenomear").disabled = true;
  } else {
    $("#btnSalvar").textContent = "salvar & reindexar";
    $("#btnRenomear").disabled = false;
    $("#edStatus").textContent = "carregando…";
    try {
      const d = await api(`/documents/${encodeURIComponent(doc_id)}?` +
        qs({ memoria: estado.memoria, tenant: estado.tenant }));
      $("#edTitulo").value = d.title || "";
      $("#edConteudo").value = d.content;
      $("#edStatus").textContent = `fonte: ${d.origem} · ${d.size_bytes} bytes · ` +
        `atualizado ${fmtData(d.atualizado_em)}`;
    } catch (e) {
      $("#edStatus").textContent = "";
      $("#edConteudo").value = "";
      toast("sem fonte para abrir: " + e.message);
    }
  }
  contarPalavras();
}
$("#btnCancelarEd").addEventListener("click", () => {
  if (estado.dirty && !confirm("descartar a edição não salva?")) return;
  estado.dirty = false; $("#abaEditor").hidden = true;
  mostrar("arquivos"); carregarDocs();
});
$("#btnSalvar").addEventListener("click", async () => {
  if (!estado.doc) return;
  const conteudo = $("#edConteudo").value;
  if (!conteudo.trim()) { toast("conteúdo vazio"); return; }
  const titulo = $("#edTitulo").value || null;
  try {
    let r;
    if (estado.novo) {
      r = await api("/ingest", { method: "POST", body: JSON.stringify({
        doc_id: estado.doc, title: titulo || estado.doc, content: conteudo,
        memoria: estado.memoria, tenant: estado.operador ? estado.tenant : undefined }) });
      estado.novo = false;
      $("#btnSalvar").textContent = "salvar & reindexar";
      $("#btnRenomear").disabled = false;
    } else {
      r = await api(`/documents/${encodeURIComponent(estado.doc)}?` +
        qs({ memoria: estado.memoria }), { method: "PUT", body: JSON.stringify({
          content: conteudo, title: titulo, memoria: estado.memoria,
          tenant: estado.operador ? estado.tenant : undefined }) });
    }
    estado.dirty = false;
    acompanhar(r.job_id);
  } catch (e) { toast("salvar: " + e.message); }
});
async function acompanhar(job_id) {
  $("#btnSalvar").disabled = true;
  for (let i = 0; i < 400; i++) {
    let st;
    try { st = await api(`/ingest/${job_id}?` + qs({ tenant: estado.operador ? estado.tenant : "" })); }
    catch (e) { break; }
    $("#edStatus").textContent = `reindexando… ${st.chunks_feitos}/${st.chunks_total} (${st.status})`;
    if (st.status === "concluido") { toast("salvo e reindexado ✓"); break; }
    if (st.status === "erro") { toast("job com erro: " + (st.erro || "?")); break; }
    if (st.status === "cancelado") break;
    await new Promise(res => setTimeout(res, 3000));
  }
  $("#btnSalvar").disabled = false;
}
$("#btnRenomear").addEventListener("click", () => {
  const box = $("#edRenameBox");
  box.hidden = !box.hidden;
  if (!box.hidden) { $("#edNovoId").value = ""; $("#edNovaGaveta").value = ""; $("#edNovoId").focus(); }
});
$("#btnFecharRename").addEventListener("click", () => $("#edRenameBox").hidden = true);
$("#btnAplicarRename").addEventListener("click", async () => {
  if (!estado.doc) return;
  const novo = $("#edNovoId").value.trim(), dest = $("#edNovaGaveta").value.trim();
  if (!novo && !dest) { toast("nada para mudar"); return; }
  try {
    const r = await api(`/documents/${encodeURIComponent(estado.doc)}?` +
      qs({ memoria: estado.memoria }), { method: "PATCH", body: JSON.stringify({
        novo_doc_id: novo || null, destino_memoria: dest || null,
        tenant: estado.operador ? estado.tenant : undefined }) });
    toast(`ok: ${r.doc_id} → gaveta ${r.memoria || "(padrão)"}`);
    if (r.movido && r.memoria !== estado.memoria) {
      estado.dirty = false; $("#abaEditor").hidden = true;
      mostrar("arquivos"); carregarDocs();
    } else {
      estado.doc = r.doc_id;
      $("#edOnde").textContent = "— " + onde() + " · " + r.doc_id;
      $("#edRenameBox").hidden = true;
    }
  } catch (e) { toast("renomear: " + e.message); }
});
$("#btnPreview").addEventListener("click", () => {
  const p = $("#edPreview"), ta = $("#edConteudo");
  if (!p.hidden) { p.hidden = true; ta.hidden = false; $("#btnPreview").textContent = "prévia markdown"; return; }
  p.innerHTML = mdParaHtml(ta.value);
  p.hidden = false; ta.hidden = true;
  $("#btnPreview").textContent = "voltar a editar";
});
function mdParaHtml(txt) {
  let s = esc(txt);
  s = s.replace(/^### (.*)$/gm, "<h3>$1</h3>")
       .replace(/^## (.*)$/gm, "<h2>$1</h2>")
       .replace(/^# (.*)$/gm, "<h1>$1</h1>")
       .replace(/```([\s\S]*?)```/g, (m, c) => `<pre>${c}</pre>`)
       .replace(/`([^`]+)`/g, "<code>$1</code>")
       .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
       .replace(/\*([^*]+)\*/g, "<i>$1</i>")
       .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
       .replace(/^- (.*)$/gm, "• $1")
       .replace(/\n{2,}/g, "</p><p>")
       .replace(/\n/g, "<br>");
  return "<p>" + s + "</p>";
}

// ------------------------------------------------------------------ buscar --
$("#busScore").addEventListener("input", () =>
  $("#busScoreOut").textContent = Number($("#busScore").value).toFixed(2));
$("#btnBuscar").addEventListener("click", async () => {
  const q = $("#busQuery").value.trim();
  if (!q) return;
  $("#busOnde").textContent = "— " + onde();
  $("#busResultado").innerHTML = '<p class="dica">buscando…</p>';
  const minScore = Number($("#busScore").value);
  try {
    const r = await api("/search", { method: "POST", body: JSON.stringify({
      query: q, k: Number($("#busK").value) || 8, min_score: minScore,
      memoria: estado.memoria, include_archived: $("#busArq").checked,
      tenant: estado.operador ? estado.tenant : undefined }) });
    const box = $("#busResultado"); box.innerHTML = "";
    const cab = document.createElement("p"); cab.className = "dica";
    cab.textContent = `${r.total} resultado(s)` +
      ($("#busArq").checked ? " (arquivados achados foram REVIVIDOS)" : "");
    box.appendChild(cab);
    if (!r.total) {
      const d = document.createElement("p"); d.className = "dica";
      d.textContent = `nada acima de ${minScore.toFixed(2)} — baixe o score mínimo ` +
        `(o texto pode estar lá, só fora do corte de similaridade)`;
      box.appendChild(d);
    }
    for (const it of r.items) {
      const el = document.createElement("div"); el.className = "hit";
      el.innerHTML = `<span class="score"></span> <b class="t"></b>
        <div class="meta"></div><p class="x"></p>`;
      el.querySelector(".score").textContent = it.score.toFixed(3);
      el.querySelector(".t").textContent = it.title || it.doc_id;
      el.querySelector(".meta").textContent = `doc ${it.doc_id}` +
        (it.arquivado ? " · estava arquivado" : "");
      el.querySelector(".x").textContent = it.text;
      el.querySelector(".meta").style.cursor = "pointer";
      el.querySelector(".meta").addEventListener("click", () => abrirEditor(it.doc_id));
      box.appendChild(el);
    }
  } catch (e) { $("#busResultado").innerHTML = ""; toast("busca: " + e.message); }
});
$("#busQuery").addEventListener("keydown", e => e.key === "Enter" && $("#btnBuscar").click());

// -------------------------------------------------------------------- jobs --
async function carregarJobs() {
  const st = $("#jobStatus").value;
  try {
    const j = await api("/jobs?" + qs({
      limit: 80, status: st, tenant: estado.operador ? estado.tenant : estado.nome }));
    const chips = Object.entries(j.resumo_por_status)
      .map(([k, v]) => `${k}: ${v}`).join("   ·   ");
    $("#jobsInfo").textContent = chips || "sem jobs";
    const tb = $("#jobsTabela tbody"); tb.innerHTML = "";
    for (const job of j.jobs) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="num"></td><td></td><td></td><td class="t"></td>
        <td class="st"></td><td class="num"></td><td class="miudo e"></td>
        <td class="acoes"></td>`;
      tr.children[0].textContent = job.job_id;
      tr.children[1].textContent = job.tenant;
      tr.children[2].textContent = job.memoria || "(padrão)";
      tr.children[3].textContent = job.doc_id;
      const stc = tr.querySelector(".st"); stc.textContent = job.status;
      stc.className = "st " + ({ concluido: "ok", erro: "ruim",
        processando: "meio", na_fila: "meio" }[job.status] || "");
      tr.children[5].textContent = `${job.chunks_feitos}/${job.chunks_total}`;
      tr.querySelector(".e").textContent = (job.erro || "").slice(0, 60);
      const ac = tr.querySelector(".acoes");
      if (job.status === "na_fila") {
        const b = document.createElement("button");
        b.className = "linterna apagar"; b.textContent = "cancelar";
        b.addEventListener("click", async () => {
          try { await api(`/jobs/${job.job_id}/cancel?` +
            qs({ tenant: estado.operador ? job.tenant : "" }), { method: "POST" });
            toast("job cancelado"); carregarJobs();
          } catch (e) { toast(e.message); }
        });
        ac.appendChild(b);
      }
      if (job.status === "erro" || job.status === "cancelado") {
        const b = document.createElement("button");
        b.className = "linterna"; b.textContent = "retentar";
        b.addEventListener("click", async () => {
          try { await api(`/jobs/${job.job_id}/retry?` +
            qs({ tenant: estado.operador ? job.tenant : "" }), { method: "POST" });
            toast("job reenfileirado"); carregarJobs();
          } catch (e) { toast(e.message); }
        });
        ac.appendChild(b);
      }
      tb.appendChild(tr);
    }
    if (!j.jobs.length) tb.innerHTML = '<tr><td colspan="8" class="dica">fila vazia</td></tr>';
  } catch (e) { toast("jobs: " + e.message); }
}
$("#btnJobs").addEventListener("click", carregarJobs);
$("#jobStatus").addEventListener("change", carregarJobs);

// -------------------------------------------------------------------- boot --
const tsSalvo = Number(sessionStorage.getItem("mr_ts") || 0);
if (estado.key && estado.nome && Date.now() - tsSalvo < TTL_MS) {
  $("#loginErro").textContent = "restaurando sessão…";
  api("/gavetas").then(g => {
    estado.operador = !!g.operador;
    if (!estado.tenant) estado.tenant = estado.nome;
    aposLogin();
  }).catch(() => sair("sessão expirada ou chave inválida"));
} else if (estado.key) {
  sair("sessão passou de 12h — entre de novo");
}