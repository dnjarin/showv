import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { catalogApi, labelsApi } from "../services/api";
import LabelView from "../components/labels/LabelView";
import { encode } from "../utils/barcode";

const ROLLS = {
  "30x20": [30, 20], "40x25": [40, 25], "50x30": [50, 30], "60x40": [60, 40], "100x50": [100, 50],
};
const SHEETS = {
  "5160": { label: "30 por hoja (3 × 10) · 66,7 × 25,4 mm", cols: "3", rows: "10", sw: "66.7", sh: "25.4", mt: "12.7", ml: "4.8", gx: "3.2", gy: "0" },
  "5163": { label: "10 por hoja (2 × 5) · 101,6 × 50,8 mm", cols: "2", rows: "5", sw: "101.6", sh: "50.8", mt: "12.7", ml: "3.8", gx: "3.2", gy: "0" },
  "custom": { label: "Personalizada" },
};
const PAPER = { letter: [215.9, 279.4, "Carta"], a4: [210, 297, "A4"] };
const MAX_LABELS = 2000;

const DEFAULT_CFG = {
  mode: "roll", roll: "50x30", w: "50", h: "30",
  sheet: "5160", cols: "3", rows: "10", sw: "66.7", sh: "25.4", mt: "12.7", ml: "4.8", gx: "3.2", gy: "0",
  paper: "letter", skip: "0",
  show: { biz: true, name: true, sku: true, usd: true, ves: false, code: true },
  includeTax: true,
};

const num = (s, def, min = 0.1, max = 400) => {
  const v = Number(String(s).replace(",", "."));
  return Number.isFinite(v) && v >= min && v <= max ? v : def;
};

function loadCfg() {
  try {
    const c = JSON.parse(localStorage.getItem("label-config"));
    if (c && typeof c === "object") return { ...DEFAULT_CFG, ...c, show: { ...DEFAULT_CFG.show, ...(c.show || {}) } };
  } catch { /* sin config guardada */ }
  return DEFAULT_CFG;
}

