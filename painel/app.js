/* Minirag painel v1.11 — SPA sem build, falando a REST do próprio serviço.
   Sessão em sessionStorage com prazo de 12h. Nada de segredo em disco. */
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
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
const fmtData = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso), agora = new Date();
  const dia = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dif = Math.round((dia(agora) - dia(d)) / 86400000);
  const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (dif === 0) return "hoje " + hora;
  if (dif === 1) return "ontem " + hora;
  if (dif > 1 && dif < 7) return `há ${dif} dias`;
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
};
const onde = () => `${estado.tenant || "—"} : ${estado.memoria || "(padrão)"}`;
const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")
  .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
const esc = (s) => String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ------------------------------------------------------------------ views --
function mostrar(nome) {
  $$("main section").forEach(s => s.hidden = true);
  $("#v" + nome.charAt(0).toUpperCase() + nome.slice(1)).hidden = false;
  $$(".aba").forEach(b => b.classList.toggle("ativa", b.dataset.view === nome));
}
$$(".aba").forEach(b =>
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
async function entrar(ev) {
  if (ev) ev.preventDefault();
  const nome = $("#loginNome").value.trim(), key = $("#loginKey").value.trim();
  if (!nome || !key) { $("#loginErro").textContent = "preencha nome e segredo"; return; }
  estado.key = key;
  $("#btnEntrar").disabled = true;
  try {
    const g = await api("/gavetas");
    estado.nome = nome; estado.operador = !!g.operador;
    estado.tenant = nome; estado.memoria = "";
    sessionStorage.setItem("mr_nome", nome);
    sessionStorage.setItem("mr_key", key);
    sessionStorage.setItem("mr_op", g.operador ? "1" : "0");
    sessionStorage.setItem("mr_ts", String(Date.now()));
    guardarEscopo(); aposLogin();
  } catch (e) {
    if (e.message !== "401") $("#loginErro").textContent = e.message;
  } finally { $("#btnEntrar").disabled = false; }
}
function aposLogin() {
  document.body.classList.remove("fora");
  $("#loginErro").textContent = "";
  $("#vLogin").hidden = true;
  $("#nav").hidden = false; $("#userbox").hidden = false; $("#rodape").hidden = false;
  $("#quo").textContent = estado.nome;
  $("#chipEscopo").innerHTML = estado.operador
    ? '<span class="chip op">operador · vê tudo</span>'
    : '<span class="chip">tenant</span>';
  api("/health").then(h => $("#ver").textContent = "versão " + (h.versao || "?")).catch(() => {});
  mostrar("gavetas"); carregarGavetas();
}
function sair(msg) {
  if (estado.dirty && !confirm("há edição não salva — sair mesmo assim?")) return;
  estado.dirty = false;
  sessionStorage.clear();
  document.body.classList.add("fora");
  $("#abaEditor").hidden = true;
  $("#nav").hidden = true; $("#userbox").hidden = true; $("#rodape").hidden = true;
  $("#vLogin").hidden = false;
  $$("main section").forEach(s => s.hidden = s.id !== "vLogin");
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

// ---------------------------------------------------------------- gavetas --
async function carregarGavetas() {
  const grid = $("#gavetasGrid");
  grid.innerHTML = '<p class="dica">carregando…</p>';
  try {
    const g = await api("/gavetas");
    $("#gavetasInfo").textContent =
      `${g.gavetas.length} gaveta(s) · ${g.documentos_fonte} documento(s) com fonte guardada`;
    grid.innerHTML = "";
    if (!g.gavetas.length) {
      grid.innerHTML = '<div class="vazio"><div class="tit">Nenhuma memória ainda</div>' +
        'Crie uma nota ou envie um arquivo na aba Arquivos.</div>';
      return;
    }
    for (const gav of g.gavetas) {
      const el = document.createElement("div"); el.className = "gaveta";
      el.innerHTML = `<div class="nome"><span></span></div>
        <div class="nums"></div>
        <div class="acoesG">
          <button class="sutil mini g-x" title="baixar esta gaveta em zip">⬇ zip</button>
          <button class="perigo mini g-ap" title="apagar a gaveta inteira">apagar</button>
        </div>`;
      el.querySelector(".nome span").textContent =
        (g.operador ? gav.tenant + " ▸ " : "") + (gav.memoria || "(padrão)");
      el.querySelector(".nums").innerHTML =
        `<span><b>${gav.docs}</b> arquivo(s)</span>` +
        `<span><b>${gav.chunks}</b> chunks</span>` +
        `<span>${gav.chunks_arquivados ? gav.chunks_arquivados + " arquiv." : "tudo ativo"}</span>` +
        `<span>último ${fmtData(gav.ultimo_ingress)}</span>`;
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
  } catch (e) { grid.innerHTML = ""; toast("gavetas: " + e.message); }
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
  const tb = $("#arqTabela tbody");
  tb.innerHTML = '<tr class="linha-carregando"><td colspan="6">carregando…</td></tr>';
  try {
    const d = await api("/docs?" + qs({
      memoria: estado.memoria, tenant: estado.tenant,
      include_archived: $("#arqMostrarArq").checked ? "true" : "",
      q: $("#arqFiltro").value.trim(), limit: 500,
    }));
    tb.innerHTML = "";
    $("#arqTotal").textContent = `${d.total} arquivo(s)`;
    if (!d.docs.length) {
      tb.innerHTML = '<tr class="linha-vazia"><td colspan="6">' +
        ($("#arqFiltro").value.trim() ? "nenhum arquivo com esse filtro</td></tr>"
          : "gaveta vazia — use <b>nova nota</b> ou arraste arquivos acima</td></tr>") +
        "";
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
      tr.querySelector(".tcode").textContent = doc.doc_id;
      const tag = tr.querySelector(".tag");
      tag.classList.add(arquivado ? "arquivado" : "ativo");
      tag.textContent = arquivado ? "arquivado" : "ativo";
      tr.children[3].textContent = doc.chunks;
      tr.children[4].textContent = fmtData(doc.updated_at);
      const ac = tr.querySelector(".acoes-linha");
      const bt = (rotulo, classe, titulo, fn) => {
        const b = document.createElement("button");
        b.textContent = rotulo; b.className = classe;
        b.title = titulo; b.setAttribute("aria-label", titulo);
        b.addEventListener("click", fn);
        ac.appendChild(b); return b;
      };
      bt("abrir", "a-br", "abrir no editor", () => abrirEditor(doc.doc_id));
      bt("baixar", "", "baixar o arquivo original",
        () => comAuthBaixar(`/documents/${encodeURIComponent(doc.doc_id)}/raw?` +
          qs({ memoria: estado.memoria, tenant: estado.tenant }),
          doc.doc_id.replace(/[^\w.-]/g, "_") + ".txt").catch(e => toast(e.message)));
      bt("⧉", "", "copiar o doc_id",
        () => navigator.clipboard.writeText(doc.doc_id).then(
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
            carregarDocs();
          } catch (e) { toast(e.message); }
        });
      bt("apagar", "apagar", "apagar para sempre (chunks + fonte)",
        async () => {
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
  } catch (e) { tb.innerHTML = ""; toast("docs: " + e.message); }
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
function marcarDirty() {
  estado.dirty = true;
  $("#edStatus").innerHTML = '<span class="ponto"></span>não salvo';
}
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
      const d = await api(`/documents/${encodeURIComponent(doc_id)}?` +
        qs({ memoria: estado.memoria, tenant: estado.tenant }));
      $("#edTitulo").value = d.title || "";
      $("#edConteudo").value = d.content;
      $("#edStatus").textContent = `fonte ${d.origem} · ${d.size_bytes} bytes · ` +
        `atualizado ${fmtData(d.atualizado_em)}`;
    } catch (e) {
      $("#edStatus").textContent = "";
      $("#edConteudo").value = "";
      toast("sem fonte para abrir: " + e.message);
    }
  }
  contarPalavras();
  $("#edConteudo").focus();
}
function fecharEditor() {
  if (estado.dirty && !confirm("descartar a edição não salva?")) return;
  estado.dirty = false;
  $("#abaEditor").hidden = true;
  mostrar("arquivos"); carregarDocs();
}
$("#btnCancelarEd").addEventListener("click", fecharEditor);
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
    $("#edStatus").textContent = `reindexando ${st.chunks_feitos}/${st.chunks_total} · ${st.status}`;
    if (st.status === "concluido") { $("#edStatus").textContent = "salvo e reindexado ✓"; toast("salvo e reindexado ✓"); break; }
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
  if (!p.hidden) { p.hidden = true; ta.hidden = false; $("#btnPreview").textContent = "prévia"; return; }
  p.innerHTML = mdParaHtml(ta.value);
  p.hidden = false; ta.hidden = true;
  $("#btnPreview").textContent = "editar";
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
document.addEventListener("keydown", (e) => {
  const noEditor = !$("#vEditor").hidden;
  if (e.key === "Escape" && noEditor) { e.preventDefault(); fecharEditor(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (noEditor) $("#btnSalvar").click();
  }
});

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
      ($("#busArq").checked ? " · arquivados achados foram revividos" : "");
    box.appendChild(cab);
    if (!r.total) {
      box.innerHTML += `<div class="vazio"><div class="tit">Nada acima de ${minScore.toFixed(2)}</div>` +
        `Baixe o score mínimo — o texto pode estar lá, só fora do corte.</div>`;
      return;
    }
    for (const it of r.items) {
      const el = document.createElement("div"); el.className = "hit";
      el.innerHTML = `<div class="topo-hit"><span class="score"></span>
        <b class="t"></b><span class="meta"></span>
        <button class="sutil mini abrir-doc">abrir</button></div><p class="x"></p>`;
      el.querySelector(".score").textContent = it.score.toFixed(3);
      el.querySelector(".t").textContent = it.title || it.doc_id;
      el.querySelector(".meta").textContent = it.doc_id +
        (it.arquivado ? " · estava arquivado" : "");
      el.querySelector(".x").textContent = it.text;
      el.querySelector(".abrir-doc").addEventListener("click", () => abrirEditor(it.doc_id));
      box.appendChild(el);
    }
  } catch (e) { $("#busResultado").innerHTML = ""; toast("busca: " + e.message); }
});
$("#busQuery").addEventListener("keydown", e => e.key === "Enter" && $("#btnBuscar").click());

// -------------------------------------------------------------------- jobs --
const TAG_JOB = { concluido: "ativo", erro: "erro", processando: "processando",
  na_fila: "fila", cancelado: "arquivado" };
const ROT_JOB = { concluido: "concluído" };
async function carregarJobs() {
  const st = $("#jobStatus").value;
  const tb = $("#jobsTabela tbody");
  tb.innerHTML = '<tr class="linha-carregando"><td colspan="8">carregando…</td></tr>';
  try {
    const j = await api("/jobs?" + qs({
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
      tr.children[0].textContent = job.job_id;
      tr.children[1].textContent = job.tenant;
      tr.children[2].textContent = job.memoria || "(padrão)";
      tr.querySelector(".tcode").textContent = job.doc_id;
      const tag = tr.querySelector(".tag");
      tag.classList.add(TAG_JOB[job.status] || "fila");
      tag.textContent = ROT_JOB[job.status] || job.status.replace("_", " ");
      tr.children[5].textContent = `${job.chunks_feitos}/${job.chunks_total}`;
      const ec = tr.querySelector(".erro-cel");
      ec.textContent = job.erro || "";
      if (job.erro) ec.title = job.erro;
      const ac = tr.querySelector(".acoes-linha");
      const bt = (rotulo, classe, fn) => {
        const b = document.createElement("button");
        b.textContent = rotulo; b.className = classe;
        b.addEventListener("click", fn); ac.appendChild(b);
      };
      if (job.status === "na_fila") {
        bt("cancelar", "mini", async () => {
          try { await api(`/jobs/${job.job_id}/cancel?` +
            qs({ tenant: estado.operador ? job.tenant : "" }), { method: "POST" });
            toast("job cancelado"); carregarJobs();
          } catch (e) { toast(e.message); }
        });
      }
      if (job.status === "erro" || job.status === "cancelado") {
        bt("retentar", "mini", async () => {
          try { await api(`/jobs/${job.job_id}/retry?` +
            qs({ tenant: estado.operador ? job.tenant : "" }), { method: "POST" });
            toast("job reenfileirado"); carregarJobs();
          } catch (e) { toast(e.message); }
        });
      }
      tb.appendChild(tr);
    }
  } catch (e) { tb.innerHTML = ""; toast("jobs: " + e.message); }
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