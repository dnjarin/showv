import { useCallback, useEffect, useState } from "react";
import { catalogApi, pricingApi } from "../services/api";
import { formatMoney, toMinor } from "../utils/money";
import { todayStr } from "../utils/dates";
import { TabBar } from "../components/Tabs";

/** "-15" o "7,5" -> -1500 / 750 (puntos base). Inválido -> null. */
const pctToBp = (s, min, max) => {
  const v = Number(String(s ?? "").trim().replace(",", "."));
  if (String(s ?? "").trim() === "" || !Number.isFinite(v) || v < min || v > max) return null;
  return Math.round(v * 100);
};
const bpToPct = (bp) => String(bp / 100).replace(".", ",");
const fmtDate = (s) => s.split("-").reverse().join("/");
const STATE = {
  vigente: "bg-green-100 text-green-800", programada: "bg-blue-100 text-blue-800",
  vencida: "bg-slate-200 text-slate-600", inactiva: "bg-slate-200 text-slate-600",
};
const input = "rounded border p-2";

function ProductSearch({ onPick }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState([]);
  useEffect(() => {
    const t = q.trim();
    if (!t) { setRes([]); return; }
    const h = setTimeout(() => catalogApi.listProducts(t, false, false).then((r) => setRes(r.slice(0, 8))).catch(() => {}), 200);
    return () => clearTimeout(h);
  }, [q]);
  return (
    <div className="relative">
      <input className={`${input} w-full`} placeholder="Buscar producto por nombre o SKU…" value={q} onChange={(e) => setQ(e.target.value)} />
      {res.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full rounded border bg-white shadow">
          {res.map((p) => (
            <li key={p.id}>
              <button type="button" className="flex w-full justify-between p-2 text-left hover:bg-slate-100"
                onClick={() => { onPick(p); setQ(""); setRes([]); }}>
                <span>{p.sku} · {p.name}</span>
                <span className="text-sm text-slate-500">{formatMoney(p.priceMinor, p.priceCurrency)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Lists() {
  const [lists, setLists] = useState([]);
  const [form, setForm] = useState({ id: null, name: "", adjust: "0", cashierCanUse: true, active: true });
  const [sel, setSel] = useState(null);
  const [items, setItems] = useState([]);
  const [pick, setPick] = useState(null);
  const [price, setPrice] = useState("");
  const [cur, setCur] = useState("USD");
  const [error, setError] = useState("");
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const load = useCallback(async () => {
    try { setLists(await pricingApi.lists()); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const loadItems = useCallback(async (id) => {
    try { setItems(await pricingApi.items(id)); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { if (sel) loadItems(sel.id); else setItems([]); }, [sel, loadItems]);

  const save = async (e) => {
    e.preventDefault(); setError("");
    const bp = pctToBp(form.adjust, -90, 100);
    if (bp === null) return setError("El ajuste debe estar entre -90 y 100 (%)");
    try {
      const id = await pricingApi.saveList({
        id: form.id, name: form.name, adjustBp: bp, cashierCanUse: form.cashierCanUse, active: form.active,
      });
      setForm({ id: null, name: "", adjust: "0", cashierCanUse: true, active: true });
      await load();
      if (!form.id) setSel({ id, name: form.name });
    } catch (e2) { setError(e2.message); }
  };

  const edit = (l) => setForm({ id: l.id, name: l.name, adjust: bpToPct(l.adjustBp), cashierCanUse: l.cashierCanUse, active: l.active });

  const addItem = async () => {
    setError("");
    const m = toMinor(price);
    if (!pick) return setError("Elige un producto");
    if (m === null) return setError("Precio inválido (ejemplo: 12.50)");
    try {
      await pricingApi.setItem(sel.id, pick.id, m, cur);
      setPick(null); setPrice("");
      loadItems(sel.id); load();
    } catch (e) { setError(e.message); }
  };
  const removeItem = async (pid) => {
    try { await pricingApi.removeItem(sel.id, pid); loadItems(sel.id); load(); } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-6">
      {error && <p className="rounded bg-red-50 p-3 text-red-700">{error}</p>}
      <p className="text-sm text-slate-600">
        Una lista aplica un porcentaje sobre el precio base (por ejemplo −15 para mayorista) y, además, puedes fijar
        precios específicos por producto. En «Nueva venta» se elige la lista; los cajeros solo ven las marcadas para ellos.
      </p>
      <form onSubmit={save} className="flex flex-wrap items-end gap-3 rounded-xl border bg-white p-4">
        <label className="text-sm">Nombre
          <input className={`${input} block`} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Mayorista" />
        </label>
        <label className="text-sm">Ajuste vs. precio base (%)
          <input className={`${input} block w-32`} value={form.adjust} onChange={(e) => set("adjust", e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.cashierCanUse} onChange={(e) => set("cashierCanUse", e.target.checked)} /> Disponible para cajeros
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} /> Activa
        </label>
        <button className="rounded bg-slate-900 px-4 py-2 text-white">{form.id ? "Guardar cambios" : "Crear lista"}</button>
        {form.id && <button type="button" className="underline" onClick={() => setForm({ id: null, name: "", adjust: "0", cashierCanUse: true, active: true })}>Cancelar</button>}
      </form>

      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Lista</th><th className="p-3">Ajuste</th><th className="p-3">Precios propios</th><th className="p-3">Cajeros</th><th className="p-3">Estado</th><th className="p-3" /></tr>
          </thead>
          <tbody>
            {lists.map((l) => (
              <tr key={l.id} className={`border-b ${sel?.id === l.id ? "bg-slate-50" : ""} ${l.active ? "" : "opacity-60"}`}>
                <td className="p-3 font-medium">{l.name}</td>
                <td className="p-3">{l.adjustBp > 0 ? "+" : ""}{bpToPct(l.adjustBp)} %</td>
                <td className="p-3">{l.items}</td>
                <td className="p-3">{l.cashierCanUse ? "Sí" : "Solo admin"}</td>
                <td className="p-3">{l.active ? "Activa" : "Inactiva"}</td>
                <td className="space-x-3 p-3 text-right">
                  <button className="underline" onClick={() => setSel(l)}>Precios</button>
                  <button className="underline" onClick={() => edit(l)}>Editar</button>
                </td>
              </tr>
            ))}
            {lists.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-500">Aún no hay listas</td></tr>}
          </tbody>
        </table>
      </div>

      {sel && (
        <div className="rounded-xl border bg-white p-4">
          <h3 className="mb-2 font-semibold">Precios específicos · {sel.name}</h3>
          <div className="mb-3 grid gap-2 md:grid-cols-[1fr_auto_auto_auto]">
            <div>
              <ProductSearch onPick={setPick} />
              {pick && <div className="mt-1 text-sm text-slate-600">{pick.sku} · {pick.name} (base {formatMoney(pick.priceMinor, pick.priceCurrency)})</div>}
            </div>
            <input className={`${input} w-28`} placeholder="Precio" value={price} onChange={(e) => setPrice(e.target.value)} />
            <select className={input} value={cur} onChange={(e) => setCur(e.target.value)}><option>USD</option><option>VES</option></select>
            <button onClick={addItem} className="rounded border px-4 py-2">Fijar precio</button>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-slate-100"><tr><th className="p-2">Producto</th><th className="p-2">Base</th><th className="p-2">En esta lista</th><th className="p-2" /></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.productId} className="border-b">
                  <td className="p-2">{i.sku} · {i.name}</td>
                  <td className="p-2">{formatMoney(i.baseMinor, i.baseCurrency)}</td>
                  <td className="p-2 font-semibold">{formatMoney(i.priceMinor, i.currencyCode)}</td>
                  <td className="p-2 text-right"><button className="underline" onClick={() => removeItem(i.productId)}>Quitar</button></td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={4} className="p-4 text-center text-slate-500">Sin precios propios: se usa el ajuste porcentual</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Promos() {
  const [rows, setRows] = useState([]);
  const [cats, setCats] = useState([]);
  const [f, setF] = useState({ name: "", scope: "product", categoryId: "", percent: "", from: todayStr(), to: todayStr() });
  const [pick, setPick] = useState(null);
  const [error, setError] = useState("");
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  const load = useCallback(async () => {
    try { setRows(await pricingApi.promos()); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => {
    load();
    catalogApi.options().then((o) => setCats(o.categories)).catch(() => {});
  }, [load]);

  const save = async (e) => {
    e.preventDefault(); setError("");
    const bp = pctToBp(f.percent, 0.01, 90);
    if (bp === null) return setError("El descuento debe estar entre 0,01 y 90 (%)");
    try {
      await pricingApi.savePromo({
        name: f.name, scope: f.scope,
        productId: f.scope === "product" ? pick?.id ?? null : null,
        categoryId: f.scope === "category" && f.categoryId ? Number(f.categoryId) : null,
        percentBp: bp, startsOn: f.from, endsOn: f.to,
      });
      setF({ name: "", scope: "product", categoryId: "", percent: "", from: todayStr(), to: todayStr() });
      setPick(null); load();
    } catch (e2) { setError(e2.message); }
  };

  const toggle = async (r) => {
    try { await pricingApi.setPromoActive(r.id, !r.active); load(); } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-6">
      {error && <p className="rounded bg-red-50 p-3 text-red-700">{error}</p>}
      <p className="text-sm text-slate-600">
        Las promociones vigentes se aplican solas en la venta como descuento de línea. Si un producto tiene varias,
        gana la mayor (no se acumulan); el descuento manual del cajero se suma sobre la promoción.
      </p>
      <form onSubmit={save} className="space-y-3 rounded-xl border bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">Nombre
            <input className={`${input} block`} value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Semana del cliente" />
          </label>
          <label className="text-sm">Aplica a
            <select className={`${input} block`} value={f.scope} onChange={(e) => set("scope", e.target.value)}>
              <option value="product">Un producto</option><option value="category">Una categoría</option><option value="all">Todo el catálogo</option>
            </select>
          </label>
          <label className="text-sm">Descuento (%)
            <input className={`${input} block w-24`} value={f.percent} onChange={(e) => set("percent", e.target.value)} />
          </label>
          <label className="text-sm">Desde
            <input type="date" className={`${input} block`} value={f.from} onChange={(e) => set("from", e.target.value)} />
          </label>
          <label className="text-sm">Hasta
            <input type="date" className={`${input} block`} value={f.to} onChange={(e) => set("to", e.target.value)} />
          </label>
          <button className="rounded bg-slate-900 px-4 py-2 text-white">Crear promoción</button>
        </div>
        {f.scope === "product" && (
          <div className="max-w-md">
            <ProductSearch onPick={setPick} />
            {pick && <div className="mt-1 text-sm text-slate-600">Producto: {pick.sku} · {pick.name}</div>}
          </div>
        )}
        {f.scope === "category" && (
          <select className={input} value={f.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
            <option value="">Elige la categoría…</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </form>

      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Promoción</th><th className="p-3">Aplica a</th><th className="p-3">Descuento</th><th className="p-3">Vigencia</th><th className="p-3">Estado</th><th className="p-3" /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b">
                <td className="p-3 font-medium">{r.name}</td>
                <td className="p-3">{r.target}</td>
                <td className="p-3">{bpToPct(r.percentBp)} %</td>
                <td className="p-3">{fmtDate(r.startsOn)} – {fmtDate(r.endsOn)}</td>
                <td className="p-3"><span className={`rounded px-2 py-0.5 text-xs ${STATE[r.state]}`}>{r.state}</span></td>
                <td className="p-3 text-right"><button className="underline" onClick={() => toggle(r)}>{r.active ? "Desactivar" : "Activar"}</button></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-500">Sin promociones</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Pricing() {
  const [tab, setTab] = useState("lists");
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Listas de precios y promociones</h1>
      <TabBar tabs={[["lists", "Listas de precios"], ["promos", "Promociones"]]} value={tab} onChange={setTab} />
      {tab === "lists" ? <Lists /> : <Promos />}
    </div>
  );
}
