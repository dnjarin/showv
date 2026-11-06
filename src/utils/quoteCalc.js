// Cálculo de la cotización en pantalla: el vendedor escribe el precio unitario en USD
// (sin IVA) y, si el pago es en bolívares, se convierte con la tasa BCV vigente.
// Todo en enteros de la unidad menor (centavos / céntimos de Bs.).

export const IVA_BP = 1600; // 16 %

/** "265,00" | "1.234,56" | "265.5" → centavos (entero) o null si no es válido. */
export function parseMoney(s) {
  let t = String(s ?? "").trim().replace(/\s/g, "");
  if (t === "") return null;
  if (t.includes(",") && t.includes(".")) t = t.replace(/\./g, "").replace(",", ".");
  else if (t.includes(",")) t = t.replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export function parsePct(s) {
  const t = String(s ?? "").trim();
  if (t === "") return 0;
  const v = Number(t.replace(",", "."));
  return Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v * 100) : null;
}

/** Devuelve { items, subtotalMinor, exemptMinor, taxMinor, totalMinor } o { error }. */
export function computeQuote(currency, rateMicro, lines) {
  if (currency === "VES" && !rateMicro) return { error: "No hay tasa BCV registrada para hoy" };
  const items = [];
  let subtotal = 0, exempt = 0, tax = 0;
  for (const [i, l] of lines.entries()) {
    const usd = parseMoney(l.price);
    if (usd === null) return { error: `Línea ${i + 1}: escribe el precio en USD (ej. 265,00)` };
    const bp = parsePct(l.discount);
    if (bp === null) return { error: `Línea ${i + 1}: descuento inválido (0 a 100)` };
    if (!String(l.description).trim()) return { error: `Línea ${i + 1}: falta la descripción` };
    const qty = Math.max(1, parseInt(l.quantity, 10) || 1);
    const unit = currency === "VES" ? Math.round((usd * rateMicro) / 1_000_000) : usd;
    const base = Math.round((qty * unit * (10000 - bp)) / 10000);
    const taxRateBp = l.exempt ? 0 : IVA_BP;
    const lineTax = Math.round((base * taxRateBp) / 10000);
    if (l.exempt) exempt += base; else subtotal += base;
    tax += lineTax;
    items.push({
      description: String(l.description).trim(), quantity: qty, unitPriceMinor: unit,
      discountBp: bp, taxRateBp, baseMinor: base,
    });
  }
  return { items, subtotalMinor: subtotal, exemptMinor: exempt, taxMinor: tax, totalMinor: subtotal + exempt + tax };
}

export const addDays = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
