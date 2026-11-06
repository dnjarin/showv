const TYPES = ["V", "E", "J", "G", "P", "C"];

/** "V-12.345.678" -> { idType: "V", idNumber: "12345678" } | { error } */
export function parseDocument(raw) {
  const clean = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!clean) return { error: "Ingresa la cédula o el RIF" };

  if (/[A-Z]/.test(clean[0])) {
    if (!TYPES.includes(clean[0])) return { error: "La letra debe ser V, E, J, G, P o C" };
    const num = clean.slice(1);
    if (!num) return { error: "Falta el número después de la letra" };
    return { idType: clean[0], idNumber: num };
  }

  if (/^\d+$/.test(clean)) {
    if (clean.length <= 8) return { idType: "V", idNumber: clean };
    return { error: "Para un RIF incluye la letra (ejemplo: J-123456789)" };
  }
  return { error: "Documento inválido" };
}

/** Cómo se muestra un documento guardado: V-12345678 */
export const formatDocument = (c) => `${c.idType}-${c.idNumber}`;

/** Normaliza lo que se escribe en un buscador para que "V-12.345.678" encuentre "12345678". */
export function searchTerm(q) {
  const s = q.trim();
  if (/^[VEJGPC][-\s]?\d[\d.\-\s]*$/i.test(s) || /^[\d.\-\s]+$/.test(s)) {
    return s.replace(/[^0-9]/g, "");
  }
  return s;
}