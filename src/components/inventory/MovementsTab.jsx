import { useCallback, useEffect, useState } from "react";
import { inventoryApi, warehousesApi } from "../../services/api";
import { daysAgo, localDate, todayStr } from "../../utils/dates";
import { REASONS } from "./labels";

export default function MovementsTab() {
  const [f, setF] = useState({ from: daysAgo(30), to: todayStr(), warehouseId: "", reason: "", search: "" });
  const [warehouses, setWarehouses] = useState([]);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => { warehousesApi.list(true).then(setWarehouses).catch(() => {}); }, []);

  const load = useCallback(async () => {
    try {
      setRows(await inventoryApi.movements({
        from: f.from || null, to: f.to || null,
        warehouseId: f.warehouseId ? Number(f.warehouseId) : null,
        reason: f.reason || null, search: f.search.trim() || null, limit: 300,
      }));
      setError("");
    } catch (e) { setError(e.message); }
  }, [f]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  const input = "rounded border p-2";
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="text-sm">Desde
          <input type="date" className={`${input} mt-1 block`} value={f.from} onChange={(e) => set("from", e.target.value)} />
        </label>
        <label className="text-sm">Hasta
          <input type="date" className={`${input} mt-1 block`} value={f.to} onChange={(e) => set("to", e.target.value)} />
        </label>
        <select className={input} value={f.warehouseId} onChange={(e) => set("warehouseId", e.target.value)}>
          <option value="">Todos los almacenes</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select className={input} value={f.reason} onChange={(e) => set("reason", e.target.value)}>
          <option value="">Todos los tipos</option>
          {Object.entries(REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input className={`${input} w-56`} placeholder="Producto, SKU o nota" value={f.search}
          onChange={(e) => set("search", e.target.value)} />
      </div>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      {rows.length === 300 && (
        <p className="mb-2 text-xs text-slate-500">Se muestran los 300 movimientos más recientes. Acota los filtros.</p>
      )}

      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Fecha</th><th className="p-3">Almacén</th><th className="p-3">Producto</th>
              <th className="p-3">Lote</th><th className="p-3">Tipo</th><th className="p-3 text-right">Cantidad</th>
              <th className="p-3">Motivo / nota</th><th className="p-3">Usuario</th></tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} className="border-b">
                <td className="whitespace-nowrap p-3">{localDate(m.createdAt)}</td>
                <td className="p-3">{m.warehouseName}</td>
                <td className="p-3">{m.sku} · {m.productName}</td>
                <td className="p-3 font-mono text-xs">{m.lotCode ?? "—"}</td>
                <td className="p-3">{REASONS[m.reason] ?? m.reason}</td>
                <td className={`p-3 text-right font-semibold ${m.quantity < 0 ? "text-red-600" : "text-green-700"}`}>
                  {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                </td>
                <td className="p-3">{m.note ?? "—"}</td>
                <td className="p-3">{m.username ?? "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={8} className="p-6 text-center text-slate-500">Sin movimientos con esos filtros</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}