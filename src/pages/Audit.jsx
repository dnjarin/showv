import { useEffect, useState } from "react";
import { auditApi } from "../services/api";
import { todayStr } from "../utils/dates";
import { CATS, describe, splitDate } from "../utils/auditFormat";

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString("sv-SE");
};

export default function Audit() {
  const [from, setFrom] = useState(daysAgo(7));
  const [to, setTo] = useState(todayStr());
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cat, setCat] = useState("");

  const run = async () => {
    setError(""); setBusy(true);
    try {
      setRows(await auditApi.list(from, to, search.trim() || null, 300));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { run(); }, []); // carga inicial

  const described = (rows ?? []).map((r) => ({ r, d: describe(r) }));
  const counts = {};
  for (const x of described) counts[x.d.cat] = (counts[x.d.cat] ?? 0) + 1;
  const shown = cat ? described.filter((x) => x.d.cat === cat) : described;

  const input = "rounded border p-2";
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Auditoría</h1>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">Desde
          <input type="date" className={`${input} mt-1 block`} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-sm">Hasta
          <input type="date" className={`${input} mt-1 block`} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="text-sm">Buscar
          <input className={`${input} mt-1 block w-64`} placeholder="Usuario, acción o detalle" value={search}
            onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
        </label>
        <button onClick={run} disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
          {busy ? "Consultando…" : "Consultar"}
        </button>
      </div>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {rows && rows.length === 300 && (
        <p className="mb-2 text-xs text-slate-500">Se muestran los 300 eventos más recientes. Acota el rango o la búsqueda.</p>
      )}

      {rows && rows.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          <button onClick={() => setCat("")}
            className={`rounded-full px-3 py-1 text-sm ring-1 ${cat === "" ? "bg-slate-900 text-white ring-slate-900" : "bg-white ring-slate-300"}`}>
            Todo <span className="opacity-70">({rows.length})</span>
          </button>
          {Object.entries(counts).map(([k, n]) => (
            <button key={k} onClick={() => setCat(cat === k ? "" : k)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-sm ring-1 ${cat === k ? CATS[k].badge + " font-semibold" : "bg-white ring-slate-300"}`}>
              <span className={`h-2.5 w-2.5 rounded-full ${CATS[k].dot}`} />{CATS[k].label} <span className="opacity-70">({n})</span>
            </button>
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Fecha</th><th className="p-3">Usuario</th><th className="p-3">Acción</th><th className="p-3">Detalle</th></tr>
          </thead>
          <tbody>
            {shown.map(({ r, d }) => {
              const c = CATS[d.cat];
              const dt = splitDate(r.createdAt);
              const tint = d.level === "danger" ? "bg-red-50" : d.level === "warn" ? "bg-amber-50" : "hover:bg-slate-50";
              return (
                <tr key={r.id} className={`border-b border-l-4 align-top ${c.bar} ${tint}`}>
                  <td className="whitespace-nowrap p-3">
                    <div className="font-medium capitalize">{dt.day}</div>
                    <div className="text-xs text-slate-500">{dt.time}</div>
                  </td>
                  <td className="p-3">
                    <span className="inline-flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-800 text-xs font-semibold uppercase text-white">
                        {(r.username ?? "?").slice(0, 1)}
                      </span>
                      {r.username ?? "—"}
                    </span>
                  </td>
                  <td className="p-3">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${c.badge}`}>
                      <span>{c.icon}</span>{d.label}
                    </span>
                    {d.level === "danger" && <div className="mt-1 text-xs font-semibold text-red-700">⚠ Revisar</div>}
                  </td>
                  <td className="p-3">
                    <div className="text-slate-800">{d.text || <span className="text-slate-400">—</span>}</div>
                    {d.entity && <span className="mt-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">{d.entity}</span>}
                  </td>
                </tr>
              );
            })}
            {rows && shown.length === 0 && (
              <tr><td colSpan={4} className="p-6 text-center text-slate-500">Sin eventos en el rango</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
