import { useSearchParams } from "react-router-dom";

/** Barra de pestañas con subrayado (el mismo estilo de «Gastos y movimientos»). Se oculta con una sola. */
export function TabBar({ tabs, value, onChange }) {
  if (tabs.length < 2) return null;
  return (
    <div className="mb-4 flex flex-wrap gap-1 border-b">
      {tabs.map(([id, label]) => (
        <button key={id} type="button" onClick={() => onChange(id)}
          className={`-mb-px px-4 py-2 text-sm ${
            value === id ? "border-b-2 border-slate-900 font-semibold" : "text-slate-500 hover:text-slate-800"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** La pestaña activa vive en la URL (?tab=…): se puede enlazar y sobrevive a recargar. */
export function useTabParam(ids, fallback) {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get("tab");
  const tab = ids.includes(raw) ? raw : fallback;
  const setTab = (t) => setSp({ tab: t }, { replace: true });
  return [tab, setTab];
}
