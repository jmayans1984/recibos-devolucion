const RETURN_DAYS = 30; // Ross y Marshalls: 30 días con recibo
const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const key = s => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const money = n => (n == null || n === "" || isNaN(n)) ? "—" : "$" + Number(n).toFixed(2);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- almacenamiento ---------- */
// En este celular (IndexedDB): se usa antes de configurar Firebase y para pasar recibos viejos a la nube
const localStore = (() => {
  let dbp;
  const open = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open("recibos", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("receipts", {keyPath:"id"}); r.result.createObjectStore("photos"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = async (name, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(name, mode); const out = fn(t.objectStore(name));
      t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  };
  return {
    all: () => tx("receipts", "readonly", s => s.getAll()),
    put: r => tx("receipts", "readwrite", s => s.put(r)),
    del: id => tx("receipts", "readwrite", s => s.delete(id)),
    putPhoto: (id, blob) => tx("photos", "readwrite", s => s.put(blob, id)),
    getPhoto: id => tx("photos", "readonly", s => s.get(id)),
    delPhoto: id => tx("photos", "readwrite", s => s.delete(id)),
  };
})();

let receipts = [];
let loaded = false;
let pickedFiles = []; // {ocr: Blob grande para leer, keep: Blob liviano para guardar}
let lastOcrText = "";

const DEMO = [{
  id:"demo", demo:true, store:"Ross", storeNumber:"1234", date:new Date(Date.now()-9*864e5).toISOString().slice(0,10),
  transaction:"0456", total:32.97, items:[
    {code:"400123456789", codeKey:"400123456789", name:"KITCHENAID SPATULA SET", price:9.99, qty:1},
    {code:"400987654321", codeKey:"400987654321", name:"LEGO CLASSIC BOX", price:22.98, qty:1}
  ]
}];

let store = localStore;      // se cambia por la nube al iniciar sesión
let cloudMode = false;
let unwatch = null;
async function reload(){
  if(cloudMode){ renderAll(); return; }      // en la nube la lista se actualiza sola (onSnapshot)
  receipts = await store.all(); loaded = true; renderAll();
}

/* ---------- helpers ---------- */
function storeClass(s){ s=(s||"").toLowerCase(); return s.includes("ross")?"ross":s.includes("marsh")?"marshalls":"other"; }
function daysLeft(date){
  if(!date) return null;
  const d = new Date(date+"T12:00:00"); if(isNaN(d)) return null;
  return Math.ceil((d.getTime()+RETURN_DAYS*864e5 - Date.now())/864e5);
}
function deadlineChip(date){
  const n = daysLeft(date);
  if(n==null) return "";
  if(n<0) return `<span class="chip bad">Vencido hace ${-n} d</span>`;
  if(n<=7) return `<span class="chip warn">Quedan ${n} d</span>`;
  return `<span class="chip ok">Quedan ${n} d</span>`;
}
function fmtDate(d){
  if(!d) return "sin fecha";
  const x = new Date(d+"T12:00:00"); if(isNaN(x)) return d;
  return x.toLocaleDateString("es-US",{day:"numeric",month:"short",year:"numeric"});
}
function highlight(code, q){
  const c = String(code||""); if(!q) return esc(c);
  let map=[], k=""; for(let i=0;i<c.length;i++){ const ch=c[i].toUpperCase(); if(/[A-Z0-9]/.test(ch)){ map.push(i); k+=ch; } }
  const at = k.indexOf(q); if(at<0) return esc(c);
  const s = map[at], e = map[at+q.length-1]+1;
  return esc(c.slice(0,s)) + "<mark>" + esc(c.slice(s,e)) + "</mark>" + esc(c.slice(e));
}
function sorted(list){ return [...list].sort((a,b)=>(b.date||"").localeCompare(a.date||"") || (b.createdAt||"").localeCompare(a.createdAt||"")); }
// El número que se anota a lápiz en el papel del recibo, para encontrarlo rápido después.
function nextReceiptNumber(){ return receipts.reduce((m,r)=>Math.max(m, Number(r.number)||0), 0) + 1; }
function setStatus(el, text, err){ el.className = "status" + (err ? " err" : ""); el.innerHTML = text; }

/* ---------- pestañas ---------- */
function go(tab){
  document.querySelectorAll("section[data-tab]").forEach(s => s.hidden = s.dataset.tab !== tab);
  document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.go===tab)));
  $("#searchBox").hidden = tab === "escanear"; // en Escanear solo se captura el recibo, no se busca
  try{ localStorage.setItem("tab", tab); }catch(e){}
}
document.querySelectorAll("nav.tabs button").forEach(b => b.onclick = () => go(b.dataset.go));
// en el celular la barra de abajo sube con el teclado y tapa botones: se esconde mientras escribes
document.addEventListener("focusin", e => { if(e.target.matches("input,textarea,select")) document.body.classList.add("typing"); });
document.addEventListener("focusout", () => setTimeout(() => { if(!document.activeElement?.matches?.("input,textarea,select")) document.body.classList.remove("typing"); }, 50));

