import { useCallback, useEffect, useState } from "react";
import { catalogApi, quotesApi } from "../services/api";
import { formatMoney } from "../utils/money";
import { localDate } from "../utils/dates";
import { computeQuote, addDays, parseMoney } from "../utils/quoteCalc";
import QuoteTicket from "../components/QuoteTicket";
import CustomerPicker from "../components/CustomerPicker";
import DraftBanner from "../components/DraftBanner";
import { useDraft } from "../hooks/useDraft";

const blankLine = () => ({ key: Math.random().toString(36).slice(2), description: "", quantity: 1, price: "", discount: "", exempt: false });
const str = (v) => (typeof v === "string" ? v : "");

function Builder({ ctx, onIssued, onCancel }) {
  const [currency, setCurrency] = useState("VES");
  const [payCondition, setPayCondition] = useState("CONTADO");
  const [validDays, setValidDays] = useState("7");
  const [customer, setCustomer] = useState(null);
  const [cName, setCName] = useState("");
  const [cDoc, setCDoc] = useState("");
  const [cPhone, setCPhone] = useState("");
  const [cAddr, setCAddr] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([blankLine()]);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const draft = useDraft("quote-lite", {
    data: { currency, payCondition, validDays, cName, cDoc, cPhone, cAddr, notes, lines },
    isEmpty: (d) => d.lines.every((l) => !l.description && !l.price) && !d.cName,
    onRestore: (d) => {
      const ls = (Array.isArray(d?.lines) ? d.lines : []).filter((x) => x && typeof x === "object")
        .map((x) => ({ key: Math.random().toString(36).slice(2), description: str(x.description),
          quantity: Number.isInteger(x.quantity) && x.quantity > 0 ? x.quantity : 1,
          price: str(x.price), discount: str(x.discount), exempt: x.exempt === true }));
      if (ls.length === 0 || ls.every((l) => !l.description && !l.price)) return false;
      setLines(ls);
      if (d.currency === "USD" || d.currency === "VES") setCurrency(d.currency);
      setPayCondition(d.payCondition === "CREDITO" ? "CREDITO" : "CONTADO");
      setValidDays(str(d.validDays) || "7");
      setCName(str(d.cName)); setCDoc(str(d.cDoc)); setCPhone(str(d.cPhone)); setCAddr(str(d.cAddr)); setNotes(str(d.notes));
      return true;
    },
  });
  const discardDraft = () => {
    draft.clear(); setCustomer(null); setLines([blankLine()]); setCName(""); setCDoc(""); setCPhone(""); setCAddr(""); setNotes("");
    setValidDays("7"); setPayCondition("CONTADO");
  };

  // Búsqueda opcional en el inventario (solo lectura) para sugerir descripción y precio.
  useEffect(() => {
    const q = search.trim();
    if (!q) { setResults([]); return; }
    const t = setTimeout(() => {
      catalogApi.listProducts(q, false, false).then((r) => setResults(r.slice(0, 8))).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [search]);

  const suggestUsd = (p) => {
    if (p.priceCurrency === "USD") return (p.priceMinor / 100).toFixed(2).replace(".", ",");
    if (ctx.rateMicro) return ((p.priceMinor * 1_000_000) / ctx.rateMicro / 100).toFixed(2).replace(".", ",");
    return "";
  };
  const addProduct = (p) => {
    setLines((ls) => {
      const fresh = { ...blankLine(), description: p.name, price: suggestUsd(p) };
      return ls.length === 1 && !ls[0].description && !ls[0].price ? [fresh] : [...ls, fresh];
    });
    setSearch(""); setResults([]);
  };
  // Al elegir un cliente registrado se rellenan los datos (siguen editables); es solo lectura.
  const pickCustomer = (c) => {
    setCustomer(c);
    setCName(c?.name ?? ""); setCDoc(c ? `${c.idType}-${c.idNumber}` : "");
    setCPhone(c?.phone ?? ""); setCAddr(c?.fiscalAddress ?? "");
  };
  const setLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key) => setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : [blankLine()]));

  const calc = computeQuote(currency, ctx.rateMicro, lines);
  const days = parseInt(validDays, 10);
  const problem = calc.error || (!(days >= 1 && days <= 365) ? "La vigencia debe estar entre 1 y 365 días" : "");
  const sym = currency === "VES" ? "VES" : "USD";
  const usdSubtotal = lines.reduce((a, l) => a + (parseMoney(l.price) ?? 0) * Math.max(1, parseInt(l.quantity, 10) || 1), 0);

  const issue = async () => {
    setError(""); setBusy(true);
    try {
      if (problem) throw new Error(problem);
      const snap = {
        currencyCode: currency, usdRateMicro: ctx.rateMicro, payCondition,
        validUntil: addDays(days), customerName: cName.trim(), customerDoc: cDoc.trim(),
        customerPhone: cPhone.trim(), customerAddress: cAddr.trim(), notes: notes.trim() || null,
        items: calc.items, subtotalMinor: calc.subtotalMinor, exemptMinor: calc.exemptMinor,
        taxMinor: calc.taxMinor, totalMinor: calc.totalMinor,
      };
      const out = await quotesApi.issue({
        currencyCode: currency, rateMicro: ctx.rateMicro ?? null,
        customerName: cName, totalMinor: calc.totalMinor, payload: JSON.stringify(snap),
      });
      draft.clear();
      onIssued({ ...snap, id: out.id, number: out.number, createdAt: out.createdAt, createdByName: out.createdByName });
    } catch (e) { setError(e.message ?? String(e)); } finally { setBusy(false); }
  };

  const input = "rounded border p-2 text-sm";
  const lbl = "min-w-0 text-xs text-slate-500";
  return (
    <div className="mb-6 rounded-xl border bg-white p-4 shadow">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Nueva cotización</h2>
        <button onClick={onCancel} className="underline">Cerrar</button>
      </div>
      <p className="mb-3 text-xs text-slate-500">Escribe los precios en USD (sin IVA). Solo se registra la emisión para auditoría.</p>
      {draft.restored && <DraftBanner what="borrador de cotización" onKeep={draft.dismiss} onDiscard={discardDraft} />}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <label className={lbl}>Pago en
              <select className={`${input} mt-1 w-full text-slate-900`} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                <option value="VES">Bolívares (tasa BCV)</option><option value="USD">Divisas (USD)</option>
              </select>
            </label>
            <label className={lbl}>Condición
              <select className={`${input} mt-1 w-full text-slate-900`} value={payCondition} onChange={(e) => setPayCondition(e.target.value)}>
                <option value="CONTADO">Contado</option><option value="CREDITO">Crédito</option>
              </select>
            </label>
            <label className={lbl}>Vigencia (días)
              <input className={`${input} mt-1 w-full text-slate-900`} inputMode="numeric" value={validDays} onChange={(e) => setValidDays(e.target.value)} />
            </label>
            <label className={lbl}>Tasa BCV (automática)
              <input disabled className={`${input} mt-1 w-full bg-slate-100 text-slate-900`}
                value={ctx.rateMicro ? `Bs. ${(ctx.rateMicro / 1_000_000).toFixed(4).replace(".", ",")}` : "Sin tasa"} />
            </label>
          </div>
          <CustomerPicker value={customer} onChange={pickCustomer} />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <input className={input} placeholder="Cliente / Razón social" maxLength={80} value={cName} onChange={(e) => setCName(e.target.value)} />
            <input className={input} placeholder="RIF / C.I." maxLength={20} value={cDoc} onChange={(e) => setCDoc(e.target.value)} />
            <input className={input} placeholder="Teléfono" maxLength={25} value={cPhone} onChange={(e) => setCPhone(e.target.value)} />
            <input className={input} placeholder="Dirección" maxLength={120} value={cAddr} onChange={(e) => setCAddr(e.target.value)} />
          </div>

          <div className="relative">
            <div className="flex gap-2">
              <input className={`${input} flex-1`} placeholder="Buscar en inventario para sugerir descripción y precio (opcional)…"
                value={search} onChange={(e) => setSearch(e.target.value)} />
              <button type="button" className="rounded border px-3 text-sm" onClick={() => setLines((ls) => [...ls, blankLine()])}>+ Línea libre</button>
            </div>
            {results.length > 0 && (
              <ul className="absolute z-10 mt-1 w-full rounded border bg-white shadow">
                {results.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => addProduct(p)} className="flex w-full justify-between p-2 text-left hover:bg-slate-100">
                      <span>{p.sku} · {p.name}</span>
                      <span className="text-sm text-slate-500">{formatMoney(p.priceMinor, p.priceCurrency)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="overflow-x-auto rounded border">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-100">
                <tr><th className="p-2">Descripción</th><th className="p-2">Cant.</th><th className="p-2">Precio unit. (USD)</th>
                  <th className="p-2">Dto %</th><th className="p-2">Exento</th><th className="p-2 text-right">Total {sym}</th><th /></tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const it = calc.items?.[i];
                  return (
                    <tr key={l.key} className="border-t align-top">
                      <td className="p-2"><textarea rows={1} className={`${input} w-full min-w-[220px]`} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} /></td>
                      <td className="p-2"><input className={`${input} w-16`} inputMode="numeric" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: Math.max(1, parseInt(e.target.value, 10) || 1) })} /></td>
                      <td className="p-2"><input className={`${input} w-28 bg-yellow-50`} inputMode="decimal" placeholder="0,00" value={l.price} onChange={(e) => setLine(l.key, { price: e.target.value })} /></td>
                      <td className="p-2"><input className={`${input} w-16`} inputMode="decimal" value={l.discount} onChange={(e) => setLine(l.key, { discount: e.target.value })} /></td>
                      <td className="p-2 text-center"><input type="checkbox" checked={l.exempt} onChange={(e) => setLine(l.key, { exempt: e.target.checked })} /></td>
                      <td className="p-2 text-right">{it ? formatMoney(it.baseMinor, currency) : "…"}</td>
                      <td className="p-2"><button type="button" className="text-slate-500" onClick={() => removeLine(l.key)}>✕</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-3">
          <textarea className={`${input} w-full`} rows={2} maxLength={300} placeholder="Notas (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <dl className="space-y-1 rounded border p-3 text-sm">
            <div className="flex justify-between"><dt>SubTotal USD</dt><dd>{formatMoney(usdSubtotal, "USD")}</dd></div>
            {currency === "VES" && ctx.rateMicro && (
              <div className="flex justify-between"><dt>Tasa BCV</dt><dd>{(ctx.rateMicro / 1_000_000).toFixed(4).replace(".", ",")}</dd></div>
            )}
            {!calc.error && (
              <>
                <div className="flex justify-between"><dt>SubTotal {sym}</dt><dd>{formatMoney(calc.subtotalMinor + calc.exemptMinor, currency)}</dd></div>
                <div className="flex justify-between"><dt>IVA 16 %</dt><dd>{formatMoney(calc.taxMinor, currency)}</dd></div>
                <div className="flex justify-between border-t pt-1 text-lg font-semibold"><dt>TOTAL</dt><dd>{formatMoney(calc.totalMinor, currency)}</dd></div>
              </>
            )}
          </dl>
          {(error || problem) && <p className="text-sm text-red-600">{error || problem}</p>}
          <button onClick={issue} disabled={busy || !!problem}
            className="w-full rounded bg-slate-900 p-3 text-white disabled:opacity-50">Generar cotización (PDF / JPG / imprimir)</button>
        </div>
      </div>
    </div>
  );
}

