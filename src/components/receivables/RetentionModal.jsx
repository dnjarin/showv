import { useEffect, useState } from "react";
import { saleRetentionsApi } from "../../services/api";
import { formatMoney, fromMinor, toMinor } from "../../utils/money";
import { todayStr } from "../../utils/dates";

/** Registra un comprobante de retención (IVA o ISLR) que el cliente nos entregó por una venta a crédito. */
export default function RetentionModal({ documentId, onClose, onDone }) {
  const [info, setInfo] = useState(null);
  const [f, setF] = useState({ kind: "IVA", voucher: "", date: todayStr(), amount: "", notes: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    saleRetentionsApi.docInfo(documentId).then(setInfo).catch((e) => setError(e.message));
  }, [documentId]);

  const suggested = info ? Math.round((info.taxVesMinor * info.ivaDefaultBp) / 10000) : 0;

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    const amount = toMinor(f.amount);
    if (!f.voucher.trim()) return setError("Indica el número del comprobante");
    if (amount === null || amount <= 0) return setError("Monto inválido (ejemplo: 1250.00)");
    setBusy(true);
    try {
      await saleRetentionsApi.register({
        documentId, kind: f.kind, voucherNumber: f.voucher.trim(), voucherDate: f.date,
        amountVesMinor: amount, notes: f.notes.trim() || null,
      });
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  };

  const input = "w-full rounded border p-2";
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <form onSubmit={submit} className="w-full max-w-lg space-y-3 rounded-2xl bg-white p-5 shadow-2xl">
        <h2 className="text-lg font-semibold">Registrar retención sufrida</h2>
        {info && (
          <div className="rounded bg-slate-50 p-3 text-sm">
            <div>Venta <b className="font-mono">{info.label}</b> · saldo pendiente <b>{formatMoney(info.balanceMinor, info.currencyCode)}</b></div>
            <div className="text-slate-600">
              IVA de la venta: Bs. {fromMinor(info.taxVesMinor)}
              {suggested > 0 && <> · retención al {info.ivaDefaultBp / 100} %: Bs. {fromMinor(suggested)}{" "}
                <button type="button" className="underline" onClick={() => { set("kind", "IVA"); set("amount", fromMinor(suggested)); }}>
                  usar
                </button></>}
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">Tipo
            <select className={`${input} mt-1`} value={f.kind} onChange={(e) => set("kind", e.target.value)}>
              <option value="IVA">IVA</option>
              <option value="ISLR">ISLR</option>
            </select>
          </label>
          <label className="text-sm">Fecha del comprobante
            <input type="date" className={`${input} mt-1`} max={todayStr()} value={f.date} onChange={(e) => set("date", e.target.value)} />
          </label>
          <label className="text-sm">N.º de comprobante
            <input className={`${input} mt-1`} maxLength={40} value={f.voucher} onChange={(e) => set("voucher", e.target.value)} />
          </label>
          <label className="text-sm">Monto retenido (Bs.)
            <input className={`${input} mt-1`} inputMode="decimal" placeholder="0.00" value={f.amount}
              onChange={(e) => set("amount", e.target.value)} />
          </label>
        </div>
        <input className={input} placeholder="Notas (opcional)" maxLength={200} value={f.notes} onChange={(e) => set("notes", e.target.value)} />
        <p className="text-xs text-slate-500">
          El monto se descuenta del saldo de la venta (convertido con la tasa de esa venta). No es un cobro en caja.
        </p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button disabled={busy || !info} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
            {busy ? "Guardando…" : "Registrar"}
          </button>
          <button type="button" onClick={onClose} className="rounded border px-4 py-2">Cancelar</button>
        </div>
      </form>
    </div>
  );
}
