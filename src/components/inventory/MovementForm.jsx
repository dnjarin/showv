import { useState } from "react";
import { inventoryApi } from "../../services/api";
import { KINDS } from "./labels";
import LotSelect from "../lots/LotSelect";

export default function MovementForm({ rows, warehouses, preset, onClose, onDone }) {
  const defaultWh =
    preset.warehouseId ?? warehouses.find((w) => w.isSales)?.id ?? warehouses[0]?.id ?? "";
  const [form, setForm] = useState({
    productId: preset.productId ?? "", warehouseId: defaultWh, kind: "entrada", quantity: "", note: "", lotId: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const row = rows.find((r) => String(r.productId) === String(form.productId));
  const current = row?.byWarehouse.find((w) => String(w.warehouseId) === String(form.warehouseId))?.quantity ?? 0;

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    const qty = parseInt(form.quantity, 10);
    if (!form.productId) return setError("Selecciona un producto");
    if (!form.warehouseId) return setError("Selecciona un almacén");
    if (Number.isNaN(qty)) return setError("Cantidad inválida");
    if (row?.usesLots && !form.lotId) return setError("Elige el lote");
    setBusy(true);
    try {
      await inventoryApi.adjust({
        productId: Number(form.productId), warehouseId: Number(form.warehouseId),
        kind: form.kind, quantity: qty, note: form.note.trim() || null,
        lotId: row?.usesLots ? Number(form.lotId) : null,
      });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const input = "w-full rounded border p-2";
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4">
      <form onSubmit={submit} className="grid w-full max-w-lg grid-cols-2 gap-3 rounded-2xl bg-white p-5 shadow-2xl">
        <h2 className="col-span-2 text-lg font-semibold">Registrar movimiento</h2>
        <select className={`${input} col-span-2`} value={form.productId} onChange={(e) => setForm((f) => ({ ...f, productId: e.target.value, lotId: "" }))}>
          <option value="">— Selecciona un producto —</option>
          {rows.map((r) => <option key={r.productId} value={r.productId}>{r.sku} · {r.name}</option>)}
        </select>
        <select className={input} value={form.warehouseId} onChange={(e) => set("warehouseId", e.target.value)}>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}{w.isSales ? " (ventas)" : ""}</option>)}
        </select>
        <select className={input} value={form.kind} onChange={(e) => set("kind", e.target.value)}>
          {Object.entries(KINDS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        {row?.usesLots && (
          <div className="col-span-2">
            <LotSelect className="w-full" productId={form.productId} warehouseId={form.warehouseId}
              value={form.lotId} onChange={(v) => set("lotId", v)} />
            <p className="mt-1 text-xs text-slate-500">
              Este producto controla lotes. Para una entrada nueva con costo propio, crea el lote en la pestaña «Lotes».
            </p>
          </div>
        )}
        {row && (
          <p className="col-span-2 text-sm text-slate-600">
            Stock actual en ese almacén: <b>{current}</b>
          </p>
        )}
        <input className={input} inputMode="numeric" autoFocus
          placeholder={form.kind === "ajuste" ? "Cantidad contada" : "Cantidad"}
          value={form.quantity} onChange={(e) => set("quantity", e.target.value)} />
        <input className={input}
          placeholder={form.kind === "entrada" ? "Nota (opcional)" : "Motivo (obligatorio)"}
          value={form.note} onChange={(e) => set("note", e.target.value)} />
        {error && <p className="col-span-2 text-sm text-red-600">{error}</p>}
        <div className="col-span-2 flex gap-2">
          <button disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
            {busy ? "Registrando…" : "Registrar"}
          </button>
          <button type="button" onClick={onClose} className="rounded border px-4 py-2">Cancelar</button>
        </div>
      </form>
    </div>
  );
}