export default function Quotes() {
  const [ctx, setCtx] = useState(null);
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState("");
  const [building, setBuilding] = useState(false);
  const [view, setView] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setRows(await quotesApi.docsList(search || null)); setError(""); } catch (e) { setError(e.message ?? String(e)); }
  }, [search]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  const openBuilder = async () => {
    try { setCtx(await quotesApi.context()); setBuilding(true); setError(""); } catch (e) { setError(e.message ?? String(e)); }
  };

  const show = async (id) => {
    try {
      const [d, c] = await Promise.all([quotesApi.docGet(id), quotesApi.context()]);
      setView({ ...JSON.parse(d.payload), id: d.id, number: d.number, createdAt: d.createdAt, createdByName: d.createdByName,
        issuerName: c.issuerName, issuerRif: c.issuerRif, issuerAddress: c.issuerAddress, issuerPhone: c.issuerPhone, style: c.style });
    } catch (e) { setError(e.message ?? String(e)); }
  };

  const issued = async (q) => {
    let c = ctx;
    try { c = await quotesApi.context(); } catch { /* usa el contexto ya cargado */ }
    setBuilding(false); load();
    setView({ ...q, issuerName: c.issuerName, issuerRif: c.issuerRif, issuerAddress: c.issuerAddress, issuerPhone: c.issuerPhone, style: c.style });
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Cotizaciones</h1>
        {!building && <button onClick={openBuilder} className="rounded bg-slate-900 px-4 py-2 text-white">Nueva cotización</button>}
      </div>
      {error && <p className="mb-3 rounded bg-red-50 p-3 text-red-700">{error}</p>}
      {building && ctx && <Builder ctx={ctx} onCancel={() => setBuilding(false)} onIssued={issued} />}
      <div className="mb-3">
        <input className="w-64 rounded border p-2" placeholder="Buscar por número o cliente" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Número</th><th className="p-3">Fecha</th><th className="p-3">Cliente</th>
              <th className="p-3">Total</th><th className="p-3">Emitió</th><th className="p-3" /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b">
                <td className="p-3 font-mono">{r.number}</td>
                <td className="p-3">{localDate(r.createdAt)}</td>
                <td className="p-3">{r.customerName || "—"}</td>
                <td className="p-3">{formatMoney(r.totalMinor, r.currencyCode)}</td>
                <td className="p-3">{r.createdByName ?? "—"}</td>
                <td className="p-3 text-right"><button className="underline" onClick={() => show(r.id)}>Ver / imprimir</button></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-500">Sin cotizaciones emitidas</td></tr>}
          </tbody>
        </table>
      </div>
      {view && <QuoteTicket q={view} onClose={() => setView(null)} />}
    </div>
  );
}
