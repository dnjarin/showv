import { useCallback, useEffect, useRef, useState } from "react";
import { ratesApi } from "../services/api";
import { fromMicro, toMicro } from "../utils/money";

/*
  Avisos de la tasa de cambio (USD → Bs.), en una ventana que no se puede ignorar sin elegir:
  - Administrador: si la tasa de hoy no está registrada, se le pide registrarla (o posponer 1 hora).
  - Cajero: si la tasa cambió desde la última vez que la vio, se le avisa con el valor anterior y el nuevo.
*/

const POLL_MS = 60_000;
const SNOOZE_MS = 60 * 60_000;
const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD en hora local

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

export default function RateWatcher({ user }) {
  const isAdmin = user.role === "admin";
  const isCashier = user.role === "cajero";
  const seenKey = `tekkadon_rate_seen_${user.id}`;
  const snoozeKey = `tekkadon_rate_snooze_${user.id}`;

  const [modal, setModal] = useState(null); // { kind: "admin", usd } | { kind: "changed", before, now }
  const [value, setValue] = useState("");
  const [warn, setWarn] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const open = useRef(false);
  open.current = !!modal;

  const check = useCallback(async () => {
    if (open.current || !(isAdmin || isCashier)) return;
    let usd;
    try {
      const data = await ratesApi.overview();
      usd = data.current.find((r) => r.currencyCode === "USD") ?? null;
    } catch {
      return; // sin conexión o sin permiso: se vuelve a intentar en el próximo ciclo
    }

    if (isAdmin) {
      const stale = !usd || usd.rateDate < today();
      const until = Number(read(snoozeKey) || 0);
      if (stale && Date.now() >= until) setModal({ kind: "admin", usd });
      return;
    }

    // Cajero
    if (!usd) return;
    let seen = null;
    try { seen = JSON.parse(read(seenKey) || "null"); } catch { /* se ignora */ }
    const now = { rateMicro: usd.rateMicro, rateDate: usd.rateDate, source: usd.source };
    if (!seen) { write(seenKey, JSON.stringify(now)); return; } // primera vez: solo se recuerda
    if (seen.rateMicro !== now.rateMicro) setModal({ kind: "changed", before: seen, now });
  }, [isAdmin, isCashier, seenKey, snoozeKey]);

  useEffect(() => {
    check();
    const t = setInterval(check, POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, [check]);

  const close = () => { setModal(null); setValue(""); setWarn(""); setError(""); };

  const snooze = () => { write(snoozeKey, String(Date.now() + SNOOZE_MS)); close(); };

  const ack = () => {
    write(seenKey, JSON.stringify(modal.now));
    close();
  };

  const save = async (confirm) => {
    const micro = toMicro(value);
    if (micro === null) return setError("Tasa inválida (ejemplo: 36,5412, hasta 6 decimales)");
    setBusy(true); setError("");
    try {
      await ratesApi.set({ currencyCode: "USD", rateMicro: micro, rateDate: today(), source: "BCV" }, confirm);
      write(snoozeKey, "0");
      close();
      window.dispatchEvent(new Event("tekkadon:rate-changed"));
    } catch (e) {
      if (e.message.includes("Confirma para guardarla")) setWarn(e.message);
      else setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!modal) return null;

  return (
    <div className="dm fixed inset-0 z-[60] grid place-items-center bg-black/60 p-4" role="alertdialog" aria-modal="true">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        {modal.kind === "admin" ? (
          <>
            <h2 className="text-lg font-semibold text-slate-900">
              {modal.usd ? "La tasa de hoy no está registrada" : "No hay una tasa registrada"}
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              {modal.usd
                ? <>La última es <b>{fromMicro(modal.usd.rateMicro)} Bs/USD</b> del {modal.usd.rateDate}. Los cajeros están facturando con ella.</>
                : "Se necesita para facturar en divisas."}
              {" "}Registra la tasa de hoy ({today()}):
            </p>
            <form onSubmit={(e) => { e.preventDefault(); save(false); }} className="mt-3">
              <label className="block text-sm text-slate-700">Tasa (Bs por 1 USD)
                <input autoFocus className="mt-1 block w-full rounded border p-2" placeholder="36,5412" value={value}
                  onChange={(e) => { setValue(e.target.value); setWarn(""); setError(""); }} />
              </label>
              {warn && <p className="mt-2 rounded bg-amber-50 p-2 text-sm text-amber-800">{warn}</p>}
              {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button type="button" onClick={snooze} className="rounded border px-4 py-2 text-sm text-slate-700">
                  Recordármelo en 1 hora
                </button>
                {warn ? (
                  <button type="button" disabled={busy} onClick={() => save(true)}
                    className="rounded bg-amber-600 px-4 py-2 text-sm text-white disabled:opacity-50">
                    Confirmar y guardar
                  </button>
                ) : (
                  <button disabled={busy || !value.trim()} className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">
                    {busy ? "Guardando…" : "Guardar tasa"}
                  </button>
                )}
              </div>
            </form>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold text-slate-900">La tasa de cambio cambió</h2>
            <div className="mt-3 flex items-center justify-center gap-4 rounded-lg bg-slate-100 p-3 text-center">
              <div>
                <div className="text-xs text-slate-500">Antes</div>
                <div className="text-xl font-semibold text-slate-600 line-through">{fromMicro(modal.before.rateMicro)}</div>
              </div>
              <div className="text-2xl text-slate-400">→</div>
              <div>
                <div className="text-xs text-slate-500">Ahora ({modal.now.source}, {modal.now.rateDate})</div>
                <div className="text-3xl font-semibold text-slate-900">{fromMicro(modal.now.rateMicro)}</div>
              </div>
            </div>
            <p className="mt-3 text-sm text-slate-600">
              Los precios en bolívares se calculan con la tasa nueva. Si tienes una venta abierta, revisa los montos antes de cobrar.
            </p>
            <div className="mt-4 flex justify-end">
              <button autoFocus onClick={ack} className="rounded bg-slate-900 px-5 py-2 text-sm text-white">Entendido</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
