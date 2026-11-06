import { useCallback, useEffect, useState } from "react";
import { retentionsApi } from "../../services/api";
import { fromMinor, toMinor } from "../../utils/money";

const showPct = (bp) => (bp == null ? "—" : `${String(bp / 100).replace(".", ",")} %`);
const pctText = (bp) => (bp == null ? "" : String(bp / 100).replace(".", ","));

/** "" -> {value:null}; válido -> {value:bp}; inválido -> {error:true} */
const parsePct = (s) => {
  const t = String(s).trim().replace(",", ".");
  if (t === "") return { value: null };
  const v = Number(t);
  if (!Number.isFinite(v) || v <= 0 || v > 100) return { error: true };
  return { value: Math.round(v * 100) };
};

const EMPTY = { id: null, code: "", name: "", ratePnr: "", ratePjd: "", basePct: "100", minUt: "0", sustraendo: false };

export default function RetentionConfigTab() {
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState(null);
  const [concept, setConcept] = useState(null); // null | objeto del formulario de concepto
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const c = await retentionsApi.config();
      setCfg(c);
      setForm({
        agentIva: c.agentIva, agentIslr: c.agentIslr, ivaDefault: String(c.ivaDefaultBp),
        taxUnit: c.taxUnitMinor ? fromMinor(c.taxUnitMinor) : "",
      });
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn, ok) => {
    setError(""); setMsg(""); setBusy(true);
    try { await fn(); if (ok) setMsg(ok); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const saveConfig = (e) => {
    e.preventDefault();
    const ut = form.taxUnit.trim() === "" ? null : toMinor(form.taxUnit);
    if (form.taxUnit.trim() !== "" && ut === null) return setError("Valor de la unidad tributaria inválido (ejemplo: 43.00)");
    run(() => retentionsApi.saveConfig({
      agentIva: form.agentIva, agentIslr: form.agentIslr,
      ivaDefaultBp: Number(form.ivaDefault), taxUnitMinor: ut,
    }), "Configuración guardada");
  };

  const saveConcept = (e) => {
    e.preventDefault();
    const pnr = parsePct(concept.ratePnr), pjd = parsePct(concept.ratePjd), base = parsePct(concept.basePct);
    if (pnr.error || pjd.error || base.error || base.value === null) {
      return setError("Los porcentajes deben estar entre 0,01 y 100");
    }
    const minUt = Number(String(concept.minUt).trim().replace(",", ".") || "0");
    if (!Number.isFinite(minUt) || minUt < 0) return setError("Mínimo en unidades tributarias inválido");
    run(async () => {
      await retentionsApi.saveConcept({
        id: concept.id, code: concept.code, name: concept.name,
        ratePnrBp: pnr.value, ratePjdBp: pjd.value, basePctBp: base.value,
        minBaseUtMilli: Math.round(minUt * 1000), sustraendoPnr: concept.sustraendo,
      });
      setConcept(null);
    }, "Concepto guardado (los nuevos nacen desactivados)");
  };

  const editConcept = (c) => {
    setError(""); setMsg("");
    setConcept({
      id: c.id, code: c.code, name: c.name, ratePnr: pctText(c.ratePnrBp), ratePjd: pctText(c.ratePjdBp),
      basePct: pctText(c.basePctBp), minUt: String(c.minBaseUtMilli / 1000).replace(".", ","),
      sustraendo: c.sustraendoPnr,
    });
  };

  if (!cfg || !form) return <p className="text-slate-500">{error || "Cargando…"}</p>;
  const input = "w-full rounded border p-2";
  const setC = (k, v) => setConcept((c) => ({ ...c, [k]: v }));

  return (
    <div className="max-w-4xl space-y-6">
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        Las retenciones son una obligación tributaria: los porcentajes, mínimos y la unidad tributaria cambian con
        las normas del SENIAT. Confírmalos con tu contador antes de activarlos. El sistema no aplica ninguna
        retención hasta que marques que eres agente y actives los conceptos.
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {msg && <p className="text-sm text-green-700">{msg}</p>}

      <form onSubmit={saveConfig} className="space-y-3 rounded-xl bg-white p-4 shadow">
        <h2 className="font-semibold">Agente de retención</h2>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={form.agentIva} onChange={(e) => setForm({ ...form, agentIva: e.target.checked })} />
          <span>Soy agente de retención de IVA (sujeto pasivo especial designado por el SENIAT)</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={form.agentIslr} onChange={(e) => setForm({ ...form, agentIslr: e.target.checked })} />
          <span>Soy agente de retención de ISLR</span>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">Retención de IVA por defecto
            <select className={`${input} mt-1`} value={form.ivaDefault} onChange={(e) => setForm({ ...form, ivaDefault: e.target.value })}>
              <option value="7500">75 %</option><option value="10000">100 %</option>
            </select>
            <span className="text-xs text-slate-500">Cada proveedor puede tener el suyo (pestaña Proveedores).</span>
          </label>
          <label className="text-sm">Valor de la unidad tributaria (Bs.)
            <input className={`${input} mt-1`} placeholder="Ej.: 43.00" value={form.taxUnit}
              onChange={(e) => setForm({ ...form, taxUnit: e.target.value })} />
            <span className="text-xs text-slate-500">Se usa para el sustraendo y los mínimos del ISLR.</span>
          </label>
        </div>
        <button disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">Guardar</button>
      </form>

      <div className="space-y-3 rounded-xl bg-white p-4 shadow">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Conceptos de ISLR</h2>
          {!concept && <button onClick={() => { setConcept(EMPTY); setError(""); setMsg(""); }} className="rounded border px-3 py-1 text-sm">Nuevo concepto</button>}
        </div>

        {concept && (
          <form onSubmit={saveConcept} className="grid grid-cols-2 gap-3 rounded border bg-slate-50 p-3">
            <label className="text-sm">Código *
              <input className={`${input} mt-1`} value={concept.code} onChange={(e) => setC("code", e.target.value)} />
            </label>
            <label className="text-sm">Nombre *
              <input className={`${input} mt-1`} value={concept.name} onChange={(e) => setC("name", e.target.value)} />
            </label>
            <label className="text-sm">Tarifa persona natural residente (%)
              <input className={`${input} mt-1`} value={concept.ratePnr} onChange={(e) => setC("ratePnr", e.target.value)} placeholder="vacío = no aplica" />
            </label>
            <label className="text-sm">Tarifa persona jurídica domiciliada (%)
              <input className={`${input} mt-1`} value={concept.ratePjd} onChange={(e) => setC("ratePjd", e.target.value)} placeholder="vacío = no aplica" />
            </label>
            <label className="text-sm">Porcentaje de la base sujeta (%)
              <input className={`${input} mt-1`} value={concept.basePct} onChange={(e) => setC("basePct", e.target.value)} />
            </label>
            <label className="text-sm">Mínimo sujeto a retención (en UT)
              <input className={`${input} mt-1`} value={concept.minUt} onChange={(e) => setC("minUt", e.target.value)} />
            </label>
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={concept.sustraendo} onChange={(e) => setC("sustraendo", e.target.checked)} />
              Aplica sustraendo a persona natural (UT × tarifa × 83,3334)
            </label>
            <div className="col-span-2 flex gap-2">
              <button disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">Guardar</button>
              <button type="button" onClick={() => setConcept(null)} className="rounded border px-4 py-2">Cancelar</button>
            </div>
          </form>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-slate-100">
              <tr><th className="p-2">Concepto</th><th className="p-2">P. natural</th><th className="p-2">P. jurídica</th>
                <th className="p-2">Base</th><th className="p-2">Mín. (UT)</th><th className="p-2">Sustraendo</th>
                <th className="p-2">Estado</th><th className="p-2"></th></tr>
            </thead>
            <tbody>
              {cfg.concepts.map((c) => (
                <tr key={c.id} className={`border-b ${c.active ? "" : "opacity-60"}`}>
                  <td className="p-2">{c.name} <span className="font-mono text-xs text-slate-500">{c.code}</span></td>
                  <td className="p-2">{showPct(c.ratePnrBp)}</td><td className="p-2">{showPct(c.ratePjdBp)}</td>
                  <td className="p-2">{showPct(c.basePctBp)}</td><td className="p-2">{c.minBaseUtMilli / 1000}</td>
                  <td className="p-2">{c.sustraendoPnr ? "Sí" : "No"}</td>
                  <td className="p-2">{c.active ? "Activo" : "Desactivado"}</td>
                  <td className="space-x-2 p-2 text-right">
                    <button className="underline" disabled={busy} onClick={() => editConcept(c)}>Editar</button>
                    <button className="underline" disabled={busy}
                      onClick={() => run(() => retentionsApi.setConceptActive(c.id, !c.active))}>
                      {c.active ? "Desactivar" : "Activar"}
                    </button>
                  </td>
                </tr>
              ))}
              {cfg.concepts.length === 0 && (
                <tr><td colSpan={8} className="p-4 text-center text-slate-500">Sin conceptos</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-500">
          Los conceptos de fábrica (honorarios, comisiones e intereses) vienen desactivados y con las tarifas de las
          tablas del Decreto 1808 que encontré (3 % con sustraendo para persona natural y 5 % para jurídica). Revísalos
          y actívalos tú. Para servicios u otros conceptos, créalos con las tarifas que te indique tu contador.
        </p>
      </div>
    </div>
  );
}