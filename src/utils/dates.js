/** "2026-10-07 14:30:00" (UTC de SQLite) -> fecha y hora local legible */
export const localDate = (s) => {
  if (!s) return "—";
  const d = new Date(String(s).replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleString("es-VE");
};

/** YYYY-MM-DD de hoy en hora local */
export const todayStr = () => new Date().toLocaleDateString("sv-SE");

/** YYYY-MM-DD de hace n días */
export const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString("sv-SE");
};