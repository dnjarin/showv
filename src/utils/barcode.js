// Generador de códigos de barras (EAN-13, EAN-8 y Code 128) sin dependencias.
// Devuelve las barras como rectángulos {x, w} en "módulos"; el dibujo lo hace <Barcode />.

const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const R = L.map((c) => [...c].map((b) => (b === "0" ? "1" : "0")).join(""));
const G = R.map((c) => [...c].reverse().join(""));
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

const C128 = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232",
];
const C128_STOP = "2331112";
export const _tables = { C128, C128_STOP, L, G, R, PARITY }; // solo para pruebas

export function ean13Check(d12) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(d12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (s % 10)) % 10;
}
export function ean8Check(d7) {
  let s = 0;
  for (let i = 0; i < 7; i++) s += Number(d7[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (s % 10)) % 10;
}

function bitsToBars(bits, offset = 0) {
  const bars = [];
  let i = 0;
  while (i < bits.length) {
    if (bits[i] === "1") {
      let j = i;
      while (j < bits.length && bits[j] === "1") j++;
      bars.push({ x: offset + i, w: j - i });
      i = j;
    } else i++;
  }
  return bars;
}

function widthsToBits(widths) {
  let bits = "";
  [...widths].forEach((w, i) => { bits += (i % 2 === 0 ? "1" : "0").repeat(Number(w)); });
  return bits;
}

function ean13Bits(v) {
  const par = PARITY[Number(v[0])];
  let bits = "101";
  for (let i = 0; i < 6; i++) bits += (par[i] === "L" ? L : G)[Number(v[i + 1])];
  bits += "01010";
  for (let i = 7; i < 13; i++) bits += R[Number(v[i])];
  return bits + "101";
}
function ean8Bits(v) {
  let bits = "101";
  for (let i = 0; i < 4; i++) bits += L[Number(v[i])];
  bits += "01010";
  for (let i = 4; i < 8; i++) bits += R[Number(v[i])];
  return bits + "101";
}
function code128Bits(text) {
  const vals = [...text].map((c) => c.charCodeAt(0) - 32);
  const start = 104; // Start B
  let sum = start;
  vals.forEach((v, i) => { sum += v * (i + 1); });
  const seq = [start, ...vals, sum % 103];
  return seq.map((v) => widthsToBits(C128[v])).join("") + widthsToBits(C128_STOP);
}

/** ¿Se puede codificar este texto? (Code 128 B admite ASCII imprimible) */
export function isPrintable(text) {
  return typeof text === "string" && text.length > 0 && text.length <= 40 && [...text].every((c) => c >= " " && c <= "~");
}

/**
 * Elige la simbología y arma las barras.
 * EAN-13/EAN-8 solo si el dígito verificador es correcto; cualquier otro valor va en Code 128,
 * así el lector entrega exactamente el mismo texto que está guardado en el producto.
 * Devuelve null si el texto no se puede codificar.
 */
export function encode(value) {
  const v = String(value ?? "").trim();
  let kind, bits;
  if (/^\d{13}$/.test(v) && ean13Check(v) === Number(v[12])) { kind = "ean13"; bits = ean13Bits(v); }
  else if (/^\d{8}$/.test(v) && ean8Check(v) === Number(v[7])) { kind = "ean8"; bits = ean8Bits(v); }
  else if (isPrintable(v)) { kind = "code128"; bits = code128Bits(v); }
  else return null;
  const quiet = kind === "code128" ? 10 : 9;
  return { kind, text: v, modules: bits.length + quiet * 2, bars: bitsToBars(bits, quiet) };
}

/** Código interno EAN-13 (prefijo 200) a partir de un número de secuencia. */
export function internalEan13(seq) {
  const base = `200${String(seq).padStart(9, "0")}`;
  return base + ean13Check(base);
}
