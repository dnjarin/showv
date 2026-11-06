import { useCallback, useEffect, useState } from "react";
import { legacyApi } from "../services/api";
import { readTable } from "../utils/readSheet";

// El orden importa: los saldos necesitan que el cliente o proveedor ya exista.
const STEPS = [
  {
    id: "customers", title: "1. Clientes",
    help: "Trae los clientes del sistema anterior con su límite y días de crédito. Si un cliente ya existe, se actualizan solo los datos que traiga el archivo.",
    columns: "tipo, rif_cedula, nombre, direccion, telefono, correo, limite_credito_usd, dias_credito",
  },
  {
    id: "suppliers", title: "2. Proveedores",
    help: "Trae los proveedores. Si ya existe uno con el mismo RIF, se actualizan sus datos.",
    columns: "tipo, rif_cedula, nombre, direccion, telefono",
  },
  {
    id: "ar_balances", title: "3. Saldos por cobrar",
    help: "Cada fila es una factura que el cliente todavía debe. Entra como «saldo inicial» a Cuentas por cobrar; no cuenta como venta ni mueve inventario. Requiere los clientes cargados.",
    columns: "tipo, rif_cedula, factura, fecha, vencimiento, moneda, saldo",
  },
  {
    id: "ap_balances", title: "4. Saldos por pagar",
    help: "Cada fila es una factura que la empresa todavía debe a un proveedor. Entra a Cuentas por pagar; no mueve inventario ni aparece en el libro de compras. Requiere los proveedores cargados.",
    columns: "tipo, rif_cedula, factura, fecha, vencimiento, moneda, saldo",
  },
];

const ENTITY_LABEL = {
  customers: "Clientes", suppliers: "Proveedores", ar_balances: "Saldos por cobrar", ap_balances: "Saldos por pagar",
};

const ACTIONS = {
  new: { label: "Nuevo", cls: "bg-green-100 text-green-800" },
  update: { label: "Actualiza", cls: "bg-blue-100 text-blue-800" },
  unchanged: { label: "Sin cambios", cls: "bg-slate-100 text-slate-600" },
  skipped: { label: "Omitido", cls: "bg-amber-100 text-amber-800" },
  error: { label: "Error", cls: "bg-red-100 text-red-800" },
};

