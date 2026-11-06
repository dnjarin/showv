import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../store/authStore";
import { reportsApi, retentionsApi } from "../../services/api";
import { localDate, todayStr } from "../../utils/dates";
import { formatMoney } from "../../utils/money";
import { csvMoney, toCsv } from "../../utils/csv";
import VoucherModal from "./VoucherModal";

const pct = (bp) => `${String(bp / 100).replace(".", ",")} %`;

export default function RetentionsTab() {
  const isAdmin = useAuth((s) => s.user.role === "admin");
  const today = todayStr();
  const [f, setF] = useState({ from: today.slice(0, 8) + "01", to: today, kind: "", status: "", search: "" });
  const [data, setData] = useState({ rows: [], totals: [] });
  const [viewId, setViewId] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  const load = useCallback(async () => {
    try {
      setData(await retentionsApi.list({
        from: f.from || null, to: f.to || null, kind: f.kind || null,
        status: f.status || null, search: f.search.trim() || null, limit: 500,
      }));
      setError("");
    } catch (e) { setError(e.message); }
  }, [f]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  const exportCsv = async () => {
    setMsg(""); setError("");
    const header = ["Comprobante", "Tipo", "Período", "Fecha", "Proveedor", "RIF", "Factura", "Concepto",
      "Base Bs.", "Impuesto Bs.", "Porcentaje", "Retenido Bs.", "Estado"];
    const rows = data.rows.map((r) => [
      r.voucherNumber, r.kind, r.period, localDate(r.createdAt), r.supplierName, r.supplierDoc,
      r.invoiceNumber ?? "", r.conceptName ?? "", csvMoney(r.baseVesMinor), csvMoney(r.taxVesMinor),
      String(r.rateBp / 100).replace(".", ","), csvMoney(r.amountVesMinor),
      r.status === "voided" ? "Anulado" : "Vigente",
    ]);
    try {
      const path = await reportsApi.exportCsv(`retenciones_${f.from}_${f.to}.csv`, toCsv(header, rows));
      setMsg(`Guardado en: ${path}`);
    } catch (e) { setError(e.message); }
  };

  const input = "rounded border p-2";
  const totalOf = (k) => data.totals.find((t) => t.kind === k);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="text-sm">Desde
          <input type="date" className={`${input} mt-1 block`} value={f.from} onChange={(e) => set("from", e.target.value)} />
        </label>
        <label className="text-sm">Hasta
          <input type="date" className={`${input} mt-1 block`} value={f.to} onChange={(e) => set("to", e.target.value)} />
        </label>
        <select className={input} value={f.kind} onChange={(e) => set("kind", e.target.value)}>
          <option value="">IVA e ISLR</option><option value="IVA">Solo IVA</option><option value="ISLR">Solo ISLR</option>
        </select>
        <select className={input} value={f.status} onChange={(e) => set("status", e.target.value)}>
          <option value="">Todos los estados</option><option value="active">Vigentes</option><option value="voided">Anulados</option>
        </select>
        <input className={`${input} w-56`} placeholder="Comprobante, proveedor o factura" value={f.search}
          onChange={(e) => set("search", e.target.value)} />
        {isAdmin && data.rows.length > 0 && (
          <button onClick={exportCsv} className="rounded border px-4 py-2">Exportar CSV</button>
        )}
      </div>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      {msg && <p className="mb-2 text-sm text-green-700">{msg}</p>}

      <div className="mb-4 grid max-w-2xl grid-cols-2 gap-3">
        {["IVA", "ISLR"].map((k) => (
          <div key={k} className="rounded-xl bg-white p-4 shadow">
            <div className="text-sm text-slate-500">{k} retenido (vigentes)</div>
            <div className="text-2xl font-semibold">{formatMoney(totalOf(k)?.amountVesMinor ?? 0, "VES")}</div>
            <div className="text-xs text-slate-500">{totalOf(k)?.count ?? 0} comprobante(s)</div>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Comprobante</th><th className="p-3">Tipo</th><th className="p-3">Fecha</th>
              <th className="p-3">Proveedor</th><th className="p-3">Factura</th><th className="p-3 text-right">Base</th>
              <th className="p-3 text-right">%</th><th className="p-3 text-right">Retenido</th><th className="p-3"></th></tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id} className={`border-b ${r.status === "voided" ? "opacity-50" : ""}`}>
                <td className="p-3 font-mono text-xs">{r.voucherNumber}</td>
                <td className="p-3">{r.kind}{r.conceptName ? ` · ${r.conceptName}` : ""}</td>
                <td className="whitespace-nowrap p-3">{localDate(r.createdAt)}</td>
                <td className="p-3">{r.supplierName}</td>
                <td className="p-3">{r.invoiceNumber ?? "—"}</td>
                <td className="p-3 text-right">{formatMoney(r.baseVesMinor, "VES")}</td>
                <td className="p-3 text-right">{pct(r.rateBp)}</td>
                <td className="p-3 text-right font-semibold">{formatMoney(r.amountVesMinor, "VES")}{r.status === "voided" ? " (anulado)" : ""}</td>
                <td className="p-3 text-right"><button className="underline" onClick={() => setViewId(r.id)}>Ver</button></td>
              </tr>
            ))}
            {data.rows.length === 0 && (
              <tr><td colSpan={9} className="p-6 text-center text-slate-500">Sin retenciones con esos filtros</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {viewId && <VoucherModal id={viewId} onClose={() => setViewId(null)} />}
    </div>
  );
}