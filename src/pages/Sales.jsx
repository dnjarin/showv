import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { cashApi, catalogApi, pricingApi, quotesApi, salesApi } from "../services/api";
import LotPickerModal from "../components/lots/LotPickerModal";
import { formatMoney } from "../utils/money";
import CheckoutModal from "../components/CheckoutModal";
import Ticket from "../components/Ticket";
import DraftBanner from "../components/DraftBanner";
import { useDraft } from "../hooks/useDraft";
import { useHeldSales, MAX_HELD } from "../hooks/useHeldSales";

/** Valida y normaliza un carrito guardado (borrador o venta en espera) antes de usarlo. */
const cleanCart = (arr) => (Array.isArray(arr) ? arr : [])
  .filter((x) => x && Number.isInteger(x.productId) && Number.isInteger(x.quantity) && x.quantity > 0)
  .map((x) => ({
    k: typeof x.k === "string" ? x.k : String(x.productId),
    productId: x.productId, sku: String(x.sku ?? ""), name: String(x.name ?? ""),
    usesLots: !!x.usesLots, lotId: Number.isInteger(x.lotId) ? x.lotId : null,
    lotLabel: typeof x.lotLabel === "string" ? x.lotLabel : null,
    quantity: x.quantity, discount: typeof x.discount === "string" ? x.discount : "",
    stock: typeof x.stock === "number" ? x.stock : null,
  }));

/** "10" o "7,5" -> 1000 / 750 (puntos base). "" -> 0. Inválido -> null. */
const pctToBp = (s) => {
  const t = String(s ?? "").trim();
  if (t === "") return 0;
  const v = Number(t.replace(",", "."));
  if (!Number.isFinite(v) || v < 0 || v > 100) return null;
  return Math.round(v * 100);
};

