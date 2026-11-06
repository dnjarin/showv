import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../store/authStore";
import { ratesApi } from "../services/api";
import { fromMicro, toMicro } from "../utils/money";

const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD en hora local

export default function Rates() {
  const isAdmin = useAuth((s) => s.user.role === "admin");
  const [data, setData] = useState({ current: [], history: [] });
  const [form, setForm] = useState({ rate: "", rateDate: today(), source: "BCV" });
  const [error, setError] = useState("");
  const [warn, setWarn] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setData(await ratesApi.overview()); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (confirm) => {
    const micro = toMicro(form.rate);
    if (micro === null) return setError("Tasa inválida (ejemplo: 36,5412, hasta 6 decimales)");
    setBusy(true); setError(""); setMsg("");
    try {
      await ratesApi.set(
        { currencyCode: "USD", rateMicro: micro, rateDate: form.rateDate, source: form.source },
        confirm
      );
      setWarn(""); setMsg("Tasa guardada"); setForm({ ...form, rate: "" }); load();
    } catch (err) {
      if (err.message.includes("Confirma para guardarla")) setWarn(err.message);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const usd = data.current.find((r) => r.currencyCode === "USD");
  const input = "rounded border p-2";

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Tasas de cambio</h1>

      {usd ? (
        <div className="mb-6 max-w-sm rounded-xl bg-white p-4 shadow">
          <div className="text-sm text-slate-500">Tasa vigente USD → Bs. ({usd.source})</div>
          <div className="text-3xl font-semibold">{fromMicro(usd.rateMicro)}</div>
          <div className="text-sm text-slate-500">Fecha: {usd.rateDate}</div>
        </div>
      ) : (
        <div className="mb-6 max-w-xl rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900">
          No hay una tasa USD vigente. Se necesita para facturar en divisas.
        </div>
      )}

      {isAdmin && (
        <form onSubmit={(e) => { e.preventDefault(); save(false); }}
          className="mb-6 flex max-w-2xl flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow">
          <label className="text-sm">Tasa (Bs por 1 USD)
            <input className={`${input} mt-1 block w-40`} placeholder="36,5412" value={form.rate}
              onChange={(e) => { setForm({ ...form, rate: e.target.value }); setWarn(""); }} />
          </label>
          <label className="text-sm">Fecha
            <input type="date" className={`${input} mt-1 block`} value={form.rateDate}
              onChange={(e) => setForm({ ...form, rateDate: e.target.value })} />
          </label>
          <label className="text-sm">Fuente
            <select className={`${input} mt-1 block`} value={form.source}
              onChange={(e) => setForm({ ...form, source: e.target.value })}>
              <option value="BCV">BCV</option>
              <option value="manual">Manual</option>
            </select>
          </label>
          <button disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
            Guardar tasa
          </button>
          {error && <p className="w-full text-sm text-red-600">{error}</p>}
          {msg && <p className="w-full text-sm text-green-700">{msg}</p>}
          {warn && (
            <div className="w-full rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {warn}
              <button type="button" onClick={() => save(true)} className="ml-3 underline">
                Guardar de todos modos
              </button>
            </div>
          )}
        </form>
      )}
      {!isAdmin && error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <h2 className="mb-2 font-semibold">Historial</h2>
      <div className="max-w-2xl overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Fecha</th><th className="p-3">Moneda</th><th className="p-3">Tasa</th>
              <th className="p-3">Fuente</th><th className="p-3">Registrada por</th></tr>
          </thead>
          <tbody>
            {data.history.map((r) => (
              <tr key={r.id} className="border-b">
                <td className="p-3">{r.rateDate}</td><td className="p-3">{r.currencyCode}</td>
                <td className="p-3 font-mono">{fromMicro(r.rateMicro)}</td>
                <td className="p-3">{r.source}</td><td className="p-3">{r.username ?? "—"}</td>
              </tr>
            ))}
            {data.history.length === 0 && (
              <tr><td colSpan={5} className="p-6 text-center text-slate-500">Aún no hay tasas registradas</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}