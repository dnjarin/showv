import { useEffect, useState } from "react";
import { settingsApi } from "../services/api";
import LanCard from "../components/LanCard";
import KeyCard from "../components/KeyCard";
import QuoteStyleCard from "../components/QuoteStyleCard";

const toBp = (s) => {
  const v = Number(String(s).trim().replace(",", "."));
  return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null;
};
const fromBp = (bp) => String(bp / 100).replace(".", ",");

export default function Settings() {
  const [form, setForm] = useState(null);
  const [rates, setRates] = useState([]);
  const [hasCode, setHasCode] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const load = async () => {
    try {
      const s = await settingsApi.get();
      setForm({
        rif: s.company.rif,
        legalName: s.company.legalName,
        tradeName: s.company.tradeName ?? "",
        fiscalAddress: s.company.fiscalAddress,
        phone: s.company.phone ?? "",
        email: s.company.email ?? "",
        igtf: fromBp(s.igtfBp),
        maxDiscount: fromBp(s.cashierMaxDiscountBp),
        legend: s.receiptLegend,
      });
      setRates(s.taxRates.map((t) => ({ ...t, pct: fromBp(t.rateBp) })));
      setHasCode(s.hasRecoveryCode);
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => { load(); }, []);

  const save = async (e) => {
    e.preventDefault();
    setError(""); setMsg("");
    const igtfBp = toBp(form.igtf);
    if (igtfBp === null) return setError("IGTF inválido (ejemplo: 3)");
    const maxDiscBp = toBp(form.maxDiscount);
    if (maxDiscBp === null || maxDiscBp > 10000) return setError("Descuento máximo del cajero inválido (0 a 100)");
    const taxRates = [];
    for (const t of rates) {
      const bp = toBp(t.pct);
      if (bp === null) return setError(`Porcentaje inválido en «${t.name}»`);
      taxRates.push({ id: t.id, rateBp: bp });
    }
    setBusy(true);
    try {
      await settingsApi.save({
        company: {
          rif: form.rif,
          legalName: form.legalName,
          tradeName: form.tradeName.trim() || null,
          fiscalAddress: form.fiscalAddress,
          phone: form.phone.trim() || null,
          email: form.email.trim() || null,
        },
        igtfBp,
        cashierMaxDiscountBp: maxDiscBp,
        receiptLegend: form.legend,
        taxRates,
      });
      setMsg("Configuración guardada. Los cambios aplican a las ventas nuevas.");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    if (hasCode && !window.confirm("Ya existe un código. Generar uno nuevo invalida el anterior. ¿Continuar?")) return;
    setError(""); setMsg("");
    try {
      setCode(await settingsApi.generateRecoveryCode());
      setHasCode(true);
    } catch (e) {
      setError(e.message);
    }
  };

  if (!form) return <p className="text-slate-500">{error || "Cargando…"}</p>;

  const input = "mt-1 w-full rounded border p-2";
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Configuración</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {msg && <p className="text-sm text-green-700">{msg}</p>}

      <form onSubmit={save} className="space-y-6">
        <section className="grid grid-cols-2 gap-3 rounded-xl bg-white p-4 shadow">
          <h2 className="col-span-2 font-semibold">Datos de la empresa</h2>
          <label className="text-sm">RIF *
            <input className={input} value={form.rif} onChange={(e) => set("rif", e.target.value)} />
          </label>
          <label className="text-sm">Razón social *
            <input className={input} value={form.legalName} onChange={(e) => set("legalName", e.target.value)} />
          </label>
          <label className="text-sm">Nombre comercial
            <input className={input} value={form.tradeName} onChange={(e) => set("tradeName", e.target.value)} />
          </label>
          <label className="text-sm">Teléfono
            <input className={input} value={form.phone} onChange={(e) => set("phone", e.target.value)} />
          </label>
          <label className="col-span-2 text-sm">Domicilio fiscal *
            <input className={input} value={form.fiscalAddress} onChange={(e) => set("fiscalAddress", e.target.value)} />
          </label>
          <label className="col-span-2 text-sm">Correo
            <input className={input} value={form.email} onChange={(e) => set("email", e.target.value)} />
          </label>
          <p className="col-span-2 text-xs text-slate-500">
            Los documentos ya emitidos conservan los datos con los que se hicieron.
          </p>
        </section>

        <section className="rounded-xl bg-white p-4 shadow">
          <h2 className="mb-3 font-semibold">Impuestos</h2>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">IGTF (%)
              <input className={input} value={form.igtf} onChange={(e) => set("igtf", e.target.value)} />
            </label>
            <label className="text-sm">Descuento máximo del cajero (%)
              <input className={input} value={form.maxDiscount} onChange={(e) => set("maxDiscount", e.target.value)} />
            </label>
          </div>
          <table className="mt-4 w-full text-left text-sm">
            <thead className="border-b bg-slate-100">
              <tr><th className="p-2">Impuesto</th><th className="p-2">Porcentaje (%)</th></tr>
            </thead>
            <tbody>
              {rates.map((t, i) => (
                <tr key={t.id} className="border-b">
                  <td className="p-2">{t.name}</td>
                  <td className="p-2">
                    <input className="w-28 rounded border p-1 disabled:bg-slate-100" value={t.pct}
                      disabled={!t.editable}
                      onChange={(e) => setRates((rs) => rs.map((r, j) => (j === i ? { ...r, pct: e.target.value } : r)))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-slate-500">
            Confirma las alícuotas vigentes con tu contador. El cambio afecta solo ventas nuevas.
          </p>
        </section>

        <section className="rounded-xl bg-white p-4 shadow">
          <h2 className="mb-3 font-semibold">Ticket</h2>
          <label className="block text-sm">Leyenda del comprobante (obligatoria)
            <input className={input} value={form.legend} onChange={(e) => set("legend", e.target.value)} />
          </label>
          <p className="mt-1 text-xs text-slate-500">
            Mientras el comprobante sea interno, debe aclarar que no tiene validez fiscal.
          </p>
        </section>

        <button disabled={busy} className="rounded bg-slate-900 px-5 py-2 text-white disabled:opacity-50">
          {busy ? "Guardando…" : "Guardar configuración"}
        </button>
      </form>

      <section className="rounded-xl bg-white p-4 shadow">
        <h2 className="mb-1 font-semibold">Código de recuperación del administrador</h2>
        <p className="mb-3 text-sm text-slate-600">
          Si un administrador olvida su contraseña, este código le permite crear una nueva desde la pantalla de
          inicio de sesión. Sirve una sola vez. Estado actual:{" "}
          <b>{hasCode ? "hay un código activo" : "no hay ningún código"}</b>.
        </p>
        {code && (
          <div className="mb-3 rounded-lg border-2 border-amber-400 bg-amber-50 p-3">
            <div className="text-xs font-semibold text-amber-900">
              Anótalo ahora y guárdalo en un lugar seguro. No se volverá a mostrar.
            </div>
            <div className="my-2 select-all font-mono text-xl tracking-wider">{code}</div>
          </div>
        )}
        <button onClick={generate} className="rounded border px-4 py-2">
          {hasCode ? "Generar un código nuevo" : "Generar código"}
        </button>
        <p className="mt-2 text-xs text-slate-500">
          Quien tenga este código puede tomar el control de una cuenta de administrador: trátalo como una llave.
        </p>
      </section>

      <QuoteStyleCard />

      <KeyCard />

      <LanCard />
    </div>
  );
}