import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../store/authStore";
import { saleRetentionsApi } from "../../services/api";
import { formatMoney } from "../../utils/money";
import { todayStr } from "../../utils/dates";

const fmtDate = (s) => (s ? s.split("-").reverse().join("/") : "—");

export default function SaleRetentionsTab() {
  const isAdmin = useAuth((s) => s.user.role === "admin");
  const [period, setPeriod] = useState(todayStr().slice(0, 7));
  const [kind, setKind] = useState("");
  const [voided, setVoided] = useState(false);
  const [data, setData] = useState({ rows: [], ivaVesMinor: 0, islrVesMinor: 0 });
  const [voiding, setVoiding] = useState(null); // { id, reason }
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await saleRetentionsApi.list({
        period: period || null, kind: kind || null, customerId: null, includeVoided: voided,
      }));
      setError("");
    } catch (e) { setError(e.message); }
  }, [period, kind, voided]);
  useEffect(() => { load(); }, [load]);

  const doVoid = async () => {
    try {
      await saleRetentionsApi.void(voiding.id, voiding.reason);
      setVoiding(null); load();
    } catch (e) { setError(e.message); }
  };
  const input = "rounded border p-2";

  return (
    <div>
      <div className="mb-4 grid max-w-2xl gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-white p-4 shadow">
          <div className="text-sm text-slate-500">IVA retenido por clientes</div>
          <div className="text-2xl font-semibold">{formatMoney(data.ivaVesMinor, "VES")}</div>
        </div>
        <div className="rounded-xl bg-white p-4 shadow">
          <div className="text-sm text-slate-500">ISLR retenido por clientes</div>
          <div className="text-2xl font-semibold">{formatMoney(data.islrVesMinor, "VES")}</div>
        </div>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="text-sm">Período{" "}
          <input type="month" className={input} value={period} onChange={(e) => setPeriod(e.target.value)} />
        </label>
        <button className="text-sm underline" onClick={() => setPeriod("")}>Todos</button>
        <select className={input} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">IVA e ISLR</option>
          <option value="IVA">Solo IVA</option>
          <option value="ISLR">Solo ISLR</option>
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={voided} onChange={(e) => setVoided(e.target.checked)} /> Incluir anuladas
        </label>
      </div>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Fecha</th><th className="p-3">Tipo</th><th className="p-3">Comprobante</th>
              <th className="p-3">Cliente</th><th className="p-3">Venta</th><th className="p-3 text-right">Monto Bs.</th>
              <th className="p-3">Registró</th><th className="p-3"></th></tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id} className={`border-b ${r.voided ? "opacity-50" : ""}`}>
                <td className="whitespace-nowrap p-3">{fmtDate(r.voucherDate)}</td>
                <td className="p-3">{r.kind}</td>
                <td className="p-3 font-mono">{r.voucherNumber}</td>
                <td className="p-3">{r.customerName} <span className="text-slate-500">({r.customerDoc})</span></td>
                <td className="p-3 font-mono">{r.documentLabel}</td>
                <td className="p-3 text-right font-semibold">{formatMoney(r.amountVesMinor, "VES")}</td>
                <td className="p-3">{r.username ?? "—"}</td>
                <td className="p-3 text-right">
                  {r.voided ? <span title={r.voidReason ?? ""} className="text-xs text-red-700">Anulada</span>
                    : isAdmin && <button className="underline" onClick={() => setVoiding({ id: r.id, reason: "" })}>Anular</button>}
                </td>
              </tr>
            ))}
            {data.rows.length === 0 && (
              <tr><td colSpan={8} className="p-6 text-center text-slate-500">Sin retenciones en este período</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Se registran desde Cuentas por cobrar → Ver cuenta → «Retención» en la venta correspondiente.
        Los totales no incluyen las anuladas.
      </p>
      {voiding && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
          <div className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-5 shadow-2xl">
            <h2 className="text-lg font-semibold">Anular retención</h2>
            <p className="text-sm text-slate-600">El saldo de la venta vuelve a su monto anterior.</p>
            <input className={`${input} w-full`} placeholder="Motivo (mínimo 5 caracteres)" value={voiding.reason}
              onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })} />
            <div className="flex gap-2">
              <button onClick={doVoid} className="rounded bg-red-700 px-4 py-2 text-white">Anular</button>
              <button onClick={() => setVoiding(null)} className="rounded border px-4 py-2">Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
