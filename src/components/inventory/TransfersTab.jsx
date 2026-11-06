import { useCallback, useEffect, useState } from "react";
import { inventoryApi, warehousesApi } from "../../services/api";
import { localDate } from "../../utils/dates";
import LotSelect from "../lots/LotSelect";

const EMPTY_LINE = { productId: "", quantity: "", lotId: "" };

export default function TransfersTab() {
  const [warehouses, setWarehouses] = useState([]);
  const [history, setHistory] = useState([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [available, setAvailable] = useState([]);
  const [lines, setLines] = useState([{ ...EMPTY_LINE }]);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const loadHistory = useCallback(() => {
    inventoryApi.transfers(50).then(setHistory).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    warehousesApi.list(false).then(setWarehouses).catch((e) => setError(e.message));
    loadHistory();
  }, [loadHistory]);

  // Productos con existencias en el almacén de origen
  const loadAvailable = useCallback(async (wid) => {
    if (!wid) { setAvailable([]); return; }
    try {
      const o = await inventoryApi.overview({
        search: null, categoryId: null, warehouseId: Number(wid), status: "available", includeInactive: false,
      });
      setAvailable(o.rows);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { setLines([{ ...EMPTY_LINE }]); loadAvailable(from); }, [from, loadAvailable]);

  const qtyAvail = (productId) =>
    available.find((r) => String(r.productId) === String(productId))
      ?.byWarehouse.find((w) => String(w.warehouseId) === String(from))?.quantity ?? 0;

  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setMsg("");
    if (!from || !to) return setError("Elige el almacén de origen y el de destino");
    if (from === to) return setError("El origen y el destino deben ser distintos");
    const items = [];
    for (const l of lines) {
      const q = parseInt(l.quantity, 10);
      if (!l.productId || Number.isNaN(q) || q <= 0) return setError("Completa producto y cantidad en cada línea");
      const row = available.find((r) => String(r.productId) === String(l.productId));
      if (row?.usesLots && !l.lotId) return setError(`Elige el lote de «${row.name}»`);
      if (q > qtyAvail(l.productId)) return setError("Una cantidad supera lo disponible en el origen");
      items.push({ productId: Number(l.productId), quantity: q, lotId: row?.usesLots ? Number(l.lotId) : null });
    }
    setBusy(true);
    try {
      await inventoryApi.transfer({
        fromWarehouseId: Number(from), toWarehouseId: Number(to), note: note.trim() || null, items,
      });
      setMsg("Transferencia registrada");
      setLines([{ ...EMPTY_LINE }]); setNote("");
      loadHistory(); loadAvailable(from);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const input = "w-full rounded border p-2";
  if (warehouses.length < 2) {
    return (
      <div className="max-w-xl rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900">
        Para transferir necesitas al menos dos almacenes. Crea otro en la pestaña <b>Almacenes</b>.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="max-w-3xl space-y-3 rounded-xl bg-white p-4 shadow">
        <h2 className="font-semibold">Nueva transferencia</h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">Desde
            <select className={`${input} mt-1`} value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">— Origen —</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <label className="text-sm">Hacia
            <select className={`${input} mt-1`} value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">— Destino —</option>
              {warehouses.filter((w) => String(w.id) !== String(from)).map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </label>
        </div>

        {lines.map((l, i) => (
          <div key={i} className="space-y-1">
          <div className="grid grid-cols-[1fr_8rem_auto] items-center gap-2">
            <select className={input} value={l.productId} disabled={!from}
              onChange={(e) => setLine(i, { productId: e.target.value, lotId: "" })}>
              <option value="">{from ? "— Producto —" : "Elige primero el origen"}</option>
              {available.map((r) => (
                <option key={r.productId} value={r.productId}>
                  {r.sku} · {r.name} (disp. {r.byWarehouse.find((w) => String(w.warehouseId) === String(from))?.quantity ?? 0})
                </option>
              ))}
            </select>
            <input className={input} inputMode="numeric" placeholder="Cantidad" value={l.quantity}
              onChange={(e) => setLine(i, { quantity: e.target.value })} />
            <button type="button" className="text-sm underline" disabled={lines.length === 1}
              onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Quitar</button>
          </div>
          {available.find((r) => String(r.productId) === String(l.productId))?.usesLots && (
            <LotSelect className="w-full" productId={l.productId} warehouseId={from}
              value={l.lotId} onChange={(v) => setLine(i, { lotId: v })} />
          )}
          </div>
        ))}
        <button type="button" className="rounded border px-3 py-1 text-sm"
          onClick={() => setLines((ls) => [...ls, { ...EMPTY_LINE }])}>+ Agregar producto</button>

        <input className={input} placeholder="Nota (opcional)" value={note} onChange={(e) => setNote(e.target.value)} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        {msg && <p className="text-sm text-green-700">{msg}</p>}
        <button disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
          {busy ? "Transfiriendo…" : "Transferir"}
        </button>
      </form>

      <div>
        <h2 className="mb-2 font-semibold">Historial</h2>
        <div className="space-y-2">
          {history.map((t) => (
            <div key={t.id} className="rounded-xl bg-white p-3 text-sm shadow">
              <div className="flex flex-wrap justify-between gap-2">
                <b>{t.fromName} → {t.toName}</b>
                <span className="text-slate-500">{localDate(t.createdAt)} · {t.username ?? "—"}</span>
              </div>
              <ul className="mt-1 text-slate-700">
                {t.lines.map((l, i) => <li key={i}>{l.quantity} × {l.sku} · {l.name}{l.lotCode ? ` (lote ${l.lotCode})` : ""}</li>)}
              </ul>
              {t.note && <div className="mt-1 text-xs text-slate-500">Nota: {t.note}</div>}
            </div>
          ))}
          {history.length === 0 && <p className="text-sm text-slate-500">Aún no hay transferencias.</p>}
        </div>
      </div>
    </div>
  );
}