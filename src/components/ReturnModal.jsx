import { useEffect, useState } from "react";
import { returnsApi } from "../services/api";
import { convertMinor, formatMoney, fromMinor, toMinor } from "../utils/money";

const METHODS = {
  efectivo: "Efectivo", punto: "Punto de venta", pago_movil: "Pago móvil",
  transferencia: "Transferencia", zelle: "Zelle", otro: "Otro",
};

export default function ReturnModal({ documentId, onClose, onDone }) {
  const [cand, setCand] = useState(null);
  const [qty, setQty] = useState({});        // itemId -> texto
  const [restock, setRestock] = useState({}); // itemId -> bool
  const [reason, setReason] = useState("");
  const [refundIgtf, setRefundIgtf] = useState(true);
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState("");
  const [refunds, setRefunds] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    returnsApi.candidates(documentId).then(setCand).catch((e) => setError(e.message));
  }, [documentId]);

  const lines = cand
    ? cand.items
        .map((it) => ({
          itemId: it.itemId,
          quantity: parseInt(qty[it.itemId] ?? "0", 10) || 0,
          restock: restock[it.itemId] ?? true,
        }))
        .filter((l) => l.quantity > 0)
    : [];
  const linesKey = JSON.stringify(lines) + String(refundIgtf);

  // La nota de crédito la calcula Rust
  useEffect(() => {
    if (!cand) return;
    if (lines.length === 0) { setQuote(null); setQuoteError(""); return; }
    let cancelled = false;
    returnsApi
      .quote(documentId, lines, refundIgtf)
      .then((q) => { if (!cancelled) { setQuote(q); setQuoteError(""); } })
      .catch((e) => { if (!cancelled) { setQuote(null); setQuoteError(e.message); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cand, linesKey]);

  // Si cambian los montos de la devolución, los reintegros se reinician.
  useEffect(() => { setRefunds([]); }, [linesKey]);

  const cur = cand?.currencyCode;
  const rate = quote?.usdRateMicro ?? null;
  const due = quote?.refundDueMinor ?? 0;
  const toDoc = (p) => {
    const m = toMinor(p.amount);
    return m === null ? 0 : convertMinor(m, p.currency, cur, rate) ?? 0;
  };
  const paid = refunds.reduce((s, p) => s + toDoc(p), 0);
  const cross = refunds.some((p) => p.currency !== cur);
  const tol = !cross ? 0 : cur === "VES" ? Math.ceil((rate ?? 0) / 1_000_000) : 1;
  const remaining = due - paid;
  const settled =
    (due === 0 && refunds.length === 0) || (refunds.length > 0 && Math.abs(remaining) <= tol);

  const setRef = (i, patch) => setRefunds((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRefund = (c) => {
    const target = c ?? cur;
    const v = convertMinor(Math.max(remaining, 0), cur, target, rate);
    setRefunds((rs) => [
      ...rs,
      { method: target === "USD" ? "efectivo" : "efectivo", currency: target,
        amount: v && v > 0 ? fromMinor(v) : "", reference: "" },
    ]);
  };

  const submit = async () => {
    setError("");
    if (!quote) return setError("Indica qué productos se devuelven");
    if (reason.trim().length < 5) return setError("Indica el motivo de la devolución (mínimo 5 caracteres)");
    const rs = [];
    for (const r of refunds) {
      const m = toMinor(r.amount);
      if (m === null || m <= 0) return setError("Hay un monto de reintegro inválido (ejemplo: 12.50)");
      rs.push({ method: r.method, currencyCode: r.currency, amountMinor: m, reference: r.reference.trim() || null });
    }
    if (rs.length === 0 && due > 0) return setError("Indica cómo se le devuelve el dinero al cliente");
    setBusy(true);
    try {
      const id = await returnsApi.create({
        documentId, reason: reason.trim(), lines, refundIgtf, refunds: rs,
      });
      onDone(id);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const input = "rounded border p-2";
  const igtfLeft = cand ? cand.igtfMinor - cand.igtfRefundedMinor : 0;

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60 p-4">
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-slate-100 shadow-2xl">
        <div className="flex items-center justify-between bg-white px-5 py-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Nota de crédito (devolución)</div>
            <div className="text-lg font-semibold">
              {cand ? `Venta ${cand.series}-${String(cand.number).padStart(6, "0")} · ${cand.customerName ?? "Consumidor final"}` : "Cargando…"}
            </div>
          </div>
          <button onClick={onClose} disabled={busy} aria-label="Cerrar"
            className="rounded-full px-2 text-2xl leading-none text-slate-500 hover:bg-slate-100">×</button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {error && !cand && <p className="text-red-600">{error}</p>}
          {cand && (
            <>
              <div className="overflow-x-auto rounded-xl bg-white shadow">
                <table className="w-full text-left text-sm">
                  <thead className="border-b bg-slate-100">
                    <tr><th className="p-3">Producto</th><th className="p-3">Vendido</th>
                      <th className="p-3">Ya devuelto</th><th className="p-3">Devolver</th>
                      <th className="p-3">Reingresa al inventario</th></tr>
                  </thead>
                  <tbody>
                    {cand.items.map((it) => (
                      <tr key={it.itemId} className="border-b">
                        <td className="p-3">{it.description}</td>
                        <td className="p-3">{it.quantity}</td>
                        <td className="p-3">{it.returned}</td>
                        <td className="p-3">
                          <input className="w-16 rounded border p-1" inputMode="numeric" disabled={it.available === 0}
                            placeholder="0" value={qty[it.itemId] ?? ""}
                            onChange={(e) => setQty({ ...qty, [it.itemId]: e.target.value })} />
                          <span className="ml-1 text-xs text-slate-500">máx. {it.available}</span>
                        </td>
                        <td className="p-3">
                          {it.trackStock ? (
                            <label className="flex items-center gap-1">
                              <input type="checkbox" checked={restock[it.itemId] ?? true}
                                onChange={(e) => setRestock({ ...restock, [it.itemId]: e.target.checked })} />
                              Sí (si está dañado, desmarca)
                            </label>
                          ) : <span className="text-slate-400">No controla stock</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <input className={`${input} w-full`} placeholder="Motivo de la devolución (obligatorio)"
                value={reason} onChange={(e) => setReason(e.target.value)} />

              {igtfLeft > 0 && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={refundIgtf} onChange={(e) => setRefundIgtf(e.target.checked)} />
                  Devolver también la parte proporcional del IGTF cobrado
                </label>
              )}

              {quoteError && <p className="text-sm text-red-600">{quoteError}</p>}

              {quote && (
                <div className="rounded-xl bg-white p-4 shadow">
                  <h2 className="mb-2 font-semibold">Nota de crédito</h2>
                  <dl className="space-y-1 text-sm">
                    <div className="flex justify-between"><dt>Base imponible</dt><dd>{formatMoney(quote.subtotalMinor, cur)}</dd></div>
                    {quote.exemptMinor > 0 && (
                      <div className="flex justify-between"><dt>Exento</dt><dd>{formatMoney(quote.exemptMinor, cur)}</dd></div>
                    )}
                    <div className="flex justify-between"><dt>IVA</dt><dd>{formatMoney(quote.taxMinor, cur)}</dd></div>
                    <div className="flex justify-between"><dt>Total</dt><dd>{formatMoney(quote.totalMinor, cur)}</dd></div>
                    {quote.balanceAppliedMinor > 0 && (
                      <div className="flex justify-between text-purple-800">
                        <dt>Se descuenta del saldo pendiente del cliente</dt>
                        <dd>−{formatMoney(quote.balanceAppliedMinor, cur)}</dd>
                      </div>
                    )}
                    {quote.igtfMinor > 0 && (
                      <div className="flex justify-between"><dt>IGTF a devolver</dt><dd>{formatMoney(quote.igtfMinor, cur)}</dd></div>
                    )}
                    <div className="flex justify-between border-t pt-1 text-lg font-semibold">
                      <dt>Dinero a devolver</dt><dd>{formatMoney(quote.refundDueMinor, cur)}</dd>
                    </div>
                  </dl>
                </div>
              )}

              {quote && (
                <div className="rounded-xl bg-white p-4 shadow">
                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="font-semibold">Cómo se devuelve el dinero</h2>
                    <div className="flex gap-2">
                      <button onClick={() => addRefund(cur)} className="rounded border px-2 py-1 text-sm">+ En {cur === "USD" ? "USD" : "Bs."}</button>
                      {rate && (
                        <button onClick={() => addRefund(cur === "USD" ? "VES" : "USD")} className="rounded border px-2 py-1 text-sm">
                          + En {cur === "USD" ? "Bs." : "USD"}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className={`mb-3 rounded border p-2 text-sm ${
                    settled ? "border-green-300 bg-green-50 text-green-800"
                    : remaining < -tol ? "border-red-300 bg-red-50 text-red-700"
                    : "border-amber-300 bg-amber-50 text-amber-900"}`}>
                    {settled ? "✔ Cuadra con el total a devolver"
                      : remaining < -tol ? `Excedente: ${formatMoney(-remaining, cur)}`
                      : `Falta por devolver: ${formatMoney(Math.max(remaining, 0), cur)}`}
                    {cur === "USD" && rate && remaining > tol && (
                      <> · Bs. {formatMoney(convertMinor(remaining, cur, "VES", rate) ?? 0, "VES")}</>
                    )}
                  </div>

                  {refunds.map((r, i) => (
                    <div key={i} className="mb-2 grid grid-cols-2 gap-2 rounded border p-2 sm:grid-cols-4">
                      <select className={input} value={r.method} onChange={(e) => setRef(i, { method: e.target.value })}>
                        {Object.entries(METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                      <select className={input} value={r.currency} onChange={(e) => setRef(i, { currency: e.target.value })}>
                        <option value="USD">USD</option><option value="VES">Bs.</option>
                      </select>
                      <input className={input} placeholder="Monto" value={r.amount}
                        onChange={(e) => setRef(i, { amount: e.target.value })} />
                      <input className={input} placeholder="Referencia" value={r.reference}
                        onChange={(e) => setRef(i, { reference: e.target.value })} />
                      <button type="button" className="text-left text-sm underline"
                        onClick={() => {
                          const others = refunds.reduce((s, p, j) => (j === i ? s : s + toDoc(p)), 0);
                          const v = convertMinor(due - others, cur, r.currency, rate);
                          if (v !== null && v > 0) setRef(i, { amount: fromMinor(v) });
                        }}>Completar saldo</button>
                      <button type="button" className="text-right text-sm underline sm:col-start-4"
                        onClick={() => setRefunds((rs) => rs.filter((_, j) => j !== i))}>Quitar</button>
                    </div>
                  ))}
                  {refunds.length === 0 && <p className="text-sm text-slate-500">Agrega cómo se devolverá el dinero.</p>}
                  <p className="mt-2 text-xs text-slate-500">
                    Si se devuelve en efectivo, sale de tu caja abierta y se descuenta del efectivo esperado al cierre.
                  </p>
                </div>
              )}

              {error && <p className="text-sm text-red-600">{error}</p>}
            </>
          )}
        </div>

        <div className="flex justify-between gap-2 bg-white px-5 py-3">
          <button onClick={onClose} disabled={busy} className="rounded-lg border px-4 py-2">Cancelar</button>
          <button onClick={submit} disabled={busy || !quote}
            className="rounded-lg bg-red-700 px-5 py-2 font-medium text-white disabled:opacity-50">
            {busy ? "Registrando…" : "Emitir nota de crédito"}
          </button>
        </div>
      </div>
    </div>
  );
}