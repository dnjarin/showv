import { useState } from "react";
import { reportsApi } from "../services/api";
import { formatMoney } from "../utils/money";
import { localDate, todayStr } from "../utils/dates";
import { toCsv, csvMoney } from "../utils/csv";

const METHODS = {
  efectivo: "Efectivo", punto: "Punto de venta", pago_movil: "Pago móvil",
  transferencia: "Transferencia", zelle: "Zelle", otro: "Otro",
};

function Table({ head, rows }) {
  return (
    <div className="mb-6 overflow-x-auto rounded-xl bg-white shadow">
      <table className="w-full text-left text-sm">
        <thead className="border-b bg-slate-100">
          <tr>{head.map((h) => <th key={h} className="p-3">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b">{r.map((c, j) => <td key={j} className="p-3">{c}</td>)}</tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={head.length} className="p-6 text-center text-slate-500">Sin datos en el rango</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function Reports() {
  const today = todayStr();
  const [tab, setTab] = useState("ventas");
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setError(""); setMsg(""); setData(null); setBusy(true);
    try {
      if (tab === "ventas") setData(await reportsApi.sales(from, to));
      else if (tab === "productos") setData(await reportsApi.top(from, to, 20));
      else setData(await reportsApi.valuation());
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const exportCsv = async () => {
    if (!data) return;
    let header, rows, name;
    if (tab === "ventas") {
      name = `ventas_${from}_${to}.csv`;
      header = ["Fecha", "Documentos", "Total Bs. equivalente"];
      rows = data.byDay.map((d) => [d.day, d.docs, csvMoney(d.totalVesMinor)]);
    } else if (tab === "productos") {
      name = `mas_vendidos_${from}_${to}.csv`;
      header = ["SKU", "Producto", "Cantidad", "Ingresos USD", "Ingresos Bs."];
      rows = data.map((p) => [p.sku ?? "", p.description, p.quantity, csvMoney(p.usdMinor), csvMoney(p.vesMinor)]);
    } else {
      name = `inventario_valorizado_${todayStr()}.csv`;
      header = ["SKU", "Producto", "Moneda", "Stock", "Costo unitario", "Valor"];
      rows = data.items.map((i) => [i.sku, i.name, i.currencyCode, i.stock, csvMoney(i.costMinor), csvMoney(i.valueMinor)]);
    }
    try {
      const path = await reportsApi.exportCsv(name, toCsv(header, rows));
      setMsg(`Guardado en: ${path}`);
    } catch (e) { setError(e.message); }
  };

  const tabBtn = (id, label) => (
    <button onClick={() => { setTab(id); setData(null); setMsg(""); setError(""); }}
      className={`rounded px-4 py-2 ${tab === id ? "bg-slate-900 text-white" : "border bg-white"}`}>
      {label}
    </button>
  );
  const input = "rounded border p-2";

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Reportes</h1>
      <div className="mb-4 flex gap-2">
        {tabBtn("ventas", "Ventas")}
        {tabBtn("productos", "Más vendidos")}
        {tabBtn("inventario", "Inventario valorizado")}
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        {tab !== "inventario" && (
          <>
            <label className="text-sm">Desde
              <input type="date" className={`${input} mt-1 block`} value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="text-sm">Hasta
              <input type="date" className={`${input} mt-1 block`} value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </>
        )}
        <button onClick={run} disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
          {busy ? "Consultando…" : "Consultar"}
        </button>
        {data && <button onClick={exportCsv} className="rounded border px-4 py-2">Exportar CSV</button>}
      </div>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {msg && <p className="mb-3 text-sm text-green-700">{msg}</p>}

      {data && tab === "ventas" && (
        <>
          <div className="mb-6 grid max-w-2xl grid-cols-3 gap-3">
            <div className="rounded-xl bg-white p-4 shadow"><div className="text-sm text-slate-500">Documentos</div><div className="text-2xl font-semibold">{data.docs}</div></div>
            <div className="rounded-xl bg-white p-4 shadow"><div className="text-sm text-slate-500">Total (Bs. equiv.)</div><div className="text-2xl font-semibold">{formatMoney(data.totalVesMinor, "VES")}</div></div>
            <div className="rounded-xl bg-white p-4 shadow"><div className="text-sm text-slate-500">Anulados</div><div className="text-2xl font-semibold">{data.voided}</div></div>
          </div>
          {data.returnsCount > 0 && (
            <div className="mb-6 max-w-2xl rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">
              Devoluciones del período: <b>{data.returnsCount}</b> por <b>{formatMoney(data.returnsVesMinor, "VES")}</b> (Bs. equiv.).{" "}
              Venta neta: <b>{formatMoney(data.totalVesMinor - data.returnsVesMinor, "VES")}</b>.
            </div>
          )}
          <h2 className="mb-2 font-semibold">Por moneda del documento</h2>
          <Table head={["Moneda", "Docs", "Base", "IVA", "IGTF", "Total"]}
            rows={data.byCurrency.map((c) => [c.currencyCode, c.docs, formatMoney(c.baseMinor, c.currencyCode),
              formatMoney(c.taxMinor, c.currencyCode), formatMoney(c.igtfMinor, c.currencyCode), formatMoney(c.totalMinor, c.currencyCode)])} />
          <h2 className="mb-2 font-semibold">Cobrado por método de pago</h2>
          <Table head={["Método", "Moneda", "Cobrado"]}
            rows={data.byMethod.map((m) => [METHODS[m.method] ?? m.method, m.currencyCode, formatMoney(m.collectedMinor, m.currencyCode)])} />
          <h2 className="mb-2 font-semibold">Por día</h2>
          <Table head={["Fecha", "Docs", "Total Bs. equiv."]}
            rows={data.byDay.map((d) => [d.day, d.docs, formatMoney(d.totalVesMinor, "VES")])} />
          <h2 className="mb-2 font-semibold">Ventas sin IVA o sin IGTF (con motivo)</h2>
          <Table head={["Documento", "Fecha", "Cajero", "No cobrado", "Motivo"]}
            rows={data.waivers.map((w) => [
              `${w.series}-${String(w.number).padStart(6, "0")}`,
              localDate(w.issuedAt),
              w.cashier ?? "—",
              [w.taxWaived && "IVA", w.igtfWaived && "IGTF"].filter(Boolean).join(" + "),
              w.reason ?? "—",
            ])} />
        </>
      )}

      {data && tab === "productos" && (
        <Table head={["SKU", "Producto", "Cantidad", "Ingresos USD", "Ingresos Bs."]}
          rows={data.map((p) => [p.sku ?? "—", p.description, p.quantity,
            formatMoney(p.usdMinor, "USD"), formatMoney(p.vesMinor, "VES")])} />
      )}

      {data && tab === "inventario" && (
        <>
          <div className="mb-4 flex gap-3">
            {data.totals.map((t) => (
              <div key={t.currencyCode} className="rounded-xl bg-white p-4 shadow">
                <div className="text-sm text-slate-500">Valor total ({t.currencyCode})</div>
                <div className="text-2xl font-semibold">{formatMoney(t.valueMinor, t.currencyCode)}</div>
              </div>
            ))}
          </div>
          <Table head={["SKU", "Producto", "Stock", "Costo", "Valor"]}
            rows={data.items.map((i) => [i.sku, i.name, i.stock,
              formatMoney(i.costMinor, i.currencyCode), formatMoney(i.valueMinor, i.currencyCode)])} />
        </>
      )}
    </div>
  );
}