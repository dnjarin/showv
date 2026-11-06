import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../store/authStore";
import { catalogApi, lotsApi, warehousesApi } from "../services/api";
import { formatMoney, fromMinor, toMinor } from "../utils/money";

const EMPTY = {
  sku: "", barcode: "", name: "", categoryId: "", taxRateId: "",
  cost: "0.00", price: "", priceCurrency: "USD",
  trackStock: true, minStock: "0", initialStock: "0", warehouseId: "",
};

function ProductForm({ product, options, warehouses, onCategoriesChanged, onSaved, onCancel, onLotsChanged }) {
  const [form, setForm] = useState(
    product
      ? {
          sku: product.sku, barcode: product.barcode ?? "", name: product.name,
          categoryId: product.categoryId ?? "", taxRateId: product.taxRateId,
          cost: fromMinor(product.costMinor), price: fromMinor(product.priceMinor),
          priceCurrency: product.priceCurrency, trackStock: product.trackStock,
          minStock: String(product.minStock), initialStock: "0", warehouseId: "",
        }
      : {
          ...EMPTY,
          taxRateId: options.taxRates[0]?.id ?? "",
          warehouseId: warehouses.find((w) => w.isSales)?.id ?? "",
        }
  );
  const [newCat, setNewCat] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [usesLots, setUsesLots] = useState(!!product?.usesLots);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const addCategory = async () => {
    const name = newCat.trim();
    if (!name) return;
    setError(""); setNote("");
    try {
      const c = await catalogApi.createCategory(name);
      await onCategoriesChanged(); // el padre recarga la lista, así no queda desactualizada
      set("categoryId", c.id);
      setNewCat("");
      setNote(c.existed ? `«${c.name}» ya existía: la seleccioné.` : `Categoría «${c.name}» creada.`);
    } catch (e) { setError(e.message); }
  };

  const toggleLots = async () => {
    setError(""); setNote("");
    try {
      await lotsApi.setProduct(product.id, !usesLots);
      setUsesLots(!usesLots);
      setNote(!usesLots
        ? "Control de lotes activado: la existencia actual quedó en el lote «INICIAL»."
        : "Control de lotes desactivado.");
      onLotsChanged?.();
    } catch (e) { setError(e.message); }
  };

  const submit = async (e) => {
    e.preventDefault();
    const cost = toMinor(form.cost);
    const price = toMinor(form.price);
    if (!form.sku.trim() || !form.name.trim()) return setError("SKU y nombre son obligatorios");
    if (cost === null || price === null) return setError("Montos inválidos (ejemplo: 12.50)");
    if (!form.taxRateId) return setError("Selecciona el impuesto");

    const input = {
      sku: form.sku, barcode: form.barcode.trim() || null, name: form.name,
      categoryId: form.categoryId ? Number(form.categoryId) : null,
      taxRateId: Number(form.taxRateId),
      costMinor: cost, priceMinor: price, priceCurrency: form.priceCurrency,
      trackStock: form.trackStock,
      minStock: parseInt(form.minStock, 10) || 0,
      initialStock: product ? null : parseInt(form.initialStock, 10) || 0,
      warehouseId: !product && form.warehouseId ? Number(form.warehouseId) : null,
    };
    setBusy(true);
    setError("");
    try {
      product ? await catalogApi.updateProduct(product.id, input)
              : await catalogApi.createProduct(input);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full rounded border p-2";
  return (
    <form onSubmit={submit} className="mb-6 grid grid-cols-2 gap-3 rounded-xl bg-white p-4 shadow">
      <h2 className="col-span-2 font-semibold">{product ? "Editar producto" : "Nuevo producto"}</h2>
      <input className={input} placeholder="SKU *" value={form.sku} onChange={(e) => set("sku", e.target.value)} />
      <input className={input} placeholder="Código de barras" value={form.barcode} onChange={(e) => set("barcode", e.target.value)} />
      <input className={`${input} col-span-2`} placeholder="Nombre *" value={form.name} onChange={(e) => set("name", e.target.value)} />

      <select className={input} value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
        <option value="">Sin categoría</option>
        {options.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <div className="flex gap-2">
        <input className={input} placeholder="Nueva categoría" value={newCat}
          onChange={(e) => setNewCat(e.target.value)}
          onKeyDown={(e) => {
            // Enter crea la categoría; no debe enviar el formulario del producto
            if (e.key === "Enter") { e.preventDefault(); addCategory(); }
          }} />
        <button type="button" onClick={addCategory} className="rounded border px-3">+</button>
      </div>
      {note && <p className="col-span-2 text-sm text-green-700">{note}</p>}

      <select className={input} value={form.taxRateId} onChange={(e) => set("taxRateId", e.target.value)}>
        {options.taxRates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.rateBp / 100}%)</option>)}
      </select>
      <select className={input} value={form.priceCurrency} onChange={(e) => set("priceCurrency", e.target.value)}>
        {options.currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
      </select>

      <input className={input} placeholder="Costo" value={form.cost} onChange={(e) => set("cost", e.target.value)} />
      <input className={input} placeholder="Precio *" value={form.price} onChange={(e) => set("price", e.target.value)} />

      <label className="col-span-2 flex items-center gap-2">
        <input type="checkbox" checked={form.trackStock} onChange={(e) => set("trackStock", e.target.checked)} />
        Controlar inventario de este producto
      </label>
      {product && form.trackStock && (
        <div className="col-span-2 rounded border bg-slate-50 p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span>
              <b>Control por lotes:</b> {usesLots ? "activado" : "desactivado"}
              <span className="block text-xs text-slate-500">
                Opcional. Con lotes, cada compra crea un lote con su propio costo y al vender se elige de cuál sale.
              </span>
            </span>
            <button type="button" onClick={toggleLots} className="shrink-0 rounded border px-3 py-1">
              {usesLots ? "Desactivar" : "Activar"}
            </button>
          </div>
        </div>
      )}
      {form.trackStock && (
        <>
          <input className={input} placeholder="Stock mínimo (total)" value={form.minStock} onChange={(e) => set("minStock", e.target.value)} />
          {!product && (
            <input className={input} placeholder="Stock inicial" value={form.initialStock} onChange={(e) => set("initialStock", e.target.value)} />
          )}
          {!product && warehouses.length > 1 && (
            <label className="col-span-2 text-sm">Almacén del stock inicial
              <select className={`${input} mt-1`} value={form.warehouseId} onChange={(e) => set("warehouseId", e.target.value)}>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}{w.isSales ? " (ventas)" : ""}</option>)}
              </select>
            </label>
          )}
        </>
      )}

      {error && <p className="col-span-2 text-sm text-red-600">{error}</p>}
      <div className="col-span-2 flex gap-2">
        <button disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
          {busy ? "Guardando…" : "Guardar"}
        </button>
        <button type="button" onClick={onCancel} className="rounded border px-4 py-2">Cancelar</button>
      </div>
    </form>
  );
}

