import { fromMinor } from "./money";

// Evita que Excel ejecute como fórmula un texto que empieza por = + - @ (los números no se tocan).
const neutralize = (s) => {
  if (/^[=@\t\r]/.test(s)) return `'${s}`;
  if (/^[+-]/.test(s) && !/^[+-]?[0-9][0-9.,]*$/.test(s)) return `'${s}`;
  return s;
};

const esc = (v) => {
  const s = neutralize(String(v ?? ""));
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (header, rows) =>
  "\uFEFF" + [header, ...rows].map((r) => r.map(esc).join(";")).join("\r\n");

/** 1250 -> "12,50" */
export const csvMoney = (minor) => fromMinor(minor).replace(".", ",");