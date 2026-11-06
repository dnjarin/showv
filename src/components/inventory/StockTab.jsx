import { useCallback, useEffect, useState } from "react";
import { catalogApi, inventoryApi } from "../../services/api";
import MovementForm from "./MovementForm";

const STATUS = { all: "Todos", available: "Con stock", low: "Bajo el mínimo", zero: "Agotados" };

export default function StockTab() {
  const [filters, setFilters] = useState({ search: "", categoryId: "", warehouseId: "", status: "all", inactive: false });
  const [data, setData] = useState({ warehouses: [], rows: [] });
  const [categories, setCategories] = useState([]);
  const [moving, setMoving] = useState(null); // null | { productId?, warehouseId? }
  const [error, setError] = useState("");
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));

  useEffect(() => { catalogApi.options().then((o) => setCategories(o.categories)).catch(() => {}); }, []);

  const load = useCallback(async () => {
    try {
      setData(await inventoryApi.overview({
        search: filters.search.trim() || null,
        categoryId: filters.categoryId ? Number(filters.categoryId) : null,
        warehouseId: filters.warehouseId ? Number(filters.warehouseId) : null,
        status: filters.status,
        includeInactive: filters.inactive,
      }));
      setError("");
    } catch (e) { setError(e.message); }
  }, [filters]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const shown = filters.warehouseId
    ? data.warehouses.filter((w) => String(w.id) === String(filters.warehouseId))
    : data.warehouses;
  const qtyIn = (row, wid) => row.byWarehouse.find((w) => w.warehouseId === wid)?.quantity ?? 0;
  const badge = (r) =>
    r.total <= 0 ? ["Agotado", "bg-red-100 text-red-700"]
    : r.total <= r.minStock ? ["Stock bajo", "bg-amber-100 text-amber-800"]
    : ["OK", "bg-green-100 text-green-700"];

  const stats = {
    products: data.rows.length,
    zero: data.rows.filter((r) => r.total <= 0).length,
    low: data.rows.filter((r) => r.total > 0 && r.total <= r.minStock).length,
    units: data.rows.reduce((s, r) => s + Math.max(r.total, 0), 0),
  };
  const input = "rounded border p-2";

  return (
    <div>
      <div className="mb-4 grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4">
        {[["Productos", stats.products], ["Unidades", stats.units], ["Bajo el mínimo", stats.low], ["Agotados", stats.zero]].map(([l, v]) => (
          <div key={l} className="rounded-xl bg-white p-3 shadow">
            <div className="text-xs text-slate-500">{l}</div>
            <div className="text-2xl font-semibold">{v}</div>
          </div>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input className={`${input} w-64`} placeholder="Buscar por nombre, SKU o código" value={filters.search}
          onChange={(e) => set("search", e.target.value)} />
        <select className={input} value={filters.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
          <option value="">Todas las categorías</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className={input} value={filters.warehouseId} onChange={(e) => set("warehouseId", e.target.value)}>
          <option value="">Todos los almacenes</option>
          {data.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select className={input} value={filters.status} onChange={(e) => set("status", e.target.value)}>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={filters.inactive} onChange={(e) => set("inactive", e.target.checked)} />
          Incluir inactivos
        </label>
        <button onClick={() => setMoving({})} className="ml-auto rounded bg-slate-900 px-4 py-2 text-white">
          Registrar movimiento
        </button>
      </div>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr>
              <th className="p-3">SKU</th><th className="p-3">Producto</th><th className="p-3">Categoría</th>
              {shown.map((w) => (
                <th key={w.id} className="p-3 text-right">{w.name}{w.isSales && <span className="block text-[10px] font-normal text-slate-500">ventas</span>}</th>
              ))}
              <th className="p-3 text-right">Total</th><th className="p-3 text-right">Mín.</th>
              <th className="p-3">Estado</th><th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => {
              const [label, cls] = badge(r);
              return (
                <tr key={r.productId} className={`border-b ${r.active ? "" : "opacity-50"}`}>
                  <td className="p-3 font-mono">{r.sku}</td>
                  <td className="p-3">{r.name}{r.usesLots && <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">Lotes</span>}</td>
                  <td className="p-3">{r.categoryName ?? "—"}</td>
                  {shown.map((w) => (
                    <td key={w.id} className="p-3 text-right">{qtyIn(r, w.id)}</td>
                  ))}
                  <td className="p-3 text-right font-semibold">{r.total}</td>
                  <td className="p-3 text-right">{r.minStock}</td>
                  <td className="p-3"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{label}</span></td>
                  <td className="p-3 text-right">
                    <button className="underline" onClick={() => setMoving({
                      productId: r.productId,
                      warehouseId: filters.warehouseId ? Number(filters.warehouseId) : undefined,
                    })}>Mover</button>
                  </td>
                </tr>
              );
            })}
            {data.rows.length === 0 && (
              <tr><td colSpan={7 + shown.length} className="p-6 text-center text-slate-500">Sin resultados</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        «Bajo el mínimo» compara el total de todos los almacenes contra el mínimo del producto.
      </p>

      {moving && (
        <MovementForm rows={data.rows} warehouses={data.warehouses} preset={moving}
          onClose={() => setMoving(null)} onDone={() => { setMoving(null); load(); }} />
      )}
    </div>
  );
}