export default function Products({ embedded = false }) {
  const user = useAuth((s) => s.user);
  const canManage = ["admin", "almacen"].includes(user.role);

  const [items, setItems] = useState([]);
  const [options, setOptions] = useState(null);
  const [warehouses, setWarehouses] = useState([]);
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [lowOnly, setLowOnly] = useState(false);
  const [editing, setEditing] = useState(null); // null | "new" | producto
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setItems(await catalogApi.listProducts(
        search.trim() || null, showInactive, lowOnly, categoryId ? Number(categoryId) : null));
    } catch (e) { setError(e.message); }
  }, [search, showInactive, lowOnly, categoryId]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const reloadOptions = useCallback(async () => {
    try { setOptions(await catalogApi.options()); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => {
    reloadOptions();
    if (canManage) warehousesApi.list(false).then(setWarehouses).catch(() => {});
  }, [reloadOptions, canManage]);

  const toggle = async (p) => {
    try { await catalogApi.setActive(p.id, !p.active); load(); }
    catch (e) { setError(e.message); }
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        {embedded ? <span /> : <h1 className="text-2xl font-semibold">Productos</h1>}
        {canManage && options && !editing && (
          <button onClick={() => setEditing("new")} className="rounded bg-slate-900 px-4 py-2 text-white">
            Nuevo producto
          </button>
        )}
      </div>

      {editing && options && (
        <ProductForm
          key={editing === "new" ? "new" : editing.id}
          product={editing === "new" ? null : editing}
          options={options}
          warehouses={warehouses}
          onCategoriesChanged={reloadOptions}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
          onLotsChanged={load}
        />
      )}

      <div className="mb-3 flex flex-wrap items-center gap-4">
        <input className="w-72 rounded border p-2" placeholder="Buscar por nombre, SKU o código de barras"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="rounded border p-2" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Todas las categorías</option>
          {options?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
          Solo stock bajo
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Mostrar inactivos
        </label>
      </div>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr>
              <th className="p-3">SKU</th><th className="p-3">Nombre</th><th className="p-3">Categoría</th>
              <th className="p-3">Precio</th><th className="p-3">Stock total</th><th className="p-3">Estado</th>
              {canManage && <th className="p-3"></th>}
            </tr>
          </thead>
          <tbody>
            {items.map((p) => {
              const low = p.trackStock && p.stock <= p.minStock;
              return (
                <tr key={p.id} className={`border-b ${p.active ? "" : "opacity-50"}`}>
                  <td className="p-3 font-mono">{p.sku}</td>
                  <td className="p-3">{p.name}{p.usesLots && <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">Lotes</span>}</td>
                  <td className="p-3">{p.categoryName ?? "—"}</td>
                  <td className="p-3">{formatMoney(p.priceMinor, p.priceCurrency)}</td>
                  <td className={`p-3 ${low ? "font-semibold text-red-600" : ""}`}>
                    {p.trackStock ? p.stock : "—"}{low && " ⚠"}
                    {p.trackStock && p.salesStock !== p.stock && (
                      <div className="text-xs font-normal text-slate-500">En ventas: {p.salesStock}</div>
                    )}
                  </td>
                  <td className="p-3">{p.active ? "Activo" : "Inactivo"}</td>
                  {canManage && (
                    <td className="space-x-2 p-3 text-right">
                      <button onClick={() => setEditing(p)} className="underline">Editar</button>
                      <button onClick={() => toggle(p)} className="underline">
                        {p.active ? "Desactivar" : "Activar"}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
            {items.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-slate-500">Sin resultados</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}