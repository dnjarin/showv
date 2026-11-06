// Dibuja la cotización con el formato de «Medano Tech» (encabezado con logo, bloque del cliente,
// bloque del vendedor, tabla de productos, garantías y totales) sobre un <canvas> tamaño carta.
// Lo que se ve en pantalla es exactamente lo que se exporta a JPG/PDF o se imprime.
import { fromMicro } from "./money";

export const PAGE_W = 1275; // carta a 150 ppp
export const PAGE_H = 1650;
const M = 70;
const CW = PAGE_W - 2 * M;
const FONT = "Arial, Helvetica, sans-serif";
const BLUE = "#4A7EC4";
const INK = "#111111";
const GRID = "#222222";

// ---------- formato ----------
const num = (minor) => {
  const n = Math.abs(minor);
  const int = String(Math.floor(n / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${minor < 0 ? "-" : ""}${int},${String(n % 100).padStart(2, "0")}`;
};
const dmy = (s) => (s ? String(s).slice(0, 10).split("-").reverse().join("/") : "—");
const createdDmy = (s) => {
  if (!s) return "—";
  const d = new Date(String(s).replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? dmy(s) : d.toLocaleDateString("es-VE");
};

// ---------- utilidades de canvas ----------
const font = (ctx, size, weight = "normal", italic = false) => {
  ctx.font = `${italic ? "italic " : ""}${weight} ${size}px ${FONT}`;
};

function wrap(ctx, text, maxW) {
  const out = [];
  for (const para of String(text ?? "").split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) { out.push(""); continue; }
    let line = "";
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (ctx.measureText(t).width <= maxW) { line = t; continue; }
      if (line) out.push(line);
      if (ctx.measureText(w).width <= maxW) { line = w; continue; }
      // palabra más larga que la celda: se parte por caracteres
      let chunk = "";
      for (const ch of w) {
        if (ctx.measureText(chunk + ch).width > maxW) { out.push(chunk); chunk = ch; } else chunk += ch;
      }
      line = chunk;
    }
    out.push(line);
  }
  return out;
}

const loadImage = (src) =>
  new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });

function cellText(ctx, lines, x, y, w, h, lh, align = "center") {
  const total = lines.length * lh;
  let ty = y + (h - total) / 2 + lh / 2;
  ctx.textBaseline = "middle";
  ctx.textAlign = align;
  const tx = align === "center" ? x + w / 2 : align === "left" ? x + 12 : x + w - 12;
  for (const l of lines) { ctx.fillText(l, tx, ty); ty += lh; }
}

function headerRow(ctx, y, cols, h = 46) {
  let x = M;
  for (const c of cols) {
    ctx.fillStyle = BLUE; ctx.fillRect(x, y, c.w, h);
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.strokeRect(x, y, c.w, h);
    ctx.fillStyle = "#ffffff"; font(ctx, 21, "bold");
    cellText(ctx, wrap(ctx, c.label, c.w - 16), x, y, c.w, h, 24);
    x += c.w;
  }
  return y + h;
}

function valueRow(ctx, y, cols, values, h, bold = false) {
  let x = M;
  cols.forEach((c, i) => {
    ctx.strokeStyle = GRID; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, c.w, h);
    ctx.fillStyle = INK; font(ctx, 21, bold ? "bold" : "normal");
    cellText(ctx, wrap(ctx, values[i] || "", c.w - 20), x, y, c.w, h, 26);
    x += c.w;
  });
  return y + h;
}

const splitCols = (fr) => fr.map((f) => ({ w: Math.round(CW * f) }));

// ---------- modelo de datos ----------
function model(q) {
  const ves = q.currencyCode === "VES";
  const rate = q.usdRateMicro || null;
  const sym = ves ? "Bs." : "$";
  const rows = q.items.map((l) => {
    let desc = l.description;
    if (l.discountBp > 0) desc += `\nDescuento ${String(l.discountBp / 100).replace(".", ",")} %`;
    if (l.taxRateBp === 0) desc += "\n(Exento de IVA)";
    return {
      qty: String(l.quantity),
      desc,
      unitUsd: ves ? (rate ? Math.round((l.unitPriceMinor * 1_000_000) / rate) : null) : l.unitPriceMinor,
      unitBs: ves ? l.unitPriceMinor : null,
      total: l.baseMinor,
    };
  });
  return {
    ves, sym, rows,
    subtotal: q.subtotalMinor + q.exemptMinor,
    tax: q.taxMinor,
    total: q.totalMinor,
    rateText: rate ? `Bs. ${fromMicro(rate)}` : "—",
  };
}

// ---------- dibujo principal ----------
/** Devuelve un arreglo de <canvas> (una por página). */
export async function renderQuote(q) {
  const m = model(q);
  const logo = await loadImage(q.style?.logo);
  const pages = [];
  const newPage = () => {
    const c = document.createElement("canvas");
    c.width = PAGE_W; c.height = PAGE_H;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    pages.push(c);
    return ctx;
  };
  let ctx = newPage();
  let y = 60;

  // --- encabezado: logo + datos de la empresa ---
  const LOGO_W = 300, LOGO_H = 170;
  let textX = M, textW = CW;
  if (logo) {
    const k = Math.min(LOGO_W / logo.width, LOGO_H / logo.height);
    const lw = logo.width * k, lh = logo.height * k;
    ctx.drawImage(logo, M, y + (LOGO_H - lh) / 2, lw, lh);
    textX = M + LOGO_W + 20; textW = CW - LOGO_W - 20;
  }
  ctx.fillStyle = INK; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  const cx = textX + textW / 2;
  let ty = y + 52;
  let nameSize = 54;
  font(ctx, nameSize, "bold");
  while (ctx.measureText(q.issuerName.toUpperCase()).width > textW && nameSize > 28) { nameSize -= 2; font(ctx, nameSize, "bold"); }
  ctx.fillText(q.issuerName.toUpperCase(), cx, ty);
  ty += 14;
  font(ctx, 22);
  ctx.fillStyle = "#333333";
  for (const l of wrap(ctx, q.issuerAddress || "", textW)) { ty += 28; ctx.fillText(l, cx, ty); }
  ctx.fillStyle = INK; font(ctx, 26);
  ty += 38; ctx.fillText(`Rif: ${q.issuerRif}`, cx, ty);
  if (q.issuerPhone) { ty += 34; ctx.fillText(`Teléfono: ${q.issuerPhone}`, cx, ty); }
  y += Math.max(LOGO_H, ty - y) + 22;

  // --- título y número ---
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  font(ctx, 34, "bold"); ctx.fillStyle = BLUE;
  ctx.fillText("COTIZACIÓN", M, y + 30);
  ctx.textAlign = "right"; ctx.fillStyle = INK; font(ctx, 28, "bold");
  ctx.fillText(`N° ${q.number}`, M + CW, y + 30);
  y += 50;

  // --- cliente ---
  const cCols = splitCols([0.17, 0.31, 0.32, 0.20]);
  cCols[0].label = "RIF / C.I."; cCols[1].label = "Nombre y apellido / Razón social";
  cCols[2].label = "Dirección"; cCols[3].label = "Teléfono";
  y = headerRow(ctx, y, cCols, 44);
  const addr = q.customerAddress || "";
  y = valueRow(ctx, y, cCols, [q.customerDoc || "", q.customerName || "", addr, q.customerPhone || ""], 64, true);
  y += 22;

  // --- vendedor / fechas / condición / tasa ---
  const iCols = splitCols([0.22, 0.17, 0.19, 0.19, 0.23]);
  ["Vendedor", "Fecha", "VÁLIDO HASTA", "Condición:", "TASA BCV"].forEach((t, i) => { iCols[i].label = t; });
  y = headerRow(ctx, y, iCols, 44);
  y = valueRow(ctx, y, iCols, [
    q.createdByName || "", createdDmy(q.createdAt), dmy(q.validUntil),
    q.payCondition === "CREDITO" ? "CRÉDITO" : "CONTADO", m.rateText,
  ], 48);
  y += 26;

  // --- tabla de productos ---
  const tCols = m.ves
    ? splitCols([0.11, 0.37, 0.17, 0.17, 0.18])
    : splitCols([0.12, 0.48, 0.20, 0.20]);
  const labels = m.ves
    ? ["Cantidad", "Descripción", "PRECIO PROMOCIÓN", "PRECIO BS", "TOTAL BS"]
    : ["Cantidad", "Descripción", "PRECIO PROMOCIÓN", "TOTAL $"];
  labels.forEach((t, i) => { tCols[i].label = t; });

  // altura reservada para el pie (garantías + totales)
  const warrantyLines = (q.style?.warranty || "").split("\n").map((s) => s.trim()).filter(Boolean);
  font(ctx, 19);
  const notesLines = q.notes ? wrap(ctx, q.notes, CW * 0.55) : [];
  const leftH = 40 + warrantyLines.length * 32 + 30 + (notesLines.length ? notesLines.length * 26 + 16 : 0) + 40;
  const footerH = Math.max(leftH, 3 * 48 + 20) + 50;
  const bottom = PAGE_H - 60;

  const money = (cx0, w, yy, h, sym, minor, bold = false) => {
    ctx.fillStyle = INK; font(ctx, 21, bold ? "bold" : "normal");
    ctx.textBaseline = "middle";
    ctx.textAlign = "left"; ctx.fillText(sym, cx0 + 12, yy + h / 2);
    ctx.textAlign = "right"; ctx.fillText(minor == null ? "—" : num(minor), cx0 + w - 12, yy + h / 2);
  };

  y = headerRow(ctx, y, tCols, 60);
  const MIN_ROWS = 5;
  let drawn = 0;
  const drawRow = (r) => {
    font(ctx, 21);
    const lines = wrap(ctx, r.desc, tCols[1].w - 24);
    const h = Math.max(58, lines.length * 27 + 24);
    if (y + h > bottom) {
      ctx = newPage(); y = 60;
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; font(ctx, 26, "bold"); ctx.fillStyle = INK;
      ctx.fillText(`COTIZACIÓN ${q.number} (continuación)`, M, y + 24); y += 44;
      y = headerRow(ctx, y, tCols, 60);
    }
    let x = M;
    tCols.forEach((c) => { ctx.strokeStyle = GRID; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, c.w, h); x += c.w; });
    ctx.fillStyle = INK; font(ctx, 21);
    cellText(ctx, [r.qty], M, y, tCols[0].w, h, 27);
    cellText(ctx, lines, M + tCols[0].w, y, tCols[1].w, h, 27);
    let px = M + tCols[0].w + tCols[1].w;
    if (m.ves) {
      money(px, tCols[2].w, y, h, "$", r.unitUsd);
      money(px + tCols[2].w, tCols[3].w, y, h, "Bs.", r.unitBs);
      money(px + tCols[2].w + tCols[3].w, tCols[4].w, y, h, "Bs.", r.total);
    } else {
      money(px, tCols[2].w, y, h, "$", r.unitUsd);
      money(px + tCols[2].w, tCols[3].w, y, h, "$", r.total);
    }
    y += h; drawn += 1;
  };
  for (const r of m.rows) drawRow(r);
  while (drawn < MIN_ROWS && y + 46 < bottom - footerH) {
    let x = M;
    tCols.forEach((c) => { ctx.strokeStyle = GRID; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, c.w, 46); x += c.w; });
    y += 46; drawn += 1;
  }
  y += 30;

  // --- pie: garantías (izq.) y totales (der.) ---
  if (y + footerH > bottom + 20) { ctx = newPage(); y = 70; }
  const top = y;
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = INK;
  font(ctx, 22, "bold");
  let ly = top + 22;
  if (q.style?.warrantyTitle) { ctx.fillText(q.style.warrantyTitle, M, ly); ly += 14; }
  font(ctx, 19);
  for (const w of warrantyLines) {
    ly += 32;
    ctx.strokeStyle = "#555555"; ctx.lineWidth = 1.5; ctx.strokeRect(M + 4, ly - 14, 11, 11);
    ctx.fillText(w, M + 28, ly);
  }
  ly += 40;
  if (q.style?.footer) { font(ctx, 19); ctx.fillText(q.style.footer, M, ly); ly += 14; }
  if (notesLines.length) {
    font(ctx, 19, "normal", true); ly += 12;
    for (const l of notesLines) { ly += 26; ctx.fillText(l, M, ly); }
  }

  const bw = 470, bx = M + CW - bw, rh = 48;
  const totals = [["SubTotal", m.subtotal], ["IVA", m.tax], ["TOTAL", m.total]];
  totals.forEach(([lab, val], i) => {
    const by = top + i * (rh + 6);
    ctx.setLineDash([7, 4]); ctx.strokeStyle = INK; ctx.lineWidth = 1.5;
    ctx.strokeRect(bx, by, 170, rh); ctx.strokeRect(bx + 176, by, bw - 176, rh);
    ctx.setLineDash([]);
    ctx.fillStyle = INK; ctx.textBaseline = "middle"; font(ctx, 23, "bold");
    ctx.textAlign = "left"; ctx.fillText(lab, bx + 14, by + rh / 2);
    font(ctx, 23, "bold");
    ctx.textAlign = "left"; ctx.fillText(m.sym, bx + 176 + 14, by + rh / 2);
    ctx.textAlign = "right"; ctx.fillText(num(val), bx + bw - 14, by + rh / 2);
  });

  // pie de página
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = "#777777"; font(ctx, 17);
  ctx.fillText("Documento informativo sin validez fiscal.", PAGE_W / 2, PAGE_H - 34);
  return pages;
}

// ---------- exportación ----------
export const canvasToJpeg = (canvas, quality = 0.92) =>
  new Promise((resolve, reject) => {
    canvas.toBlob(async (b) => {
      if (!b) return reject(new Error("No se pudo generar la imagen"));
      resolve(new Uint8Array(await b.arrayBuffer()));
    }, "image/jpeg", quality);
  });

/** PDF mínimo (carta) con una imagen JPEG por página. Sin dependencias externas. */
export function buildPdf(pages) {
  const enc = new TextEncoder();
  const chunks = [];
  let len = 0;
  const push = (d) => { const b = typeof d === "string" ? enc.encode(d) : d; chunks.push(b); len += b.length; };
  const offsets = [];
  const begin = (n) => { offsets[n] = len; push(`${n} 0 obj\n`); };
  const n = pages.length;
  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  begin(1); push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  begin(2);
  push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}] /Count ${n} >>\nendobj\n`);
  pages.forEach((p, i) => {
    const pg = 3 + i * 3, ct = pg + 1, im = pg + 2;
    begin(pg);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>\nendobj\n`);
    const content = "q 612 0 0 792 0 0 cm /Im0 Do Q";
    begin(ct); push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    begin(im);
    push(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
    push(p.jpeg); push("\nendstream\nendobj\n");
  });
  const xref = len;
  const total = 3 + n * 3;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  push(x);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const isDesktopApp = () => typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

export function browserSave(filename, bytes, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Reduce una imagen subida a un PNG/JPG liviano (para guardar el logo en la configuración). */
export async function shrinkLogo(file, maxSide = 560) {
  const url = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("No se pudo leer el archivo"));
    fr.readAsDataURL(file);
  });
  const img = await loadImage(url);
  if (!img) throw new Error("No se pudo leer la imagen");
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0, c.width, c.height);
  const png = c.toDataURL("image/png");
  if (png.length <= 700_000) return png;
  // PNG demasiado pesado (fotografía): se guarda como JPG sobre fondo blanco
  g.globalCompositeOperation = "destination-over"; g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}
