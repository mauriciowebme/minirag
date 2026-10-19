/* Minirag painel — SPA sem build. Fala com a mesma REST do serviço.
   Sessão (nome+segredo) só em sessionStorage: fecha a aba, sumiu. */
"use strict";

const $ = (s) => document.querySelector(s);
const estado = {
  nome: sessionStorage.getItem("mr_nome") || "",
  key: sessionStorage.getItem("mr_key") || "",
  operador: sessionStorage.getItem("mr_op") === "1",
  tenant: sessionStorage.getItem("mr_tenant") || "",
  memoria: sessionStorage.getItem("mr_mem") || "",
  doc: null,
  job: null,
};

async function api(caminho, opts = {}) {
  const hdr = { Authorization: "B" + "earer " + estado.key };
  if (opts.body !== undefined) hdr["Content-Type"] = "application/json";
  const r = await fetch(caminho, { ...opts, headers: { ...hdr, ...opts.headers } });
  if (r.status === 401) { sair("segredo recusado — verifique nome e chave"); throw new Error("401"); }
  if (r.status === 202 || r.status === 200) {
    const ct = r.headers.get("content-type") || "";
    return ct.includes("json") ? r.json() : r.text();
  }
  let detalhe = r.status + " " + r.statusText;
  try { const j = await r.json(); if (j.detail) detalhe = j.detail; } catch (e) {}
  throw new Error(detalhe);
}

