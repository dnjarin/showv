import { useCallback, useEffect, useState } from "react";
import { profitApi, reportsApi } from "../services/api";
import { formatMoney } from "../utils/money";
import { csvMoney, toCsv } from "../utils/csv";
import { todayStr } from "../utils/dates";

const pct = (bp) => `${(bp / 100).toFixed(1).replace(".", ",")} %`;
const usd = (v) => formatMoney(v, "USD");
const ves = (v) => formatMoney(v, "VES");
const monthStart = () => todayStr().slice(0, 8) + "01";
const input = "rounded border p-2";

function Card({ label, usdV, vesV, tone = "", note }) {
  return (
    <div className="rounded-xl bg-white p-4 shadow">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-2xl font-semibold ${tone}`}>{usd(usdV)}</div>
      <div className="text-sm text-slate-600">{ves(vesV)}</div>
      {note && <div className="mt-1 text-xs text-slate-500">{note}</div>}
    </div>
  );
}

export default function Profit() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayStr());
  const [r, setR] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setError(""); setMsg(""); setR(null);
    try { setR(await profitApi.report(from, to)); } catch (e) { setError(e.message); }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const exportCsv = async () => {
    setMsg(""); setError("");
    const header = ["SKU", "Producto", "Cantidad", "Ventas USD", "Costo USD", "Utilidad USD", "Margen %"];
    const rows = r.byProduct.map((p) => [p.sku ?? "", p.name, p.quantity, csvMoney(p.revenueUsdMinor),
      csvMoney(p.costUsdMinor), csvMoney(p.profitUsdMinor), String(p.marginBp / 100).replace(".", ",")]);
    try {
      setMsg(`Guardado en: ${await reportsApi.exportCsv(`utilidad_${from}_${to}.csv`, toCsv(header, rows))}`);
    } catch (e) { setError(e.message); }
  };

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Utilidad y rentabilidad</h1>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <label className="text-sm">Desde<input type="date" className={`${input} ml-1`} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-sm">Hasta<input type="date" className={`${input} ml-1`} value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button onClick={exportCsv} disabled={!r} className="rounded border bg-white px-3 py-2 text-sm disabled:opacity-50">Exportar CSV (por producto)</button>
      </div>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      {msg && <p className="mb-2 text-sm text-green-700">{msg}</p>}
      {!r && !error && <p className="text-slate-500">Calculando…</p>}

      {r && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Card label="Ventas netas (sin IVA)" usdV={r.revenueUsdMinor} vesV={r.revenueVesMinor}
              note={`${r.salesDocs} operaciones · devoluciones ya descontadas`} />
            <Card label="Costo de lo vendido" usdV={r.costUsdMinor} vesV={r.costVesMinor} />
            <Card label="Ganancia bruta" usdV={r.grossUsdMinor} vesV={r.grossVesMinor}
              tone={r.grossUsdMinor < 0 ? "text-red-700" : "text-green-800"} note={`Margen ${pct(r.marginBp)}`} />
            <Card label="Gastos del período" usdV={r.expensesUsdMinor} vesV={r.expensesVesMinor} />
            <Card label="Utilidad neta" usdV={r.netUsdMinor} vesV={r.netVesMinor}
              tone={r.netUsdMinor < 0 ? "text-red-700" : "text-green-800"} note="Ganancia bruta menos gastos" />
          </div>

          {r.estimatedCostShareBp > 0 && (
            <p className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
              El {pct(r.estimatedCostShareBp)} del costo corresponde a ventas anteriores a este módulo, cuyo costo se estimó
              con el costo actual del producto. Las ventas nuevas guardan el costo real del momento.
            </p>
          )}
          {r.noCostLines > 0 && (
            <p className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
              {r.noCostLines} línea(s) no tienen costo registrado y se contaron con costo cero.
            </p>
          )}

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="overflow-x-auto rounded-xl bg-white shadow lg:col-span-2">
              <div className="p-3 text-sm font-semibold">Rentabilidad por producto (USD)</div>
              <table className="w-full text-left text-sm">
                <thead className="border-y bg-slate-100">
                  <tr><th className="p-2">Producto</th><th className="p-2 text-right">Cant.</th><th className="p-2 text-right">Ventas</th>
                    <th className="p-2 text-right">Costo</th><th className="p-2 text-right">Utilidad</th><th className="p-2 text-right">Margen</th></tr>
                </thead>
                <tbody>
                  {r.byProduct.map((p, i) => (
                    <tr key={i} className="border-b">
                      <td className="p-2">{p.name}{p.sku && <span className="ml-1 text-xs text-slate-400">{p.sku}</span>}</td>
                      <td className="p-2 text-right">{p.quantity}</td>
                      <td className="p-2 text-right">{usd(p.revenueUsdMinor)}</td>
                      <td className="p-2 text-right">{usd(p.costUsdMinor)}</td>
                      <td className={`p-2 text-right font-medium ${p.profitUsdMinor < 0 ? "text-red-700" : ""}`}>{usd(p.profitUsdMinor)}</td>
                      <td className={`p-2 text-right ${p.marginBp < 0 ? "text-red-700" : ""}`}>{pct(p.marginBp)}</td>
                    </tr>
                  ))}
                  {r.byProduct.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-500">Sin ventas en el período</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="rounded-xl bg-white p-3 shadow">
              <div className="mb-2 text-sm font-semibold">Gastos por categoría</div>
              <div className="space-y-1 text-sm">
                {r.byCategory.map((c) => (
                  <div key={c.category} className="flex justify-between gap-2">
                    <span>{c.category}</span><span>{usd(c.usdMinor)}</span>
                  </div>
                ))}
                {r.byCategory.length === 0 && <div className="text-slate-500">Sin gastos en el período</div>}
              </div>
            </div>
          </div>
          <p className="max-w-3xl text-sm text-slate-500">
            Ventas netas = lo vendido sin IVA y con descuentos aplicados. Cada operación se convierte con la tasa que tenía al emitirse.
            En una devolución, el costo solo se recupera si el producto volvió al inventario.
          </p>
        </div>
      )}
    </div>
  );
}
