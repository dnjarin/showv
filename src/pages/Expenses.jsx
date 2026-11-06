import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../store/authStore";
import { expensesApi } from "../services/api";
import { formatMoney, toMinor } from "../utils/money";
import { daysAgo, localDate, todayStr } from "../utils/dates";

const METHODS = {
  efectivo: "Efectivo", punto: "Punto de venta", pago_movil: "Pago móvil",
  transferencia: "Transferencia", zelle: "Zelle", otro: "Otro",
};
const fmtDate = (s) => (s ? s.split("-").reverse().join("/") : "—");
const input = "rounded border p-2";

function VoidBox({ voiding, setVoiding, onConfirm }) {
  if (!voiding) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2 rounded border border-red-300 bg-red-50 p-2">
      <input className="min-w-0 flex-1 rounded border p-2 text-sm" autoFocus
        placeholder="Motivo de la anulación (obligatorio)" value={voiding.reason}
        onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })} />
      <button onClick={onConfirm} className="rounded bg-red-700 px-3 py-2 text-sm text-white">Confirmar anulación</button>
      <button onClick={() => setVoiding(null)} className="rounded border px-3 py-2 text-sm">Cancelar</button>
    </div>
  );
}

function DateRange({ from, to, setFrom, setTo, children }) {
  return (
    <div className="mb-3 flex flex-wrap items-end gap-2">
      <label className="text-sm">Desde<input type="date" className={`${input} ml-1`} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className="text-sm">Hasta<input type="date" className={`${input} ml-1`} value={to} onChange={(e) => setTo(e.target.value)} /></label>
      {children}
    </div>
  );
}

