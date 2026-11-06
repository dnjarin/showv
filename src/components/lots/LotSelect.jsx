import { useEffect, useState } from "react";
import { lotsApi } from "../../services/api";

/** Selector de lote de un producto (movimientos y transferencias). Con almacén, muestra su existencia ahí. */
export default function LotSelect({ productId, warehouseId, value, onChange, className = "" }) {
  const [lots, setLots] = useState([]);
  useEffect(() => {
    if (!productId) { setLots([]); return; }
    let off = false;
    lotsApi.list(Number(productId), warehouseId ? Number(warehouseId) : null, true)
      .then((l) => { if (!off) setLots(l); })
      .catch(() => { if (!off) setLots([]); });
    return () => { off = true; };
  }, [productId, warehouseId]);

  return (
    <select className={`rounded border p-2 ${className}`} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      <option value="">— Lote —</option>
      {lots.map((l) => (
        <option key={l.id} value={l.id}>
          {l.code}{l.brand ? ` · ${l.brand}` : ""} ({l.stock} en el almacén)
        </option>
      ))}
    </select>
  );
}