export default function Labels({ embedded = false }) {
  const [cfg, setCfg] = useState(loadCfg);
  const [ctx, setCtx] = useState(null);
  const [items, setItems] = useState([]); // [{ p, copies }]
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [categories, setCategories] = useState([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printKey, setPrintKey] = useState(0);
  const teardownRef = useRef(null);

  useEffect(() => {
    try { localStorage.setItem("label-config", JSON.stringify(cfg)); } catch { /* sin almacenamiento */ }
  }, [cfg]);
  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));
  const setShow = (k, v) => setCfg((c) => ({ ...c, show: { ...c.show, [k]: v } }));

  const loadCtx = useCallback(() => labelsApi.context().then(setCtx).catch((e) => setError(e.message)), []);
  useEffect(() => {
    loadCtx();
    catalogApi.options().then((o) => setCategories(o.categories)).catch(() => {});
  }, [loadCtx]);

  useEffect(() => {
    const q = search.trim();
    if (!q) { setResults([]); return; }
    const t = setTimeout(() => {
      catalogApi.listProducts(q, false, false).then((r) => setResults(r.slice(0, 8))).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [search]);

  // ---- lista a imprimir
  const addProducts = (ps) => {
    setItems((cur) => {
      const have = new Set(cur.map((i) => i.p.id));
      const fresh = ps.filter((p) => !have.has(p.id)).map((p) => ({ p, copies: "1" }));
      return [...cur, ...fresh];
    });
  };
  const addOne = (p) => { addProducts([p]); setSearch(""); setResults([]); setMsg(""); };
  const addCategory = async (id) => {
    if (!id) return;
    setError("");
    try { const r = await catalogApi.listProducts(null, false, false, Number(id)); addProducts(r); setMsg(`${r.length} productos agregados`); }
    catch (e) { setError(e.message); }
  };
  const addWithoutCode = async () => {
    setError("");
    try {
      const r = (await catalogApi.listProducts(null, false, false)).filter((p) => !p.barcode);
      addProducts(r); setMsg(`${r.length} productos sin código agregados`);
    } catch (e) { setError(e.message); }
  };
  const addAll = async () => {
    setError("");
    try { const r = await catalogApi.listProducts(null, false, false); addProducts(r); setMsg(`${r.length} productos agregados`); }
    catch (e) { setError(e.message); }
  };
  const setCopies = (id, v) => setItems((cur) => cur.map((i) => (i.p.id === id ? { ...i, copies: v } : i)));
  const remove = (id) => setItems((cur) => cur.filter((i) => i.p.id !== id));
  const copiesFromStock = () =>
    setItems((cur) => cur.map((i) => ({ ...i, copies: String(i.p.trackStock ? Math.max(i.p.stock, 1) : 1) })));
  const copiesOf = (i) => Math.min(500, Math.max(0, parseInt(i.copies, 10) || 0));

  const assign = async (onlyList) => {
    const ids = onlyList ? items.filter((i) => !i.p.barcode).map((i) => i.p.id) : null;
    const n = onlyList ? ids.length : ctx?.withoutBarcode ?? 0;
    if (n === 0) return;
    if (!window.confirm(
      `Se asignarán ${n} códigos EAN-13 internos (prefijo 200) a productos que no tienen código.\n` +
      "Podrás escanearlos en caja. ¿Continuar?")) return;
    setBusy(true); setError(""); setMsg("");
    try {
      const r = await labelsApi.assign(ids);
      const byId = new Map(r.items.map((x) => [x.id, x.barcode]));
      setItems((cur) => cur.map((i) => (byId.has(i.p.id) ? { ...i, p: { ...i.p, barcode: byId.get(i.p.id) } } : i)));
      setMsg(`${r.assigned} códigos asignados`);
      loadCtx();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  // ---- etiquetas
  const geom = useMemo(() => {
    const roll = cfg.mode === "roll";
    const [pw, ph] = PAPER[cfg.paper] ?? PAPER.letter;
    return roll
      ? { roll, w: num(cfg.w, 50, 15, 200), h: num(cfg.h, 30, 10, 200) }
      : {
        roll, pw, ph, w: num(cfg.sw, 66.7, 15, 200), h: num(cfg.sh, 25.4, 10, 200),
        cols: Math.round(num(cfg.cols, 3, 1, 8)), rows: Math.round(num(cfg.rows, 10, 1, 30)),
        mt: num(cfg.mt, 0, 0, 60), ml: num(cfg.ml, 0, 0, 60), gx: num(cfg.gx, 0, 0, 30), gy: num(cfg.gy, 0, 0, 30),
        skip: Math.round(num(cfg.skip, 0, 0, 500)),
      };
  }, [cfg]);

  const labels = useMemo(() => items.flatMap((i) => Array(copiesOf(i)).fill(i.p)), [items]);
  const total = labels.length;
  const tooMany = total > MAX_LABELS;
  const perPage = geom.roll ? 1 : geom.cols * geom.rows;
  const pages = geom.roll ? total : Math.ceil((total + geom.skip) / perPage);
  const noScan = items.filter((i) => !i.p.barcode).length;
  const invalid = items.filter((i) => !encode(i.p.barcode || i.p.sku)).length;

  const sheetPages = (list) => {
    const slots = [...Array(geom.skip).fill(null), ...list];
    const out = [];
    for (let i = 0; i < slots.length; i += perPage) out.push(slots.slice(i, i + perPage));
    return out;
  };

  const renderSheetPage = (slots, key, zoom) => (
    <div key={key} className="label-page" style={{
      width: `${geom.pw}mm`, height: `${geom.ph - 0.5}mm`, boxSizing: "border-box", overflow: "hidden", background: "#fff",
      paddingTop: `${geom.mt}mm`, paddingLeft: `${geom.ml}mm`, display: "grid",
      gridTemplateColumns: `repeat(${geom.cols}, ${geom.w}mm)`, gridAutoRows: `${geom.h}mm`,
      columnGap: `${geom.gx}mm`, rowGap: `${geom.gy}mm`, alignContent: "start", zoom,
    }}>
      {slots.map((p, i) => (p ? <LabelView key={i} p={p} cfg={cfg} ctx={ctx} w={geom.w} h={geom.h} /> : <div key={i} />))}
    </div>
  );

  // ---- impresión
  const doPrint = () => {
    setError("");
    if (total === 0) return setError("Agrega productos a la lista");
    if (tooMany) return setError(`Máximo ${MAX_LABELS} etiquetas por impresión`);
    if (invalid > 0) return setError("Hay productos con un código que no se puede dibujar. Revisa los marcados en rojo.");
    setPrinting(true);
    setPrintKey((k) => k + 1);
  };
  useEffect(() => {
    if (!printKey) return undefined;
    teardownRef.current?.();
    const size = geom.roll ? `${geom.w}mm ${geom.h}mm` : `${geom.pw}mm ${geom.ph}mm`;
    const style = document.createElement("style");
    style.textContent = `@page { size: ${size}; margin: 0; }`;
    document.head.appendChild(style);
    document.body.classList.add("printing-labels");
    const teardown = () => {
      style.remove();
      document.body.classList.remove("printing-labels");
      window.removeEventListener("afterprint", done);
      teardownRef.current = null;
    };
    const done = () => { teardown(); setPrinting(false); };
    teardownRef.current = teardown;
    window.addEventListener("afterprint", done);
    const t = setTimeout(() => window.print(), 200);
    return () => { clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printKey]);
  useEffect(() => () => teardownRef.current?.(), []);

  const input = "rounded border p-2";
  const small = "w-20 rounded border p-1";

  return (
    <div>
      {!embedded && <h1 className="mb-4 text-2xl font-semibold">Etiquetas y códigos de barras</h1>}
      {error && <p className="mb-3 rounded bg-red-50 p-3 text-red-700">{error}</p>}
      {msg && <p className="mb-3 rounded bg-green-50 p-3 text-green-800">{msg}</p>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {/* Agregar productos */}
          <div className="mb-4 rounded-xl bg-white p-4 shadow">
            <h2 className="mb-2 font-semibold">1. Productos</h2>
            <div className="relative mb-3">
              <input className={`${input} w-full`} placeholder="Buscar producto por nombre, SKU o código…"
                value={search} onChange={(e) => setSearch(e.target.value)} />
              {results.length > 0 && (
                <ul className="absolute z-10 mt-1 w-full rounded border bg-white shadow">
                  {results.map((p) => (
                    <li key={p.id}>
                      <button type="button" onClick={() => addOne(p)} className="flex w-full justify-between p-2 text-left hover:bg-slate-100">
                        <span>{p.sku} · {p.name}</span>
                        <span className="text-sm text-slate-500">{p.barcode || "sin código"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <select className={input} value="" onChange={(e) => addCategory(e.target.value)}>
                <option value="">Agregar una categoría…</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button type="button" className="underline" onClick={addWithoutCode}>Agregar los que no tienen código</button>
              <button type="button" className="underline" onClick={addAll}>Agregar todos</button>
              {items.length > 0 && (
                <>
                  <button type="button" className="underline" onClick={copiesFromStock}>Copias = existencias</button>
                  <button type="button" className="underline" onClick={() => { setItems([]); setMsg(""); }}>Vaciar lista</button>
                </>
              )}
            </div>
          </div>

          {/* Lista */}
          <div className="mb-4 overflow-x-auto rounded-xl bg-white shadow">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-slate-100">
                <tr><th className="p-3">Producto</th><th className="p-3">Código</th><th className="p-3">Copias</th><th className="p-3" /></tr>
              </thead>
              <tbody>
                {items.map((i) => {
                  const bad = !encode(i.p.barcode || i.p.sku);
                  return (
                    <tr key={i.p.id} className="border-b">
                      <td className="p-3">{i.p.sku} · {i.p.name}</td>
                      <td className={`p-3 font-mono text-xs ${bad ? "text-red-600" : i.p.barcode ? "" : "text-amber-700"}`}>
                        {bad ? "no válido" : i.p.barcode || `${i.p.sku} (SKU)`}
                      </td>
                      <td className="p-3">
                        <input type="number" min="0" max="500" className={small} value={i.copies}
                          onChange={(e) => setCopies(i.p.id, e.target.value)} />
                      </td>
                      <td className="p-3 text-right"><button className="underline" onClick={() => remove(i.p.id)}>Quitar</button></td>
                    </tr>
                  );
                })}
                {items.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-slate-500">Agrega los productos cuyas etiquetas quieres imprimir</td></tr>}
              </tbody>
            </table>
          </div>

          {/* Códigos internos */}
          <div className="mb-4 rounded-xl bg-white p-4 shadow">
            <h2 className="mb-2 font-semibold">Códigos de barras internos</h2>
            <p className="mb-3 text-sm text-slate-600">
              Los productos que no traen código de fábrica pueden recibir uno propio (EAN-13, prefijo 200, que no choca con códigos comerciales).
              Una vez asignado, se guarda en el producto y el lector lo reconoce en Nueva venta.
            </p>
            <div className="flex flex-wrap gap-3">
              <button disabled={busy || !ctx?.withoutBarcode} onClick={() => assign(false)}
                className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
                Asignar a todos los que no tienen ({ctx?.withoutBarcode ?? "…"})
              </button>
              {noScan > 0 && (
                <button disabled={busy} onClick={() => assign(true)} className="rounded border px-4 py-2 disabled:opacity-50">
                  Asignar solo a la lista ({noScan})
                </button>
              )}
            </div>
            {noScan > 0 && (
              <p className="mt-2 text-sm text-amber-700">
                {noScan} producto(s) de la lista no tienen código: se imprimirá su SKU (también se puede escanear en caja si lo registras tal cual).
              </p>
            )}
          </div>
        </div>

        {/* Configuración y vista previa */}
        <div>
          <div className="mb-4 rounded-xl bg-white p-4 shadow">
            <h2 className="mb-2 font-semibold">2. Formato</h2>
            <div className="mb-3 flex gap-4 text-sm">
              <label><input type="radio" checked={cfg.mode === "roll"} onChange={() => set({ mode: "roll" })} /> Rollo (térmica)</label>
              <label><input type="radio" checked={cfg.mode === "sheet"} onChange={() => set({ mode: "sheet" })} /> Hoja de etiquetas</label>
            </div>

            {cfg.mode === "roll" ? (
              <div className="space-y-2 text-sm">
                <label className="block">Tamaño{" "}
                  <select className={input} value={ROLLS[cfg.roll] ? cfg.roll : "custom"}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (ROLLS[v]) set({ roll: v, w: String(ROLLS[v][0]), h: String(ROLLS[v][1]) }); else set({ roll: "custom" });
                    }}>
                    {Object.keys(ROLLS).map((k) => <option key={k} value={k}>{k.replace("x", " × ")} mm</option>)}
                    <option value="custom">Personalizado</option>
                  </select>
                </label>
                <div className="flex items-center gap-2">
                  Ancho <input className={small} value={cfg.w} onChange={(e) => set({ w: e.target.value, roll: "custom" })} />
                  Alto <input className={small} value={cfg.h} onChange={(e) => set({ h: e.target.value, roll: "custom" })} /> mm
                </div>
              </div>
            ) : (
              <div className="space-y-2 text-sm">
                <label className="block">Modelo{" "}
                  <select className={`${input} max-w-full`} value={cfg.sheet}
                    onChange={(e) => { const v = e.target.value; const { label: _l, ...rest } = SHEETS[v]; set({ sheet: v, ...rest }); }}>
                    {Object.entries(SHEETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                </label>
                <label className="block">Papel{" "}
                  <select className={input} value={cfg.paper} onChange={(e) => set({ paper: e.target.value })}>
                    {Object.entries(PAPER).map(([k, v]) => <option key={k} value={k}>{v[2]}</option>)}
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {[["cols", "Columnas"], ["rows", "Filas"], ["sw", "Ancho mm"], ["sh", "Alto mm"],
                    ["mt", "Margen sup. mm"], ["ml", "Margen izq. mm"], ["gx", "Espacio horiz. mm"], ["gy", "Espacio vert. mm"]].map(([k, label]) => (
                    <label key={k} className="block">{label}
                      <input className="w-full rounded border p-1" value={cfg[k]} onChange={(e) => set({ [k]: e.target.value, sheet: "custom" })} />
                    </label>
                  ))}
                </div>
                <label className="block">Saltar etiquetas ya usadas de la primera hoja
                  <input className="w-full rounded border p-1" value={cfg.skip} onChange={(e) => set({ skip: e.target.value })} />
                </label>
              </div>
            )}

            <h2 className="mb-2 mt-4 font-semibold">3. Contenido</h2>
            <div className="grid grid-cols-2 gap-1 text-sm">
              {[["biz", "Nombre del negocio"], ["name", "Nombre del producto"], ["sku", "SKU"], ["code", "Número del código"],
                ["usd", "Precio en USD"], ["ves", "Precio en Bs."]].map(([k, label]) => (
                <label key={k}><input type="checkbox" checked={cfg.show[k]} onChange={(e) => setShow(k, e.target.checked)} /> {label}</label>
              ))}
              <label className="col-span-2"><input type="checkbox" checked={cfg.includeTax} onChange={(e) => set({ includeTax: e.target.checked })} /> Precio con IVA incluido</label>
            </div>
            {cfg.show.ves && (
              <p className="mt-2 text-xs text-slate-500">
                {ctx?.usdRateMicro ? `Bs. a la tasa vigente (${ctx.rateDate}). Si cambia la tasa, vuelve a imprimir.` : "No hay tasa del dólar registrada: el precio en Bs. saldrá como «Sin tasa»."}
              </p>
            )}
          </div>

          <div className="rounded-xl bg-white p-4 shadow">
            <h2 className="mb-2 font-semibold">Vista previa</h2>
            {total === 0 ? (
              items.length > 0
                ? <p className="text-sm text-slate-500">Todas las copias están en 0.</p>
                : <p className="text-sm text-slate-500">Agrega productos para ver cómo quedan.</p>
            ) : geom.roll ? (
              <div className="flex flex-wrap gap-2">
                {labels.slice(0, 4).map((p, i) => (
                  <div key={i} className="border shadow-sm"><LabelView p={p} cfg={cfg} ctx={ctx} w={geom.w} h={geom.h} /></div>
                ))}
              </div>
            ) : (
              <div className="overflow-hidden border">{renderSheetPage(sheetPages(labels)[0], "pv", 0.4)}</div>
            )}
            <p className="mt-3 text-sm text-slate-600">
              {total} etiqueta(s){geom.roll ? "" : ` · ${pages} hoja(s)`}
              {tooMany && <span className="text-red-600"> · máximo {MAX_LABELS} por impresión</span>}
            </p>
            <button onClick={doPrint} disabled={total === 0 || tooMany}
              className="mt-2 w-full rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">Imprimir etiquetas</button>
            <p className="mt-2 text-xs text-slate-500">
              En el cuadro de impresión elige tu impresora, tamaño real (100 %) y sin márgenes. Haz una prueba con una sola etiqueta antes de imprimir el lote.
            </p>
          </div>
        </div>
      </div>

      {printing && createPortal(
        <div className="label-print">
          {geom.roll
            ? labels.map((p, i) => (
              <div key={i} className="label-page" style={{ width: `${geom.w}mm`, height: `${geom.h}mm`, overflow: "hidden" }}>
                <LabelView p={p} cfg={cfg} ctx={ctx} w={geom.w} h={geom.h} />
              </div>
            ))
            : sheetPages(labels).map((slots, i) => renderSheetPage(slots, i, 1))}
        </div>,
        document.body,
      )}
    </div>
  );
}
