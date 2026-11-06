import { useCallback, useEffect, useState } from "react";
import { catalogApi } from "../../services/api";

export default function CategoriesTab() {
  const [rows, setRows] = useState([]);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(null); // { id, name }
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setRows(await catalogApi.categories()); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn, ok) => {
    setError(""); setMsg(""); setBusy(true);
    try { const r = await fn(); if (ok) setMsg(typeof ok === "function" ? ok(r) : ok); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const create = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    run(async () => { const r = await catalogApi.createCategory(name); setName(""); return r; },
      (r) => (r.existed ? `«${r.name}» ya existe` : `Categoría «${r.name}» creada`));
  };

  const input = "rounded border p-2";
  return (
    <div className="max-w-2xl">
      <form onSubmit={create} className="mb-4 flex gap-2">
        <input className={`${input} flex-1`} placeholder="Nueva categoría" value={name}
          onChange={(e) => setName(e.target.value)} />
        <button disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">Crear</button>
      </form>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      {msg && <p className="mb-2 text-sm text-green-700">{msg}</p>}

      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Categoría</th><th className="p-3 text-right">Productos</th><th className="p-3"></th></tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-b">
                <td className="p-3">
                  {editing?.id === c.id ? (
                    <form className="flex gap-2" onSubmit={(e) => {
                      e.preventDefault();
                      run(async () => { await catalogApi.renameCategory(c.id, editing.name); setEditing(null); }, "Categoría renombrada");
                    }}>
                      <input className={`${input} flex-1`} autoFocus value={editing.name}
                        onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                      <button className="underline" disabled={busy}>Guardar</button>
                      <button type="button" className="underline" onClick={() => setEditing(null)}>Cancelar</button>
                    </form>
                  ) : c.name}
                </td>
                <td className="p-3 text-right">{c.products}</td>
                <td className="space-x-2 p-3 text-right">
                  {editing?.id !== c.id && (
                    <>
                      <button className="underline" disabled={busy} onClick={() => setEditing({ id: c.id, name: c.name })}>Renombrar</button>
                      <button className="underline" disabled={busy}
                        onClick={() => window.confirm(`¿Eliminar la categoría «${c.name}»?`) &&
                          run(() => catalogApi.deleteCategory(c.id), "Categoría eliminada")}>Eliminar</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={3} className="p-6 text-center text-slate-500">Aún no hay categorías</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-500">Una categoría con productos no se puede eliminar: muévelos primero.</p>
    </div>
  );
}