function toast(msg, ms = 3500) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("ver");
  clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove("ver"), ms);
}
const fmtData = (iso) => iso ? new Date(iso).toLocaleString("pt-BR",
  { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const onde = () => `${estado.tenant || "—"} : ${estado.memoria || "(padrão)"}`;

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
async function entrar() {
  const nome = $("#loginNome").value.trim(), key = $("#loginKey").value.trim();
  if (!nome || !key) { $("#loginErro").textContent = "preencha nome e segredo"; return; }
  estado.key = key;
  try {
    const g = await api("/gavetas");
    estado.nome = nome; estado.operador = !!g.operador;
    sessionStorage.setItem("mr_nome", nome); sessionStorage.setItem("mr_key", key);
    sessionStorage.setItem("mr_op", g.operador ? "1" : "0");
    estado.tenant = nome; estado.memoria = "";
    guardarEscopo(); aposLogin();
  } catch (e) { if (e.message !== "401") $("#loginErro").textContent = e.message; }
}
function guardarEscopo() {
  sessionStorage.setItem("mr_tenant", estado.tenant);
  sessionStorage.setItem("mr_mem", estado.memoria);
}
function aposLogin() {
  document.body.classList.remove("fora");   // saiu da tela exclusiva de login
  $("#loginErro").textContent = "";
  $("#vLogin").hidden = true; $("#nav").hidden = false;
  $("#quo").innerHTML = `${estado.nome} ` +
    (estado.operador ? '<span class="chip op">operador</span>' : '<span class="chip">tenant</span>');
  mostrar("gavetas"); carregarGavetas();
}
function sair(msg) {
  sessionStorage.clear();
  document.body.classList.add("fora");     // volta ao palco só com o login
  $("#abaEditor").hidden = true;
  $("#nav").hidden = true; $("#vLogin").hidden = false;
  document.querySelectorAll("main section").forEach(s => s.hidden = s.id !== "vLogin");
  if (msg) $("#loginErro").textContent = msg;
}
$("#btnEntrar").addEventListener("click", entrar);
$("#loginKey").addEventListener("keydown", e => e.key === "Enter" && entrar());
$("#btnSair").addEventListener("click", () => sair(""));

// ---------------------------------------------------------------- gavetas --
async function carregarGavetas() {
  try {
    const g = await api("/gavetas");
    $("#gavetasInfo").textContent =
      `${g.gavetas.length} gaveta(s) · ${g.documentos_fonte} documento(s) com fonte guardada`;
    const grid = $("#gavetasGrid"); grid.innerHTML = "";
    if (!g.gavetas.length) { grid.innerHTML = '<p class="dica">Nenhuma memória ainda — mande um ingest ou faça upload na aba Arquivos.</p>'; return; }
    for (const gav of g.gavetas) {
      const el = document.createElement("div"); el.className = "gaveta";
      const nome = gav.memoria || "(padrão)";
      el.innerHTML = `<div class="nome"></div>
        <div class="nums"></div>
        <div class="nums"></div>`;
      el.children[0].textContent = (g.operador ? gav.tenant + " ▸ " : "") + nome;
      el.children[1].textContent = `${gav.docs} arquivo(s) · ${gav.chunks} chunks`;
      el.children[2].textContent = `vivos ${gav.chunks - gav.chunks_arquivados} · arquivados ${gav.chunks_arquivados} · último ${fmtData(gav.ultimo_ingress)}`;
      el.addEventListener("click", () => {
        estado.tenant = gav.tenant; estado.memoria = gav.memoria;
        guardarEscopo(); mostrar("arquivos"); carregarDocs();
      });
      grid.appendChild(el);
    }
  } catch (e) { toast("gavetas: " + e.message); }
}
$("#btnDecay").addEventListener("click", async () => {
  const alvo = estado.operador
    ? "global (TODOS os tenants)" : `só o tenant ${estado.nome}`;
  if (!confirm("Rodar decay agora sobre " + alvo + "?")) return;
  try {
    const r = await api("/decay", { method: "POST", body: JSON.stringify({}) });
    toast(`decay: ${r.docs_arquivados_agora} doc(s) arquivados agora · ` +
          `ativos ${r.ativos} · arquivados ${r.arquivados}`);
    carregarGavetas();
  } catch (e) { toast("decay: " + e.message); }
});

// --------------------------------------------------------------- arquivos --
async function carregarDocs() {
  if (!estado.tenant) { toast("escolha uma gaveta primeiro"); mostrar("gavetas"); return; }
  $("#arqOnde").textContent = "— " + onde();
  $("#arqInfo").textContent = "clique em abrir para editar; baixar salva o arquivo original";
  try {
    const d = await api(`/docs?include_archived=true&memoria=${encodeURIComponent(estado.memoria)}&tenant=${encodeURIComponent(estado.tenant)}`);
    const tb = $("#arqTabela tbody"); tb.innerHTML = "";
    for (const doc of d.docs) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="t"></td><td class="t"></td><td class="num"></td>
        <td class="num"></td><td></td>
        <td class="acoes"><button class="linterna a-br">abrir</button>
        <button class="linterna a-bx">baixar</button>
        <button class="linterna apagar">apagar</button></td>`;
      tr.children[0].textContent = doc.title || "(sem título)";
      tr.children[1].textContent = doc.doc_id;
      tr.children[2].textContent = doc.chunks;
      tr.children[3].textContent = doc.chunks_arquivados || "—";
      tr.children[4].textContent = fmtData(doc.updated_at);
      tr.querySelector(".a-br").addEventListener("click", () => abrirEditor(doc.doc_id));
      tr.querySelector(".a-bx").addEventListener("click", () => baixar(doc.doc_id));
      tr.querySelector(".apagar").addEventListener("click", async () => {
        if (!confirm(`APAGAR definitivamente "${doc.doc_id}" (${doc.chunks} chunks)?`)) return;
        try {
          const r = await api(`/docs/${encodeURIComponent(doc.doc_id)}?memoria=${encodeURIComponent(estado.memoria)}&tenant=${encodeURIComponent(estado.tenant)}`,
            { method: "DELETE" });
          toast(`apagado: ${r.chunks_apagados} chunks + fonte`); carregarDocs();
        } catch (e) { toast(e.message); }
      });
      tb.appendChild(tr);
    }
    if (!d.docs.length) tb.innerHTML = '<tr><td colspan="6" class="dica">gaveta vazia</td></tr>';
  } catch (e) { toast("docs: " + e.message); }
}
async function baixar(doc_id) {
  try {
    const r = await fetch(`/documents/${encodeURIComponent(doc_id)}/raw?memoria=${encodeURIComponent(estado.memoria)}&tenant=${encodeURIComponent(estado.tenant)}`,
      { headers: { Authorization: "B" + "earer " + estado.key } });
    if (!r.ok) throw new Error("download: " + r.status);
    const blob = await r.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = doc_id.replace(/[^\w.-]/g, "_") + ".txt";
    a.click(); URL.revokeObjectURL(url);
  } catch (e) { toast(e.message); }
}
$("#arquivoInput").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; ev.target.value = "";
  if (!f) return;
  const texto = await f.text();
  try {
    const r = await api("/ingest", { method: "POST", body: JSON.stringify({
      doc_id: f.name, title: f.name, content: texto,
      memoria: estado.memoria, tenant: estado.operador ? estado.tenant : undefined }) });
    toast(`upload na fila (job ${r.job_id}, ${r.chunks_total} chunks)`);
    mostrar("jobs"); carregarJobs();
  } catch (e) { toast("upload: " + e.message); }
});

// ------------------------------------------------------------------ editor --
async function abrirEditor(doc_id) {
  estado.doc = doc_id;
  $("#abaEditor").hidden = false; mostrar("editor");
  $("#edOnde").textContent = "— " + onde() + " · " + doc_id;
  $("#edStatus").textContent = "carregando…";
  try {
    const d = await api(`/documents/${encodeURIComponent(doc_id)}?memoria=${encodeURIComponent(estado.memoria)}&tenant=${encodeURIComponent(estado.tenant)}`);
    $("#edTitulo").value = d.title || "";
    $("#edConteudo").value = d.content;
    $("#edStatus").textContent = `fonte: ${d.origem} · ${d.size_bytes} bytes · atualizado ${fmtData(d.atualizado_em)}`;
  } catch (e) { $("#edStatus").textContent = ""; toast(e.message);
    $("#edConteudo").value = "(conteúdo indisponível — docs antigos pré-v1.8 podem estar só como índice reconstruído)"; }
}
$("#btnCancelarEd").addEventListener("click", () => { $("#abaEditor").hidden = true; mostrar("arquivos"); carregarDocs(); });
$("#btnSalvar").addEventListener("click", async () => {
  if (!estado.doc) return;
  const body = { content: $("#edConteudo").value, title: $("#edTitulo").value || null,
    memoria: estado.memoria, tenant: estado.operador ? estado.tenant : undefined };
  try {
    const r = await api(`/documents/${encodeURIComponent(estado.doc)}`,
      { method: "PUT", body: JSON.stringify(body) });
    estado.job = r.job_id;
    acompanhar(r.job_id);
  } catch (e) { toast("salvar: " + e.message); }
});
async function acompanhar(job_id) {
  $("#btnSalvar").disabled = true;
  for (let i = 0; i < 400; i++) {
    let st;
    try { st = await api(`/ingest/${job_id}?tenant=${encodeURIComponent(estado.operador ? estado.tenant : "")}`); }
    catch (e) { break; }
    $("#edStatus").textContent = `reindexando… ${st.chunks_feitos}/${st.chunks_total} (${st.status})`;
    if (st.status === "concluido") { toast("salvo e reindexado ✓"); break; }
    if (st.status === "erro") { toast("job com erro: " + (st.erro || "?")); break; }
    if (st.status === "cancelado") break;
    await new Promise(res => setTimeout(res, 3000));
  }
  $("#btnSalvar").disabled = false;
}

// ------------------------------------------------------------------ buscar --
$("#btnBuscar").addEventListener("click", async () => {
  const q = $("#busQuery").value.trim();
  if (!q) return;
  $("#busOnde").textContent = "— " + onde();
  $("#busResultado").innerHTML = '<p class="dica">buscando…</p>';
  try {
    const r = await api("/search", { method: "POST", body: JSON.stringify({
      query: q, k: 8, memoria: estado.memoria,
      include_archived: $("#busArq").checked,
      tenant: estado.operador ? estado.tenant : undefined }) });
    const box = $("#busResultado"); box.innerHTML = "";
    const cab = document.createElement("p"); cab.className = "dica";
    cab.textContent = `${r.total} resultado(s)` + ($("#busArq").checked ? " (achados arquivados foram REVIVIDOS)" : "");
    box.appendChild(cab);
    for (const it of r.items) {
      const el = document.createElement("div"); el.className = "hit";
      el.innerHTML = `<span class="score"></span> <b class="t"></b>
        <div class="meta"></div><p class="x"></p>`;
      el.querySelector(".score").textContent = it.score.toFixed(3);
      el.querySelector(".t").textContent = it.title || it.doc_id;
      el.querySelector(".meta").textContent = `doc ${it.doc_id}` + (it.arquivado ? " · estava arquivado" : "");
      el.querySelector(".x").textContent = it.text;
      box.appendChild(el);
    }
  } catch (e) { $("#busResultado").innerHTML = ""; toast("busca: " + e.message); }
});
$("#busQuery").addEventListener("keydown", e => e.key === "Enter" && $("#btnBuscar").click());

// -------------------------------------------------------------------- jobs --
async function carregarJobs() {
  const st = $("#jobStatus").value;
  try {
    const j = await api(`/jobs?limit=60&status=${encodeURIComponent(st)}&tenant=${encodeURIComponent(estado.operador ? "" : estado.nome)}`);
    const chips = Object.entries(j.resumo_por_status)
      .map(([k, v]) => `${k}: ${v}`).join("   ·   ");
    $("#jobsInfo").textContent = chips || "sem jobs";
    const tb = $("#jobsTabela tbody"); tb.innerHTML = "";
    for (const job of j.jobs) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="num"></td><td></td><td></td><td class="t"></td>
        <td class="st"></td><td class="num"></td><td class="miudo e"></td>`;
      tr.children[0].textContent = job.job_id;
      tr.children[1].textContent = job.tenant;
      tr.children[2].textContent = job.memoria || "(padrão)";
      tr.children[3].textContent = job.doc_id;
      const stc = tr.querySelector(".st"); stc.textContent = job.status;
      stc.className = "st " + ({ concluido: "ok", erro: "ruim", processando: "meio", na_fila: "meio" }[job.status] || "");
      tr.children[5].textContent = `${job.chunks_feitos}/${job.chunks_total}`;
      tr.querySelector(".e").textContent = (job.erro || "").slice(0, 60);
      tb.appendChild(tr);
    }
  } catch (e) { toast("jobs: " + e.message); }
}
$("#btnJobs").addEventListener("click", carregarJobs);
$("#jobStatus").addEventListener("change", carregarJobs);

// -------------------------------------------------------------------- boot --
if (estado.key && estado.nome) {
  $("#loginErro").textContent = "restaurando sessão…";
  api("/gavetas").then(g => {
    estado.operador = !!g.operador; aposLogin();
  }).catch(() => sair("sessão expirada ou chave inválida"));
}
