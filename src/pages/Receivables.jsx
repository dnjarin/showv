import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../store/authStore";
import { receivablesApi } from "../services/api";
import { convertMinor, formatMoney, fromMinor, toMinor } from "../utils/money";
import { localDate } from "../utils/dates";
import Ticket from "../components/Ticket";
import ReceiptTicket from "../components/ReceiptTicket";
import StatementTicket from "../components/StatementTicket";
import CustomerPicker from "../components/CustomerPicker";
import RetentionModal from "../components/receivables/RetentionModal";

const METHODS = {
  efectivo: "Efectivo", punto: "Punto de venta", pago_movil: "Pago móvil",
  transferencia: "Transferencia", zelle: "Zelle", otro: "Otro", saldo_favor: "Saldo a favor",
};

const fmtDate = (s) => (s ? s.split("-").reverse().join("/") : "—");

function Overdue({ days }) {
  if (days > 0) return <span className="font-semibold text-red-700">{days} d de atraso</span>;
  return <span className="text-slate-500">Al día</span>;
}

function CustomerPanel({ customerId, onClose, onChanged }) {
  const isAdmin = useAuth((s) => s.user.role === "admin");
  const [acc, setAcc] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [pay, setPay] = useState({ docId: "", method: "efectivo", currency: "USD", amount: "", reference: "", advance: false });
  const [terms, setTerms] = useState({ limit: "", days: "" });
  const [receiptId, setReceiptId] = useState(null);
  const [docId, setDocId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [stmt, setStmt] = useState(false);
  const [voiding, setVoiding] = useState(null); // { id, reason }
  const [retDoc, setRetDoc] = useState(null); // venta a la que se registra una retención

  const load = useCallback(async () => {
    try {
      const a = await receivablesApi.customer(customerId);
      setAcc(a);
      setTerms({ limit: fromMinor(a.credit.limitUsdMinor), days: String(a.credit.creditDays) });
    } catch (e) { setError(e.message); }
  }, [customerId]);
  useEffect(() => { load(); }, [load]);

  const submitPay = async () => {
    setError(""); setMsg("");
    const m = toMinor(pay.amount);
    if (m === null || m <= 0) return setError("Monto inválido (ejemplo: 25.00)");
    setBusy(true);
    try {
      const id = await receivablesApi.receive({
        customerId,
        documentId: pay.docId ? Number(pay.docId) : null,
        method: pay.method, currencyCode: pay.currency, amountMinor: m,
        reference: pay.reference.trim() || null, notes: null, allowAdvance: pay.advance,
      });
      setPay({ ...pay, amount: "", reference: "" });
      setReceiptId(id);
      await load();
      onChanged();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const applyCredit = async () => {
    setError(""); setMsg("");
    setBusy(true);
    try {
      const ids = await receivablesApi.applyCredit(customerId, null);
      setMsg(`Saldo a favor aplicado (${ids.length} recibo${ids.length > 1 ? "s" : ""})`);
      setReceiptId(ids[0]);
      await load();
      onChanged();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const confirmVoid = async () => {
    setError(""); setMsg("");
    try {
      await receivablesApi.voidReceipt(voiding.id, voiding.reason);
      setVoiding(null);
      setMsg("Recibo anulado; la deuda volvió a su saldo anterior");
      await load();
      onChanged();
    } catch (e) { setError(e.message); }
  };

  const saveTerms = async () => {
    setError(""); setMsg("");
    const lim = toMinor(terms.limit === "" ? "0" : terms.limit);
    const days = parseInt(terms.days, 10);
    if (lim === null || lim < 0 || !Number.isFinite(days)) return setError("Límite o plazo inválido");
    try {
      await receivablesApi.setCredit(customerId, lim, days);
      setMsg("Condiciones de crédito guardadas");
      await load();
    } catch (e) { setError(e.message); }
  };

  const input = "rounded border p-2";
  const a = acc;

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60 p-4">
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-slate-100 shadow-2xl">
        <div className="flex items-center justify-between bg-white px-5 py-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Cuenta del cliente</div>
            <div className="text-lg font-semibold">
              {a ? `${a.name} (${a.idType}-${a.idNumber})` : "Cargando…"}
            </div>
            {a?.phone && <div className="text-sm text-slate-500">Tel. {a.phone}</div>}
          </div>
          {a && (
            <button onClick={() => setStmt(true)} className="mr-2 rounded-lg border px-3 py-1.5 text-sm">
              Estado de cuenta
            </button>
          )}
          <button onClick={onClose} aria-label="Cerrar"
            className="rounded-full px-2 text-2xl leading-none text-slate-500 hover:bg-slate-100">×</button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {a && (
            <>
              {/* Crédito */}
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl bg-white p-3 shadow">
                  <div className="text-xs text-slate-500">Deuda actual (USD equiv.)</div>
                  <div className="text-xl font-semibold">{formatMoney(a.credit.outstandingUsdMinor, "USD")}</div>
                </div>
                <div className="rounded-xl bg-white p-3 shadow">
                  <div className="text-xs text-slate-500">Límite de crédito</div>
                  <div className="text-xl font-semibold">{formatMoney(a.credit.limitUsdMinor, "USD")}</div>
                </div>
                <div className="rounded-xl bg-white p-3 shadow">
                  <div className="text-xs text-slate-500">Disponible · plazo</div>
                  <div className="text-xl font-semibold">
                    {formatMoney(a.credit.availableUsdMinor, "USD")} · {a.credit.creditDays} d
                  </div>
                </div>
              </div>

              {isAdmin && (
                <div className="flex flex-wrap items-end gap-2 rounded-xl bg-white p-3 shadow">
                  <label className="text-sm">Límite (USD)
                    <input className={`${input} mt-1 block w-32`} value={terms.limit}
                      onChange={(e) => setTerms({ ...terms, limit: e.target.value })} />
                  </label>
                  <label className="text-sm">Plazo (días)
                    <input className={`${input} mt-1 block w-24`} value={terms.days}
                      onChange={(e) => setTerms({ ...terms, days: e.target.value })} />
                  </label>
                  <button onClick={saveTerms} className="rounded bg-slate-900 px-4 py-2 text-white">Guardar condiciones</button>
                  <span className="text-xs text-slate-500">Límite 0 = sin crédito.</span>
                </div>
              )}

              {/* Antigüedad */}
              <div className="rounded-xl bg-white p-3 shadow">
                <div className="mb-2 text-sm font-semibold">Antigüedad de saldos (USD equiv.)</div>
                <div className="grid grid-cols-5 gap-2 text-center text-sm">
                  {[["Al día", a.notDueUsdMinor], ["1-15 d", a.agingUsdMinor[0]], ["16-30 d", a.agingUsdMinor[1]],
                    ["31-60 d", a.agingUsdMinor[2]], ["+60 d", a.agingUsdMinor[3]]].map(([l, v], i) => (
                    <div key={l} className={`rounded border p-2 ${i > 0 && v > 0 ? "border-red-300 bg-red-50" : ""}`}>
                      <div className="text-xs text-slate-500">{l}</div>
                      <div className="font-semibold">{formatMoney(v, "USD")}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Ventas pendientes */}
              <div className="overflow-x-auto rounded-xl bg-white shadow">
                <table className="w-full text-left text-sm">
                  <thead className="border-b bg-slate-100">
                    <tr><th className="p-3">Venta</th><th className="p-3">Fecha</th><th className="p-3">Vence</th>
                      <th className="p-3">Total</th><th className="p-3">Saldo</th><th className="p-3">Estado</th><th className="p-3"></th></tr>
                  </thead>
                  <tbody>
                    {a.docs.map((d) => (
                      <tr key={d.id} className="border-b">
                        <td className="p-3 font-mono">{d.series}-{String(d.number).padStart(6, "0")}</td>
                        <td className="p-3">{localDate(d.issuedAt)}</td>
                        <td className="p-3">{fmtDate(d.dueDate)}</td>
                        <td className="p-3">{formatMoney(d.totalMinor, d.currencyCode)}</td>
                        <td className="p-3 font-semibold">{formatMoney(d.balanceMinor, d.currencyCode)}</td>
                        <td className="p-3"><Overdue days={d.daysOverdue} /></td>
                        <td className="space-x-2 p-3 text-right">
                          <button className="underline" onClick={() => setDocId(d.id)}>Ver</button>
                          <button className="underline" onClick={() => setPay({ ...pay, docId: String(d.id), currency: d.currencyCode })}>
                            Abonar aquí
                          </button>
                          <button className="underline" onClick={() => setRetDoc(d.id)}>Retención</button>
                        </td>
                      </tr>
                    ))}
                    {a.docs.length === 0 && (
                      <tr><td colSpan={7} className="p-6 text-center text-slate-500">Sin deudas pendientes</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {(a.creditVesMinor > 0 || a.creditUsdMinor > 0) && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-green-300 bg-green-50 p-3">
                  <div className="text-sm">
                    <span className="font-semibold">Saldo a favor:</span>{" "}
                    {[a.creditUsdMinor > 0 && formatMoney(a.creditUsdMinor, "USD"),
                      a.creditVesMinor > 0 && formatMoney(a.creditVesMinor, "VES")].filter(Boolean).join(" + ")}
                  </div>
                  {a.docs.length > 0 && (
                    <button onClick={applyCredit} disabled={busy}
                      className="rounded bg-green-700 px-3 py-1.5 text-sm text-white disabled:opacity-50">
                      Aplicar a la deuda
                    </button>
                  )}
                </div>
              )}

              {/* Registrar abono */}
              {(

                <div className="rounded-xl bg-white p-4 shadow">
                  <h2 className="mb-2 font-semibold">Registrar abono</h2>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <select className={input} value={pay.docId} onChange={(e) => setPay({ ...pay, docId: e.target.value })}>
                      <option value="">A las más antiguas primero</option>
                      {a.docs.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.series}-{String(d.number).padStart(6, "0")} · {formatMoney(d.balanceMinor, d.currencyCode)}
                        </option>
                      ))}
                    </select>
                    <select className={input} value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                      {Object.entries(METHODS).filter(([k]) => k !== "saldo_favor").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                    <select className={input} value={pay.currency} onChange={(e) => setPay({ ...pay, currency: e.target.value })}>
                      <option value="USD">USD</option><option value="VES">Bs.</option>
                    </select>
                    <input className={input} placeholder="Monto" value={pay.amount}
                      onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
                    <input className={`${input} sm:col-span-2`} placeholder="Referencia (opcional)" value={pay.reference}
                      onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
                    <button onClick={submitPay} disabled={busy}
                      className="rounded bg-green-700 px-4 py-2 text-white disabled:opacity-50 sm:col-span-2">
                      {busy ? "Registrando…" : "Cobrar abono"}
                    </button>
                  </div>
                  <label className="mt-2 flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={pay.advance}
                      onChange={(e) => setPay({ ...pay, advance: e.target.checked })} />
                    Guardar el excedente como saldo a favor (anticipo)
                  </label>
                  <p className="mt-2 text-xs text-slate-500">
                    Si abona en otra moneda se convierte a la tasa vigente. El efectivo entra a tu caja abierta.
                  </p>
                </div>
              )}

              {/* Recibos */}
              {a.receipts.length > 0 && (
                <div className="rounded-xl bg-white p-3 shadow">
                  <div className="mb-1 text-sm font-semibold">Últimos recibos</div>
                  {a.receipts.map((r) => (
                    <div key={r.id} className={`flex flex-wrap items-center justify-between gap-2 border-b py-1 text-sm last:border-0 ${r.voided ? "text-slate-400 line-through" : ""}`}>
                      <span className="font-mono">R-{String(r.number).padStart(6, "0")}</span>
                      <span>{localDate(r.createdAt)}</span>
                      <span>{METHODS[r.method] ?? r.method} · {formatMoney(r.amountMinor, r.currencyCode)}</span>
                      <span className="no-underline">
                        <button className="underline" onClick={() => setReceiptId(r.id)}>Ver / imprimir</button>
                        {isAdmin && !r.voided && (
                          <button className="ml-3 text-red-700 underline" onClick={() => setVoiding({ id: r.id, reason: "" })}>
                            Anular
                          </button>
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
      {stmt && a && <StatementTicket acc={a} onClose={() => setStmt(false)} />}
      {retDoc && (
        <RetentionModal documentId={retDoc} onClose={() => setRetDoc(null)}
          onDone={async () => { setRetDoc(null); setMsg("Retención registrada: el saldo de la venta se redujo."); await load(); onChanged(); }} />
      )}
      {receiptId && <ReceiptTicket id={receiptId} onClose={() => setReceiptId(null)} />}
      {docId && <Ticket id={docId} onClose={() => setDocId(null)} />}
    </div>
  );
}

export default function Receivables({ embedded = false }) {
  const isAdmin = useAuth((s) => s.user.role === "admin");
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try { setRows(await receivablesApi.summary()); setError(""); }
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
      {!embedded && <h1 className="mb-4 text-2xl font-semibold">Cuentas por cobrar</h1>}
      <div className="mb-4 grid max-w-3xl gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-white p-4 shadow"><div className="text-sm text-slate-500">Por cobrar en USD</div><div className="text-2xl font-semibold">{formatMoney(totUsd, "USD")}</div></div>
        <div className="rounded-xl bg-white p-4 shadow"><div className="text-sm text-slate-500">Por cobrar en Bs.</div><div className="text-2xl font-semibold">{formatMoney(totVes, "VES")}</div></div>
        <div className="rounded-xl bg-white p-4 shadow"><div className="text-sm text-slate-500">Clientes con atraso</div><div className="text-2xl font-semibold text-red-700">{overdue}</div></div>
      </div>
      {isAdmin && (
        <div className="mb-4 max-w-xl rounded-xl bg-white p-3 shadow">
          <div className="mb-2 text-sm font-semibold">Asignar o cambiar el crédito de un cliente</div>
          <CustomerPicker value={null} onChange={(c) => c && setOpen(c.id)} />
        </div>
      )}
      <input className="mb-3 w-72 rounded border p-2" placeholder="Buscar cliente o cédula/RIF"
        value={search} onChange={(e) => setSearch(e.target.value)} />
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Cliente</th><th className="p-3">Ventas</th><th className="p-3">Saldo USD</th>
              <th className="p-3">Saldo Bs.</th><th className="p-3">Atraso</th><th className="p-3"></th></tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.customerId} className="border-b">
                <td className="p-3">{r.name} <span className="text-slate-500">({r.idType}-{r.idNumber})</span></td>
                <td className="p-3">{r.docs}</td>
                <td className="p-3">{r.balanceUsdMinor ? formatMoney(r.balanceUsdMinor, "USD") : "—"}</td>
                <td className="p-3">{r.balanceVesMinor ? formatMoney(r.balanceVesMinor, "VES") : "—"}</td>
                <td className="p-3">{r.overdueDocs > 0
                  ? <span className="font-semibold text-red-700">{r.maxDaysOverdue} d</span>
                  : <span className="text-slate-500">Al día</span>}</td>
                <td className="p-3 text-right"><button className="underline" onClick={() => setOpen(r.customerId)}>Ver cuenta / abonar</button></td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-slate-500">Sin deudas pendientes</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-slate-500">
        Para vender a crédito: el administrador asigna primero un límite y un plazo al cliente (arriba). Luego, en el
        cobro, se elige al cliente y se activa «Venta a crédito».
      </p>
      {open && <CustomerPanel customerId={open} onClose={() => { setOpen(null); load(); }} onChanged={load} />}
    </div>
  );
}