/* ---------- búsqueda ---------- */
function renderResults(){
  const raw = $("#q").value.trim();
  $("#qClear").hidden = !raw;
  const q = key(raw);
  const out = $("#results");
  const src = receipts.length ? receipts : DEMO;
  if(!raw){
    if(!loaded){ out.innerHTML = `<div class="empty">Cargando recibos…</div>`; return; }
    if(!receipts.length){
      out.innerHTML = `<div class="empty"><div class="demo-tag">Ejemplo</div>Aún no tienes recibos guardados. Ve a <b>Escanear</b>, toma la foto y la app guardará cada código, nombre y precio. Luego escribe aquí el código de la etiqueta. Prueba con <span class="mono">4001</span> para ver cómo se ve.</div>`;
      return;
    }
    out.innerHTML = `<div class="label">Últimos recibos</div>` + sorted(receipts).slice(0,5).map(receiptRow).join("");
    bindReceiptRows(out); return;
  }
  const words = raw.toLowerCase().split(/\s+/).filter(Boolean);
  // el número que se anotó a lápiz en el papel: búsqueda exacta o por si empieza igual
  const numHits = /^\d{1,6}$/.test(raw) ? src.filter(r => r.number != null && String(r.number).startsWith(raw)) : [];
  const hits = [];
  for(const r of src){
    (r.items||[]).forEach((it, idx) => {
      const byCode = q.length>=2 && (it.codeKey||key(it.code)).includes(q);
      const byName = /[a-z]/i.test(raw) && words.every(w => (it.name||"").toLowerCase().includes(w));
      if(byCode || byName) hits.push({r, it, idx});
    });
  }
  hits.sort((a,b)=>(b.r.date||"").localeCompare(a.r.date||""));
  if(!hits.length && !numHits.length){ out.innerHTML = `<div class="empty">Ningún producto con “${esc(raw)}”. Revisa el código o busca solo los últimos 4 a 6 dígitos.</div>`; return; }
  let html = "";
  if(numHits.length) html += `<div class="label">Recibo${numHits.length>1?"s":""} con ese número</div>` + numHits.map(receiptRow).join("");
  html += hits.length ? `<div class="label">${hits.length} coincidencia${hits.length>1?"s":""}${receipts.length?"":" · ejemplo"}</div>` + hits.map(({r,it,idx}) => `
    <button class="hit" data-r="${esc(r.id)}" data-i="${idx}">
      <span class="code">${highlight(it.code, q)}</span>
      <span class="price">${money(it.price)}</span>
      <span class="name">${esc(it.name)}${it.qty>1?` <span class="mono" style="color:var(--muted)">×${it.qty}</span>`:""}</span>
      <span class="meta">
        <span class="chip ${storeClass(r.store)}">${esc(r.store||"Tienda")}${r.storeNumber?" #"+esc(r.storeNumber):""}</span>
        <span>${fmtDate(r.date)}</span>
        ${it.returned?`<span class="chip done">Ya devuelto</span>`:deadlineChip(r.date)}
      </span>
    </button>`).join("") : "";
  out.innerHTML = html;
  bindReceiptRows(out);
  out.querySelectorAll(".hit").forEach(b => b.onclick = () => openReceipt(b.dataset.r, Number(b.dataset.i)));
}
$("#q").addEventListener("input", renderResults);
$("#qClear").onclick = () => { $("#q").value=""; renderResults(); $("#q").focus(); };

