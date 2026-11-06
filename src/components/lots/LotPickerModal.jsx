import { useEffect, useState } from "react";
import { lotsApi } from "../../services/api";
import { formatMoney } from "../../utils/money";
import { localDate } from "../../utils/dates";

/** Ventana para elegir de qué lote sale la mercancía (siempre a mano). */
export default function LotPickerModal({ product, onPick, onClose }) {
  const [lots, setLots] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    lotsApi.forSale(product.id).then(setLots).catch((e) => setError(e.message));
  }, [product.id]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Elige el lote</h2>
        <p className="mb-3 text-sm text-slate-600">{product.name}</p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {lots === null && !error && <p className="text-sm text-slate-500">Cargando…</p>}
        {lots && lots.length === 0 && (
          <p className="rounded bg-amber-50 p-3 text-sm text-amber-900">
            No hay lotes con existencia en el almacén de ventas.
          </p>
        )}
        <ul className="max-h-80 space-y-2 overflow-y-auto">
          {(lots ?? []).map((l) => (
            <li key={l.id}>
              <button type="button" onClick={() => onPick(l)}
                className="flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left hover:bg-slate-50">
                <span>
                  <span className="block font-mono font-semibold">{l.code}</span>
                  <span className="block text-xs text-slate-500">
                    {l.brand ? `${l.brand} · ` : ""}llegó {localDate(l.receivedDate)}
                    {l.unitCostMinor != null && ` · costo ${formatMoney(l.unitCostMinor, l.costCurrency)}`}
                  </span>
                </span>
                <span className="shrink-0 text-right text-sm font-semibold">{l.stock} disp.</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" onClick={onClose} className="mt-4 rounded border px-4 py-2">Cancelar</button>
      </div>
    </div>
  );
}
