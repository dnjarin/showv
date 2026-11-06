import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../store/authStore";
import { purchasesApi } from "../../services/api";
import { daysAgo, localDate, todayStr } from "../../utils/dates";
import { formatMoney, fromMicro } from "../../utils/money";
import VoucherModal from "./VoucherModal";

const num = (n) => `C-${String(n).padStart(6, "0")}`;
const pct = (bp) => `${String(bp / 100).replace(".", ",")} %`;

function Detail({ id, onClose, onChanged }) {
  const isAdmin = useAuth((s) => s.user.role === "admin");
  const [d, setD] = useState(null);
  const [reason, setReason] = useState("");
  const [voiding, setVoiding] = useState(false);
  const [voucherId, setVoucherId] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    purchasesApi.get(id).then(setD).catch((e) => setError(e.message));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const confirmVoid = async () => {
    setError(""); setBusy(true);
    try {
      await purchasesApi.void(id, reason);
      setVoiding(false); setReason(""); load(); onChanged();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const m = (v) => formatMoney(v, d.currencyCode);
  const activeWh = d?.withholdings.filter((w) => w.status === "active") ?? [];
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4">
      <div className="max-h-full w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl">
        {!d ? <p>{error || "Cargando…"}</p> : (
          <>
            <div className="mb-3 flex items-start justify-between">
              <div>
                <div className="font-mono text-lg font-semibold">{num(d.number)}</div>
                <div className="text-sm text-slate-500">{localDate(d.createdAt)} · registrada por {d.username ?? "—"}</div>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${d.status === "voided" ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
                {d.status === "voided" ? "Anulada" : "Registrada"}
              </span>
            </div>

            <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <div><dt className="text-slate-500">Proveedor</dt><dd>{d.supplierName} ({d.supplierDoc})</dd></div>
              <div><dt className="text-slate-500">Almacén</dt><dd>{d.warehouseName}</dd></div>
              <div><dt className="text-slate-500">Factura</dt><dd>{d.invoiceNumber ?? "—"}{d.invoiceDate ? ` · ${d.invoiceDate}` : ""}</dd></div>
              <div><dt className="text-slate-500">N.º de control</dt><dd>{d.invoiceControl ?? "—"}</dd></div>
              <div><dt className="text-slate-500">Costos actualizados</dt><dd>{d.costsUpdated} producto(s)</dd></div>
              {d.notes && <div className="col-span-2"><dt className="text-slate-500">Notas</dt><dd>{d.notes}</dd></div>}
            </dl>

            <table className="mb-3 w-full text-left text-sm">
              <thead className="border-b bg-slate-100">
                <tr><th className="p-2">Producto</th><th className="p-2 text-right">Cant.</th>
                  <th className="p-2 text-right">Costo</th><th className="p-2 text-right">Subtotal</th></tr>
              </thead>
              <tbody>
                {d.lines.map((l, i) => (
                  <tr key={i} className="border-b">
                    <td className="p-2">{l.sku} · {l.description}</td>
                    <td className="p-2 text-right">{l.quantity}</td>
                    <td className="p-2 text-right">{m(l.unitCostMinor)}</td>
                    <td className="p-2 text-right">{m(l.lineTotalMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mb-3 space-y-1 text-right text-sm">
              <div>Subtotal: {m(d.totalMinor)}</div>
              {d.exemptMinor > 0 && <div>De los cuales exento: {m(d.exemptMinor)}</div>}
              {d.ivaMinor > 0 && <div>IVA ({pct(d.ivaRateBp)}): {m(d.ivaMinor)}</div>}
              <div className="text-lg font-semibold">Total de la factura: {m(d.invoiceTotalMinor)}</div>
              {d.invoiceTotalMinor !== d.netPayableMinor && (
                <div className="text-lg font-semibold">Neto pagado al proveedor: {m(d.netPayableMinor)}</div>
              )}
              {d.currencyCode !== "VES" && d.totalVesMinor != null && (
                <div className="text-sm text-slate-500">
                  Subtotal equiv. {formatMoney(d.totalVesMinor, "VES")} (tasa {fromMicro(d.exchangeRateMicro)})
                </div>
              )}
            </div>

            {d.withholdings.length > 0 && (
              <div className="mb-3 rounded-xl border p-3">
                <div className="mb-2 text-sm font-semibold">Retenciones practicadas</div>
                {d.withholdings.map((w) => (
                  <div key={w.id} className={`flex items-center justify-between gap-2 text-sm ${w.status === "voided" ? "opacity-50" : ""}`}>
                    <span>{w.kind === "IVA" ? "IVA" : "ISLR"} · <span className="font-mono">{w.voucherNumber}</span> · {pct(w.rateBp)}{w.status === "voided" ? " · anulado" : ""}</span>
                    <span className="flex items-center gap-3">
                      <b>{formatMoney(w.amountVesMinor, "VES")}</b>
                      <button className="underline" onClick={() => setVoucherId(w.id)}>Comprobante</button>
                    </span>
                  </div>
                ))}
                {d.retSkipReason && <p className="mt-2 text-xs text-amber-800">No se retuvo algo que correspondía. Motivo: {d.retSkipReason}</p>}
              </div>
            )}

            {d.status === "voided" && (
              <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-800">
                Anulada el {localDate(d.voidedAt)}. Motivo: {d.voidReason}
              </p>
            )}
            {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

            {voiding && (
              <div className="mb-3 space-y-2 rounded-xl border border-red-300 bg-red-50 p-3">
                {activeWh.length > 0 && (
                  <p className="text-xs text-red-900">
                    También se anularán {activeWh.length} comprobante(s) de retención. Si ya los entregaste al proveedor o los declaraste, consúltalo con tu contador antes de anular.
                  </p>
                )}
                <div className="flex gap-2">
                  <input className="flex-1 rounded border p-2" placeholder="Motivo de la anulación" value={reason}
                    onChange={(e) => setReason(e.target.value)} />
                  <button disabled={busy} onClick={confirmVoid} className="rounded bg-red-700 px-3 py-2 text-white disabled:opacity-50">Anular</button>
                  <button onClick={() => setVoiding(false)} className="rounded border bg-white px-3 py-2">Cancelar</button>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              {isAdmin && d.status === "received" && !voiding && (
                <button onClick={() => { setVoiding(true); setError(""); }} className="rounded border border-red-400 px-4 py-2 text-red-700">
                  Anular compra
                </button>
              )}
              <button onClick={onClose} className="rounded border px-4 py-2">Cerrar</button>
            </div>
          </>
        )}
      </div>
      {voucherId && <VoucherModal id={voucherId} onClose={() => setVoucherId(null)} />}
    </div>
  );
}

export default function HistoryTab() {
  const [f, setF] = useState({ from: daysAgo(30), to: todayStr(), search: "", status: "" });
  const [rows, setRows] = useState([]);
  const [viewId, setViewId] = useState(null);
  const [error, setError] = useState("");
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  const load = useCallback(async () => {
    try {
      setRows(await purchasesApi.list({
        search: f.search.trim() || null, status: f.status || null,
        from: f.from || null, to: f.to || null, limit: 200,
      }));
      setError("");
    } catch (e) { setError(e.message); }
  }, [f]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  const input = "rounded border p-2";
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="text-sm">Desde
          <input type="date" className={`${input} mt-1 block`} value={f.from} onChange={(e) => set("from", e.target.value)} />
        </label>
        <label className="text-sm">Hasta
          <input type="date" className={`${input} mt-1 block`} value={f.to} onChange={(e) => set("to", e.target.value)} />
        </label>
        <select className={input} value={f.status} onChange={(e) => set("status", e.target.value)}>
          <option value="">Todas</option><option value="received">Registradas</option><option value="voided">Anuladas</option>
        </select>
        <input className={`${input} w-64`} placeholder="Número, factura o proveedor" value={f.search}
          onChange={(e) => set("search", e.target.value)} />
      </div>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Compra</th><th className="p-3">Fecha</th><th className="p-3">Proveedor</th>
              <th className="p-3">Almacén</th><th className="p-3">Factura</th><th className="p-3 text-right">Subtotal</th>
              <th className="p-3">Estado</th><th className="p-3"></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`border-b ${r.status === "voided" ? "opacity-50" : ""}`}>
                <td className="p-3 font-mono">{num(r.number)}</td>
                <td className="whitespace-nowrap p-3">{localDate(r.createdAt)}</td>
                <td className="p-3">{r.supplierName}</td>
                <td className="p-3">{r.warehouseName}</td>
                <td className="p-3">{r.invoiceNumber ?? "—"}</td>
                <td className="p-3 text-right">{formatMoney(r.totalMinor, r.currencyCode)}</td>
                <td className="p-3">{r.status === "voided" ? "Anulada" : "Registrada"}</td>
                <td className="p-3 text-right"><button className="underline" onClick={() => setViewId(r.id)}>Ver</button></td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={8} className="p-6 text-center text-slate-500">Sin compras con esos filtros</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {viewId && <Detail id={viewId} onClose={() => setViewId(null)} onChanged={load} />}
    </div>
  );
}