export default function Sales() {
  const [currency, setCurrency] = useState("USD");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [cart, setCart] = useState([]);
  const [allDisc, setAllDisc] = useState("");
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState("");
  const [error, setError] = useState("");
  const [checkout, setCheckout] = useState(false);
  const [ticketId, setTicketId] = useState(null);
  const [cashOpen, setCashOpen] = useState(true);
  const location = useLocation();
  const [fromQuote, setFromQuote] = useState(null);
  const [lists, setLists] = useState([]);
  const [priceListId, setPriceListId] = useState("");
  const [picker, setPicker] = useState(null); // { product, lineKey? }

  // Borrador automático: si se recarga la vista, el carrito se puede recuperar
  const draft = useDraft("sales", {
    data: { currency, priceListId, fromQuote, cart },
    isEmpty: (d) => d.cart.length === 0,
    enabled: !location.state?.fromQuote,
    onRestore: (d) => {
      const items = cleanCart(d?.cart);
      if (items.length === 0) return false;
      setCart(items);
      if (d.currency === "USD" || d.currency === "VES") setCurrency(d.currency);
      setPriceListId(typeof d.priceListId === "string" ? d.priceListId : "");
      const q = d.fromQuote;
      if (q && Number.isInteger(q.id)) setFromQuote({ id: q.id, number: String(q.number ?? ""), customerName: q.customerName ?? null });
      return true;
    },
  });
  const discardDraft = () => { draft.clear(); setCart([]); setAllDisc(""); setFromQuote(null); };

  // Ventas en espera: aparcar el carrito para atender a otro cliente y retomarlo después
  const heldSales = useHeldSales();
  const snapshot = () => ({ currency, priceListId, fromQuote, cart });
  const holdCurrent = () => {
    if (cart.length === 0) return;
    if (!heldSales.hold(snapshot())) {
      show("error", `Ya hay ${MAX_HELD} ventas en espera. Retoma o elimina alguna.`);
      return;
    }
    discardDraft();
    setQuote(null);
    show("ok", "Venta puesta en espera. Puedes atender al siguiente cliente.");
    searchRef.current?.focus();
  };
  const resumeHeld = (h) => {
    const items = cleanCart(h.cart);
    heldSales.remove(h.id);
    if (items.length === 0) return;
    if (cart.length > 0) heldSales.hold(snapshot()); // la venta actual pasa a espera
    setCart(items);
    setAllDisc("");
    setCurrency(h.currency === "VES" ? "VES" : "USD");
    setPriceListId(typeof h.priceListId === "string" ? h.priceListId : "");
    const q = h.fromQuote;
    setFromQuote(q && Number.isInteger(q.id)
      ? { id: q.id, number: String(q.number ?? ""), customerName: q.customerName ?? null } : null);
    draft.dismiss();
  };

  // Búsqueda / lector de códigos
  const searchRef = useRef(null);
  const [hi, setHi] = useState(0);              // resultado resaltado con el teclado
  const [touched, setTouched] = useState(false); // el usuario navegó con las flechas
  const [flash, setFlash] = useState(null);      // línea recién agregada
  const [notice, setNotice] = useState(null);    // {type: "ok"|"error", text}
  const [sound, setSound] = useState(() => {
    try { return localStorage.getItem("pos-sound") !== "off"; } catch { return true; }
  });
  const audioRef = useRef(null);
  const noticeTimer = useRef(null);
  const flashTimer = useRef(null);

  const toggleSound = (v) => {
    setSound(v);
    try { localStorage.setItem("pos-sound", v ? "on" : "off"); } catch { /* sin almacenamiento */ }
  };
  const beep = (ok) => {
    if (!sound) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioRef.current) audioRef.current = new Ctx();
      const ctx = audioRef.current;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = ok ? 880 : 220;
      g.gain.value = 0.05;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + (ok ? 0.08 : 0.25));
    } catch { /* sin audio */ }
  };
  const show = (type, text) => {
    setNotice({ type, text });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  };
  useEffect(() => () => { clearTimeout(noticeTimer.current); clearTimeout(flashTimer.current); }, []);

  useEffect(() => {
    pricingApi.options().then(setLists).catch(() => {});
  }, []);

  // Viene de «Convertir en venta» en Cotizaciones
  useEffect(() => {
    const q = location.state?.fromQuote;
    if (!q) return;
    setFromQuote({ id: q.id, number: q.number, customerName: q.customerName });
    setCurrency(q.currencyCode);
    setPriceListId(q.priceListId ? String(q.priceListId) : "");
    setCart(q.items.map((i) => ({
      k: String(i.productId), productId: i.productId, sku: i.sku, name: i.name, quantity: i.quantity,
      usesLots: !!i.usesLots, lotId: null, lotLabel: null,
      discount: i.discountBp ? String(i.discountBp / 100).replace(".", ",") : "",
    })));
    window.history.replaceState({}, "");
  }, [location.state]);

  useEffect(() => {
    cashApi.current().then((s) => setCashOpen(!!s)).catch(() => {});
  }, []);

  // Sugerencias mientras se escribe
  useEffect(() => {
    const q = search.trim();
    if (!q) { setResults([]); return; }
    const t = setTimeout(() => {
      catalogApi.listProducts(q, false, false)
        .then((r) => { setResults(r.slice(0, 8)); setHi(0); setTouched(false); })
        .catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [search]);

  // Si el foco se pierde, escribir (o escanear) devuelve el cursor al buscador
  useEffect(() => {
    const onKey = (e) => {
      if (checkout || ticketId) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const a = document.activeElement;
      if (a && ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName)) return;
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [checkout, ticketId]);

  // Cotización calculada por Rust (incluye descuentos)
  useEffect(() => {
    if (cart.length === 0) { setQuote(null); setQuoteError(""); return; }
    const bad = cart.find((c) => pctToBp(c.discount) === null);
    if (bad) {
      setQuote(null);
      setQuoteError(`Descuento inválido en «${bad.name}» (debe estar entre 0 y 100)`);
      return;
    }
    let cancelled = false;
    salesApi
      .quote(currency, cart.map((c) => ({
        productId: c.productId, quantity: c.quantity, discountBp: pctToBp(c.discount), lotId: c.lotId ?? null,
      })), true, priceListId ? Number(priceListId) : null)
      .then((q) => { if (!cancelled) { setQuote(q); setQuoteError(""); } })
      .catch((e) => { if (!cancelled) { setQuote(null); setQuoteError(e.message); } });
    return () => { cancelled = true; };
  }, [cart, currency, priceListId]);

  const add = (p, lot) => {
    if (p.trackStock && p.salesStock <= 0) {
      show("error", `«${p.name}» no tiene existencias en el almacén de ventas`);
      beep(false);
      setSearch(""); setResults([]);
      searchRef.current?.focus();
      return;
    }
    // Producto con lotes: el lote siempre se elige a mano.
    if (p.usesLots && !lot) {
      setSearch(""); setResults([]);
      setPicker({ product: p });
      return;
    }
    const k = lot ? `${p.id}:${lot.id}` : String(p.id);
    const prev = cart.find((x) => x.k === k)?.quantity ?? 0;
    setCart((c) => {
      const i = c.findIndex((x) => x.k === k);
      if (i >= 0) return c.map((x, j) => (j === i ? { ...x, quantity: x.quantity + 1 } : x));
      // Lo nuevo va arriba: siempre se ve lo último que se agregó
      return [{ k, productId: p.id, sku: p.sku, name: p.name, quantity: 1, discount: "",
        usesLots: !!p.usesLots, lotId: lot?.id ?? null,
        lotLabel: lot ? `${lot.code}${lot.brand ? ` · ${lot.brand}` : ""}` : null,
        stock: lot ? lot.stock : p.trackStock ? p.salesStock : null }, ...c];
    });
    setFlash(k);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1500);
    show("ok", `${prev > 0 ? `+1 ${p.name} (ahora ${prev + 1})` : `Agregado: ${p.name}`}`);
    beep(true);
    setSearch(""); setResults([]); setHi(0); setTouched(false);
    searchRef.current?.focus();
  };

  // Se eligió el lote en la ventana: agrega la línea nueva o asigna el lote a una línea sin lote.
  const onPickLot = (lot) => {
    const pk = picker;
    setPicker(null);
    if (!pk) return;
    if (pk.lineKey) {
      const label = `${lot.code}${lot.brand ? ` · ${lot.brand}` : ""}`;
      const k = `${pk.product.id}:${lot.id}`;
      setCart((c) => {
        const line = c.find((x) => x.k === pk.lineKey);
        if (!line) return c;
        const dup = c.find((x) => x.k === k && x.k !== pk.lineKey);
        if (dup) {
          return c.filter((x) => x.k !== pk.lineKey)
            .map((x) => (x.k === k ? { ...x, quantity: x.quantity + line.quantity } : x));
        }
        return c.map((x) => (x.k === pk.lineKey
          ? { ...x, k, lotId: lot.id, lotLabel: label, stock: lot.stock } : x));
      });
    } else {
      add({ ...pk.product, trackStock: true, salesStock: lot.stock, usesLots: true }, lot);
    }
    searchRef.current?.focus();
  };

  // Teclado del buscador: flechas, Enter (también lo usa el lector de códigos) y Esc
  const onSearchKey = async (e) => {
    if (e.key === "Escape") { setSearch(""); setResults([]); return; }
    if (e.key === "ArrowDown" && results.length > 0) {
      e.preventDefault(); setTouched(true); setHi((i) => Math.min(i + 1, results.length - 1)); return;
    }
    if (e.key === "ArrowUp" && results.length > 0) {
      e.preventDefault(); setTouched(true); setHi((i) => Math.max(i - 1, 0)); return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = search.trim();
    if (!q) return;
    if (touched && results[hi]) { add(results[hi]); return; }
    try {
      const r = await catalogApi.listProducts(q, false, false);
      const hit =
        r.find((p) => p.barcode === q || p.sku === q.toUpperCase()) ?? (r.length === 1 ? r[0] : null);
      if (hit) add(hit);
      else if (r.length > 1) show("error", `Hay ${r.length} coincidencias para «${q}»: elige una de la lista`);
      else {
        show("error", `No encontré ningún producto con «${q}»`);
        beep(false);
        e.target.select?.();
      }
    } catch (err) { setError(err.message); }
  };

  const setQty = (k, v) =>
    setCart((c) => c.map((x) => (x.k === k ? { ...x, quantity: Math.max(1, parseInt(v, 10) || 1) } : x)));
  const setDisc = (k, v) =>
    setCart((c) => c.map((x) => (x.k === k ? { ...x, discount: v } : x)));
  const removeLine = (k) => setCart((c) => c.filter((x) => x.k !== k));
  const applyAll = () => setCart((c) => c.map((x) => ({ ...x, discount: allDisc })));

  const apiItems = cart.map((c) => ({
    productId: c.productId, quantity: c.quantity, discountBp: pctToBp(c.discount) ?? 0, lotId: c.lotId ?? null,
  }));

  const onDone = (id) => {
    if (fromQuote) {
      quotesApi.markConverted(fromQuote.id, id).catch(() => {});
      setFromQuote(null);
    }
    setCart([]); setAllDisc("");
    draft.clear();
    setCheckout(false);
    setTicketId(id);
  };

  const lineOf = (c) =>
    quote?.lines.find((l) => l.productId === c.productId && (l.lotId ?? null) === (c.lotId ?? null));
  const input = "rounded border p-2";
  const zeroTotal = quote && quote.totalMinor <= 0;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Nueva venta</h1>
        <div className="flex items-center gap-4">
        {lists.length > 0 && (
          <label className="text-sm">Lista de precios{" "}
            <select className={input} value={priceListId} onChange={(e) => setPriceListId(e.target.value)}>
              <option value="">Precio base</option>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        )}
        <label className="text-sm">Moneda del documento{" "}
          <select className={input} value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="USD">USD</option>
            <option value="VES">Bs. (VES)</option>
          </select>
        </label>
        </div>
      </div>

      {fromQuote && (
        <div className="mb-4 rounded-xl border border-blue-300 bg-blue-50 p-3 text-blue-900">
          Venta basada en la cotización <b>{fromQuote.number}</b>
          {fromQuote.customerName ? ` (${fromQuote.customerName})` : ""}. Los precios y el stock son los de hoy.
          Elige el cliente al cobrar.
        </div>
      )}

      {draft.restored && (
        <DraftBanner what="carrito" onKeep={draft.dismiss} onDiscard={discardDraft} />
      )}

      {heldSales.held.length > 0 && (
        <div className="mb-4 rounded-xl border border-slate-300 bg-white p-3 shadow-sm">
          <div className="mb-2 text-sm font-semibold text-slate-700">
            Ventas en espera ({heldSales.held.length})
            <span className="ml-2 font-normal text-slate-500">
              No descuentan stock; los precios y el stock se recalculan al retomarlas. Se descartan al cerrar sesión.
            </span>
          </div>
          <ul className="space-y-1">
            {heldSales.held.map((h) => {
              const units = h.cart.reduce((n, c) => n + (Number(c.quantity) || 0), 0);
              const hora = new Date(h.t).toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit" });
              return (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm">
                  <span>
                    <b>{hora}</b> · {h.cart.length} {h.cart.length === 1 ? "producto" : "productos"} · {units} u.
                    <span className="ml-2 text-slate-500">
                      {h.cart[0]?.name}{h.cart.length > 1 ? ` y ${h.cart.length - 1} más` : ""}
                      {h.fromQuote?.number ? ` · cotización ${h.fromQuote.number}` : ""}
                    </span>
                  </span>
                  <span className="space-x-4">
                    <button type="button" className="underline" onClick={() => resumeHeld(h)}>Retomar</button>
                    <button type="button" className="underline" onClick={() => heldSales.remove(h.id)}>Eliminar</button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!cashOpen && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-900">
          No tienes una caja abierta. <Link to="/caja" className="underline">Abrir caja</Link> para poder vender.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Carrito */}
        <div className="lg:col-span-2">
          <div className="relative mb-2">
            <input autoFocus ref={searchRef} className={`${input} w-full`} value={search}
              placeholder="Buscar producto (nombre, SKU) o escanear código de barras…"
              onChange={(e) => setSearch(e.target.value)} onKeyDown={onSearchKey} />
            {results.length > 0 && (
              <ul className="absolute z-10 mt-1 max-h-96 w-full overflow-y-auto rounded border bg-white shadow-lg">
                {results.map((p, i) => {
                  const noStock = p.trackStock && p.salesStock <= 0;
                  return (
                    <li key={p.id}>
                      <button type="button" onClick={() => add(p)} onMouseEnter={() => { setHi(i); setTouched(true); }}
                        className={`flex w-full items-center justify-between gap-3 p-2 text-left ${i === hi ? "bg-slate-100" : ""} ${noStock ? "opacity-60" : ""}`}>
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{p.name}</span>
                          <span className="block truncate text-xs text-slate-500">
                            <span className="font-mono">{p.sku}</span>
                            {p.barcode && ` · ${p.barcode}`}
                            {p.categoryName && ` · ${p.categoryName}`}
                          </span>
                        </span>
                        <span className="shrink-0 text-right text-sm">
                          <span className="block font-semibold">{formatMoney(p.priceMinor, p.priceCurrency)}</span>
                          {p.trackStock && (
                            <span className={`block text-xs ${noStock ? "text-red-600" : p.salesStock <= p.minStock ? "text-amber-600" : "text-slate-500"}`}>
                              {noStock ? "Sin stock" : `Stock: ${p.salesStock}`}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="mb-3 flex min-h-[1.75rem] flex-wrap items-center justify-between gap-2 text-sm">
            {notice ? (
              <span className={`rounded px-2 py-1 ${notice.type === "ok" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-700"}`}>
                {notice.text}
              </span>
            ) : (
              <span className="text-slate-500">Con un lector conectado, escanea y se agrega solo. Enter también agrega.</span>
            )}
            <label className="flex items-center gap-1 text-xs text-slate-500">
              <input type="checkbox" checked={sound} onChange={(e) => toggleSound(e.target.checked)} /> Sonido
            </label>
          </div>

          {cart.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <span>Descuento a todas las líneas:</span>
              <input className={`${input} w-20`} placeholder="%" value={allDisc}
                onChange={(e) => setAllDisc(e.target.value)} />
              <button type="button" onClick={applyAll} className="rounded border px-3 py-2">Aplicar</button>
              <button type="button" onClick={() => { setAllDisc(""); setCart((c) => c.map((x) => ({ ...x, discount: "" }))); }}
                className="underline">Quitar descuentos</button>
              {quote && quote.maxDiscountBp < 10000 && (
                <span className="text-xs text-slate-500">Máximo permitido: {quote.maxDiscountBp / 100} %</span>
              )}
            </div>
          )}

          {cart.length > 0 && (
            <div className="mb-1 text-sm font-medium text-slate-600">
              {cart.length} {cart.length === 1 ? "producto" : "productos"} · {cart.reduce((n, c) => n + c.quantity, 0)} unidades
            </div>
          )}
          <div className="overflow-x-auto rounded-xl bg-white shadow">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-slate-100">
                <tr><th className="p-3">Producto</th><th className="p-3">Cant.</th>
                  <th className="p-3">Precio</th><th className="p-3">Desc. %</th><th className="p-3">IVA</th>
                  <th className="p-3">Total</th><th className="p-3"></th></tr>
              </thead>
              <tbody>
                {cart.map((c) => {
                  const l = lineOf(c);
                  return (
                    <tr key={c.k} className={`border-b transition-colors duration-700 ${flash === c.k ? "bg-green-100" : ""}`}>
                      <td className="p-3">
                        <div className="font-medium">{c.name}</div>
                        <div className="text-xs text-slate-500">
                          <span className="font-mono">{c.sku}</span>
                          {c.usesLots && (c.lotId ? (
                            <button type="button" className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-slate-700 underline"
                              onClick={() => setPicker({ product: { id: c.productId, name: c.name }, lineKey: c.k })}>
                              Lote {c.lotLabel}
                            </button>
                          ) : (
                            <button type="button" className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800"
                              onClick={() => setPicker({ product: { id: c.productId, name: c.name }, lineKey: c.k })}>
                              Elegir lote
                            </button>
                          ))}
                          {c.stock != null && (
                            <span className={c.quantity > c.stock ? "ml-2 font-semibold text-red-600" : "ml-2"}>
                              {c.quantity > c.stock ? `Solo hay ${c.stock} en stock` : `stock ${c.stock}`}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-3">
                        <input className="w-16 rounded border p-1" inputMode="numeric"
                          value={c.quantity} onChange={(e) => setQty(c.k, e.target.value)} />
                      </td>
                      <td className="p-3">{l ? formatMoney(l.unitPriceMinor, currency) : "…"}</td>
                      <td className="p-3">
                        <input className="w-16 rounded border p-1" inputMode="decimal" placeholder="0"
                          value={c.discount} onChange={(e) => setDisc(c.k, e.target.value)} />
                      </td>
                      <td className="p-3">{l ? (l.taxRateBp === 0 ? "Exento" : `${l.taxRateBp / 100}%`) : "…"}</td>
                      <td className="p-3">
                        {l ? formatMoney(l.lineTotalMinor, currency) : "…"}
                        {l && l.discountMinor > 0 && (
                          <div className="text-xs text-green-700">
                            −{formatMoney(l.discountMinor, currency)} desc.
                            {l.promoBp > 0 && ` (incluye promo ${l.promoBp / 100}%)`}
                          </div>
                        )}
                      </td>
                      <td className="p-3 text-right">
                        <button onClick={() => removeLine(c.k)} className="underline">Quitar</button>
                      </td>
                    </tr>
                  );
                })}
                {cart.length === 0 && (
                  <tr><td colSpan={7} className="p-8 text-center text-slate-500">El carrito está vacío.<br />Escanea un código de barras o busca un producto para empezar.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {quoteError && <p className="mt-2 text-sm text-red-600">{quoteError}</p>}
        </div>

        {/* Resumen */}
        <div className="space-y-4">
          <div className="rounded-xl bg-white p-4 shadow">
            <h2 className="mb-2 font-semibold">Resumen</h2>
            {quote ? (
              <dl className="space-y-1 text-sm">
                {quote.discountMinor > 0 && (
                  <div className="flex justify-between text-green-700">
                    <dt>Descuentos otorgados</dt><dd>−{formatMoney(quote.discountMinor, currency)}</dd>
                  </div>
                )}
                <div className="flex justify-between"><dt>Base imponible</dt><dd>{formatMoney(quote.subtotalMinor, currency)}</dd></div>
                {quote.exemptMinor > 0 && (
                  <div className="flex justify-between"><dt>Exento</dt><dd>{formatMoney(quote.exemptMinor, currency)}</dd></div>
                )}
                <div className="flex justify-between"><dt>IVA</dt><dd>{formatMoney(quote.taxMinor, currency)}</dd></div>
                <div className="flex justify-between text-lg font-semibold"><dt>Total</dt><dd>{formatMoney(quote.totalMinor, currency)}</dd></div>
                {currency !== "VES" && (
                  <div className="flex justify-between text-slate-500"><dt>Equiv. en Bs.</dt><dd>{formatMoney(quote.totalVesMinor, "VES")}</dd></div>
                )}
                <p className="pt-1 text-xs text-slate-500">
                  El IGTF y el vuelto se calculan en el siguiente paso, según cómo pague el cliente.
                </p>
              </dl>
            ) : (
              <p className="text-sm text-slate-500">Agrega productos para ver el total.</p>
            )}
          </div>

          {zeroTotal && <p className="text-sm text-amber-700">El total es cero: revisa los descuentos.</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button onClick={() => setCheckout(true)} disabled={!quote || !cashOpen || zeroTotal}
            className="w-full rounded bg-green-700 p-3 text-lg text-white disabled:opacity-50">
            Cobrar
          </button>
          <button type="button" onClick={holdCurrent} disabled={cart.length === 0}
            className="w-full rounded border p-2 text-slate-700 disabled:opacity-50">
            Poner en espera
          </button>
        </div>
      </div>

      {checkout && quote && (
        <CheckoutModal
          quote={quote}
          currency={currency}
          items={apiItems}
          priceListId={priceListId ? Number(priceListId) : null}
          onClose={() => setCheckout(false)}
          onDone={onDone}
        />
      )}
      {ticketId && <Ticket id={ticketId} onClose={() => setTicketId(null)} />}
      {picker && <LotPickerModal product={picker.product} onPick={onPickLot} onClose={() => setPicker(null)} />}
    </div>
  );
}