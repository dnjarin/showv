/** "12.50" o "12,5" -> 1250. Devuelve null si es inválido. */
export function toMinor(input) {
  const s = String(input).trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [int, dec = ""] = s.split(".");
  return Number(int) * 100 + Number(dec.padEnd(2, "0"));
}

/** 1250 -> "12.50" (para rellenar inputs) */
export function fromMinor(minor) {
  const n = Math.abs(minor);
  return `${minor < 0 ? "-" : ""}${Math.floor(n / 100)}.${String(n % 100).padStart(2, "0")}`;
}

/** 123456 USD -> "$ 1.234,56" (formato venezolano) */
export function formatMoney(minor, currency) {
  const symbol = currency === "USD" ? "$" : "Bs.";
  const [int, dec] = fromMinor(minor).split(".");
  return `${symbol} ${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}
/** "36,5412" o "36.5412" -> 36541200 (Bs por unidad × 1.000.000). null si es inválido. */
export function toMicro(input) {
  const s = String(input).trim().replace(",", ".");
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
  const [int, dec = ""] = s.split(".");
  const v = Number(int) * 1_000_000 + Number(dec.padEnd(6, "0"));
  return v > 0 && Number.isSafeInteger(v) ? v : null;
}

/** 36541200 -> "36,5412" */
export function fromMicro(micro) {
  const int = Math.floor(micro / 1_000_000);
  let dec = String(micro % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  if (dec.length < 2) dec = dec.padEnd(2, "0");
  return `${int},${dec}`;
}
/** Conversión solo para mostrar ayudas en pantalla. El cálculo real lo hace Rust. */
export function convertMinor(minor, from, to, usdRateMicro) {
  if (from === to) return minor;
  if (!usdRateMicro) return null;
  if (from === "VES" && to === "USD") return Math.round((minor * 1_000_000) / usdRateMicro);
  if (from === "USD" && to === "VES") return Math.round((minor * usdRateMicro) / 1_000_000);
  return null;
}