import { useCallback, useEffect, useState } from "react";
import { booksApi, reportsApi } from "../services/api";
import { formatMoney } from "../utils/money";
import { csvMoney, toCsv } from "../utils/csv";
import { todayStr } from "../utils/dates";

const fmtDate = (s) => (s ? s.split("-").reverse().join("/") : "");
const monthStart = () => todayStr().slice(0, 8) + "01";
const ves = (v) => formatMoney(v, "VES");
const input = "rounded border p-2";

/** Columnas de montos comunes a ambos libros. `show` oculta alícuotas sin movimiento. */
function amountCols(totals) {
  const a = totals;
  return [
    ["Total", "totalVesMinor", true],
    ["Exentas / sin IVA", "exemptVesMinor", true],
    ["Base 16 %", "baseGeneralVesMinor", true],
    ["IVA 16 %", "ivaGeneralVesMinor", true],
    ["Base 8 %", "baseReducedVesMinor", a.baseReducedVesMinor !== 0 || a.ivaReducedVesMinor !== 0],
    ["IVA 8 %", "ivaReducedVesMinor", a.baseReducedVesMinor !== 0 || a.ivaReducedVesMinor !== 0],
    ["Base 31 %", "baseExtraVesMinor", a.baseExtraVesMinor !== 0 || a.ivaExtraVesMinor !== 0],
    ["IVA 31 %", "ivaExtraVesMinor", a.baseExtraVesMinor !== 0 || a.ivaExtraVesMinor !== 0],
  ].filter((c) => c[2]);
}

function BookTable({ kind, data, small }) {
  const cols = amountCols(data.totals);
  const cell = small ? "px-1 py-0.5" : "p-2";
  const sales = kind === "ventas";
  return (
    <table className={`w-full text-left ${small ? "text-[9px]" : "text-xs"}`}>
      <thead className="border-b bg-slate-100">
        <tr>
          <th className={cell}>N.º</th><th className={cell}>Fecha</th>
          {sales ? <><th className={cell}>Documento</th><th className={cell}>Cliente</th><th className={cell}>RIF / C.I.</th></>
            : <><th className={cell}>Proveedor</th><th className={cell}>RIF</th><th className={cell}>Factura</th><th className={cell}>Control</th></>}
          {cols.map((c) => <th key={c[1]} className={`${cell} text-right`}>{c[0]}</th>)}
          {sales ? <th className={`${cell} text-right`}>IGTF</th>
            : <><th className={`${cell} text-right`}>IVA retenido</th><th className={cell}>Comprobante</th></>}
        </tr>
      </thead>
      <tbody>
        {data.rows.map((r, i) => (
          <tr key={r.id} className={`border-b ${r.voided ? "text-slate-400 line-through" : ""}`}>
            <td className={cell}>{i + 1}</td>
            <td className={`${cell} whitespace-nowrap`}>{fmtDate(r.date)}</td>
            {sales ? (
              <>
                <td className={`${cell} whitespace-nowrap font-mono`}>
                  {r.document}{r.kind === "Nota de crédito" ? ` (NC${r.related ? ` de ${r.related}` : ""})` : ""}{r.voided ? " ANULADO" : ""}
                </td>
                <td className={cell}>{r.customerName ?? "Consumidor final"}</td>
                <td className={cell}>{r.customerDoc ?? ""}</td>
              </>
            ) : (
              <>
                <td className={cell}>{r.supplierName}{r.voided ? " (ANULADA)" : ""}{r.noRate ? " (sin tasa)" : ""}</td>
                <td className={cell}>{r.supplierDoc}</td>
                <td className={cell}>{r.invoiceNumber ?? ""}</td>
                <td className={cell}>{r.invoiceControl ?? ""}</td>
              </>
            )}
            {cols.map((c) => <td key={c[1]} className={`${cell} whitespace-nowrap text-right`}>{ves(r.amounts[c[1]])}</td>)}
            {sales ? <td className={`${cell} whitespace-nowrap text-right`}>{ves(r.igtfVesMinor)}</td>
              : <><td className={`${cell} whitespace-nowrap text-right`}>{ves(r.ivaWithheldVesMinor)}</td><td className={cell}>{r.voucher ?? ""}</td></>}
          </tr>
        ))}
        {data.rows.length === 0 && (
          <tr><td colSpan={20} className="p-6 text-center text-slate-500">Sin operaciones en el período</td></tr>
        )}
      </tbody>
      <tfoot className="border-t-2 bg-slate-50 font-semibold">
        <tr>
          <td className={cell} colSpan={sales ? 5 : 6}>TOTALES</td>
          {cols.map((c) => <td key={c[1]} className={`${cell} whitespace-nowrap text-right`}>{ves(data.totals[c[1]])}</td>)}
          {sales ? <td className={`${cell} whitespace-nowrap text-right`}>{ves(data.igtfVesMinor)}</td>
            : <><td className={`${cell} whitespace-nowrap text-right`}>{ves(data.ivaWithheldVesMinor)}</td><td /></>}
        </tr>
      </tfoot>
    </table>
  );
}