function Counter({ label, value, cls }) {
  return (
    <div className="rounded-xl border bg-white p-3 text-center">
      <div className={`text-2xl font-semibold ${cls || ""}`}>{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

export default function LegacyMigration() {
  const [step, setStep] = useState("customers");
  const [file, setFile] = useState(null);
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState(null);
  const [filter, setFilter] = useState("all");
  const [skipErrors, setSkipErrors] = useState(false);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const cur = STEPS.find((s) => s.id === step);

  const loadHistory = useCallback(async () => {
    try { setHistory(await legacyApi.history()); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const reset = () => { setFile(null); setContent(""); setPreview(null); setFilter("all"); setSkipErrors(false); };
  const pickStep = (id) => { setStep(id); reset(); setError(""); setMsg(""); };

  const run = async (fn, okMsg) => {
    setError(""); setMsg(""); setBusy(true);
    try {
      const r = await fn();
      if (okMsg) setMsg(okMsg(r));
      return r;
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const validate = async (f = file) => {
    if (!f) return setError("Elige un archivo (Excel o CSV) primero");
    setPreview(null); setSkipErrors(false); setFilter("all");
    const r = await run(async () => {
      const text = await readTable(f);
      setContent(text);
      return legacyApi.preview({ entity: step, filename: f.name, content: text });
    });
    if (r) setPreview(r);
  };

  const apply = async () => {
    const r = await run(
      () => legacyApi.apply({ entity: step, filename: file.name, content, skipErrors }),
      (x) => `Listo: ${x.created} nuevo(s), ${x.updated} actualizado(s), ${x.skipped} sin aplicar.`
    );
    if (r) { reset(); loadHistory(); }
  };

  const rows = preview ? preview.rows.filter((r) => filter === "all" || r.action === filter) : [];
  const applicable = preview ? preview.newRows + preview.updateRows : 0;
  const blocked = preview && preview.errorRows > 0 && !skipErrors;
  const isBalance = step === "ar_balances" || step === "ap_balances";

  return (
    <div className="p-6">
      <h1 className="mb-1 text-2xl font-semibold">Migración desde el sistema anterior</h1>
      <p className="mb-4 text-sm text-slate-600">
        Pasa a Tekkadon los clientes, proveedores y saldos pendientes que tenías en QSL Sistemas. Exporta cada
        listado a Excel (.xlsx o CSV) y cárgalo aquí. Siempre ves una vista previa antes de aplicar nada, y
        cada paso se aplica completo o no se aplica. Los productos y su existencia se cargan en
        «Productos → Importar / exportar».
      </p>

      {error && <p className="mb-3 rounded bg-red-50 p-3 text-red-700">{error}</p>}
      {msg && <p className="mb-3 rounded bg-green-50 p-3 text-green-800">{msg}</p>}

      <div className="mb-4 flex flex-wrap gap-2">
        {STEPS.map((s) => (
          <button key={s.id} onClick={() => pickStep(s.id)}
            className={`rounded-full border px-4 py-2 text-sm ${step === s.id ? "bg-slate-900 text-white" : "bg-white"}`}>
            {s.title}
          </button>
        ))}
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border bg-white p-4">
          <h2 className="mb-2 font-semibold">{cur.title}</h2>
          <p className="mb-3 text-sm text-slate-600">{cur.help}</p>
          <p className="mt-3 text-xs text-slate-500">Archivo Excel (.xlsx) o CSV; la primera fila debe traer los nombres de columna. Columnas: {cur.columns}.</p>
          <p className="mt-1 text-xs text-slate-500">
            El RIF o la cédula puede venir como «J-30123456-7» o «V12.345.678»; si el tipo viene en otra columna,
            se usa esa. Los montos aceptan «1.234,56» o «1234.56».
            {isBalance && " La moneda es obligatoria (USD o VES) y las fechas se escriben AAAA-MM-DD o DD/MM/AAAA. Si falta el vencimiento, se calcula con los días de crédito."}
          </p>
        </div>

        <div className="rounded-xl border bg-white p-4">
          <h2 className="mb-2 font-semibold">Cargar archivo</h2>
          <div className="space-y-3">
            <label className="inline-flex cursor-pointer items-center gap-3 rounded border-2 border-dashed border-slate-400 bg-slate-50 px-4 py-3 hover:bg-slate-100">
              <span className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white">Elegir archivo…</span>
              <span className="text-sm text-slate-600">{file ? file.name : "Excel (.xlsx) o CSV"}</span>
              <input type="file" accept=".xlsx,.csv,.txt" className="hidden"
                key={`${step}-${file ? file.name : "none"}`}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f); setPreview(null);
                  if (f) validate(f);
                }} />
            </label>
            <p className="text-xs text-slate-500">Al elegir el archivo se valida solo; todavía no se guarda nada.</p>
            {file && (
              <div>
                <button onClick={() => validate()} disabled={busy}
                  className="rounded border px-4 py-2 disabled:opacity-50">
                  {busy ? "Procesando…" : "Volver a validar"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {preview && (
        <div className="mb-8">
          <h2 className="mb-2 font-semibold">
            Vista previa · {ENTITY_LABEL[preview.entity]} · <span className="text-slate-500">{file?.name}</span>
          </h2>

          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-5">
            <Counter label="Nuevos" value={preview.newRows} cls="text-green-700" />
            <Counter label="Se actualizan" value={preview.updateRows} cls="text-blue-700" />
            <Counter label="Sin cambios" value={preview.unchangedRows} />
            <Counter label="Omitidos" value={preview.skippedRows} cls="text-amber-700" />
            <Counter label="Con errores" value={preview.errorRows} cls={preview.errorRows ? "text-red-700" : ""} />
          </div>

          {preview.ignoredColumns.length > 0 && (
            <p className="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-800">
              Columnas que no reconocí y se ignoraron: {preview.ignoredColumns.join(", ")}
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

          <div className="overflow-x-auto rounded-xl bg-white shadow">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-slate-100">
                <tr>
                  <th className="p-3">Línea</th><th className="p-3">Resultado</th>
                  <th className="p-3">Documento</th><th className="p-3">Nombre</th><th className="p-3">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.lineNo} className="border-b align-top">
                    <td className="p-3">{r.lineNo}</td>
                    <td className="p-3">
                      <span className={`rounded px-2 py-0.5 text-xs ${ACTIONS[r.action].cls}`}>{ACTIONS[r.action].label}</span>
                    </td>
                    <td className="p-3 font-mono">{r.key || "—"}</td>
                    <td className="p-3">{r.name || "—"}</td>
                    <td className="p-3">
                      {r.detail}
                      {r.message && <div className={r.action === "error" ? "text-red-700" : "text-amber-700"}>{r.message}</div>}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={5} className="p-6 text-center text-slate-500">No hay filas con ese filtro</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {isBalance && preview.usdRateMicro && (
            <p className="mt-2 text-xs text-slate-500">
              Los saldos en USD se convierten a bolívares con la última tasa registrada: Bs. {(preview.usdRateMicro / 1_000_000).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} por USD.
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-4">
            {preview.errorRows > 0 && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={skipErrors} onChange={(e) => setSkipErrors(e.target.checked)} />
                Omitir las filas con error y aplicar el resto
              </label>
            )}
            <button onClick={apply} disabled={busy || applicable === 0 || blocked}
              className="rounded bg-green-700 px-4 py-2 text-white disabled:opacity-50">
              {busy ? "Aplicando…" : `Aplicar ${applicable} fila(s)`}
            </button>
            <button onClick={reset} disabled={busy} className="underline">Cancelar</button>
            {blocked && <span className="text-sm text-red-700">Para aplicar, marca «Omitir las filas con error» (esas filas no se cargarán) o corrige el archivo y vuelve a elegirlo.</span>}
          </div>
        </div>
      )}

      <h2 className="mb-2 font-semibold">Migraciones aplicadas</h2>
      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr>
              <th className="p-3">Fecha</th><th className="p-3">Paso</th><th className="p-3">Archivo</th>
              <th className="p-3">Nuevos</th><th className="p-3">Actualizados</th><th className="p-3">Sin aplicar</th>
              <th className="p-3">Usuario</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id} className="border-b">
                <td className="p-3">{new Date(h.createdAt.replace(" ", "T") + "Z").toLocaleString("es-VE")}</td>
                <td className="p-3">{ENTITY_LABEL[h.entity] ?? h.entity}</td>
                <td className="p-3">{h.filename}</td>
                <td className="p-3">{h.createdRows}</td>
                <td className="p-3">{h.updatedRows}</td>
                <td className="p-3">{h.skippedRows}</td>
                <td className="p-3">{h.userName ?? "—"}</td>
              </tr>
            ))}
            {history.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-slate-500">Aún no se ha aplicado ninguna migración</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
