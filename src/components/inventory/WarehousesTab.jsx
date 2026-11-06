import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../store/authStore";
import { warehousesApi } from "../../services/api";
import { WAREHOUSE_KINDS } from "./labels";

export default function WarehousesTab() {
  const isAdmin = useAuth((s) => s.user.role === "admin");
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null); // null | "new" | almacén
  const [form, setForm] = useState({ code: "", name: "", address: "", kind: "general" });
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setRows(await warehousesApi.list(true)); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const startEdit = (w) => {
    setEditing(w);
    setForm(w === "new" ? { code: "", name: "", address: "", kind: "general" } : { code: w.code, name: w.name, address: w.address ?? "", kind: w.kind ?? "general" });
    setError(""); setMsg("");
  };

  const run = async (fn, ok) => {
    setError(""); setMsg(""); setBusy(true);
    try { await fn(); if (ok) setMsg(ok); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const addr = form.address.trim() || null;
      if (editing === "new") await warehousesApi.create(form.code, form.name, addr, form.kind);
      else await warehousesApi.update(editing.id, form.code, form.name, addr, form.kind);
      setEditing(null);
    }, "Almacén guardado");
  };

  const input = "w-full rounded border p-2";
  return (
    <div className="max-w-4xl">
      <div className="mb-3 rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-600">
        Las ventas descuentan siempre del <b>almacén de ventas</b>, y las anulaciones devuelven el stock al
        almacén del que salió. Para vender desde otro almacén, márcalo como almacén de ventas. Usa los tipos <b>Garantía</b> y <b>Dañado / merma</b> para separar esa mercancía y
        muévela con un traspaso desde Inventario → Traspasos.
      </div>

      {isAdmin && !editing && (
        <button onClick={() => startEdit("new")} className="mb-3 rounded bg-slate-900 px-4 py-2 text-white">
          Nuevo almacén
        </button>
      )}

      {editing && (
        <form onSubmit={save} className="mb-4 grid grid-cols-2 gap-3 rounded-xl bg-white p-4 shadow">
          <h2 className="col-span-2 font-semibold">{editing === "new" ? "Nuevo almacén" : "Editar almacén"}</h2>
          <input className={input} placeholder="Código * (ej. TIENDA)" value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })} />
          <input className={input} placeholder="Nombre *" autoFocus value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <label className="col-span-2 text-sm text-slate-600">Tipo de almacén
            <select className={`${input} mt-1`} value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {Object.entries(WAREHOUSE_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <input className={`${input} col-span-2`} placeholder="Dirección o referencia (opcional)" value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })} />
          <div className="col-span-2 flex gap-2">
            <button disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">Guardar</button>
            <button type="button" onClick={() => setEditing(null)} className="rounded border px-4 py-2">Cancelar</button>
          </div>
        </form>
      )}

      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      {msg && <p className="mb-2 text-sm text-green-700">{msg}</p>}

      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Código</th><th className="p-3">Nombre</th><th className="p-3">Tipo</th><th className="p-3">Dirección</th>
              <th className="p-3 text-right">Productos</th><th className="p-3 text-right">Unidades</th>
              <th className="p-3">Estado</th>{isAdmin && <th className="p-3"></th>}</tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.id} className={`border-b ${w.active ? "" : "opacity-50"}`}>
                <td className="p-3 font-mono">{w.code}</td>
                <td className="p-3">{w.name}</td>
                <td className="p-3">{WAREHOUSE_KINDS[w.kind] ?? w.kind}</td>
                <td className="p-3">{w.address ?? "—"}</td>
                <td className="p-3 text-right">{w.productsWithStock}</td>
                <td className="p-3 text-right">{w.units}</td>
                <td className="p-3">
                  {w.isSales && <span className="mr-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">Ventas</span>}
                  {w.active ? "Activo" : "Inactivo"}
                </td>
                {isAdmin && (
                  <td className="space-x-2 p-3 text-right">
                    <button className="underline" disabled={busy} onClick={() => startEdit(w)}>Editar</button>
                    {w.active && !w.isSales && w.kind === "general" && (
                      <button className="underline" disabled={busy}
                        onClick={() => run(() => warehousesApi.setSales(w.id), "Almacén de ventas actualizado")}>
                        Usar para ventas</button>
                    )}
                    {!w.isSales && (
                      <button className="underline" disabled={busy}
                        onClick={() => run(() => warehousesApi.setActive(w.id, !w.active))}>
                        {w.active ? "Desactivar" : "Activar"}</button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}