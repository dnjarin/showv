import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../store/authStore";
import { cashApi } from "../services/api";
import { formatMoney, toMinor } from "../utils/money";
import { localDate } from "../utils/dates";

const METHODS = {
  efectivo: "Efectivo", punto: "Punto de venta", pago_movil: "Pago móvil",
  transferencia: "Transferencia", zelle: "Zelle", otro: "Otro", saldo_favor: "Saldo a favor",
};

function Summary({ s }) {
  return (
    <div className="rounded-xl bg-white p-4 shadow">
      <div className="mb-2 text-sm text-slate-500">
        Cajero: <b>{s.username}</b> · Abierta: {localDate(s.openedAt)}
        {s.closedAt && <> · Cerrada: {localDate(s.closedAt)}</>}
      </div>
      <div className="mb-3 text-sm">
        Ventas emitidas: <b>{s.salesCount}</b> · Anuladas: <b>{s.voidedCount}</b>
      </div>
      <table className="mb-3 w-full text-left text-sm">
        <thead className="border-b bg-slate-100">
          <tr><th className="p-2">Método</th><th className="p-2">Moneda</th>
            <th className="p-2">Pagos</th><th className="p-2">Cobrado</th></tr>
        </thead>
        <tbody>
          {s.methods.map((m, i) => (
            <tr key={i} className="border-b">
              <td className="p-2">{METHODS[m.method] ?? m.method}</td>
              <td className="p-2">{m.currencyCode}</td>
              <td className="p-2">{m.count}</td>
              <td className="p-2">{formatMoney(m.collectedMinor, m.currencyCode)}</td>
            </tr>
          ))}
          {s.methods.length === 0 && (
            <tr><td colSpan={4} className="p-3 text-center text-slate-500">Sin cobros todavía</td></tr>
          )}
        </tbody>
      </table>
      {s.refunds && s.refunds.length > 0 && (
        <div className="mb-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          <div className="mb-1 font-semibold text-amber-900">Devoluciones pagadas al cliente</div>
          {s.refunds.map((m, i) => (
            <div key={i} className="flex justify-between">
              <span>{METHODS[m.method] ?? m.method} · {m.currencyCode} ({m.count})</span>
              <span>{formatMoney(m.collectedMinor, m.currencyCode)}</span>
            </div>
          ))}
          <p className="mt-1 text-xs text-amber-900">Las devoluciones en efectivo se restan del efectivo esperado.</p>
        </div>
      )}
      {((s.expenses && s.expenses.length > 0) || (s.movements && s.movements.length > 0)) && (
        <div className="mb-3 rounded border border-slate-300 bg-slate-50 p-3 text-sm">
          <div className="mb-1 font-semibold text-slate-800">Gastos y movimientos de caja</div>
          {(s.expenses ?? []).map((m, i) => (
            <div key={`e${i}`} className="flex justify-between">
              <span>Gastos · {METHODS[m.method] ?? m.method} · {m.currencyCode} ({m.count})</span>
              <span>−{formatMoney(m.collectedMinor, m.currencyCode)}</span>
            </div>
          ))}
          {(s.movements ?? []).map((m, i) => (
            <div key={`m${i}`} className="flex justify-between">
              <span>{m.method === "entrada" ? "Ingresos de fondo" : "Retiros / salidas"} · {m.currencyCode} ({m.count})</span>
              <span>{m.method === "entrada" ? "+" : "−"}{formatMoney(m.collectedMinor, m.currencyCode)}</span>
            </div>
          ))}
          <p className="mt-1 text-xs text-slate-600">Los gastos en efectivo y los movimientos ajustan el efectivo esperado.</p>
        </div>
      )}
      {s.payments && s.payments.length > 0 && (
        <div className="mb-3 rounded border border-rose-300 bg-rose-50 p-3 text-sm">
          <div className="mb-1 font-semibold text-rose-900">Pagos a proveedores</div>
          {s.payments.map((m, i) => (
            <div key={i} className="flex justify-between">
              <span>{METHODS[m.method] ?? m.method} · {m.currencyCode} ({m.count})</span>
              <span>{formatMoney(m.collectedMinor, m.currencyCode)}</span>
            </div>
          ))}
          <p className="mt-1 text-xs text-rose-900">Los pagos en efectivo se restan del efectivo esperado.</p>
        </div>
      )}
      {s.receipts && s.receipts.length > 0 && (
        <div className="mb-3 rounded border border-purple-300 bg-purple-50 p-3 text-sm">
          <div className="mb-1 font-semibold text-purple-900">Abonos de cuentas por cobrar</div>
          {s.receipts.map((m, i) => (
            <div key={i} className="flex justify-between">
              <span>{METHODS[m.method] ?? m.method} · {m.currencyCode} ({m.count})</span>
              <span>{formatMoney(m.collectedMinor, m.currencyCode)}</span>
            </div>
          ))}
          <p className="mt-1 text-xs text-purple-900">Los abonos en efectivo se suman al efectivo esperado.</p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded border p-3">
          <div className="text-slate-500">Efectivo esperado Bs.</div>
          <div className="text-lg font-semibold">{formatMoney(s.expectedVesMinor, "VES")}</div>
          {s.changeVesMinor > 0 && (
            <div className="text-xs text-slate-500">Descuenta vuelto entregado: {formatMoney(s.changeVesMinor, "VES")}</div>
          )}
          {s.countedVesMinor != null && (
            <div>Contado: {formatMoney(s.countedVesMinor, "VES")} · Dif.:{" "}
              <b>{formatMoney(s.countedVesMinor - s.expectedVesMinor, "VES")}</b></div>
          )}
        </div>
        <div className="rounded border p-3">
          <div className="text-slate-500">Efectivo esperado USD</div>
          <div className="text-lg font-semibold">{formatMoney(s.expectedUsdMinor, "USD")}</div>
          {s.changeUsdMinor > 0 && (
            <div className="text-xs text-slate-500">Descuenta vuelto entregado: {formatMoney(s.changeUsdMinor, "USD")}</div>
          )}
          {s.countedUsdMinor != null && (
            <div>Contado: {formatMoney(s.countedUsdMinor, "USD")} · Dif.:{" "}
              <b>{formatMoney(s.countedUsdMinor - s.expectedUsdMinor, "USD")}</b></div>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        «Cobrado» son las ventas netas. El efectivo esperado suma lo realmente recibido y resta el vuelto entregado.
      </p>
      {s.notes && <p className="mt-2 text-sm">Notas: {s.notes}</p>}
    </div>
  );
}

export default function Cash({ embedded = false }) {
  const isAdmin = useAuth((s) => s.user.role === "admin");
  const [session, setSession] = useState(undefined); // undefined = cargando, null = sin caja
  const [history, setHistory] = useState([]);
  const [closedResult, setClosedResult] = useState(null);
  const [form, setForm] = useState({ ves: "0.00", usd: "0.00", notes: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSession(await cashApi.current());
      if (isAdmin) setHistory(await cashApi.history());
    } catch (e) { setError(e.message); }
  }, [isAdmin]);
  useEffect(() => { load(); }, [load]);

  const amounts = () => {
    const ves = toMinor(form.ves), usd = toMinor(form.usd);
    if (ves === null || usd === null) { setError("Montos inválidos (ejemplo: 12.50)"); return null; }
    return { ves, usd };
  };

  const open = async (e) => {
    e.preventDefault(); setError("");
    const a = amounts(); if (!a) return;
    setBusy(true);
    try {
      setSession(await cashApi.open(a.ves, a.usd));
      setClosedResult(null);
      setForm({ ves: "0.00", usd: "0.00", notes: "" });
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const close = async (e) => {
    e.preventDefault(); setError("");
    const a = amounts(); if (!a) return;
    if (!window.confirm("¿Cerrar la caja? Ya no podrás vender hasta abrir una nueva.")) return;
    setBusy(true);
    try {
      setClosedResult(await cashApi.close(a.ves, a.usd, form.notes.trim() || null));
      setSession(null);
      setForm({ ves: "0.00", usd: "0.00", notes: "" });
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const input = "rounded border p-2";
  if (session === undefined) return <p className="text-slate-500">Cargando…</p>;

  return (
    <div className="max-w-3xl">
      {!embedded && <h1 className="mb-4 text-2xl font-semibold">Caja</h1>}
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {closedResult && (
        <div className="mb-6">
          <h2 className="mb-2 font-semibold text-green-700">Caja cerrada correctamente</h2>
          <Summary s={closedResult} />
        </div>
      )}

      {session === null && (
        <form onSubmit={open} className="mb-6 flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow">
          <div className="w-full font-semibold">Abrir caja</div>
          <label className="text-sm">Fondo en Bs.
            <input className={`${input} mt-1 block w-36`} value={form.ves}
              onChange={(e) => setForm({ ...form, ves: e.target.value })} />
          </label>
          <label className="text-sm">Fondo en USD
            <input className={`${input} mt-1 block w-36`} value={form.usd}
              onChange={(e) => setForm({ ...form, usd: e.target.value })} />
          </label>
          <button disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
            Abrir caja
          </button>
        </form>
      )}

      {session && (
        <>
          <Summary s={session} />
          <form onSubmit={close} className="mt-4 flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow">
            <div className="w-full font-semibold">Cerrar caja (cuenta el efectivo físico)</div>
            <label className="text-sm">Contado en Bs.
              <input className={`${input} mt-1 block w-36`} value={form.ves}
                onChange={(e) => setForm({ ...form, ves: e.target.value })} />
            </label>
            <label className="text-sm">Contado en USD
              <input className={`${input} mt-1 block w-36`} value={form.usd}
                onChange={(e) => setForm({ ...form, usd: e.target.value })} />
            </label>
            <input className={`${input} w-full`} placeholder="Notas (obligatorias si hay diferencia)"
              value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            <button disabled={busy} className="rounded bg-red-700 px-4 py-2 text-white disabled:opacity-50">
              Cerrar caja
            </button>
          </form>
        </>
      )}

      {isAdmin && (
        <div className="mt-8">
          <h2 className="mb-2 font-semibold">Historial de cajas</h2>
          <div className="overflow-x-auto rounded-xl bg-white shadow">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-slate-100">
                <tr><th className="p-3">Cajero</th><th className="p-3">Apertura</th><th className="p-3">Cierre</th>
                  <th className="p-3">Ventas</th><th className="p-3">Dif. Bs.</th><th className="p-3">Dif. USD</th></tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className="border-b">
                    <td className="p-3">{h.username}</td>
                    <td className="p-3">{localDate(h.openedAt)}</td>
                    <td className="p-3">{h.closedAt ? localDate(h.closedAt) : "Abierta"}</td>
                    <td className="p-3">{h.salesCount}</td>
                    <td className="p-3">{h.closedAt ? formatMoney(h.countedVesMinor - h.expectedVesMinor, "VES") : "—"}</td>
                    <td className="p-3">{h.closedAt ? formatMoney(h.countedUsdMinor - h.expectedUsdMinor, "USD") : "—"}</td>
                  </tr>
                ))}
                {history.length === 0 && (
                  <tr><td colSpan={6} className="p-6 text-center text-slate-500">Sin cajas registradas</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}