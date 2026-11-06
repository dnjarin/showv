import { useCallback, useEffect, useState } from "react";
import { payablesApi } from "../services/api";
import { formatMoney, toMinor } from "../utils/money";
import { localDate } from "../utils/dates";
import PaymentTicket from "../components/PaymentTicket";

const METHODS = {
  efectivo: "Efectivo", punto: "Punto de venta", pago_movil: "Pago móvil",
  transferencia: "Transferencia", zelle: "Zelle", otro: "Otro",
};
const fmtDate = (s) => (s ? s.split("-").reverse().join("/") : "—");

function SupplierPanel({ supplierId, onClose, onChanged }) {
  const [acc, setAcc] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [pay, setPay] = useState({ purchaseId: "", method: "transferencia", currency: "USD", amount: "", reference: "" });
  const [paymentId, setPaymentId] = useState(null);
  const [voiding, setVoiding] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setAcc(await payablesApi.supplier(supplierId)); } catch (e) { setError(e.message); }
  }, [supplierId]);
  useEffect(() => { load(); }, [load]);

  const submitPay = async () => {
    setError(""); setMsg("");
    const m = toMinor(pay.amount);
    if (m === null || m <= 0) return setError("Monto inválido (ejemplo: 25.00)");
    setBusy(true);
    try {
      const id = await payablesApi.pay({
        supplierId,
        purchaseId: pay.purchaseId ? Number(pay.purchaseId) : null,
        method: pay.method, currencyCode: pay.currency, amountMinor: m,
        reference: pay.reference.trim() || null, notes: null,
      });
      setPay({ ...pay, amount: "", reference: "" });
      setPaymentId(id);
      await load();
      onChanged();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const confirmVoid = async () => {
    setError(""); setMsg("");
    try {
      await payablesApi.voidPayment(voiding.id, voiding.reason);
      setVoiding(null);
      setMsg("Pago anulado; la deuda volvió a su saldo anterior");
      await load();
      onChanged();
    } catch (e) { setError(e.message); }
  };

  const a = acc;
  const input = "rounded border p-2";
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60 p-4">
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-slate-100 shadow-2xl">
        <div className="flex items-center justify-between bg-white px-5 py-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Cuenta del proveedor</div>
            <div className="text-lg font-semibold">{a ? `${a.name} (${a.idType}-${a.idNumber})` : "Cargando…"}</div>
            {a?.phone && <div className="text-sm text-slate-500">Tel. {a.phone}</div>}
          </div>
          <button onClick={onClose} aria-label="Cerrar"
            className="rounded-full px-2 text-2xl leading-none text-slate-500 hover:bg-slate-100">×</button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {a && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl bg-white p-3 shadow">
                  <div className="text-xs text-slate-500">Deuda total (USD equiv.)</div>
                  <div className="text-xl font-semibold">{formatMoney(a.debtUsdMinor, "USD")}</div>
                </div>
                <div className="rounded-xl bg-white p-3 shadow">
                  <div className="text-xs text-slate-500">Por vencer</div>
                  <div className="text-xl font-semibold">{formatMoney(a.notDueUsdMinor, "USD")}</div>
                </div>
                <div className="rounded-xl bg-white p-3 shadow">
                  <div className="text-xs text-slate-500">Vencido</div>
                  <div className="text-xl font-semibold text-red-700">
                    {formatMoney(a.agingUsdMinor.reduce((x, y) => x + y, 0), "USD")}
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl bg-white shadow">
                <table className="w-full text-left text-sm">
                  <thead className="border-b bg-slate-100">
                    <tr><th className="p-2">Compra</th><th className="p-2">Factura</th><th className="p-2">Vence</th>
                      <th className="p-2">A pagar</th><th className="p-2">Saldo</th><th className="p-2">Atraso</th><th className="p-2"></th></tr>
                  </thead>
                  <tbody>
                    {a.docs.map((d) => (
                      <tr key={d.id} className="border-b">
                        <td className="p-2 font-mono">C-{String(d.number).padStart(6, "0")}</td>
                        <td className="p-2">{d.invoiceNumber ?? "—"}</td>
                        <td className="p-2">{fmtDate(d.dueDate)}</td>
                        <td className="p-2">{formatMoney(d.payableMinor, d.currencyCode)}</td>
                        <td className="p-2 font-semibold">{formatMoney(d.balanceMinor, d.currencyCode)}</td>
                        <td className="p-2">{d.daysOverdue > 0
                          ? <span className="font-semibold text-red-700">{d.daysOverdue} d</span>
                          : <span className="text-slate-500">Al día</span>}</td>
                        <td className="p-2">
                          <button className="underline"
                            onClick={() => setPay({ ...pay, purchaseId: String(d.id), currency: d.currencyCode })}>Pagar esta</button>
                        </td>
                      </tr>
                    ))}
                    {a.docs.length === 0 && (
                      <tr><td colSpan={7} className="p-6 text-center text-slate-500">Sin deudas pendientes</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {a.docs.length > 0 && (
                <div className="rounded-xl bg-white p-4 shadow">
                  <h2 className="mb-2 font-semibold">Registrar pago</h2>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <select className={input} value={pay.purchaseId} onChange={(e) => setPay({ ...pay, purchaseId: e.target.value })}>
                      <option value="">A las más antiguas primero</option>
                      {a.docs.map((d) => (
                        <option key={d.id} value={d.id}>
                          C-{String(d.number).padStart(6, "0")} · {formatMoney(d.balanceMinor, d.currencyCode)}
                        </option>
                      ))}
                    </select>
                    <select className={input} value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                      {Object.entries(METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                    <select className={input} value={pay.currency} onChange={(e) => setPay({ ...pay, currency: e.target.value })}>
                      <option value="USD">USD</option><option value="VES">Bs.</option>
                    </select>
                    <input className={input} placeholder="Monto" value={pay.amount}
                      onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
                    <input className={`${input} sm:col-span-2`} placeholder="Referencia (opcional)" value={pay.reference}
                      onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
                    <button onClick={submitPay} disabled={busy}
                      className="rounded bg-rose-700 px-4 py-2 text-white disabled:opacity-50 sm:col-span-2">
                      {busy ? "Registrando…" : "Registrar pago"}
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    Si pagas en otra moneda se convierte a la tasa vigente. Los pagos en efectivo salen de tu caja abierta.
                  </p>
                </div>
              )}

              {a.payments.length > 0 && (
                <div className="rounded-xl bg-white p-3 shadow">
                  <div className="mb-1 text-sm font-semibold">Últimos pagos</div>
                  {a.payments.map((r) => (
                    <div key={r.id} className={`flex flex-wrap items-center justify-between gap-2 border-b py-1 text-sm last:border-0 ${r.voided ? "text-slate-400 line-through" : ""}`}>
                      <span className="font-mono">P-{String(r.number).padStart(6, "0")}</span>
                      <span>{localDate(r.createdAt)}</span>
                      <span>{METHODS[r.method] ?? r.method} · {formatMoney(r.amountMinor, r.currencyCode)}</span>
                      <span>
                        <button className="underline" onClick={() => setPaymentId(r.id)}>Ver / imprimir</button>
                        {!r.voided && (
                          <button className="ml-3 text-red-700 underline" onClick={() => setVoiding({ id: r.id, reason: "" })}>Anular</button>
                        )}
                      </span>
                    </div>
                  ))}
                  {voiding && (
                    <div className="mt-2 flex flex-wrap gap-2 rounded border border-red-300 bg-red-50 p-2">
                      <input className="min-w-0 flex-1 rounded border p-2 text-sm" autoFocus
                        placeholder="Motivo de la anulación (obligatorio)" value={voiding.reason}
                        onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })} />
                      <button onClick={confirmVoid} className="rounded bg-red-700 px-3 py-2 text-sm text-white">Confirmar anulación</button>
                      <button onClick={() => setVoiding(null)} className="rounded border px-3 py-2 text-sm">Cancelar</button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {msg && <p className="text-sm text-green-700">{msg}</p>}
        </div>
      </div>
      {paymentId && <PaymentTicket id={paymentId} onClose={() => setPaymentId(null)} />}
    </div>
  );
}

export default function Payables({ embedded = false }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try { setRows(await payablesApi.summary()); setError(""); }
    catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const q = search.trim().toLowerCase();
  const shown = rows.filter((r) => !q || r.name.toLowerCase().includes(q) || r.idNumber.includes(q));
  const totUsd = rows.reduce((s, r) => s + r.balanceUsdMinor, 0);
  const totVes = rows.reduce((s, r) => s + r.balanceVesMinor, 0);
  const overdue = rows.filter((r) => r.overdueDocs > 0).length;

  return (
    <div>
      {!embedded && <h1 className="mb-4 text-2xl font-semibold">Cuentas por pagar</h1>}
      <div className="mb-4 grid max-w-3xl gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-white p-4 shadow"><div className="text-sm text-slate-500">Por pagar en USD</div><div className="text-2xl font-semibold">{formatMoney(totUsd, "USD")}</div></div>
        <div className="rounded-xl bg-white p-4 shadow"><div className="text-sm text-slate-500">Por pagar en Bs.</div><div className="text-2xl font-semibold">{formatMoney(totVes, "VES")}</div></div>
        <div className="rounded-xl bg-white p-4 shadow"><div className="text-sm text-slate-500">Proveedores con atraso</div><div className="text-2xl font-semibold text-red-700">{overdue}</div></div>
      </div>
      <input className="mb-3 w-72 rounded border p-2" placeholder="Buscar proveedor o RIF"
        value={search} onChange={(e) => setSearch(e.target.value)} />
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Proveedor</th><th className="p-3">Compras</th><th className="p-3">Saldo USD</th>
              <th className="p-3">Saldo Bs.</th><th className="p-3">Atraso</th><th className="p-3"></th></tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.supplierId} className="border-b">
                <td className="p-3">{r.name} <span className="text-slate-500">({r.idType}-{r.idNumber})</span></td>
                <td className="p-3">{r.docs}</td>
                <td className="p-3">{r.balanceUsdMinor ? formatMoney(r.balanceUsdMinor, "USD") : "—"}</td>
                <td className="p-3">{r.balanceVesMinor ? formatMoney(r.balanceVesMinor, "VES") : "—"}</td>
                <td className="p-3">{r.overdueDocs > 0
                  ? <span className="font-semibold text-red-700">{r.maxDaysOverdue} d</span>
                  : <span className="text-slate-500">Al día</span>}</td>
                <td className="p-3 text-right"><button className="underline" onClick={() => setOpen(r.supplierId)}>Ver cuenta / pagar</button></td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-slate-500">Sin deudas con proveedores</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-slate-500">
        Para que una compra aparezca aquí, márcala como «Compra a crédito» al registrarla (menú Compras).
        Se debe el neto de la factura: ya descontadas las retenciones, que se enteran al SENIAT aparte.
      </p>
      {open && <SupplierPanel supplierId={open} onClose={() => { setOpen(null); load(); }} onChanged={load} />}
    </div>
  );
}
