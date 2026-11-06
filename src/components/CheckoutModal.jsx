import { useEffect, useState } from "react";
import { receivablesApi, salesApi } from "../services/api";
import { useAuth } from "../store/authStore";
import { convertMinor, formatMoney, fromMicro, fromMinor, toMinor } from "../utils/money";
import { formatDocument } from "../utils/document";
import CustomerPicker from "./CustomerPicker";

const METHODS = {
  efectivo: "Efectivo", punto: "Punto de venta", pago_movil: "Pago móvil",
  transferencia: "Transferencia", zelle: "Zelle", otro: "Otro",
};

function Switch({ checked, onChange, disabled, label, hint }) {
  return (
    <div className={`flex items-start justify-between gap-3 rounded-lg border bg-white p-3 ${disabled ? "opacity-60" : ""}`}>
      <div>
        <div className="text-sm font-semibold">{label}</div>
        <div className="text-xs text-slate-500">{hint}</div>
      </div>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? "bg-green-600" : "bg-slate-300"} disabled:cursor-not-allowed`}>
        <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : ""}`} />
      </button>
    </div>
  );
}

export default function CheckoutModal({ quote: initialQuote, currency, items, priceListId = null, onClose, onDone }) {
  const isAdmin = useAuth((s) => s.user.role === "admin");
  const [step, setStep] = useState(1);
  const [customer, setCustomer] = useState(null);
  const [payments, setPayments] = useState([]);
  const [quote, setQuote] = useState(initialQuote);
  const [chargeTax, setChargeTax] = useState(true);
  const [chargeIgtf, setChargeIgtf] = useState(true);
  const [reason, setReason] = useState("");
  const [changeCur, setChangeCur] = useState("");
  const [onCredit, setOnCredit] = useState(false);
  const [creditInfo, setCreditInfo] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Condiciones de crédito del cliente elegido
  useEffect(() => {
    setOnCredit(false);
    setCreditInfo(null);
    if (!customer) return;
    receivablesApi.creditInfo(customer.id).then(setCreditInfo).catch(() => {});
  }, [customer]);

  const hasTaxable = quote.lines.some((l) => l.taxRateBp > 0);
  const hasForeign = payments.some((p) => p.currency !== "VES");
  const taxWaived = !chargeTax && hasTaxable;
  const igtfWaived = !chargeIgtf && hasForeign;
  const needsReason = taxWaived || igtfWaived;

  // ---------- Cálculos de ayuda (la validación real la hace Rust) ----------
  const rate = quote.usdRateMicro ?? null;
  const igtfPct = (quote.igtfBp ?? 0) / 100;
  const bp = chargeIgtf ? quote.igtfBp ?? 0 : 0; // con el interruptor apagado no hay IGTF
  const total = quote.totalMinor;

  const toDoc = (p) => {
    const m = toMinor(p.amount);
    return m === null ? 0 : convertMinor(m, p.currency, currency, rate) ?? 0;
  };
  const igtfOf = (p) => {
    const m = toMinor(p.amount);
    if (m === null || p.currency === "VES") return 0;
    return Math.round((m * bp) / 10000);
  };
  const dueOf = (p) => (toMinor(p.amount) ?? 0) + igtfOf(p); // lo que debe entregar el cliente
  const tenderedOf = (p) => (p.method === "efectivo" && p.tendered.trim() !== "" ? toMinor(p.tendered) : null);
  const surplusOf = (p) => {
    const t = tenderedOf(p);
    return t === null ? 0 : Math.max(t - dueOf(p), 0);
  };

  const paidDoc = payments.reduce((s, p) => s + toDoc(p), 0);
  const igtfEst = payments.reduce((s, p) => s + (convertMinor(igtfOf(p), p.currency, currency, rate) ?? 0), 0);

  // Misma regla de tolerancia que Rust
  const crossCurrency = payments.some((p) => p.currency !== currency);
  const tol = !crossCurrency ? 0 : currency === "VES" ? Math.ceil((rate ?? 0) / 1_000_000) : 1;

  const remaining = total - paidDoc;
  const settled = payments.length > 0 && Math.abs(remaining) <= tol;
  const pending = Math.max(remaining, 0);
  const pendingUsd = convertMinor(pending, currency, "USD", rate);
  const pendingVes = convertMinor(pending, currency, "VES", rate);
  const igtfIfUsd = pendingUsd ? Math.round((pendingUsd * bp) / 10000) : 0;

  // Vuelto
  const surplusList = payments.map((p) => ({ cur: p.currency, s: surplusOf(p) })).filter((x) => x.s > 0);
  const firstSurplusCur = surplusList[0]?.cur ?? null;
  const changeCurrency = firstSurplusCur ? changeCur || firstSurplusCur : null;
  const changeNeedsRate = !!changeCurrency && surplusList.some((x) => x.cur !== changeCurrency) && !rate;
  const changeAmount = changeCurrency
    ? surplusList.reduce((acc, x) => acc + (convertMinor(x.s, x.cur, changeCurrency, rate) ?? 0), 0)
    : 0;

  const setPay = (i, patch) => setPayments((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const newPayment = (extra) => ({ method: "efectivo", currency, amount: "", reference: "", tendered: "", ...extra });
  const addPayment = () => setPayments((ps) => [...ps, newPayment()]);

  const addRemaining = (cur) => {
    const v = convertMinor(pending, currency, cur, rate);
    setPayments((ps) => [
      ...ps,
      newPayment({
        method: cur === "USD" ? "efectivo" : "punto",
        currency: cur,
        amount: v && v > 0 ? fromMinor(v) : "",
      }),
    ]);
  };

  const fill = (i) => {
    const others = payments.reduce((s, p, j) => (j === i ? s : s + toDoc(p)), 0);
    const v = convertMinor(total - others, currency, payments[i].currency, rate);
    if (v !== null && v > 0) setPay(i, { amount: fromMinor(v) });
  };

  // Cambiar el IVA modifica el total: se vuelve a cotizar en Rust y se reinician los pagos
  const toggleTax = async (value) => {
    setError(""); setNotice("");
    try {
      const q = await salesApi.quote(currency, items, value, priceListId);
      setQuote(q);
      setChargeTax(value);
      if (payments.length > 0) {
        setPayments([]);
        setNotice("El total cambió: vuelve a ingresar los pagos.");
      }
    } catch (e) {
      setError(e.message);
    }
  };

  const issue = async () => {
    setError("");
    if (payments.length === 0 && !onCredit) return setError("Agrega al menos un pago");
    if (onCredit && settled) return setError("El pago cubre el total: desactiva «Venta a crédito» o reduce el pago");
    if (needsReason && reason.trim().length < 3) {
      return setError("Indica el motivo por el que no se cobra el IVA o el IGTF");
    }
    if (changeNeedsRate) {
      return setError("Sin tasa USD vigente: no se puede calcular el vuelto en otra moneda");
    }
    const pays = [];
    for (let i = 0; i < payments.length; i++) {
      const p = payments[i];
      const m = toMinor(p.amount);
      if (m === null || m <= 0) return setError("Hay un monto de pago inválido (ejemplo: 12.50)");
      let tendered = null;
      if (p.method === "efectivo" && p.tendered.trim() !== "") {
        const t = toMinor(p.tendered);
        if (t === null || t <= 0) return setError(`Monto recibido inválido en el pago ${i + 1}`);
        if (t < m + igtfOf(p)) {
          return setError(`El monto recibido en el pago ${i + 1} no cubre lo que corresponde cobrar`);
        }
        tendered = t;
      }
      pays.push({
        method: p.method, currencyCode: p.currency, amountMinor: m,
        reference: p.reference.trim() || null, tenderedMinor: tendered,
      });
    }
    setBusy(true);
    try {
      const id = await salesApi.issue({
        customerId: customer ? customer.id : null,
        currencyCode: currency,
        items,
        payments: pays,
        notes: null,
        chargeTax,
        chargeIgtf,
        waiverReason: needsReason ? reason.trim() : null,
        changeCurrency: changeAmount > 0 ? changeCurrency : null,
        onCredit,
        priceListId,
      });
      onDone(id);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const input = "rounded border p-2";
  const pill = (n, label) => (
    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
      step === n ? "bg-slate-900 text-white" : "bg-slate-200 text-slate-600"}`}>
      {n}. {label}
    </span>
  );

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60 p-4">
      <div className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-slate-100 shadow-2xl">
        {/* Encabezado: total siempre visible */}
        <div className="bg-white px-5 py-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex gap-2">{pill(1, "Cliente")}{pill(2, "Pago")}</div>
            <button onClick={onClose} disabled={busy} aria-label="Cerrar"
              className="rounded-full px-2 text-2xl leading-none text-slate-500 hover:bg-slate-100 disabled:opacity-50">
              ×
            </button>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-slate-500">Total a cobrar</span>
            <span className="text-3xl font-semibold">{formatMoney(total, currency)}</span>
          </div>
          {currency !== "VES" && (
            <div className="text-right text-sm text-slate-500">
              Equiv. {formatMoney(quote.totalVesMinor, "VES")}
            </div>
          )}
          {quote.discountMinor > 0 && (
            <div className="mt-1 text-right text-xs font-semibold text-green-700">
              Incluye descuentos por {formatMoney(quote.discountMinor, currency)}
            </div>
          )}
          {taxWaived && (
            <div className="mt-1 text-right text-xs font-semibold text-amber-700">Sin IVA en esta venta</div>
          )}
        </div>

        {/* Paso 1: cliente */}
        {step === 1 && (
          <>
            <div className="min-h-[18rem] flex-1 overflow-y-auto p-5">
              <h2 className="mb-1 font-semibold">Datos del cliente</h2>
              <p className="mb-3 text-sm text-slate-500">
                Escribe la cédula o RIF y pulsa Enter. Si no existe, podrás registrarlo aquí mismo.
              </p>
              <CustomerPicker value={customer} onChange={setCustomer} />
            </div>
            <div className="flex justify-between gap-2 bg-white px-5 py-3">
              <button onClick={onClose} className="rounded-lg border px-4 py-2">Cancelar</button>
              <button onClick={() => setStep(2)}
                className="rounded-lg bg-slate-900 px-5 py-2 font-medium text-white">
                {customer ? "Continuar al pago →" : "Continuar sin cliente →"}
              </button>
            </div>
          </>
        )}

        {/* Paso 2: impuestos y pago */}
        {step === 2 && (
          <>
            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              <div className="flex items-center justify-between rounded border bg-white p-2 text-sm">
                <span>
                  Cliente:{" "}
                  <b>{customer ? `${customer.name} (${formatDocument(customer)})` : "Consumidor final"}</b>
                </span>
                <button onClick={() => setStep(1)} disabled={busy} className="underline">Cambiar</button>
              </div>

              {/* Interruptores de impuestos */}
              <div className="space-y-2">
                {hasTaxable && (
                  <Switch
                    checked={chargeTax}
                    onChange={toggleTax}
                    disabled={!isAdmin || busy}
                    label="Cobrar IVA"
                    hint={
                      !isAdmin
                        ? "Solo el administrador puede desactivarlo"
                        : chargeTax
                          ? `Se suma ${formatMoney(quote.taxMinor, currency)} al total`
                          : "No se cobrará IVA en esta venta"
                    }
                  />
                )}
                <Switch
                  checked={chargeIgtf}
                  onChange={setChargeIgtf}
                  disabled={busy}
                  label={`Cobrar IGTF (${igtfPct}%)`}
                  hint={chargeIgtf
                    ? "Se aplica a los pagos en divisas (USD)"
                    : "No se cobrará IGTF en esta venta"}
                />
                {needsReason && (
                  <input className={`${input} w-full border-amber-400`} value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Motivo por el que no se cobra (obligatorio)" />
                )}
              </div>

              {/* Venta a crédito */}
              {customer && creditInfo && (
                <Switch
                  checked={onCredit}
                  onChange={setOnCredit}
                  disabled={busy || creditInfo.limitUsdMinor <= 0}
                  label="Venta a crédito"
                  hint={
                    creditInfo.limitUsdMinor <= 0
                      ? "Este cliente no tiene crédito autorizado (el administrador lo asigna en Cuentas por cobrar)"
                      : `Disponible ${formatMoney(creditInfo.availableUsdMinor, "USD")} de ${formatMoney(creditInfo.limitUsdMinor, "USD")} · plazo ${creditInfo.creditDays} días`
                  }
                />
              )}
              {onCredit && (
                <div className={`rounded-xl border p-4 ${settled ? "border-red-300 bg-red-50" : "border-purple-300 bg-purple-50"}`}>
                  <div className="text-sm font-semibold text-purple-900">Saldo que quedará a crédito</div>
                  <div className="text-2xl font-semibold text-purple-950">{formatMoney(Math.max(remaining, 0), currency)}</div>
                  {settled && (
                    <p className="mt-1 text-xs text-red-700">El pago cubre el total: ya no queda saldo a crédito.</p>
                  )}
                  <p className="mt-1 text-xs text-purple-900">
                    Puedes dejar todo a crédito o registrar un pago inicial abajo. El resto se cobra con abonos
                    en Cuentas por cobrar.
                  </p>
                </div>
              )}

              {/* Falta por cobrar: ambas monedas */}
              {!onCredit && (
              <div className={`rounded-xl border p-4 ${
                settled ? "border-green-300 bg-green-50"
                : remaining < -tol ? "border-red-300 bg-red-50"
                : "border-amber-300 bg-amber-50"}`}>
                {settled ? (
                  <div className="font-semibold text-green-800">✔ Pago completo: cuadra con el total</div>
                ) : remaining < -tol ? (
                  <div className="font-semibold text-red-700">
                    Excedente: {formatMoney(-remaining, currency)}. Ajusta los pagos (el vuelto se calcula con «Recibido»).
                  </div>
                ) : (
                  <>
                    <div className="mb-1 text-sm font-semibold text-amber-900">Falta por cobrar</div>
                    <div className="flex justify-between text-lg font-semibold">
                      <span>USD</span>
                      <span>{pendingUsd === null ? "—" : formatMoney(pendingUsd, "USD")}</span>
                    </div>
                    <div className="flex justify-between text-lg font-semibold">
                      <span>Bs.</span>
                      <span>{pendingVes === null ? "—" : formatMoney(pendingVes, "VES")}</span>
                    </div>
                    {igtfIfUsd > 0 && (
                      <p className="mt-2 text-xs text-amber-900">
                        Si paga este saldo en USD, con IGTF entrega{" "}
                        <b>{formatMoney(pendingUsd + igtfIfUsd, "USD")}</b>{" "}
                        ({formatMoney(igtfIfUsd, "USD")} de IGTF).
                      </p>
                    )}
                    {pendingUsd === null && (
                      <p className="mt-2 text-xs text-amber-900">
                        Sin tasa USD vigente: no se puede mostrar la otra moneda.
                      </p>
                    )}
                  </>
                )}
                {igtfEst > 0 && (
                  <div className="mt-2 flex justify-between border-t border-amber-300 pt-2 text-sm text-amber-800">
                    <span>IGTF de los pagos en divisas</span><span>{formatMoney(igtfEst, currency)}</span>
                  </div>
                )}
              </div>

              )}

              {/* Vuelto */}
              {changeAmount > 0 && (
                <div className="rounded-xl border border-blue-300 bg-blue-50 p-4">
                  <div className="text-sm font-semibold text-blue-900">Vuelto a entregar al cliente</div>
                  <div className="text-3xl font-semibold text-blue-950">{formatMoney(changeAmount, changeCurrency)}</div>
                  <label className="mt-2 block text-sm text-blue-900">Entregar el vuelto en
                    <select className="ml-2 rounded border p-1" value={changeCurrency}
                      onChange={(e) => setChangeCur(e.target.value)}>
                      <option value="USD">Dólares (USD)</option>
                      <option value="VES">Bolívares (Bs.)</option>
                    </select>
                  </label>
                  {surplusList.some((x) => x.cur !== changeCurrency) && rate && (
                    <p className="mt-1 text-xs text-blue-900">Convertido a la tasa vigente: {fromMicro(rate)} Bs/USD.</p>
                  )}
                  {changeNeedsRate && (
                    <p className="mt-1 text-xs text-red-700">
                      Sin tasa USD vigente: no se puede calcular el vuelto en otra moneda.
                    </p>
                  )}
                </div>
              )}

              <div className="rounded-xl bg-white p-4 shadow">
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="font-semibold">Pagos</h2>
                  <button onClick={addPayment} className="rounded border px-2 py-1 text-sm">+ Agregar pago</button>
                </div>

                {!settled && remaining > tol && rate && (
                  <div className="mb-3 flex gap-2">
                    <button type="button" onClick={() => addRemaining("USD")}
                      className="flex-1 rounded border border-slate-400 px-2 py-1 text-sm hover:bg-slate-100">
                      + Pagar saldo en USD
                    </button>
                    <button type="button" onClick={() => addRemaining("VES")}
                      className="flex-1 rounded border border-slate-400 px-2 py-1 text-sm hover:bg-slate-100">
                      + Pagar saldo en Bs.
                    </button>
                  </div>
                )}

                {payments.map((p, i) => {
                  const t = tenderedOf(p);
                  const due = dueOf(p);
                  const short = t !== null && t < due;
                  const sur = surplusOf(p);
                  return (
                    <div key={i} className="mb-2 grid grid-cols-2 gap-2 rounded border p-2">
                      <select className={input} value={p.method}
                        onChange={(e) => setPay(i, { method: e.target.value, tendered: e.target.value === "efectivo" ? p.tendered : "" })}>
                        {Object.entries(METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                      <select className={input} value={p.currency} onChange={(e) => setPay(i, { currency: e.target.value })}>
                        <option value="USD">USD</option><option value="VES">Bs.</option>
                      </select>
                      <input className={input} placeholder="Monto a pagar" value={p.amount}
                        onChange={(e) => setPay(i, { amount: e.target.value })} />
                      <input className={input} placeholder="Referencia" value={p.reference}
                        onChange={(e) => setPay(i, { reference: e.target.value })} />

                      {p.method === "efectivo" && (
                        <div className="col-span-2">
                          <input className={`${input} w-full`} inputMode="decimal"
                            placeholder={`Recibido en ${p.currency === "USD" ? "USD" : "Bs."} (opcional, para calcular el vuelto)`}
                            value={p.tendered} onChange={(e) => setPay(i, { tendered: e.target.value })} />
                          {igtfOf(p) > 0 && (
                            <p className="mt-1 text-xs text-slate-500">
                              Debe entregar {formatMoney(due, p.currency)} (incluye {formatMoney(igtfOf(p), p.currency)} de IGTF).
                            </p>
                          )}
                          {short && (
                            <p className="mt-1 text-xs text-red-600">
                              Lo recibido no cubre lo que corresponde cobrar ({formatMoney(due, p.currency)}).
                            </p>
                          )}
                          {sur > 0 && (
                            <p className="mt-1 text-xs text-blue-700">
                              Sobran {formatMoney(sur, p.currency)}: se entregan como vuelto.
                            </p>
                          )}
                        </div>
                      )}

                      <button type="button" onClick={() => fill(i)} className="text-left text-sm underline">
                        Completar saldo
                      </button>
                      <button type="button" onClick={() => setPayments((ps) => ps.filter((_, j) => j !== i))}
                        className="text-right text-sm underline">Quitar</button>
                    </div>
                  );
                })}
                {payments.length === 0 && (
                  <p className="text-sm text-slate-500">Aún no hay pagos. Usa los botones de saldo o agrega uno.</p>
                )}
                {currency === "USD" && !rate && (
                  <p className="mt-2 text-sm text-amber-700">Sin tasa USD vigente: no podrás pagar en Bs.</p>
                )}
              </div>

              {notice && <p className="text-sm text-amber-700">{notice}</p>}
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>

            <div className="flex justify-between gap-2 bg-white px-5 py-3">
              <button onClick={() => setStep(1)} disabled={busy} className="rounded-lg border px-4 py-2 disabled:opacity-50">
                ← Cliente
              </button>
              <button onClick={issue} disabled={busy}
                className="rounded-lg bg-green-700 px-5 py-2 font-medium text-white disabled:opacity-50">
                {busy ? "Emitiendo…" : "Emitir comprobante"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}