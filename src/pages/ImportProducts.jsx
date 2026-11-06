import { useCallback, useEffect, useState } from "react";
import { importApi, warehousesApi } from "../services/api";
import { readTable } from "../utils/readSheet";

const MODES = [
  { id: "both", label: "Crear nuevos y actualizar existentes" },
  { id: "create", label: "Solo crear los que no existen" },
  { id: "update", label: "Solo actualizar los que ya existen" },
];

const ACTIONS = {
  new: { label: "Nuevo", cls: "bg-green-100 text-green-800" },
  update: { label: "Actualiza", cls: "bg-blue-100 text-blue-800" },
  unchanged: { label: "Sin cambios", cls: "bg-slate-100 text-slate-600" },
  skipped: { label: "Omitido", cls: "bg-amber-100 text-amber-800" },
  error: { label: "Error", cls: "bg-red-100 text-red-800" },
};

const STATUS = { preview: "En revisión", applied: "Aplicado", cancelled: "Cancelado" };

/** Lee el archivo: Excel (.xlsx) se convierte a texto; CSV/TXT como UTF-8 (o windows-1252 si viene de Excel en ANSI). */
const readText = (file) => readTable(file);

function Counter({ label, value, cls }) {
  return (
    <div className="rounded-xl border bg-white p-3 text-center">
      <div className={`text-2xl font-semibold ${cls || ""}`}>{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

export default function ImportProducts({ embedded = false }) {
  const [warehouses, setWarehouses] = useState([]);
  const [history, setHistory] = useState([]);
  const [mode, setMode] = useState("both");
  const [warehouseId, setWarehouseId] = useState("");
  const [file, setFile] = useState(null);
  const [detail, setDetail] = useState(null);
  const [filter, setFilter] = useState("all");
  const [skipErrors, setSkipErrors] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(true);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const loadHistory = useCallback(async () => {
    try { setHistory(await importApi.batches()); } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const w = await warehousesApi.list(false);
        setWarehouses(w);
        setWarehouseId(w.find((x) => x.isSales)?.id ?? "");
      } catch (e) { setError(e.message); }
      loadHistory();
    })();
  }, [loadHistory]);

  const run = async (fn, okMsg) => {
    setError(""); setMsg(""); setBusy(true);
    try {
      const r = await fn();
      if (okMsg) setMsg(okMsg(r));
      return r;
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const template = () => run(importApi.template, (p) => `Plantilla guardada en: ${p}`);
  const exportAll = () => run(() => importApi.exportProducts(includeInactive), (p) => `Catálogo exportado en: ${p}`);

  const validate = async () => {
    if (!file) return setError("Elige un archivo Excel o CSV primero");
    setDetail(null); setSkipErrors(false); setFilter("all");
    const r = await run(async () => {
      const content = await readText(file);
      return importApi.preview({
        filename: file.name, content, mode,
        warehouseId: warehouseId ? Number(warehouseId) : null,
      });
    });
    if (r) setDetail(r);
  };

  const apply = async () => {
    const r = await run(
      () => importApi.apply(detail.batch.id, skipErrors),
      (x) => `Importación lista: ${x.batch.appliedRows} fila(s) aplicadas.`
    );
    if (r) { setDetail(r); setFile(null); loadHistory(); }
  };

  const cancel = async () => {
    await run(() => importApi.cancel(detail.batch.id));
    setDetail(null); setFile(null); loadHistory();
  };

  const errorReport = () => run(() => importApi.errorReport(detail.batch.id), (p) => `Informe guardado en: ${p}`);

  const open = async (id) => {
    const r = await run(() => importApi.batch(id));
    if (r) { setDetail(r); setFilter("all"); setSkipErrors(false); }
  };

  const b = detail?.batch;
  const rows = detail ? detail.rows.filter((r) => filter === "all" || r.action === filter) : [];
  const pending = b?.status === "preview";
  const applicable = b ? b.newRows + b.updateRows : 0;

  return (
    <div className={embedded ? "" : "p-6"}>
      {!embedded && <h1 className="mb-1 text-2xl font-semibold">Importar y exportar productos</h1>}
      <p className="mb-4 text-sm text-slate-600">
        Carga o actualiza el catálogo desde un archivo de Excel (.xlsx) o CSV. Siempre ves una
        vista previa antes de aplicar nada.
      </p>

      {error && <p className="mb-3 rounded bg-red-50 p-3 text-red-700">{error}</p>}
      {msg && <p className="mb-3 rounded bg-green-50 p-3 text-green-800">{msg}</p>}

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border bg-white p-4">
          <h2 className="mb-2 font-semibold">1. Plantilla y exportación</h2>
          <p className="mb-3 text-sm text-slate-600">
            La plantilla trae las columnas y dos filas de ejemplo. La exportación del catálogo usa el mismo
            formato, así que sirve para editar precios en masa y volver a importar.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={template} disabled={busy} className="rounded border px-4 py-2">Descargar plantilla</button>
            <button onClick={exportAll} disabled={busy} className="rounded border px-4 py-2">Exportar catálogo</button>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
              Incluir inactivos
            </label>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Columnas: sku, codigo_barras, nombre, categoria, iva, costo, precio, moneda, stock_minimo,
            stock_inicial, controla_stock. Una celda vacía en un producto existente significa «no cambiar».
          </p>
        </div>

        <div className="rounded-xl border bg-white p-4">
          <h2 className="mb-2 font-semibold">2. Importar archivo</h2>
          <div className="space-y-3">
            <input type="file" accept=".xlsx,.csv,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <div className="flex flex-wrap gap-3">
              <select className="rounded border p-2" value={mode} onChange={(e) => setMode(e.target.value)}>
                {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <select className="rounded border p-2" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                {warehouses.map((w) => <option key={w.id} value={w.id}>Stock inicial en: {w.name}</option>)}
              </select>
            </div>
            <button onClick={validate} disabled={busy || !file}
              className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
              {busy ? "Procesando…" : "Validar archivo"}
            </button>
          </div>
        </div>
      </div>

      {detail && (
        <div className="mb-8">
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <h2 className="font-semibold">
              Lote #{b.id} · {b.filename} · <span className="text-slate-500">{STATUS[b.status]}</span>
            </h2>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-5">
            <Counter label="Nuevos" value={b.newRows} cls="text-green-700" />
            <Counter label="Se actualizan" value={b.updateRows} cls="text-blue-700" />
            <Counter label="Sin cambios" value={b.unchangedRows} />
            <Counter label="Omitidos" value={b.skippedRows} cls="text-amber-700" />
            <Counter label="Con errores" value={b.errorRows} cls={b.errorRows ? "text-red-700" : ""} />
          </div>

          {detail.ignoredColumns.length > 0 && (
            <p className="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-800">
              Columnas que no reconocí y se ignoraron: {detail.ignoredColumns.join(", ")}
            </p>
          )}

          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            {["all", "error", "new", "update", "unchanged", "skipped"].map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={`rounded-full border px-3 py-1 ${filter === f ? "bg-slate-900 text-white" : ""}`}>
                {f === "all" ? "Todas" : ACTIONS[f].label}
              </button>
            ))}
          </div>

          <div className="mb-3 max-h-96 overflow-auto rounded-xl border bg-white">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-slate-100">
                <tr>
                  <th className="p-2">Línea</th><th className="p-2">SKU</th>
                  <th className="p-2">Producto</th><th className="p-2">Acción</th><th className="p-2">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.lineNo} className="border-b">
                    <td className="p-2">{r.lineNo}</td>
                    <td className="p-2 font-mono">{r.sku || "—"}</td>
                    <td className="p-2">{r.name ?? "—"}</td>
                    <td className="p-2">
                      <span className={`rounded px-2 py-0.5 text-xs ${ACTIONS[r.action].cls}`}>{ACTIONS[r.action].label}</span>
                    </td>
                    <td className="p-2 text-slate-700">{r.message}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={5} className="p-6 text-center text-slate-500">Sin filas en este filtro</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {pending && (
            <div className="flex flex-wrap items-center gap-3">
              {b.errorRows > 0 && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={skipErrors} onChange={(e) => setSkipErrors(e.target.checked)} />
                  Importar solo las filas válidas (omitir las {b.errorRows} con error)
                </label>
              )}
              <button onClick={apply}
                disabled={busy || applicable === 0 || (b.errorRows > 0 && !skipErrors)}
                className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
                Confirmar importación ({applicable})
              </button>
              {b.errorRows > 0 && (
                <button onClick={errorReport} disabled={busy} className="rounded border px-4 py-2">Informe de errores (CSV)</button>
              )}
              <button onClick={cancel} disabled={busy} className="rounded border px-4 py-2">Cancelar</button>
            </div>
          )}
          {!pending && (
            <button onClick={() => setDetail(null)} className="rounded border px-4 py-2">Cerrar</button>
          )}
        </div>
      )}

      <h2 className="mb-2 font-semibold">Historial de importaciones</h2>
      <div className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-2">#</th><th className="p-2">Fecha</th><th className="p-2">Archivo</th>
              <th className="p-2">Usuario</th><th className="p-2">Resumen</th><th className="p-2">Estado</th><th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id} className="border-b">
                <td className="p-2">{h.id}</td>
                <td className="p-2">{h.createdAt}</td>
                <td className="p-2">{h.filename}</td>
                <td className="p-2">{h.createdByName ?? "—"}</td>
                <td className="p-2">{h.newRows} nuevos · {h.updateRows} act. · {h.errorRows} errores</td>
                <td className="p-2">{STATUS[h.status]}</td>
                <td className="p-2 text-right"><button className="underline" onClick={() => open(h.id)}>Ver</button></td>
              </tr>
            ))}
            {history.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-slate-500">Aún no hay importaciones</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