function PrintView({ kind, data, from, to, onClose }) {
  const print = () => {
    const style = document.createElement("style");
    style.textContent = "@page{size:letter landscape;margin:10mm}";
    document.head.appendChild(style);
    window.print();
    setTimeout(() => style.remove(), 500);
  };
  return (
    <div className="ticket-overlay fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4">
      <div className="mx-auto max-w-[1100px]">
        <div className="mb-3 flex gap-2">
          <button onClick={print} className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white">Imprimir (carta horizontal)</button>
          <button onClick={onClose} className="rounded-lg bg-white px-4 py-2">Cerrar</button>
        </div>
        <div className="voucher-print relative mx-auto bg-white p-6 text-slate-900 shadow-xl">
          <div className="mb-2 text-center">
            <div className="text-sm font-bold uppercase">Libro de {kind} — montos en bolívares</div>
            <div className="text-[10px]">{data.issuer}</div>
            <div className="text-[10px]">Período: {fmtDate(from)} al {fmtDate(to)}</div>
          </div>
          <BookTable kind={kind} data={data} small />
          <p className="mt-2 text-[9px] text-slate-500">
            Documento informativo para la preparación de la declaración. No sustituye los libros fiscales
            hasta que las ventas se emitan con facturación fiscal autorizada.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function Books() {
  const [kind, setKind] = useState("ventas");
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayStr());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [printing, setPrinting] = useState(false);

  const load = useCallback(async () => {
    setError(""); setMsg(""); setData(null);
    try { setData(kind === "ventas" ? await booksApi.sales(from, to) : await booksApi.purchases(from, to)); }
    catch (e) { setError(e.message); }
  }, [kind, from, to]);
  useEffect(() => { load(); }, [load]);

  const exportCsv = async () => {
    setMsg(""); setError("");
    const cols = amountCols(data.totals);
    const names = cols.map((c) => c[0]);
    let header, rows;
    if (kind === "ventas") {
      header = ["N.º", "Fecha", "Documento", "Tipo", "Relacionado", "Cliente", "RIF/C.I.", ...names, "IGTF", "Estado"];
      rows = data.rows.map((r, i) => [i + 1, fmtDate(r.date), r.document, r.kind, r.related ?? "", r.customerName ?? "Consumidor final",
        r.customerDoc ?? "", ...cols.map((c) => csvMoney(r.amounts[c[1]])), csvMoney(r.igtfVesMinor), r.voided ? "Anulado" : "Vigente"]);
      rows.push(["", "", "", "", "", "", "TOTALES", ...cols.map((c) => csvMoney(data.totals[c[1]])), csvMoney(data.igtfVesMinor), ""]);
    } else {
      header = ["N.º", "Fecha", "Compra", "Proveedor", "RIF", "Factura", "Control", ...names, "IVA retenido", "Comprobante", "Estado"];
      rows = data.rows.map((r, i) => [i + 1, fmtDate(r.date), r.number, r.supplierName, r.supplierDoc, r.invoiceNumber ?? "",
        r.invoiceControl ?? "", ...cols.map((c) => csvMoney(r.amounts[c[1]])), csvMoney(r.ivaWithheldVesMinor), r.voucher ?? "",
        r.voided ? "Anulada" : r.noRate ? "Sin tasa" : "Vigente"]);
      rows.push(["", "", "", "", "", "", "TOTALES", ...cols.map((c) => csvMoney(data.totals[c[1]])), csvMoney(data.ivaWithheldVesMinor), "", ""]);
    }
    try {
      const path = await reportsApi.exportCsv(`libro_${kind}_${from}_${to}.csv`, toCsv(header, rows));
      setMsg(`Guardado en: ${path}`);
    } catch (e) { setError(e.message); }
  };

  const tabBtn = (id, label) => (
    <button onClick={() => setKind(id)}
      className={`rounded px-4 py-2 ${kind === id ? "bg-slate-900 text-white" : "border bg-white"}`}>{label}</button>
  );
  const ivaDebito = data ? data.totals.ivaGeneralVesMinor + data.totals.ivaReducedVesMinor + data.totals.ivaExtraVesMinor : 0;

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Libros de compras y ventas</h1>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        {tabBtn("ventas", "Libro de ventas")}
        {tabBtn("compras", "Libro de compras")}
        <label className="ml-3 text-sm">Desde<input type="date" className={`${input} ml-1`} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-sm">Hasta<input type="date" className={`${input} ml-1`} value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button onClick={exportCsv} disabled={!data} className="rounded border bg-white px-3 py-2 text-sm disabled:opacity-50">Exportar CSV</button>
        <button onClick={() => setPrinting(true)} disabled={!data} className="rounded border bg-white px-3 py-2 text-sm disabled:opacity-50">Vista de impresión</button>
      </div>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      {msg && <p className="mb-2 text-sm text-green-700">{msg}</p>}

      {data && (
        <>
          <div className="mb-3 grid max-w-3xl gap-3 sm:grid-cols-3">
            <div className="rounded-xl bg-white p-3 shadow">
              <div className="text-xs text-slate-500">{kind === "ventas" ? "IVA débito fiscal" : "IVA crédito fiscal"}</div>
              <div className="text-lg font-semibold">{ves(ivaDebito)}</div>
            </div>
            <div className="rounded-xl bg-white p-3 shadow">
              <div className="text-xs text-slate-500">{kind === "ventas" ? "IGTF percibido" : "IVA retenido a proveedores"}</div>
              <div className="text-lg font-semibold">{ves(kind === "ventas" ? data.igtfVesMinor : data.ivaWithheldVesMinor)}</div>
            </div>
            <div className="rounded-xl bg-white p-3 shadow">
              <div className="text-xs text-slate-500">Operaciones</div>
              <div className="text-lg font-semibold">{data.rows.length}</div>
            </div>
          </div>
          {kind === "compras" && data.withoutRate > 0 && (
            <p className="mb-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
              {data.withoutRate} compra(s) en USD se registraron sin tasa de cambio y no pueden convertirse a Bs.; aparecen en cero.
            </p>
          )}
          <div className="overflow-x-auto rounded-xl bg-white shadow"><BookTable kind={kind} data={data} /></div>
          <p className="mt-3 max-w-3xl text-sm text-slate-500">
            {kind === "ventas"
              ? "Incluye los comprobantes emitidos y las notas de crédito (en negativo); las anulaciones aparecen sin monto. Cada operación se convierte a Bs. con la tasa que tenía al emitirse."
              : "Incluye las compras por fecha de factura (o de registro si no se indicó), con el IVA retenido y su comprobante. Cada compra se convierte a Bs. con la tasa que tenía al registrarse."}
            {" "}Es un documento informativo: mientras las ventas sean comprobantes internos, este libro no sustituye los libros fiscales.
          </p>
        </>
      )}
      {printing && data && <PrintView kind={kind} data={data} from={from} to={to} onClose={() => setPrinting(false)} />}
    </div>
  );
}
