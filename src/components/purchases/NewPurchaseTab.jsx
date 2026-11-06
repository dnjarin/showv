import { useEffect, useMemo, useState } from "react";
import { catalogApi, purchaseOrdersApi, purchasesApi, retentionsApi, warehousesApi } from "../../services/api";
import { formatMoney, fromMinor, toMinor } from "../../utils/money";
import SupplierPicker from "./SupplierPicker";
import DraftBanner from "../DraftBanner";
import { useDraft } from "../../hooks/useDraft";

const pct = (bp) => `${String(bp / 100).replace(".", ",")} %`;

export default function NewPurchaseTab({ onCreated, fromOrder = null, onOrderUsed }) {
  const [supplier, setSupplier] = useState(null);
  const [warehouses, setWarehouses] = useState([]);
  const [warehouseId, setWarehouseId] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceControl, setInvoiceControl] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [lines, setLines] = useState([]);
  const [updateCost, setUpdateCost] = useState(true);
  const [notes, setNotes] = useState("");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);

  // Impuestos y retenciones
  const [taxRates, setTaxRates] = useState([]);
  const [ivaRate, setIvaRate] = useState("");       // puntos base, como texto ("0" = sin IVA)
  const [exemptStr, setExemptStr] = useState("");
  const [ivaOverride, setIvaOverride] = useState("");
  const [opts, setOpts] = useState({ agentIva: false, agentIslr: false, concepts: [] });
  const [conceptId, setConceptId] = useState("");
  const [retainIva, setRetainIva] = useState(true);
  const [retainIslr, setRetainIslr] = useState(true);
  const [skipReason, setSkipReason] = useState("");
  const [onCredit, setOnCredit] = useState(false);
  const [creditDays, setCreditDays] = useState("30");
  const [calc, setCalc] = useState(null);
  const [calcError, setCalcError] = useState("");

  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const draft = useDraft("purchase", {
    data: { supplier, warehouseId, currency, invoiceNumber, invoiceControl, invoiceDate, lines, updateCost, notes,
      ivaRate, exemptStr, ivaOverride, conceptId, retainIva, retainIslr, skipReason, onCredit, creditDays },
    isEmpty: (d) => d.lines.length === 0,
    enabled: !fromOrder,
    onRestore: (d) => {
      const ls = (Array.isArray(d?.lines) ? d.lines : []).filter((x) => x && Number.isInteger(x.productId))
        .map((x) => ({ ...x, sku: String(x.sku ?? ""), name: String(x.name ?? ""),
          quantity: String(x.quantity ?? "1"), cost: String(x.cost ?? "") }));
      if (ls.length === 0) return false;
      const s = (v, def = "") => (typeof v === "string" ? v : def);
      const b = (v, def) => (typeof v === "boolean" ? v : def);
      setLines(ls);
      setSupplier(d.supplier && Number.isInteger(d.supplier.id) ? d.supplier : null);
      setWarehouseId(s(d.warehouseId));
      if (d.currency === "USD" || d.currency === "VES") setCurrency(d.currency);
      setInvoiceNumber(s(d.invoiceNumber)); setInvoiceControl(s(d.invoiceControl)); setInvoiceDate(s(d.invoiceDate));
      setUpdateCost(b(d.updateCost, true)); setNotes(s(d.notes));
      setIvaRate(s(d.ivaRate)); setExemptStr(s(d.exemptStr)); setIvaOverride(s(d.ivaOverride));
      setConceptId(s(d.conceptId)); setRetainIva(b(d.retainIva, true)); setRetainIslr(b(d.retainIslr, true));
      setSkipReason(s(d.skipReason)); setOnCredit(b(d.onCredit, false)); setCreditDays(s(d.creditDays, "30"));
      return true;
    },
  });
  const resetForm = () => {
    setSupplier(null); setLines([]); setInvoiceNumber(""); setInvoiceControl(""); setInvoiceDate("");
    setNotes(""); setExemptStr(""); setIvaOverride(""); setConceptId(""); setSkipReason("");
    setRetainIva(true); setRetainIslr(true); setOnCredit(false);
  };

  useEffect(() => {
    warehousesApi.list(false).then((w) => {
      setWarehouses(w);
      setWarehouseId((prev) => prev || String(w.find((x) => x.isSales)?.id ?? w[0]?.id ?? ""));
    }).catch((e) => setError(e.message));
    catalogApi.options().then((o) => {
      const t = o.taxRates.filter((x) => x.rateBp > 0);
      setTaxRates(t);
      setIvaRate((prev) => (prev !== "" ? prev : String(t[0]?.rateBp ?? 0)));
    }).catch(() => {});
    retentionsApi.options().then(setOpts).catch(() => {});
  }, []);

  // Viene de «Recibir» en una orden de compra: carga proveedor, moneda y líneas
  useEffect(() => {
    if (!fromOrder) return;
    setSupplier(fromOrder.supplier);
    setCurrency(fromOrder.currencyCode);
    setLines(fromOrder.items.map((i) => ({
      productId: i.productId, sku: i.sku, name: i.description, quantity: String(i.quantity),
      cost: fromMinor(i.unitCostMinor), productCurrency: fromOrder.currencyCode, productCost: i.unitCostMinor,
    })));
    setNotes(`Recepción de la orden ${fromOrder.number}`);
  }, [fromOrder]);

  useEffect(() => {
    const q = search.trim();
    if (!q) { setResults([]); return; }
    const t = setTimeout(() => {
      catalogApi.listProducts(q, false, false)
        .then((r) => setResults(r.filter((p) => p.trackStock).slice(0, 8)))
        .catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [search]);

  const prefill = (p, cur) => (p.priceCurrency === cur ? fromMinor(p.costMinor) : "");

  const add = (p) => {
    setLines((ls) => {
      const i = ls.findIndex((l) => l.productId === p.id);
      if (i >= 0) {
        return ls.map((l, j) => (j === i ? { ...l, quantity: String((parseInt(l.quantity, 10) || 0) + 1) } : l));
      }
      return [...ls, {
        productId: p.id, sku: p.sku, name: p.name, quantity: "1",
        usesLots: !!p.usesLots, lotCode: "", lotBrand: "", lotDate: "",
        cost: prefill(p, currency), productCurrency: p.priceCurrency, productCost: p.costMinor,
      }];
    });
    setSearch(""); setResults([]);
  };

  const onSearchKey = async (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = search.trim();
    if (!q) return;
    try {
      const r = (await catalogApi.listProducts(q, false, false)).filter((p) => p.trackStock);
      const hit = r.find((p) => p.barcode === q || p.sku === q.toUpperCase()) ?? (r.length === 1 ? r[0] : null);
      if (hit) add(hit);
    } catch (err) { setError(err.message); }
  };

  const changeCurrency = (cur) => {
    setCurrency(cur);
    setLines((ls) => ls.map((l) => ({
      ...l, cost: l.productCurrency === cur ? fromMinor(l.productCost) : "",
    })));
  };

  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  // Total de las líneas (solo para mostrar antes de la vista previa de Rust)
  const total = useMemo(() => lines.reduce((s, l) => {
    const c = toMinor(l.cost);
    const q = parseInt(l.quantity, 10);
    return c !== null && q > 0 ? s + c * q : s;
  }, 0), [lines]);

  const validLines = useMemo(() => {
    if (lines.length === 0) return null;
    const out = [];
    for (const l of lines) {
      const q = parseInt(l.quantity, 10);
      const c = toMinor(l.cost);
      if (Number.isNaN(q) || q <= 0 || c === null) return null;
      out.push({ quantity: q, unitCostMinor: c });
    }
    return out;
  }, [lines]);

  // Vista previa calculada por Rust (IVA, retenciones y neto a pagar)
  useEffect(() => {
    if (!validLines) { setCalc(null); setCalcError(""); return; }
    const exempt = exemptStr.trim() === "" ? 0 : toMinor(exemptStr);
    const override = ivaOverride.trim() === "" ? undefined : toMinor(ivaOverride);
    if (exempt === null) { setCalc(null); setCalcError("Monto exento inválido (ejemplo: 12.50)"); return; }
    if (override === null) { setCalc(null); setCalcError("IVA indicado inválido (ejemplo: 12.50)"); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      purchasesApi.quote({
        supplierId: supplier?.id ?? null, currencyCode: currency, lines: validLines,
        exemptMinor: exempt, ivaRateBp: Number(ivaRate) || 0, ivaOverrideMinor: override ?? null,
        islrConceptId: conceptId ? Number(conceptId) : null,
        retainIva, retainIslr,
      })
        .then((c) => { if (!cancelled) { setCalc(c); setCalcError(""); } })
        .catch((e) => { if (!cancelled) { setCalc(null); setCalcError(e.message); } });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [validLines, supplier, currency, exemptStr, ivaRate, ivaOverride, conceptId, retainIva, retainIslr]);

  const anyOff = (opts.agentIva && !retainIva) || (opts.agentIslr && !retainIslr);

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setMsg("");
    if (!supplier) return setError("Selecciona el proveedor");
    if (!warehouseId) return setError("Selecciona el almacén de destino");
    if (lines.length === 0) return setError("Agrega al menos un producto");
    const items = [];
    for (const l of lines) {
      const q = parseInt(l.quantity, 10);
      const c = toMinor(l.cost);
      if (Number.isNaN(q) || q <= 0) return setError(`Cantidad inválida en «${l.name}»`);
      if (c === null) return setError(`Costo inválido en «${l.name}» (ejemplo: 12.50)`);
      items.push({
        productId: l.productId, quantity: q, unitCostMinor: c,
        ...(l.usesLots ? {
          lotCode: (l.lotCode ?? "").trim() || null, lotBrand: (l.lotBrand ?? "").trim() || null,
          lotDate: l.lotDate || null,
        } : {}),
      });
    }
    const exempt = exemptStr.trim() === "" ? 0 : toMinor(exemptStr);
    if (exempt === null) return setError("Monto exento inválido");
    const override = ivaOverride.trim() === "" ? null : toMinor(ivaOverride);
    if (ivaOverride.trim() !== "" && override === null) return setError("IVA indicado inválido");

    setBusy(true);
    try {
      const r = await purchasesApi.create({
        supplierId: supplier.id, warehouseId: Number(warehouseId), currencyCode: currency,
        invoiceNumber: invoiceNumber.trim() || null, invoiceControl: invoiceControl.trim() || null,
        invoiceDate: invoiceDate || null, notes: notes.trim() || null, updateCost, items,
        exemptMinor: exempt, ivaRateBp: Number(ivaRate) || 0, ivaOverrideMinor: override,
        islrConceptId: conceptId ? Number(conceptId) : null,
        retainIva, retainIslr, skipReason: anyOff ? skipReason.trim() || null : null,
        onCredit, creditDays: onCredit ? parseInt(creditDays, 10) || 0 : null,
      });
      const wh = warehouses.find((w) => String(w.id) === String(warehouseId))?.name ?? "el almacén";
      setMsg(
        `Compra C-${String(r.number).padStart(6, "0")} registrada. El stock ya está disponible en ${wh}.` +
        (r.vouchers.length ? ` Comprobantes de retención: ${r.vouchers.join(" · ")}. Los encuentras en la pestaña Retenciones.` : "")
      );
      resetForm();
      draft.clear();
      if (fromOrder) {
        purchaseOrdersApi.markReceived(fromOrder.id, r.id).catch(() => {});
        onOrderUsed?.();
      }
      onCreated?.();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const input = "w-full rounded border p-2";
  const orderBanner = fromOrder && (
    <div className="mb-4 rounded-xl border border-blue-300 bg-blue-50 p-3 text-blue-900">
      Recibiendo la orden <b>{fromOrder.number}</b>. Ajusta cantidades o costos a lo que realmente llegó,
      agrega los datos de la factura y registra la compra: la orden quedará como «Recibida».
      {" "}<button type="button" className="underline" onClick={() => onOrderUsed?.()}>Descartar</button>
    </div>
  );
  const m = (v) => formatMoney(v, currency);
  const showRet = calc && (calc.agentIva || calc.agentIslr);

  return (
    <form onSubmit={submit} className="grid gap-6 lg:grid-cols-3">
      {orderBanner && <div className="lg:col-span-3">{orderBanner}</div>}
      {draft.restored && (
        <div className="lg:col-span-3">
          <DraftBanner what="borrador de compra" onKeep={draft.dismiss}
            onDiscard={() => { draft.clear(); resetForm(); }} />
        </div>
      )}
      <div className="space-y-4 lg:col-span-2">
        <div className="relative">
          <input className={input} value={search} onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKey} placeholder="Agregar producto: nombre, SKU o código de barras…" />
          {results.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full rounded border bg-white shadow">
              {results.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => add(p)}
                    className="flex w-full justify-between p-2 text-left hover:bg-slate-100">
                    <span>{p.sku} · {p.name}</span>
                    <span className="text-sm text-slate-500">costo actual {formatMoney(p.costMinor, p.priceCurrency)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="overflow-x-auto rounded-xl bg-white shadow">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-slate-100">
              <tr><th className="p-3">Producto</th><th className="p-3">Cantidad</th>
                <th className="p-3">Costo unitario ({currency})</th><th className="p-3 text-right">Subtotal</th><th className="p-3"></th></tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const c = toMinor(l.cost);
                const q = parseInt(l.quantity, 10);
                return (
                  <tr key={l.productId} className="border-b">
                    <td className="p-3">
                      {l.sku} · {l.name}
                      {l.usesLots && (
                        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">Lote</span>
                          <input className="w-28 rounded border p-1" placeholder="Código (auto)" maxLength={30}
                            value={l.lotCode ?? ""} onChange={(e) => setLine(i, { lotCode: e.target.value })} />
                          <input className="w-28 rounded border p-1" placeholder="Marca" maxLength={40}
                            value={l.lotBrand ?? ""} onChange={(e) => setLine(i, { lotBrand: e.target.value })} />
                          <input type="date" className="rounded border p-1" title="Fecha de llegada"
                            value={l.lotDate ?? ""} onChange={(e) => setLine(i, { lotDate: e.target.value })} />
                        </div>
                      )}
                    </td>
                    <td className="p-3"><input className="w-20 rounded border p-1" inputMode="numeric"
                      value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></td>
                    <td className="p-3"><input className="w-28 rounded border p-1" value={l.cost} placeholder="0.00"
                      onChange={(e) => setLine(i, { cost: e.target.value })} /></td>
                    <td className="p-3 text-right">{c !== null && q > 0 ? m(c * q) : "—"}</td>
                    <td className="p-3 text-right">
                      <button type="button" className="underline" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Quitar</button>
                    </td>
                  </tr>
                );
              })}
              {lines.length === 0 && (
                <tr><td colSpan={5} className="p-6 text-center text-slate-500">Agrega los productos que recibiste</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-4">
        <div className="space-y-3 rounded-xl bg-white p-4 shadow">
          <h2 className="font-semibold">Datos de la compra</h2>
          <SupplierPicker value={supplier} onChange={setSupplier} />
          <label className="block text-sm">Almacén de destino
            <select className={`${input} mt-1`} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}{w.isSales ? " (ventas)" : ""}</option>)}
            </select>
          </label>
          <label className="block text-sm">Moneda de la compra
            <select className={`${input} mt-1`} value={currency} onChange={(e) => changeCurrency(e.target.value)}>
              <option value="USD">USD</option><option value="VES">Bs. (VES)</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">N.º de factura
              <input className={`${input} mt-1`} value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
            </label>
            <label className="block text-sm">N.º de control
              <input className={`${input} mt-1`} value={invoiceControl} onChange={(e) => setInvoiceControl(e.target.value)} />
            </label>
          </div>
          <label className="block text-sm">Fecha de la factura
            <input type="date" className={`${input} mt-1`} value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </label>
          <input className={input} placeholder="Notas (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="rounded border p-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={onCredit} onChange={(e) => setOnCredit(e.target.checked)} />
              Compra a crédito (queda por pagar al proveedor)
            </label>
            {onCredit && (
              <label className="mt-2 block text-sm">Días de crédito
                <input className={`${input} mt-1 w-28`} inputMode="numeric" value={creditDays}
                  onChange={(e) => setCreditDays(e.target.value)} />
                <span className="block text-xs text-slate-500">Se paga desde el menú Cuentas por pagar. Se debe el neto (factura menos retenciones).</span>
              </label>
            )}
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={updateCost} onChange={(e) => setUpdateCost(e.target.checked)} />
            <span>Actualizar el costo de los productos con esta compra
              <span className="block text-xs text-slate-500">Se usa el costo de esta compra como costo actual del producto.</span>
            </span>
          </label>
        </div>

        <div className="space-y-3 rounded-xl bg-white p-4 shadow">
          <h2 className="font-semibold">Impuestos de la factura</h2>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">Alícuota de IVA
              <select className={`${input} mt-1`} value={ivaRate} onChange={(e) => setIvaRate(e.target.value)}>
                <option value="0">Sin IVA</option>
                {taxRates.map((t) => <option key={t.id} value={t.rateBp}>{t.name} ({pct(t.rateBp)})</option>)}
              </select>
            </label>
            <label className="block text-sm">Monto exento ({currency})
              <input className={`${input} mt-1`} placeholder="0.00" value={exemptStr} onChange={(e) => setExemptStr(e.target.value)} />
            </label>
          </div>
          {Number(ivaRate) > 0 && (
            <label className="block text-sm">IVA según la factura del proveedor (opcional)
              <input className={`${input} mt-1`} value={ivaOverride}
                placeholder={calc ? fromMinor(calc.ivaMinor) : "se calcula solo"}
                onChange={(e) => setIvaOverride(e.target.value)} />
              <span className="text-xs text-slate-500">Úsalo solo si la factura difiere por redondeo.</span>
            </label>
          )}

          {opts.agentIslr && (
            <label className="block text-sm">Concepto de ISLR
              <select className={`${input} mt-1`} value={conceptId} onChange={(e) => setConceptId(e.target.value)}>
                <option value="">Sin retención de ISLR</option>
                {opts.concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {opts.concepts.length === 0 && (
                <span className="text-xs text-amber-700">No hay conceptos activos: el administrador debe activarlos en «Config. retenciones».</span>
              )}
            </label>
          )}

          {opts.agentIva && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={retainIva} onChange={(e) => setRetainIva(e.target.checked)} />
              Retener IVA
            </label>
          )}
          {opts.agentIslr && conceptId && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={retainIslr} onChange={(e) => setRetainIslr(e.target.checked)} />
              Retener ISLR
            </label>
          )}
          {anyOff && (
            <input className={`${input} border-amber-400`} value={skipReason} onChange={(e) => setSkipReason(e.target.value)}
              placeholder="Motivo por el que no se retiene (obligatorio si correspondía)" />
          )}
        </div>

        <div className="rounded-xl bg-white p-4 shadow">
          {calc ? (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt>Subtotal (sin IVA)</dt><dd>{m(calc.totalMinor)}</dd></div>
              {calc.exemptMinor > 0 && <div className="flex justify-between"><dt>De los cuales exento</dt><dd>{m(calc.exemptMinor)}</dd></div>}
              <div className="flex justify-between"><dt>IVA {calc.ivaRateBp > 0 ? `(${pct(calc.ivaRateBp)})` : ""}</dt><dd>{m(calc.ivaMinor)}</dd></div>
              <div className="flex justify-between border-t pt-1 font-semibold"><dt>Total de la factura</dt><dd>{m(calc.invoiceTotalMinor)}</dd></div>
              {calc.ivaRetMinor > 0 && (
                <div className="flex justify-between text-amber-800">
                  <dt>Retención de IVA ({pct(calc.ivaRetBp)})</dt><dd>−{m(calc.ivaRetMinor)}</dd>
                </div>
              )}
              {calc.islr && calc.islr.amountMinor > 0 && (
                <div className="flex justify-between text-amber-800">
                  <dt>Retención de ISLR ({pct(calc.islr.rateBp)})</dt><dd>−{m(calc.islr.amountMinor)}</dd>
                </div>
              )}
              <div className="flex items-baseline justify-between border-t pt-2">
                <dt className="font-semibold">Neto a pagar al proveedor</dt>
                <dd className="text-2xl font-semibold">{m(calc.netPayableMinor)}</dd>
              </div>
              {calc.islr?.note && <p className="text-xs text-amber-800">{calc.islr.note}</p>}
              {calc.notes.map((n, i) => <p key={i} className="text-xs text-slate-500">{n}</p>)}
              {calc.needsSupplier && <p className="text-xs text-amber-800">Selecciona el proveedor para calcular las retenciones.</p>}
              {showRet && (calc.ivaRetMinor > 0 || (calc.islr?.amountMinor ?? 0) > 0) && currency !== "VES" && (
                <p className="text-xs text-slate-500">Las retenciones se declaran en bolívares con la tasa vigente.</p>
              )}
            </dl>
          ) : (
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-slate-500">Total de la compra</span>
              <span className="text-2xl font-semibold">{m(total)}</span>
            </div>
          )}
          {calcError && <p className="mt-2 text-sm text-red-600">{calcError}</p>}
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {msg && <p className="text-sm text-green-700">{msg}</p>}
        <button disabled={busy} className="w-full rounded bg-green-700 p-3 text-lg text-white disabled:opacity-50">
          {busy ? "Registrando…" : "Registrar compra"}
        </button>
      </div>
    </form>
  );
}