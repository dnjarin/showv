import { useCallback, useEffect, useState } from "react";
import { catalogApi, lotsApi, warehousesApi } from "../../services/api";
import { formatMoney, toMinor } from "../../utils/money";
import { localDate } from "../../utils/dates";

function NewLotForm({ warehouses, onClose, onDone }) {
  const [products, setProducts] = useState([]);
  const [f, setF] = useState({
    productId: "", code: "", brand: "", receivedDate: "", cost: "", currency: "USD",
    warehouseId: String(warehouses.find((w) => w.isSales)?.id ?? warehouses[0]?.id ?? ""), quantity: "", notes: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    catalogApi.listProducts("", false, false)
      .then((r) => setProducts(r.filter((p) => p.trackStock && p.usesLots)))
      .catch((e) => setError(e.message));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    const cost = toMinor(f.cost);
    const qty = f.quantity.trim() === "" ? 0 : parseInt(f.quantity, 10);
    if (!f.productId) return setError("Elige un producto");
    if (!f.code.trim()) return setError("Indica el código del lote");
    if (cost === null) return setError("Costo inválido (ejemplo: 12.50)");
    if (Number.isNaN(qty) || qty < 0) return setError("Cantidad inválida");
    setBusy(true);
    try {
      await lotsApi.create({
        productId: Number(f.productId), code: f.code.trim(), brand: f.brand.trim() || null,
        receivedDate: f.receivedDate || null, unitCostMinor: cost, costCurrency: f.currency,
        notes: f.notes.trim() || null, warehouseId: qty > 0 ? Number(f.warehouseId) : null, quantity: qty,
      });
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  };

  const input = "w-full rounded border p-2";
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4">
      <form onSubmit={submit} className="grid w-full max-w-lg grid-cols-2 gap-3 rounded-2xl bg-white p-5 shadow-2xl">
        <h2 className="col-span-2 text-lg font-semibold">Nuevo lote</h2>
        <select className={`${input} col-span-2`} value={f.productId} onChange={(e) => set("productId", e.target.value)}>
          <option value="">— Producto con control de lotes —</option>
          {products.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}
        </select>
        {products.length === 0 && (
          <p className="col-span-2 text-xs text-slate-500">
            Ningún producto controla lotes todavía. Actívalo en Productos → editar → «Controlar por lotes».
          </p>
        )}
        <input className={input} placeholder="Código del lote" maxLength={30} value={f.code} onChange={(e) => set("code", e.target.value)} />
        <input className={input} placeholder="Marca (opcional)" maxLength={40} value={f.brand} onChange={(e) => set("brand", e.target.value)} />
        <label className="text-sm">Fecha de llegada
          <input type="date" className={`${input} mt-1`} value={f.receivedDate} onChange={(e) => set("receivedDate", e.target.value)} />
        </label>
        <div className="grid grid-cols-[1fr_5rem] gap-2">
          <label className="text-sm">Costo unitario
            <input className={`${input} mt-1`} placeholder="0.00" value={f.cost} onChange={(e) => set("cost", e.target.value)} />
          </label>
          <label className="text-sm">Moneda
            <select className={`${input} mt-1`} value={f.currency} onChange={(e) => set("currency", e.target.value)}>
              <option>USD</option><option>VES</option>
            </select>
          </label>
        </div>
        <input className={input} inputMode="numeric" placeholder="Existencia inicial (opcional)" value={f.quantity}
          onChange={(e) => set("quantity", e.target.value)} />
        <select className={input} value={f.warehouseId} onChange={(e) => set("warehouseId", e.target.value)}>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <input className={`${input} col-span-2`} placeholder="Notas (opcional)" maxLength={200} value={f.notes} onChange={(e) => set("notes", e.target.value)} />
        {error && <p className="col-span-2 text-sm text-red-600">{error}</p>}
        <div className="col-span-2 flex gap-2">
          <button disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
            {busy ? "Guardando…" : "Crear lote"}
          </button>
          <button type="button" onClick={onClose} className="rounded border px-4 py-2">Cancelar</button>
        </div>
      </form>
    </div>
  );
}

export default function LotsTab() {
  const [rows, setRows] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [search, setSearch] = useState("");
  const [empty, setEmpty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null); // { id, brand, notes }
  const [error, setError] = useState("");

  useEffect(() => { warehousesApi.list(false).then(setWarehouses).catch(() => {}); }, []);

  const load = useCallback(async () => {
    try {
      setRows(await lotsApi.report(search.trim() || null, empty));
      setError("");
    } catch (e) { setError(e.message); }
  }, [search, empty]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const whName = (id) => warehouses.find((w) => w.id === id)?.name ?? `#${id}`;
  const saveEdit = async () => {
    try {
      await lotsApi.update(editing.id, editing.brand.trim() || null, editing.notes.trim() || null);
      setEditing(null); load();
    } catch (e) { setError(e.message); }
  };
  const input = "rounded border p-2";

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input className={`${input} w-64`} placeholder="Producto, SKU, lote o marca" value={search}
          onChange={(e) => setSearch(e.target.value)} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={empty} onChange={(e) => setEmpty(e.target.checked)} />
          Incluir lotes agotados
        </label>
        <button onClick={() => setCreating(true)} className="ml-auto rounded bg-slate-900 px-4 py-2 text-white">
          Nuevo lote
        </button>
      </div>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Producto</th><th className="p-3">Lote</th><th className="p-3">Marca</th>
              <th className="p-3">Llegada</th><th className="p-3 text-right">Costo</th>
              <th className="p-3 text-right">Existencia</th><th className="p-3">Por almacén</th><th className="p-3"></th></tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id} className={`border-b ${l.stock <= 0 ? "opacity-50" : ""}`}>
                <td className="p-3">{l.sku} · {l.productName}</td>
                <td className="p-3 font-mono">{l.code}</td>
                <td className="p-3">{l.brand ?? "—"}</td>
                <td className="whitespace-nowrap p-3">{localDate(l.receivedDate)}</td>
                <td className="p-3 text-right">{l.unitCostMinor != null ? formatMoney(l.unitCostMinor, l.costCurrency) : "—"}</td>
                <td className="p-3 text-right font-semibold">{l.stock}</td>
                <td className="p-3 text-xs text-slate-600">
                  {l.byWarehouse.map((w) => `${whName(w.warehouseId)}: ${w.quantity}`).join(" · ") || "—"}
                </td>
                <td className="p-3 text-right">
                  <button className="underline" onClick={() => setEditing({ id: l.id, brand: l.brand ?? "", notes: l.notes ?? "" })}>
                    Editar
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={8} className="p-6 text-center text-slate-500">
                No hay lotes. Activa «Controlar por lotes» en un producto para empezar.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Cada compra de un producto con lotes crea su lote con el costo de esa compra. El código, la fecha y el costo de un lote no se modifican.
      </p>

      {editing && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4">
          <div className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-5 shadow-2xl">
            <h2 className="text-lg font-semibold">Editar lote</h2>
            <input className={`${input} w-full`} placeholder="Marca" maxLength={40} value={editing.brand}
              onChange={(e) => setEditing({ ...editing, brand: e.target.value })} />
            <input className={`${input} w-full`} placeholder="Notas" maxLength={200} value={editing.notes}
              onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
            <div className="flex gap-2">
              <button onClick={saveEdit} className="rounded bg-slate-900 px-4 py-2 text-white">Guardar</button>
              <button onClick={() => setEditing(null)} className="rounded border px-4 py-2">Cancelar</button>
            </div>
          </div>
        </div>
      )}
      {creating && warehouses.length > 0 && (
        <NewLotForm warehouses={warehouses} onClose={() => setCreating(false)}
          onDone={() => { setCreating(false); load(); }} />
      )}
    </div>
  );
}
