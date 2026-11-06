// Lectura de archivos para la migración: CSV/TXT como texto y Excel (.xlsx) convertido a CSV (";").
// Sin dependencias: un .xlsx es un ZIP con XML; se descomprime con DecompressionStream (WebView2/Chromium).

// Tope de lo que se descomprime de cada parte del Excel: protege contra archivos «bomba» que se expanden sin límite.
const MAX_INFLATED = 100 * 1024 * 1024;

async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const reader = new Blob([bytes]).stream().pipeThrough(ds).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_INFLATED) {
      await reader.cancel();
      throw new Error("El archivo Excel es demasiado grande o está dañado");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function unzip(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("El archivo no es un Excel (.xlsx) válido");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    const lnlen = dv.getUint16(off + 26, true);
    const lelen = dv.getUint16(off + 28, true);
    const start = off + 30 + lnlen + lelen;
    const data = u8.subarray(start, start + csize);
    files[name] = { method, data };
    p += 46 + nlen + elen + clen;
  }
  return {
    async text(name) {
      const f = files[name];
      if (!f) return null;
      if (f.method === 0) return dec.decode(f.data);
      if (f.method === 8) return dec.decode(await inflateRaw(f.data));
      throw new Error("Compresión de Excel no soportada");
    },
  };
}

const xml = (s) => new DOMParser().parseFromString(s, "application/xml");
const kids = (el, tag) => Array.from(el.getElementsByTagName(tag));

function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || "");
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function serialToDate(v) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(Number(v)) * 86400000);
  const pad = (x) => String(x).padStart(2, "0");
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function xlsxToCsv(buf) {
  const zip = await unzip(buf);
  const wb = await zip.text("xl/workbook.xml");
  if (!wb) throw new Error("El archivo no es un Excel (.xlsx) válido");
  // Primera hoja del libro
  let sheetPath = "xl/worksheets/sheet1.xml";
  const rid = kids(xml(wb), "sheet")[0]?.getAttribute("r:id");
  const rels = await zip.text("xl/_rels/workbook.xml.rels");
  if (rid && rels) {
    const rel = kids(xml(rels), "Relationship").find((r) => r.getAttribute("Id") === rid);
    const t = rel?.getAttribute("Target");
    if (t) sheetPath = t.startsWith("/") ? t.slice(1) : `xl/${t}`;
  }
  const sheetXml = await zip.text(sheetPath);
  if (!sheetXml) throw new Error("No se encontró la primera hoja del Excel");

  const shared = [];
  const sst = await zip.text("xl/sharedStrings.xml");
  if (sst) for (const si of kids(xml(sst), "si")) shared.push(kids(si, "t").map((t) => t.textContent).join(""));

  // Estilos que son fechas
  const dateStyle = new Set();
  const st = await zip.text("xl/styles.xml");
  if (st) {
    const sd = xml(st);
    const custom = new Set();
    for (const nf of kids(sd, "numFmt")) {
      const code = (nf.getAttribute("formatCode") || "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
      if (/[dmyh]/i.test(code) && !/^(general|0|#)/i.test(code)) custom.add(Number(nf.getAttribute("numFmtId")));
    }
    const xfs = sd.getElementsByTagName("cellXfs")[0];
    if (xfs) {
      Array.from(xfs.children).forEach((xf, i) => {
        const id = Number(xf.getAttribute("numFmtId"));
        if (BUILTIN_DATE.has(id) || custom.has(id)) dateStyle.add(i);
      });
    }
  }

  const rows = [];
  for (const row of kids(xml(sheetXml), "row")) {
    const line = [];
    for (const c of Array.from(row.children).filter((e) => e.tagName === "c")) {
      const idx = colIndex(c.getAttribute("r"));
      const t = c.getAttribute("t");
      const v = c.getElementsByTagName("v")[0]?.textContent ?? "";
      let val = "";
      if (t === "s") val = shared[Number(v)] ?? "";
      else if (t === "inlineStr") val = kids(c, "t").map((x) => x.textContent).join("");
      else if (t === "b") val = v === "1" ? "VERDADERO" : "FALSO";
      else if (t === "str" || t === "e") val = v;
      else if (v !== "" && dateStyle.has(Number(c.getAttribute("s")))) val = serialToDate(v);
      else val = v;
      while (line.length < idx) line.push("");
      line[idx] = val;
    }
    rows.push(line);
  }
  while (rows.length && rows[rows.length - 1].every((x) => x === "" || x == null)) rows.pop();
  return "﻿" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n");
}

/** Devuelve el contenido del archivo como texto CSV listo para validar. */
export async function readTable(file) {
  const buf = await file.arrayBuffer();
  if (/\.xlsx$/i.test(file.name)) return xlsxToCsv(buf);
  if (/\.xls$/i.test(file.name)) {
    throw new Error("El formato .xls (Excel antiguo) no se puede leer. Ábrelo en Excel y guárdalo como .xlsx");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}