/* ---------- lista de recibos ---------- */
function receiptRow(r){
  const n = (r.items||[]).length;
  return `<button class="rcpt" data-r="${esc(r.id)}">
    <span class="l"><span class="t">${r.number!=null?`<span class="recnum">#${r.number}</span> `:""}<span class="chip ${storeClass(r.store)}">${esc(r.store||"Tienda")}</span> ${fmtDate(r.date)}</span>
    <span class="s">${n} producto${n===1?"":"s"}${r.storeNumber?" · tienda #"+esc(r.storeNumber):""} ${deadlineChip(r.date)}</span></span>
    <span class="r">${money(r.total)}</span></button>`;
}
function bindReceiptRows(el){ el.querySelectorAll(".rcpt").forEach(b => b.onclick = () => openReceipt(b.dataset.r)); }
function renderReceiptList(){
  const el = $("#receiptList");
  if(!receipts.length){ el.innerHTML = `<div class="empty">No hay recibos guardados todavía.</div>`; return; }
  el.innerHTML = sorted(receipts).map(receiptRow).join("");
  bindReceiptRows(el);
}
function renderAll(){
  $("#count").textContent = loaded ? `${receipts.length} recibo${receipts.length===1?"":"s"} · ${receipts.reduce((s,r)=>s+(r.items||[]).length,0)} productos` : "";
  renderResults(); renderReceiptList();
}

/* ---------- hoja de detalle ---------- */
let sheetUrls = [];
function openSheet(html){ closeUrls(); $("#panel").innerHTML = html; $("#sheet").classList.add("open"); $("#panel").scrollTop = 0; }
function closeUrls(){ sheetUrls.forEach(u => URL.revokeObjectURL(u)); sheetUrls = []; }
function closeSheet(){ $("#sheet").classList.remove("open"); $("#panel").innerHTML = ""; closeUrls(); }
$("#sheet").addEventListener("click", e => { if(e.target.id==="sheet") closeSheet(); });

// Vista de pantalla completa, con fondo blanco, para mostrar el código de barras al cajero.
function openBarcodeFull(url){ $("#bcImg").src = url; $("#barcodeFull").classList.add("open"); }
function closeBarcodeFull(){ $("#barcodeFull").classList.remove("open"); $("#bcImg").src = ""; }
$("#bcClose").onclick = closeBarcodeFull;
$("#barcodeFull").addEventListener("click", e => { if(e.target.id==="barcodeFull") closeBarcodeFull(); });

async function openReceipt(id, matchIdx){
  const r = receipts.find(x=>x.id===id) || DEMO.find(x=>x.id===id); if(!r) return;
  const q = key($("#q").value);
  const due = r.date ? fmtDate(new Date(new Date(r.date+"T12:00:00").getTime()+RETURN_DAYS*864e5).toISOString().slice(0,10)) : "—";
  openSheet(`
    <div class="bar"><h2>${r.number!=null?`<span class="recnum big">#${r.number}</span> `:""}<span class="chip ${storeClass(r.store)}">${esc(r.store||"Tienda")}</span> ${fmtDate(r.date)}</h2><button class="x-btn" data-close aria-label="Cerrar">×</button></div>
    ${r.demo?`<p class="demo-tag">Recibo de ejemplo, no está guardado</p>`:""}
    ${r.number!=null?`<p class="hint" style="margin-top:0">Anota <b class="mono">#${r.number}</b> con lápiz en el papel del recibo para encontrarlo rápido después.</p>`:""}
    <div class="photos" id="photos"></div>
    ${r.barcodePhoto?`<div class="row"><button class="btn ghost" data-showbarcode>Mostrar código de barras</button></div>`:""}
    <div class="label">Productos</div>
    <div class="lines">${(r.items||[]).map((it,i)=>`
      <div class="line ${i===matchIdx || (q.length>=2 && (it.codeKey||"").includes(q)) ? "match":""} ${it.returned?"returned":""}">
        <span><span class="lc">${esc(it.code)}</span><button class="copy" data-copy="${esc(it.code)}">copiar</button></span>
        <span class="lp">${money(it.price)}${it.qty>1?` ×${it.qty}`:""}</span>
        <span class="ln">${esc(it.name)}</span>
        ${r.demo?"":`<button class="tog ${it.returned?"on":""}" data-tog="${i}">${it.returned?"Devuelto ✓":"Marcar devuelto"}</button>`}
      </div>`).join("")}
    </div>
    <div class="label">Detalles del recibo</div>
    <dl class="kv">
      <dt>Tienda #</dt><dd>${esc(r.storeNumber||"—")}</dd>
      <dt>Fecha / hora</dt><dd>${esc(r.date||"—")} ${esc(r.time||"")}</dd>
      <dt>Transacción</dt><dd>${esc(r.transaction||"—")}</dd>
      <dt>Pago</dt><dd>${esc(r.payment||"—")}</dd>
      ${r.cardName?`<dt>Pagado con</dt><dd>${esc(r.cardName)}</dd>`:""}
      <dt>Subtotal</dt><dd>${money(r.subtotal)}</dd>
      <dt>Impuesto</dt><dd>${money(r.tax)}</dd>
      <dt>Total</dt><dd><b>${money(r.total)}</b></dd>
      <dt>Devolver antes de</dt><dd>${due}</dd>
    </dl>
    ${r.demo?"":`<div class="row" style="margin-top:14px">
      <button class="btn ghost" data-edit>Editar</button>
      <button class="btn danger" data-del>Borrar recibo</button>
    </div>`}
  `);
  const p = $("#panel");
  p.querySelector("[data-close]").onclick = closeSheet;
  for(const pid of (r.photos||[])){
    const blob = await store.getPhoto(pid).catch(()=>null);
    if(blob){ const u = URL.createObjectURL(blob); sheetUrls.push(u); const img = new Image(); img.src = u; img.alt = "Foto del recibo"; p.querySelector("#photos")?.append(img); }
  }
  p.querySelectorAll("[data-copy]").forEach(b => b.onclick = async () => {
    try{ await navigator.clipboard.writeText(b.dataset.copy); b.textContent="copiado"; }catch(e){ b.textContent="no se pudo copiar"; }
    setTimeout(()=>b.textContent="copiar",1500);
  });
  const showBc = p.querySelector("[data-showbarcode]");
  if(showBc) showBc.onclick = async () => {
    const blob = await store.getPhoto(r.barcodePhoto).catch(()=>null);
    if(!blob){ showBc.textContent = "No se encontró la foto guardada."; return; }
    const u = URL.createObjectURL(blob); sheetUrls.push(u);
    openBarcodeFull(u);
  };
  p.querySelectorAll("[data-tog]").forEach(b => b.onclick = async () => {
    const i = Number(b.dataset.tog);
    r.items[i].returned = !r.items[i].returned;
    await store.put(r); await reload(); openReceipt(r.id, matchIdx);
  });
  const del = p.querySelector("[data-del]");
  if(del) del.onclick = async () => {
    if(del.dataset.armed!=="1"){ del.dataset.armed="1"; del.textContent="Toca otra vez para borrar"; return; }
    await store.del(r.id);
    for(const pid of (r.photos||[])) await store.delPhoto(pid).catch(()=>{});
    if(r.barcodePhoto) await store.delPhoto(r.barcodePhoto).catch(()=>{});
    closeSheet(); await reload();
  };
  const ed = p.querySelector("[data-edit]");
  if(ed) ed.onclick = () => openEditor(structuredClone(r), r.id);
}

/* ---------- editor (revisar antes de guardar) ---------- */
function openEditor(data, existingId, rawText){
  data.items = data.items?.length ? data.items : [{code:"",name:"",price:"",qty:1}];
  const itemHtml = (it,i) => `
    <div class="item" data-i="${i}">
      <input class="c" id="ic${i}" value="${esc(it.code)}" placeholder="Código" aria-label="Código" inputmode="numeric">
      <input class="p" id="ip${i}" value="${it.price ?? ""}" inputmode="decimal" placeholder="Precio" aria-label="Precio unitario">
      <input class="n" id="in${i}" value="${esc(it.name)}" placeholder="Nombre del producto" aria-label="Nombre">
      <button class="x" data-rm="${i}" aria-label="Quitar producto">×</button>
    </div>`;
  const stores = ["Ross","Marshalls","TJ Maxx","HomeGoods","Otra"];
  openSheet(`
    <div class="bar"><h2>${existingId?"Editar recibo":"Revisa y guarda"}</h2><button class="x-btn" data-close aria-label="Cerrar">×</button></div>
    ${existingId?"":`<p class="hint" style="margin-top:0">Compara con el papel y corrige cualquier código o precio antes de guardar. El lector puede confundir algunos dígitos.</p>`}
    <div class="grid2">
      <div class="field"><label for="fStore">Tienda</label>
        <select id="fStore">${stores.map(s=>`<option ${s===data.store?"selected":""}>${s}</option>`).join("")}</select></div>
      <div class="field"><label for="fDate">Fecha</label><input id="fDate" type="date" value="${esc(data.date||"")}"></div>
      <div class="field"><label for="fNum">Tienda #</label><input id="fNum" value="${esc(data.storeNumber||"")}"></div>
      <div class="field"><label for="fTotal">Total</label><input id="fTotal" inputmode="decimal" value="${data.total ?? ""}"></div>
      <div class="field"><label for="fCardName">Pagado con (nombre)</label><input id="fCardName" placeholder="Ej. Tarjeta de Juan" value="${esc(data.cardName||"")}"></div>
      <div class="field"><label for="fPayment">Tarjeta (solo los últimos 4)</label><input id="fPayment" inputmode="numeric" placeholder="Ej. VISA 1234" value="${esc(data.payment||"")}"></div>
    </div>
    <p class="hint" id="cardWarn" style="margin-top:-6px" hidden>Por tu seguridad, escribe solo los últimos 4 dígitos (así los imprime el recibo) — nunca el número completo de la tarjeta.</p>
    <div class="label">Productos (<span id="nItems">${data.items.length}</span>)</div>
    <div class="items" id="items">${data.items.map(itemHtml).join("")}</div>
    <div class="status" id="sumCheck"></div>
    <div class="row" style="margin-top:10px"><button class="btn ghost" id="addItem">+ Agregar producto</button></div>

    <div class="label" style="margin-top:22px">Código de barras (opcional)</div>
    <p class="hint" style="margin-top:0">Para mostrarlo en la tienda al hacer la devolución, sin buscar todo el recibo.</p>
    <div id="barcodeWrap"></div>
    <input id="barcodeFile" type="file" accept="image/*" capture="environment" hidden>

    <div class="row" style="margin-top:14px"><button class="btn primary" id="saveBtn">Guardar recibo</button></div>
    <div class="status" id="saveStatus"></div>
    ${rawText?`<details class="raw"><summary>Ver el texto que se leyó de la foto</summary><pre>${esc(rawText)}</pre></details>`:""}
  `);
  const p = $("#panel");
  const collect = () => {
    data.items = [...p.querySelectorAll(".item")].map(el => {
      const i = el.dataset.i, old = data.items[i] || {};
      return {...old, code:$("#ic"+i).value.trim(), name:$("#in"+i).value.trim(), price:$("#ip"+i).value.trim()};
    });
  };
  const rerender = () => { $("#items").innerHTML = data.items.map(itemHtml).join(""); $("#nItems").textContent = data.items.length; bindRm(); sumCheck(); };
  const bindRm = () => p.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { collect(); data.items.splice(Number(b.dataset.rm),1); rerender(); });
  bindRm();
  // compara la suma de los productos con el subtotal impreso para detectar productos que faltan o precios mal leídos
  const sumCheck = () => {
    const el = $("#sumCheck"); if(data.subtotal == null){ el.textContent = ""; return; }
    let sum = 0;
    p.querySelectorAll(".item").forEach(it => { const i = it.dataset.i; sum += (Number(String($("#ip"+i).value).replace(/[^0-9.\-]/g,""))||0) * (Number(data.items[i]?.qty)||1); });
    sum = Math.round(sum*100)/100;
    const diff = Math.round((data.subtotal - sum)*100)/100;
    el.className = "status" + (Math.abs(diff) < 0.01 ? "" : " err");
    el.innerHTML = Math.abs(diff) < 0.01
      ? `✓ La suma de los productos (${money(sum)}) cuadra con el subtotal del recibo.`
      : `La suma de los productos (${money(sum)}) no cuadra con el subtotal del recibo (${money(data.subtotal)}): ${diff>0?`faltan ${money(diff)}`:`sobran ${money(-diff)}`}. Revisa si falta un producto o algún precio está mal.`;
  };
  $("#items").addEventListener("input", sumCheck);
  sumCheck();
  p.querySelector("[data-close]").onclick = closeSheet;
  $("#addItem").onclick = () => { collect(); data.items.push({code:"",name:"",price:"",qty:1}); rerender(); $("#ic"+(data.items.length-1)).focus(); };

  // Por seguridad nunca se guarda el número completo de una tarjeta: un recibo real solo
  // llega a imprimir los últimos 4 dígitos, así que si se escribe o pega una fila más larga
  // de dígitos, se recorta sola a esos últimos 4.
  const CARD_RUN = /\d[\d \-]{11,}\d/;
  const stripCardNumber = el => { const m = el.value.match(CARD_RUN); if(m) el.value = el.value.slice(0, m.index) + m[0].replace(/\D/g,"").slice(-4) + el.value.slice(m.index + m[0].length); return !!m; };
  $("#fPayment").addEventListener("input", () => {
    const el = $("#fPayment"), pos = el.selectionStart, had = stripCardNumber(el);
    $("#cardWarn").hidden = !had;
    if(had) el.setSelectionRange(Math.min(pos, el.value.length), Math.min(pos, el.value.length));
  });

  // ---- foto del código de barras (por separado de las fotos del recibo) ----
  let barcodeBlob = null, barcodeExistingId = data.barcodePhoto || null, barcodeRemoved = false;
  function renderBarcode(){
    const wrap = $("#barcodeWrap"); if(!wrap) return;
    if(barcodeBlob){
      wrap.innerHTML = `<div class="barcodeBox"><img src="${URL.createObjectURL(barcodeBlob)}" alt="Código de barras"><span class="info">Se guardará con el recibo.</span><button class="btn ghost" id="bcRemove" style="height:36px">Quitar</button></div>`;
      $("#bcRemove").onclick = () => { barcodeBlob = null; renderBarcode(); };
    } else if(barcodeExistingId && !barcodeRemoved){
      wrap.innerHTML = `<div class="barcodeBox"><span class="mono" style="color:var(--muted)">Cargando…</span></div>`;
      const myId = barcodeExistingId;
      store.getPhoto(myId).then(blob => {
        if(barcodeExistingId !== myId || barcodeRemoved || barcodeBlob) return; // se cambió mientras cargaba
        wrap.innerHTML = blob
          ? `<div class="barcodeBox"><img src="${URL.createObjectURL(blob)}" alt="Código de barras"><span class="info">Ya guardado con este recibo.</span><button class="btn ghost" id="bcRemove" style="height:36px">Quitar</button></div>`
          : `<label class="barcodeAdd" for="barcodeFile">+ Agregar foto del código de barras</label>`;
        if($("#bcRemove")) $("#bcRemove").onclick = () => { barcodeRemoved = true; renderBarcode(); };
      }).catch(() => { wrap.innerHTML = `<label class="barcodeAdd" for="barcodeFile">+ Agregar foto del código de barras</label>`; });
    } else {
      wrap.innerHTML = `<label class="barcodeAdd" for="barcodeFile">+ Agregar foto del código de barras</label>`;
    }
  }
  renderBarcode();
  $("#barcodeFile").addEventListener("change", async e => {
    const f = e.target.files[0]; if(!f) return;
    try{ barcodeBlob = (await prepare(f)).keep; barcodeRemoved = false; renderBarcode(); }
    catch(err){ setStatus($("#saveStatus"), "Esa foto no se pudo abrir. Prueba con otra.", true); }
    e.target.value = "";
  });

  $("#saveBtn").onclick = async () => {
    collect();
    const items = data.items.filter(it => it.code || it.name).map(it => ({
      code:it.code, codeKey:key(it.code), name:it.name,
      price: it.price===""||it.price==null ? null : Number(String(it.price).replace(/[^0-9.\-]/g,"")),
      qty: Number(it.qty)||1, returned: !!it.returned
    }));
    if(!items.length){ setStatus($("#saveStatus"), "Agrega al menos un producto con su código.", true); return; }
    $("#saveBtn").disabled = true; setStatus($("#saveStatus"), `<span class="spinner"></span>Guardando…`);
    try{
      const id = existingId || uid();
      const photoIds = [...(data.photos||[])];
      for(const b of (data.newPhotos||[])){ const pid = uid(); await store.putPhoto(pid, b); photoIds.push(pid); }
      let barcodePhoto = barcodeExistingId;
      if(barcodeBlob){ barcodePhoto = uid(); await store.putPhoto(barcodePhoto, barcodeBlob); if(barcodeExistingId) await store.delPhoto(barcodeExistingId).catch(()=>{}); }
      else if(barcodeRemoved){ if(barcodeExistingId) await store.delPhoto(barcodeExistingId).catch(()=>{}); barcodePhoto = null; }
      // el número que se anota a lápiz en el papel: se asigna solo una vez, al primer intento de guardar
      if(!existingId && data.number == null) data.number = nextReceiptNumber();
      stripCardNumber($("#fPayment")); // última barrera: nunca guardar un número de tarjeta completo
      await store.put({
        id, number: data.number ?? null, store:$("#fStore").value, date:$("#fDate").value||null, storeNumber:$("#fNum").value.trim()||null,
        total: $("#fTotal").value.trim()==="" ? null : Number($("#fTotal").value.replace(/[^0-9.\-]/g,"")),
        time:data.time??null, transaction:data.transaction??null, subtotal:data.subtotal??null, tax:data.tax??null,
        payment:$("#fPayment").value.trim().slice(0,40)||null, cardName:$("#fCardName").value.trim().slice(0,60)||null,
        photos:photoIds, barcodePhoto, items, createdAt:data.createdAt||new Date().toISOString()
      });
      closeSheet(); resetScan(); $("#pasteBox").value = "";
      $("#q").value = ""; go("buscar"); await reload();
      setStatus($("#scanStatus"), ""); setStatus($("#pasteStatus"), "");
    }catch(e){
      $("#saveBtn").disabled = false;
      setStatus($("#saveStatus"), "No se pudo guardar. Revisa que el celular tenga espacio libre.", true);
    }
  };
}

/* ---------- fotos ---------- */
async function loadImage(file){
  const url = URL.createObjectURL(file);
  try{ return await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=url; }); }
  finally{ setTimeout(()=>URL.revokeObjectURL(url), 1000); }
}
function toBlob(canvas, q){ return new Promise(res => canvas.toBlob(res, "image/jpeg", q)); }
// Guarda una versión liviana de la foto; la lectura se hace luego en varios tamaños
async function prepare(file){
  const img = await loadImage(file);
  const W = img.naturalWidth, H = img.naturalHeight;
  const keepS = Math.min(1, 1400/Math.max(W,H));
  const k = document.createElement("canvas"); k.width = Math.round(W*keepS); k.height = Math.round(H*keepS);
  k.getContext("2d").drawImage(img,0,0,k.width,k.height);
  let keep = await toBlob(k, 0.72);
  if(keep.size > 600000) keep = await toBlob(k, 0.5);
  return {src:file, keep};
}
// Escala la foto para que el lado corto mida `width` px (el lector lee mejor a cierto tamaño de letra)
async function scaled(file, width){
  const img = await loadImage(file);
  const W = img.naturalWidth, H = img.naturalHeight;
  const s = Math.min(3, width/Math.min(W,H), 4200/Math.max(W,H));
  const c = document.createElement("canvas"); c.width = Math.round(W*s); c.height = Math.round(H*s);
  c.getContext("2d").drawImage(img,0,0,c.width,c.height);
  return toBlob(c, 0.92);
}
function resetScan(){ pickedFiles=[]; renderThumbs(); $("#readBtn").disabled=true; $("#file").value=""; $("#prog").hidden = true; }
// Miniaturas de las fotos del recibo, cada una con su botón para quitarla, y al final
// un botón para agregar otra sin perder las que ya se tomaron.
function renderThumbs(){
  $("#thumbs").innerHTML = pickedFiles.map((p,i)=>`<span class="thumb"><img src="${URL.createObjectURL(p.keep)}" alt="Foto ${i+1} del recibo"><button class="rm" data-rmphoto="${i}" aria-label="Quitar esta foto">×</button></span>`).join("")
    + `<label class="thumb" for="file"><span class="addMore" aria-label="Agregar otra foto">+</span></label>`;
  $("#thumbs").querySelectorAll("[data-rmphoto]").forEach(b => b.onclick = () => {
    pickedFiles.splice(Number(b.dataset.rmphoto), 1);
    renderThumbs();
    $("#readBtn").disabled = !pickedFiles.length;
    if(!pickedFiles.length) setStatus($("#scanStatus"), "");
  });
  renderBigPreview();
}
// Foto grande del Plan B: el celular reconoce el texto de una foto mostrada en la
// página igual que en la galería, así que no hace falta guardarla antes.
function renderBigPreview(){
  const el = $("#bigPhotos"); if(!el) return;
  el.innerHTML = pickedFiles.length
    ? pickedFiles.map((p,i)=>`<img src="${URL.createObjectURL(p.keep)}" alt="Foto ${i+1} del recibo, mantén presionado para copiar el texto">`).join("")
    : `<p class="hint empty" style="margin:0">Toma la foto arriba y aparecerá aquí para copiar el texto.</p>`;
  $("#bigPhotosHint").textContent = pickedFiles.length
    ? "Si no aparece esa opción sobre la foto de arriba: abre la foto en Fotos (iPhone) o Google Fotos (Android) y hazlo ahí igual."
    : "Si prefieres, puedes seguir usando la foto guardada en Fotos (iPhone) o Google Fotos (Android).";
}

$("#file").addEventListener("change", async e => {
  const files = [...e.target.files]; if(!files.length) return;
  setStatus($("#scanStatus"), `<span class="spinner"></span>Preparando fotos…`);
  for(const f of files){
    try{ pickedFiles.push(await prepare(f)); }catch(err){ setStatus($("#scanStatus"), "Una foto no se pudo abrir. Prueba con otra.", true); }
  }
  renderThumbs();
  $("#readBtn").disabled = !pickedFiles.length;
  if(pickedFiles.length) setStatus($("#scanStatus"), `${pickedFiles.length} foto${pickedFiles.length>1?"s":""} lista${pickedFiles.length>1?"s":""}. Toca “Leer recibo”.`);
  $("#file").value="";
});
$("#manualBtn").onclick = () => openEditor({store:"Ross", date:new Date().toISOString().slice(0,10), items:[], newPhotos:pickedFiles.map(p=>p.keep)});

/* ---------- OCR en el celular (Tesseract) ---------- */
let workerP = null;
function loadScript(src){ return new Promise((res,rej)=>{ const s=document.createElement("script"); s.src=src; s.onload=res; s.onerror=()=>rej(new Error("script")); document.head.append(s); }); }
function setProg(f){ const el=$("#prog"); el.hidden=false; el.firstElementChild.style.width = Math.round(f*100)+"%"; }
let progBase = 0, progSpan = 1, progLabel = "";
function getWorker(){
  return workerP ||= (async () => {
    if(!window.Tesseract) await loadScript(TESSERACT_URL);
    const w = await Tesseract.createWorker("eng", 1, {
      logger: m => {
        if(m.status === "recognizing text") setProg(progBase + progSpan*m.progress);
        else if(/loading|initializ/i.test(m.status)) setStatus($("#scanStatus"), `<span class="spinner"></span>Preparando el lector (solo la primera vez tarda más)…`);
      }
    });
    await w.setParameters({ tessedit_pageseg_mode: "4", preserve_interword_spaces: "1" });
    return w;
  })().catch(e => { workerP = null; throw e; });
}

// Intentos de lectura, del que mejor funcionó en recibos reales de Ross y Marshalls al siguiente.
// Se queda con el que más cuadra con el subtotal impreso; si uno cuadra exacto, para ahí.
const OCR_TRIES = [{width:1800, psm:"4"}, {width:1400, psm:"4"}, {width:1800, psm:"6"}];
const itemsSum = d => Math.round(d.items.reduce((s,it)=>s+(Number(it.price)||0)*(Number(it.qty)||1),0)*100)/100;
function rank(d){
  const n = d.items.length;
  if(d.subtotal == null) return [0, n];
  return [-Math.abs(itemsSum(d) - d.subtotal), n];
}
const better = (a, b) => !b || a[0] > b[0] + 0.001 || (Math.abs(a[0]-b[0]) <= 0.001 && a[1] > b[1]);

$("#readBtn").onclick = async () => {
  if(!pickedFiles.length) return;
  const btn = $("#readBtn"), st = $("#scanStatus");
  btn.disabled = true; setProg(0);
  try{
    setStatus(st, `<span class="spinner"></span>Preparando el lector…`);
    const w = await getWorker();
    let best = null, bestScore = null, bestText = "";
    const attempts = []; // las lecturas que se van descartando, por si sirven para recuperar un producto
    const steps = OCR_TRIES.length * pickedFiles.length;
    for(let t=0; t<OCR_TRIES.length; t++){
      const tr = OCR_TRIES[t];
      await w.setParameters({ tessedit_pageseg_mode: tr.psm });
      const texts = [], parts = [];
      for(let i=0;i<pickedFiles.length;i++){
        progBase = (t*pickedFiles.length + i)/steps; progSpan = 1/steps;
        setStatus(st, `<span class="spinner"></span>Leyendo el recibo${t?` (intento ${t+1} de ${OCR_TRIES.length}, para mejorar la lectura)`:""}${pickedFiles.length>1?` — foto ${i+1} de ${pickedFiles.length}`:""}…`);
        const { data } = await w.recognize(await scaled(pickedFiles[i].src, tr.width));
        texts.push(data.text); parts.push(ReceiptParser.parse(data.text));
      }
      // se combinan por separado (no todo el texto junto) para poder quitar los productos
      // que se repiten cuando dos fotos de un recibo largo se solapan
      const parsed = ReceiptParser.mergeParsed(parts), text = texts.join("\n\n--- foto siguiente ---\n\n"), sc = rank(parsed);
      attempts.push(parsed);
      if(better(sc, bestScore)){ best = parsed; bestScore = sc; bestText = text; }
      if(best.subtotal != null && best.items.length && Math.abs(itemsSum(best) - best.subtotal) < 0.01) break;
    }
    // El código de barras del recibo (arriba del todo, en Ross) suele pegarse a la línea del
    // primer producto y el lector confunde sus dígitos con letras, así que ese producto no sale.
    // Si la suma no cuadra con el subtotal, se busca en las otras lecturas un producto que
    // explique justo lo que falta, y se agrega arriba de la lista.
    if(best.subtotal != null && best.items.length){
      const diff = Math.round((best.subtotal - itemsSum(best)) * 100) / 100;
      if(Math.abs(diff) > 0.01){
        const known = new Set(best.items.map(it => key(it.code) + "|" + Number(it.price).toFixed(2)));
        outer: for(const a of attempts){
          if(a === best) continue;
          for(const it of a.items){
            const k = key(it.code) + "|" + Number(it.price).toFixed(2);
            if(!known.has(k) && Math.abs((it.price * (it.qty||1)) - diff) < 0.01){
              best.items.unshift(it); break outer;
            }
          }
        }
      }
    }
    setProg(1);
    lastOcrText = bestText;
    const data = best;
    data.newPhotos = pickedFiles.map(p=>p.keep);
    if(!data.items.length){
      setStatus(st, "No encontré productos con código y precio. Revisa el texto leído, toma la foto más cerca y derecha, o usa el Plan B de abajo.", true);
    } else {
      setStatus(st, `Encontré ${data.items.length} producto${data.items.length===1?"":"s"}. Revisa antes de guardar.`);
    }
    openEditor(data, null, lastOcrText);
  }catch(e){
    setStatus(st, navigator.onLine === false
      ? "La primera vez necesitas internet para descargar el lector. Conéctate e intenta otra vez."
      : "No se pudo leer la foto. Intenta otra vez o usa el Plan B de abajo.", true);
  }finally{ btn.disabled = !pickedFiles.length; }
};

/* ---------- Plan B: texto pegado ---------- */
$("#pasteBtn").onclick = () => {
  const t = $("#pasteBox").value.trim(), st = $("#pasteStatus");
  if(t.length < 10){ setStatus(st, "Primero pega el texto del recibo en el cuadro de arriba.", true); $("#pasteBox").focus(); return; }
  $("#pasteBox").blur();
  const data = ReceiptParser.parse(t);
  data.newPhotos = pickedFiles.map(p=>p.keep);
  setStatus(st, data.items.length ? `Encontré ${data.items.length} producto${data.items.length===1?"":"s"}. Revisa antes de guardar.` : "No encontré productos con código y precio; agrégalos a mano en la siguiente pantalla.", !data.items.length);
  openEditor(data, null, t);
};

/* ---------- respaldo ---------- */
const blobToDataURL = b => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
$("#exportBtn").onclick = async () => {
  const st = $("#backupStatus");
  setStatus(st, `<span class="spinner"></span>Preparando respaldo…`);
  const photos = {};
  for(const r of receipts) for(const pid of [...(r.photos||[]), r.barcodePhoto].filter(Boolean)){ const b = await store.getPhoto(pid).catch(()=>null); if(b) photos[pid] = await blobToDataURL(b); }
  const json = JSON.stringify({app:"recibos-devolucion", version:1, exportedAt:new Date().toISOString(), receipts, photos});
  const name = `recibos-respaldo-${new Date().toISOString().slice(0,10)}.json`;
  const file = new File([json], name, {type:"application/json"});
  try{
    if(navigator.canShare?.({files:[file]})){ await navigator.share({files:[file], title:"Respaldo de recibos"}); setStatus(st, "Respaldo listo."); return; }
  }catch(e){ if(e?.name === "AbortError"){ setStatus(st, ""); return; } }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name; document.body.append(a); a.click(); a.remove();
  setStatus(st, `Respaldo descargado: ${name}`);
};
$("#importBtn").onclick = () => $("#importFile").click();
$("#importFile").addEventListener("change", async e => {
  const f = e.target.files[0]; if(!f) return; const st = $("#backupStatus");
  try{
    const data = JSON.parse(await f.text());
    if(data.app !== "recibos-devolucion" || !Array.isArray(data.receipts)) throw new Error("formato");
    for(const [pid, url] of Object.entries(data.photos||{})){ const b = await (await fetch(url)).blob(); await store.putPhoto(pid, b); }
    for(const r of data.receipts) await store.put(r);
    await reload();
    setStatus(st, `Listo: se cargaron ${data.receipts.length} recibos.`);
  }catch(err){ setStatus(st, "Ese archivo no es un respaldo de esta app.", true); }
  e.target.value = "";
});

/* ---------- cuenta en la nube (Firebase) ---------- */
// Achica una foto (de respaldos o recibos viejos) para que quepa en un documento de Firestore
async function fitPhoto(blob){
  if(blob.size <= 600000) return blob;
  const img = await loadImage(blob);
  const s = Math.min(1, 1400/Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth*s); c.height = Math.round(img.naturalHeight*s);
  c.getContext("2d").drawImage(img,0,0,c.width,c.height);
  let b = await toBlob(c, 0.6); if(b.size > 600000) b = await toBlob(c, 0.4);
  return b;
}
const AUTH_ERR = {
  "auth/invalid-email":"Ese correo no es válido.",
  "auth/missing-password":"Escribe tu contraseña.",
  "auth/weak-password":"La contraseña debe tener al menos 6 caracteres.",
  "auth/email-already-in-use":"Ya existe una cuenta con ese correo. Toca “Entrar”.",
  "auth/invalid-credential":"Correo o contraseña incorrectos.",
  "auth/wrong-password":"Correo o contraseña incorrectos.",
  "auth/user-not-found":"No hay cuenta con ese correo. Toca “Crear cuenta”.",
  "auth/too-many-requests":"Demasiados intentos. Espera unos minutos.",
  "auth/network-request-failed":"Sin conexión. Revisa tu internet.",
  "auth/operation-not-allowed":"Falta activar “Correo/contraseña” en Firebase (Authentication → Sign-in method).",
};
function showLogin(show){ $("#login").classList.toggle("open", show); }
function bindLogin(Cloud){
  const st = $("#loginStatus");
  const creds = () => [$("#lEmail").value.trim(), $("#lPass").value];
  const run = async (fn, busy) => {
    setStatus(st, `<span class="spinner"></span>${busy}`);
    try{ await fn(); setStatus(st, ""); }
    catch(e){ setStatus(st, AUTH_ERR[e?.code] || "No se pudo. Intenta otra vez.", true); }
  };
  $("#loginForm").addEventListener("submit", e => { e.preventDefault(); run(() => Cloud.signIn(...creds()), "Entrando…"); });
  $("#signupBtn").onclick = () => run(() => Cloud.signUp(...creds()), "Creando tu cuenta…");
  $("#resetBtn").onclick = () => {
    const email = creds()[0];
    if(!email){ setStatus(st, "Escribe tu correo arriba y vuelve a tocar “Olvidé mi contraseña”.", true); return; }
    run(async () => { await Cloud.reset(email); setTimeout(()=>setStatus(st, "Te enviamos un correo para cambiar la contraseña."), 0); }, "Enviando…");
  };
  $("#logoutBtn").onclick = async () => { await Cloud.signOut(); };
}
// Sube a la nube los recibos que se guardaron en este celular antes de usar Firebase (una sola vez)
async function migrateLocal(){
  let local = []; try{ local = await localStore.all(); }catch(e){ return; }
  if(!local.length) return;
  const st = $("#backupStatus");
  setStatus(st, `<span class="spinner"></span>Pasando ${local.length} recibo${local.length===1?"":"s"} de este celular a la nube…`);
  for(const r of local){
    const pids = [...(r.photos||[]), r.barcodePhoto].filter(Boolean);
    for(const pid of pids){ const b = await localStore.getPhoto(pid).catch(()=>null); if(b) await store.putPhoto(pid, b); }
    await store.put(r);
    await localStore.del(r.id);
    for(const pid of pids) await localStore.delPhoto(pid).catch(()=>{});
  }
  setStatus(st, `Listo: ${local.length} recibo${local.length===1?"":"s"} de este celular ahora están en la nube.`);
}
async function startCloud(Cloud){
  bindLogin(Cloud);
  Cloud.onAuth(async user => {
    unwatch?.(); unwatch = null;
    if(!user){
      cloudMode = false; receipts = []; loaded = false; renderAll();
      $("#account").hidden = true; showLogin(true); return;
    }
    showLogin(false);
    cloudMode = true;
    store = {...Cloud, putPhoto: async (id, b) => Cloud.putPhoto(id, await fitPhoto(b))};
    $("#account").hidden = false; $("#accountEmail").textContent = user.email;
    unwatch = Cloud.watchReceipts(list => { receipts = list; loaded = true; renderAll(); },
      () => { loaded = true; renderAll(); $("#results").innerHTML = `<div class="empty">No se pudo leer la nube. Revisa que las reglas de Firestore estén publicadas.</div>`; });
    migrateLocal();
  });
}

/* ---------- inicio ---------- */
/* ---------- inicio ---------- */
(async () => {
  let start = "buscar"; try{ start = localStorage.getItem("tab") || "buscar"; }catch(e){}
  go(start); renderAll(); renderThumbs();
  // espera la conexión con Firebase (máx. 10 s); si no está configurada o no carga, sigue guardando en el celular
  const Cloud = await Promise.race([window.cloudReady, new Promise(r => setTimeout(() => r(null), 10000))]).catch(() => null);
  if(Cloud?.configured){ startCloud(Cloud); }
  else {
    try{ await reload(); }catch(e){ loaded = true; renderAll(); $("#results").innerHTML = `<div class="empty">Este navegador no permite guardar datos (¿modo incógnito?). Ábrela en una ventana normal.</div>`; }
  }
  try{ await navigator.storage?.persist?.(); }catch(e){}
  if("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(()=>{});
})();
