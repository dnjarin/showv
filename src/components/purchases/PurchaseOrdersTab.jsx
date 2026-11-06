import { useCallback, useEffect, useState } from "react";
import { catalogApi, purchaseOrdersApi } from "../../services/api";
import { formatMoney, fromMinor, toMinor } from "../../utils/money";
import { localDate } from "../../utils/dates";
import SupplierPicker from "./SupplierPicker";
import OrderTicket from "./OrderTicket";
import DraftBanner from "../DraftBanner";
import { useDraft } from "../../hooks/useDraft";

const STATUS = {
  open: { label: "Abierta", cls: "bg-blue-100 text-blue-800" },
  received: { label: "Recibida", cls: "bg-green-100 text-green-800" },
  cancelled: { label: "Anulada", cls: "bg-slate-200 text-slate-600" },
};
const input = "rounded border p-2";

function Builder({ onSaved, onCancel }) {
  const [supplier, setSupplier] = useState(null);
  const [currency, setCurrency] = useState("USD");
  const [expected, setExpected] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([]);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const draft = useDraft("purchase-order", {
    data: { supplier, currency, expected, notes, lines },
    isEmpty: (d) => d.lines.length === 0,
    onRestore: (d) => {
      const ls = (Array.isArray(d?.lines) ? d.lines : []).filter((x) => x && Number.isInteger(x.productId))
        .map((x) => ({ ...x, sku: String(x.sku ?? ""), name: String(x.name ?? ""),
          quantity: String(x.quantity ?? "1"), cost: String(x.cost ?? "") }));
      if (ls.length === 0) return false;
      setLines(ls);
      setSupplier(d.supplier && Number.isInteger(d.supplier.id) ? d.supplier : null);
      if (d.currency === "USD" || d.currency === "VES") setCurrency(d.currency);
      setExpected(typeof d.expected === "string" ? d.expected : "");
      setNotes(typeof d.notes === "string" ? d.notes : "");
      return true;
    },
  });
  const discardDraft = () => { draft.clear(); setLines([]); setSupplier(null); setExpected(""); setNotes(""); };

  useEffect(() => {
    const q = search.trim();
    if (!q) { setResults([]); return; }
    const t = setTimeout(() => {
      catalogApi.listProducts(q, false, false)
        .then((r) => setResults(r.filter((p) => p.trackStock).slice(0, 8))).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [search]);

  const costFor = (p, cur) => (p.priceCurrency === cur ? fromMinor(p.costMinor) : "");
  const add = (p, qty = 1) => {
    setLines((ls) => ls.some((l) => l.productId === p.id)
      ? ls.map((l) => (l.productId === p.id ? { ...l, quantity: String((parseInt(l.quantity, 10) || 0) + qty) } : l))
      : [...ls, { productId: p.id, sku: p.sku, name: p.name, quantity: String(qty), cost: costFor(p, currency),
          productCurrency: p.priceCurrency, productCost: p.costMinor, stock: p.stock, minStock: p.minStock }]);
    setSearch(""); setResults([]);
  };
  const changeCurrency = (cur) => {
    setCurrency(cur);
    setLines((ls) => ls.map((l) => ({ ...l, cost: l.productCurrency === cur ? fromMinor(l.productCost) : "" })));
  };
  const setLine = (id, patch) => setLines((ls) => ls.map((l) => (l.productId === id ? { ...l, ...patch } : l)));

  // Productos en o bajo su stock mínimo: pide hasta el doble del mínimo
  const suggest = async () => {
    setError("");
    try {
      const low = (await catalogApi.listProducts(null, false, true)).filter((p) => p.trackStock);
      if (low.length === 0) return setError("No hay productos bajo su stock mínimo");
      low.forEach((p) => add(p, Math.max(p.minStock * 2 - p.stock, 1)));
    } catch (e) { setError(e.message); }
  };

  const parsed = lines.map((l) => ({ q: parseInt(l.quantity, 10), c: toMinor(l.cost) }));
  const valid = lines.length > 0 && parsed.every((x) => x.q > 0 && x.c !== null);
  const total = parsed.reduce((s, x) => (x.q > 0 && x.c !== null ? s + x.q * x.c : s), 0);

  const save = async () => {
    setError("");
    if (!supplier) return setError("Selecciona el proveedor");
    if (!valid) return setError("Revisa cantidades y costos (ejemplo: 12.50)");
    setBusy(true);
    try {
      const id = await purchaseOrdersApi.create({
        supplierId: supplier.id, currencyCode: currency, expectedDate: expected || null, notes: notes || null,
        items: lines.map((l, i) => ({ productId: l.productId, quantity: parsed[i].q, unitCostMinor: parsed[i].c })),
      });
      draft.clear();
      onSaved(id);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="mb-6 rounded-xl border bg-white p-4 shadow">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Nueva orden de compra</h2>
        <button onClick={onCancel} className="underline">Cerrar</button>
      </div>
      {draft.restored && <DraftBanner what="borrador de orden" onKeep={draft.dismiss} onDiscard={discardDraft} />}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="relative mb-3 flex gap-2">
            <div className="relative flex-1">
              <input className={`${input} w-full`} placeholder="Buscar producto por nombre, SKU o código de barras…"
                value={search} onChange={(e) => setSearch(e.target.value)} />
              {results.length > 0 && (
                <ul className="absolute z-10 mt-1 w-full rounded border bg-white shadow">
                  {results.map((p) => (
                    <li key={p.id}>
                      <button type="button" onClick={() => add(p)} className="flex w-full justify-between p-2 text-left hover:bg-slate-100">
                        <span>{p.sku} · {p.name}</span>
                        <span className="text-sm text-slate-500">stock {p.stock} / mín. {p.minStock}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button type="button" onClick={suggest} className="rounded border px-3 py-2 text-sm">Sugerir reposición</button>
          </div>
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-100">
                <tr><th className="p-2">Producto</th><th className="p-2">Stock</th><th className="p-2">Cant.</th>
                  <th className="p-2">Costo unit.</th><th className="p-2">Total</th><th className="p-2" /></tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.productId} className="border-b">
                    <td className="p-2">{l.sku} · {l.name}</td>
                    <td className="p-2 text-slate-500">{l.stock} / mín. {l.minStock}</td>
                    <td className="p-2"><input className="w-20 rounded border p-1" inputMode="numeric" value={l.quantity}
                      onChange={(e) => setLine(l.productId, { quantity: e.target.value })} /></td>
                    <td className="p-2"><input className="w-24 rounded border p-1" inputMode="decimal" value={l.cost}
                      onChange={(e) => setLine(l.productId, { cost: e.target.value })} /></td>
                    <td className="p-2">{parsed[i].q > 0 && parsed[i].c !== null ? formatMoney(parsed[i].q * parsed[i].c, currency) : "…"}</td>
                    <td className="p-2 text-right"><button className="underline" onClick={() => setLines((x) => x.filter((r) => r.productId !== l.productId))}>Quitar</button></td>
                  </tr>
                ))}
                {lines.length === 0 && <tr><td colSpan={6} className="p-5 text-center text-slate-500">Agrega productos o usa «Sugerir reposición»</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="space-y-3">
          <SupplierPicker value={supplier} onChange={setSupplier} />
          <div className="flex gap-2">
            <select className={input} value={currency} onChange={(e) => changeCurrency(e.target.value)}>
              <option value="USD">USD</option><option value="VES">Bs. (VES)</option>
            </select>
            <label className="flex flex-1 items-center gap-2 text-sm">Entrega
              <input type="date" className={`${input} flex-1`} value={expected} onChange={(e) => setExpected(e.target.value)} />
            </label>
          </div>
          <textarea className={`${input} w-full`} rows={2} placeholder="Notas o condiciones (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="flex justify-between rounded border p-3 text-lg font-semibold">
            <span>Total (sin IVA)</span><span>{formatMoney(total, currency)}</span>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button onClick={save} disabled={busy || !valid || !supplier}
            className="w-full rounded bg-slate-900 p-3 text-white disabled:opacity-50">Guardar orden</button>
        </div>
      </div>
    </div>
  );
}

export default function PurchaseOrdersTab({ onReceive }) {
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [building, setBuilding] = useState(false);
  const [view, setView] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setRows(await purchaseOrdersApi.list(status || null, search || null)); setError(""); }
    catch (e) { setError(e.message); }
  }, [status, search]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  const show = async (id) => { try { setView(await purchaseOrdersApi.get(id)); } catch (e) { setError(e.message); } };
  const receive = async (id) => {
    try { onReceive(await purchaseOrdersApi.toPurchase(id)); } catch (e) { setError(e.message); }
  };
  const cancel = async (r) => {
    if (!window.confirm(`¿Anular la orden ${r.number}?`)) return;
    try { await purchaseOrdersApi.cancel(r.id); load(); } catch (e) { setError(e.message); }
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-slate-600">Pedidos a proveedores. No cambian el stock hasta que registras la compra al recibir la mercadería.</p>
        {!building && <button onClick={() => setBuilding(true)} className="rounded bg-slate-900 px-4 py-2 text-white">Nueva orden</button>}
      </div>
      {error && <p className="mb-3 rounded bg-red-50 p-3 text-red-700">{error}</p>}
      {building && <Builder onCancel={() => setBuilding(false)} onSaved={(id) => { setBuilding(false); load(); show(id); }} />}
      <div className="mb-3 flex flex-wrap gap-3">
        <input className="w-64 rounded border p-2" placeholder="Buscar por número o proveedor" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="rounded border p-2" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todas</option><option value="open">Abiertas</option>
          <option value="received">Recibidas</option><option value="cancelled">Anuladas</option>
        </select>
      </div>
      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Número</th><th className="p-3">Fecha</th><th className="p-3">Proveedor</th>
              <th className="p-3">Total</th><th className="p-3">Entrega</th><th className="p-3">Estado</th><th className="p-3" /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b">
                <td className="p-3 font-mono">{r.number}</td>
                <td className="p-3">{localDate(r.createdAt)}</td>
                <td className="p-3">{r.supplierName}</td>
                <td className="p-3">{formatMoney(r.totalMinor, r.currencyCode)}</td>
                <td className="p-3">{r.expectedDate ? r.expectedDate.split("-").reverse().join("/") : "—"}{r.overdue && <span className="ml-1 text-red-600">(atrasada)</span>}</td>
                <td className="p-3"><span className={`rounded px-2 py-0.5 text-xs ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span></td>
                <td className="space-x-3 p-3 text-right">
                  <button className="underline" onClick={() => show(r.id)}>Ver / imprimir</button>
                  {r.status === "open" && <button className="underline" onClick={() => receive(r.id)}>Recibir</button>}
                  {r.status === "open" && <button className="underline" onClick={() => cancel(r)}>Anular</button>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-500">Sin órdenes</td></tr>}
          </tbody>
        </table>
      </div>
      {view && <OrderTicket o={view} onClose={() => setView(null)} />}
    </div>
  );
}