export function ExpensesTab({ isAdmin }) {
  const [cats, setCats] = useState([]);
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(todayStr());
  const [catFilter, setCatFilter] = useState("");
  const [data, setData] = useState({ rows: [], byCategory: [], totalUsdMinor: 0 });
  const [form, setForm] = useState({ categoryId: "", description: "", date: todayStr(), method: "efectivo", currency: "USD", amount: "", reference: "" });
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await expensesApi.list({ from: from || null, to: to || null, categoryId: catFilter ? Number(catFilter) : null }));
    } catch (e) { setError(e.message); }
  }, [from, to, catFilter]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { expensesApi.categories(false).then(setCats).catch((e) => setError(e.message)); }, []);

  const save = async () => {
    setError(""); setMsg("");
    const m = toMinor(form.amount);
    if (!form.categoryId) return setError("Elige una categoría");
    if (m === null || m <= 0) return setError("Monto inválido (ejemplo: 25.00)");
    setBusy(true);
    try {
      await expensesApi.create({
        categoryId: Number(form.categoryId), description: form.description,
        expenseDate: form.date || null, method: form.method, currencyCode: form.currency,
        amountMinor: m, reference: form.reference.trim() || null,
      });
      setForm({ ...form, description: "", amount: "", reference: "" });
      setMsg("Gasto registrado");
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const confirmVoid = async () => {
    setError(""); setMsg("");
    try {
      await expensesApi.void(voiding.id, voiding.reason);
      setVoiding(null); setMsg("Gasto anulado"); await load();
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-white p-4 shadow">
        <h2 className="mb-2 font-semibold">Registrar gasto</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <select className={input} value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
            <option value="">Categoría…</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input className={`${input} sm:col-span-2`} placeholder="Descripción (ej.: pago de internet octubre)" value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <input type="date" className={input} max={todayStr()} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          <select className={input} value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
            {Object.entries(METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select className={input} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
            <option value="USD">USD</option><option value="VES">Bs.</option>
          </select>
          <input className={input} placeholder="Monto" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          <input className={input} placeholder="Referencia (opcional)" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
        </div>
        <button onClick={save} disabled={busy} className="mt-3 rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
          {busy ? "Guardando…" : "Registrar gasto"}
        </button>
        <p className="mt-2 text-xs text-slate-500">Un gasto en efectivo sale de tu caja abierta y se resta del efectivo esperado.</p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {msg && <p className="text-sm text-green-700">{msg}</p>}

      <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo}>
        <select className={input} value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
          <option value="">Todas las categorías</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </DateRange>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-xl bg-white p-4 shadow">
          <div className="text-sm text-slate-500">Total del período (USD equiv.)</div>
          <div className="text-2xl font-semibold">{formatMoney(data.totalUsdMinor, "USD")}</div>
          <div className="mt-3 space-y-1 text-sm">
            {data.byCategory.map((c) => (
              <div key={c.category} className="flex justify-between gap-2">
                <span>{c.category} <span className="text-slate-400">({c.count})</span></span>
                <span>{formatMoney(c.totalUsdMinor, "USD")}</span>
              </div>
            ))}
            {data.byCategory.length === 0 && <div className="text-slate-500">Sin gastos en el período</div>}
          </div>
        </div>
        <div className="overflow-x-auto rounded-xl bg-white shadow lg:col-span-2">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-slate-100">
              <tr><th className="p-2">N.º</th><th className="p-2">Fecha</th><th className="p-2">Categoría / descripción</th>
                <th className="p-2">Pago</th><th className="p-2 text-right">Monto</th><th className="p-2"></th></tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className={`border-b ${r.voided ? "text-slate-400 line-through" : ""}`}>
                  <td className="p-2 font-mono">G-{String(r.number).padStart(6, "0")}</td>
                  <td className="p-2">{fmtDate(r.expenseDate)}</td>
                  <td className="p-2">{r.category}<div className="text-xs text-slate-500">{r.description}{r.reference ? ` · ${r.reference}` : ""}</div></td>
                  <td className="p-2">{METHODS[r.method] ?? r.method}</td>
                  <td className="p-2 text-right">{formatMoney(r.amountMinor, r.currencyCode)}</td>
                  <td className="p-2">
                    {isAdmin && !r.voided && <button className="text-red-700 underline" onClick={() => setVoiding({ id: r.id, reason: "" })}>Anular</button>}
                  </td>
                </tr>
              ))}
              {data.rows.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-500">Sin gastos</td></tr>}
            </tbody>
          </table>
          <div className="px-3 pb-3"><VoidBox voiding={voiding} setVoiding={setVoiding} onConfirm={confirmVoid} /></div>
        </div>
      </div>
    </div>
  );
}

export function MovementsTab({ isAdmin }) {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(todayStr());
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ kind: "salida", concept: "", currency: "USD", amount: "" });
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState(null);

  const load = useCallback(async () => {
    try { setRows(await expensesApi.listMovements({ from: from || null, to: to || null, categoryId: null })); }
    catch (e) { setError(e.message); }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setError(""); setMsg("");
    const m = toMinor(form.amount);
    if (m === null || m <= 0) return setError("Monto inválido (ejemplo: 25.00)");
    setBusy(true);
    try {
      await expensesApi.createMovement({ kind: form.kind, concept: form.concept, currencyCode: form.currency, amountMinor: m });
      setForm({ ...form, concept: "", amount: "" });
      setMsg("Movimiento registrado en tu caja");
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const confirmVoid = async () => {
    setError(""); setMsg("");
    try {
      await expensesApi.voidMovement(voiding.id, voiding.reason);
      setVoiding(null); setMsg("Movimiento anulado"); await load();
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-white p-4 shadow">
        <h2 className="mb-2 font-semibold">Registrar movimiento de efectivo</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <select className={input} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="salida">Salida / retiro</option>
            <option value="entrada">Entrada / ingreso de fondo</option>
          </select>
          <input className={`${input} sm:col-span-2`} placeholder="Concepto (ej.: depósito al banco, cambio de billetes)" value={form.concept}
            onChange={(e) => setForm({ ...form, concept: e.target.value })} />
          <select className={input} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
            <option value="USD">USD</option><option value="VES">Bs.</option>
          </select>
          <input className={input} placeholder="Monto" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </div>
        <button onClick={save} disabled={busy} className="mt-3 rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
          {busy ? "Guardando…" : "Registrar movimiento"}
        </button>
        <p className="mt-2 text-xs text-slate-500">
          Es efectivo que entra o sale de tu caja sin ser una venta ni un gasto (retiro a banco, fondo adicional, cambio). Requiere caja abierta.
        </p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {msg && <p className="text-sm text-green-700">{msg}</p>}
      <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-2">N.º</th><th className="p-2">Fecha</th><th className="p-2">Tipo</th><th className="p-2">Concepto</th>
              <th className="p-2">Usuario</th><th className="p-2 text-right">Monto</th><th className="p-2"></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`border-b ${r.voided ? "text-slate-400 line-through" : ""}`}>
                <td className="p-2 font-mono">M-{String(r.number).padStart(6, "0")}</td>
                <td className="p-2">{localDate(r.createdAt)}</td>
                <td className="p-2">{r.kind === "entrada" ? "Entrada" : "Salida"}</td>
                <td className="p-2">{r.concept}</td>
                <td className="p-2">{r.user ?? "—"}</td>
                <td className="p-2 text-right">{r.kind === "entrada" ? "+" : "−"}{formatMoney(r.amountMinor, r.currencyCode)}</td>
                <td className="p-2">
                  {isAdmin && !r.voided && r.sessionOpen && (
                    <button className="text-red-700 underline" onClick={() => setVoiding({ id: r.id, reason: "" })}>Anular</button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-500">Sin movimientos</td></tr>}
          </tbody>
        </table>
        <div className="px-3 pb-3"><VoidBox voiding={voiding} setVoiding={setVoiding} onConfirm={confirmVoid} /></div>
      </div>
    </div>
  );
}

export function CategoriesTab() {
  const [cats, setCats] = useState([]);
  const [name, setName] = useState("");
  const [edit, setEdit] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setCats(await expensesApi.categories(true)); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    setError("");
    try { await expensesApi.saveCategory(null, name); setName(""); await load(); } catch (e) { setError(e.message); }
  };
  const rename = async () => {
    setError("");
    try { await expensesApi.saveCategory(edit.id, edit.name); setEdit(null); await load(); } catch (e) { setError(e.message); }
  };
  const toggle = async (c) => {
    setError("");
    try { await expensesApi.setCategoryActive(c.id, !c.active); await load(); } catch (e) { setError(e.message); }
  };

  return (
    <div className="max-w-xl space-y-3">
      <div className="flex gap-2">
        <input className={`${input} flex-1`} placeholder="Nueva categoría" value={name} onChange={(e) => setName(e.target.value)} />
        <button onClick={add} className="rounded bg-slate-900 px-4 py-2 text-white">Agregar</button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="rounded-xl bg-white shadow">
        {cats.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-2 border-b p-3 text-sm last:border-0">
            {edit?.id === c.id ? (
              <>
                <input className={`${input} flex-1`} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                <button className="underline" onClick={rename}>Guardar</button>
                <button className="underline" onClick={() => setEdit(null)}>Cancelar</button>
              </>
            ) : (
              <>
                <span className={c.active ? "" : "text-slate-400 line-through"}>{c.name}</span>
                <span>
                  <button className="underline" onClick={() => setEdit({ id: c.id, name: c.name })}>Renombrar</button>
                  <button className="ml-3 underline" onClick={() => toggle(c)}>{c.active ? "Desactivar" : "Activar"}</button>
                </span>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Expenses() {
  const isAdmin = useAuth((s) => s.user.role === "admin");
  const [tab, setTab] = useState("gastos");
  const tabs = [["gastos", "Gastos"], ["mov", "Movimientos de caja"], ...(isAdmin ? [["cats", "Categorías"]] : [])];
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Gastos y movimientos de caja</h1>
      <div className="mb-4 flex gap-2 border-b">
        {tabs.map(([k, v]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm ${tab === k ? "border-b-2 border-slate-900 font-semibold" : "text-slate-500"}`}>{v}</button>
        ))}
      </div>
      {tab === "gastos" && <ExpensesTab isAdmin={isAdmin} />}
      {tab === "mov" && <MovementsTab isAdmin={isAdmin} />}
      {tab === "cats" && isAdmin && <CategoriesTab />}
    </div>
  );
}
