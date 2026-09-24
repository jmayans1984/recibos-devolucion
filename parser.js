// Convierte el texto de un recibo (OCR o copiado del celular) en datos.
// Pensado para recibos de Ross / Marshalls / TJ Maxx / HomeGoods, pero es tolerante.
(function (global) {
  const SKIP = /(SUB\s*-?\s*TOTAL|TOTAL|\bTAX\b|IMPUESTO|CHANGE|CAMBIO|\bCASH\b|VISA|MASTER\s*CARD|\bMC\b|AMEX|DISCOVER|DEBIT|CREDIT|TENDER|BALANCE|\bAUTH|APPROV|\bREF\b|ACCOUNT|\bACCT|CHIP|\bAID\b|\bTVR\b|\bTSI\b|ENTRY|CARD\s*#|THANK|GRACIAS|RETURN|REFUND|POLICY|RECEIPT|SURVEY|WWW\.|\.COM|STORE\s*#|\bSTR\b|\bREG\b|\bTRANS|\bTRN\b|CASHIER|ITEMS?\s+(SOLD|PURCH)|SAVINGS|YOU SAVED|SOLD\s*:|ITEM COUNT|GIFT CARD|FEEDBACK|RESPOND|ENTER CODE|\bBAG\b|PHONE|TEL\b)/i;

  // Precio al final de la línea. Ross pega la marca de impuesto al precio ("$17.99B") y el
  // lector suele leer esa B como 8 ("$17.998"): se acepta un carácter extra tras los centavos.
  const PRICE_END = /(-?\$?\s?\d{1,4}[.,]\s?\d{2})(?:[0-9A-Z](?![0-9]))?(\s*-)?\s*([A-Z*]{1,2})?\s*$/;
  const QTY_AT = /(\d{1,3})\s*[@xX]\s*\$?(\d{1,4}[.,]\d{2})/;

  // Corrige confusiones típicas del OCR dentro de palabras que son casi todas dígitos
  function fixDigits(tok) {
    const digits = (tok.match(/\d/g) || []).length;
    if (digits < Math.max(3, tok.replace(/-/g, "").length * 0.6)) return tok;
    return tok.replace(/[Oo]/g, "0").replace(/[lI|]/g, "1").replace(/S/g, "5").replace(/B/g, "8").replace(/Z/g, "2");
  }
  const num = s => Number(String(s).replace(/\$|\s/g, "").replace(",", "."));

  function findCode(line) {
    // Un código: 5+ dígitos, con posibles guiones/espacios internos (ej. 12-3456-789, 400123456789)
    const orig = line.split(/\s+/), toks = orig.map(fixDigits);
    let best = null;
    for (let i = 0; i < toks.length; i++) {
      // une trozos como "12-3456" "789" o "123 456 789" si son todos numéricos
      let t = toks[i], j = i;
      while (j + 1 < toks.length && /^\d[\d-]*$/.test(t) && /^\d{2,}[\d-]*$/.test(toks[j + 1]) && !/[.,]\d{2}$/.test(toks[j + 1]) && (t + toks[j + 1]).replace(/\D/g, "").length <= 14) {
        t = t + "-" + toks[j + 1]; j++;
      }
      const clean = t.replace(/^[^\d]+|[^\d]+$/g, "");
      const d = clean.replace(/\D/g, "");
      if (/^\d[\d-]*\d$/.test(clean) && d.length >= 5 && !/[.,]\d{2}$/.test(t) && !/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/.test(clean)) {
        if (!best || d.length > best.digits) best = { code: clean, digits: d.length, raw: orig.slice(i, j + 1).join(" ") };
      }
    }
    return best;
  }

  function cleanName(line, codeRaw, priceRaw) {
    let s = line;
    if (codeRaw) s = s.replace(codeRaw, " ");
    if (priceRaw) s = s.replace(priceRaw, " ");
    s = s.replace(QTY_AT, " ").replace(/[$]/g, "");
    s = s.replace(/[^A-Za-z0-9&'/#%.\- ]/g, " ").replace(/\s{2,}/g, " ").trim();
    return s.replace(/^[-.\s]+|[-.\s]+$/g, "");
  }

  function parse(text) {
    const lines = String(text || "").split(/\r?\n/).map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    const all = lines.join("\n");
    const out = { store: "Otra", storeNumber: null, date: null, time: null, transaction: null, subtotal: null, tax: null, total: null, payment: null, items: [] };

    if (/ROSS|DRESS\s*FOR\s*LESS/i.test(all)) out.store = "Ross";
    else if (/MARSHALLS?/i.test(all)) out.store = "Marshalls";
    else if (/T\.?\s?J\.?\s?MAXX/i.test(all)) out.store = "TJ Maxx";
    else if (/HOME\s?GOODS/i.test(all)) out.store = "HomeGoods";

    const dm = all.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
    if (dm) {
      let [, m, d, y] = dm; y = y.length === 2 ? "20" + y : y;
      if (+m >= 1 && +m <= 12 && +d >= 1 && +d <= 31) out.date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    const tm = all.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?\b/i);
    if (tm) { let h = +tm[1]; if (tm[3]) { const pm = /p/i.test(tm[3]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; } out.time = `${String(h).padStart(2, "0")}:${tm[2]}`; }
    const sn = all.match(/(?:STORE|STR|TIENDA)\s*(?:#|NO\.?|NUM)?\s*:?\s*(\d{2,5})/i); if (sn) out.storeNumber = sn[1];
    const tr = all.match(/(?:TRANS(?:ACTION)?|TRN|TRAN)\s*(?:#|NO\.?)?\s*:?\s*(\d{2,8})/i); if (tr) out.transaction = tr[1];
    const pay = all.match(/(VISA|MASTER\s*CARD|MASTERCARD|AMEX|AMERICAN EXPRESS|DISCOVER|TJX CREDIT|DEBIT|CASH)/i);
    if (pay) { const l4 = all.match(/[*Xx#]{3,}\s*(\d{4})\b/); out.payment = pay[1].toUpperCase().replace(/\s+/g, " ") + (l4 ? " " + l4[1] : ""); }

    for (const l of lines) {
      const p = l.match(PRICE_END); if (!p) continue;
      if (/SUB\s*-?\s*TOTAL/i.test(l)) out.subtotal = num(p[1]);
      else if (/\bTAX\b/i.test(l)) out.tax = num(p[1]);
      else if (/\bTOTAL\b/i.test(l) && out.total == null) out.total = num(p[1]);
    }

    let pendingCode = null; // línea con código pero sin precio; el precio viene en la siguiente
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (SKIP.test(l)) { pendingCode = null; continue; }
      const p = l.match(PRICE_END);
      const c = findCode(p ? l.slice(0, p.index) : l);
      const price = p ? num(p[1]) * (p[2] ? -1 : 1) : null;

      // Descuento o rebaja: línea con precio negativo sin código -> se resta al producto anterior
      if (p && price < 0 && !c) {
        const last = out.items[out.items.length - 1];
        if (last) last.price = Math.round((last.price + price / (last.qty || 1)) * 100) / 100;
        continue;
      }
      if (c && p) {
        const q = l.match(QTY_AT);
        out.items.push({ code: c.code, name: cleanName(l, c.raw, p[0]), price: q ? num(q[2]) : price, qty: q ? +q[1] : 1 });
        pendingCode = null;
      } else if (c && !p) {
        pendingCode = { code: c.code, name: cleanName(l, c.raw, null) };
      } else if (!c && p && pendingCode) {
        const q = l.match(QTY_AT);
        const extra = cleanName(l, null, p[0]);
        out.items.push({ code: pendingCode.code, name: [pendingCode.name, extra].filter(Boolean).join(" "), price: q ? num(q[2]) : price, qty: q ? +q[1] : 1 });
        pendingCode = null;
      }
    }
    // Si no se leyó el logo: los códigos de Ross son de 12 dígitos y empiezan con 400
    if (out.store === "Otra" && out.items.length && out.items.filter(it => /^400\d{9}$/.test(it.code)).length >= out.items.length / 2) out.store = "Ross";
    return out;
  }

  global.ReceiptParser = { parse };
})(typeof window !== "undefined" ? window : globalThis);
