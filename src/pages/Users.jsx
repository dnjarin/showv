import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../store/authStore";
import { usersApi } from "../services/api";

const ROLES = { admin: "Administrador", cajero: "Cajero", almacen: "Almacén" };
const EMPTY = { username: "", fullName: "", password: "", role: "cajero" };

export default function Users() {
  const me = useAuth((s) => s.user);
  const [rows, setRows] = useState([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null);   // { id, fullName, role }
  const [resetting, setResetting] = useState(null); // { id, username, password }
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setRows(await usersApi.list()); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn, okMsg) => {
    setError(""); setMsg(""); setBusy(true);
    try { await fn(); if (okMsg) setMsg(okMsg); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const create = (e) => {
    e.preventDefault();
    run(async () => {
      await usersApi.create(form.username, form.fullName, form.password, form.role);
      setForm(EMPTY); setCreating(false);
    }, "Usuario creado");
  };

  const input = "rounded border p-2";
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Usuarios</h1>
        {!creating && (
          <button onClick={() => setCreating(true)} className="rounded bg-slate-900 px-4 py-2 text-white">
            Nuevo usuario
          </button>
        )}
      </div>

      {creating && (
        <form onSubmit={create} className="mb-6 grid max-w-xl grid-cols-2 gap-3 rounded-xl bg-white p-4 shadow">
          <h2 className="col-span-2 font-semibold">Nuevo usuario</h2>
          <input className={input} placeholder="Usuario *" value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <input className={input} placeholder="Nombre completo *" value={form.fullName}
            onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          <input className={input} type="password" placeholder="Contraseña *" value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <select className={input} value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <p className="col-span-2 text-xs text-slate-500">
            Contraseña temporal: mínimo 8 caracteres, con letras y números. La persona deberá cambiarla en su primer ingreso.
          </p>
          <div className="col-span-2 flex gap-2">
            <button disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">Crear</button>
            <button type="button" onClick={() => { setCreating(false); setForm(EMPTY); }}
              className="rounded border px-4 py-2">Cancelar</button>
          </div>
        </form>
      )}

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {msg && <p className="mb-3 text-sm text-green-700">{msg}</p>}

      {editing && (
        <div className="mb-4 flex max-w-xl flex-wrap items-center gap-2 rounded-xl border bg-white p-3 shadow">
          <input className={`${input} flex-1`} value={editing.fullName}
            onChange={(e) => setEditing({ ...editing, fullName: e.target.value })} />
          <select className={input} value={editing.role}
            onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
            {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button disabled={busy} className="rounded bg-slate-900 px-3 py-2 text-white"
            onClick={() => run(async () => {
              await usersApi.update(editing.id, editing.fullName, editing.role);
              setEditing(null);
            }, "Usuario actualizado")}>Guardar</button>
          <button onClick={() => setEditing(null)} className="rounded border px-3 py-2">Cancelar</button>
        </div>
      )}

      {resetting && (
        <div className="mb-4 flex max-w-xl flex-wrap items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3">
          <span className="w-full text-sm">Nueva contraseña para <b>{resetting.username}</b></span>
          <input className={`${input} flex-1`} type="password" value={resetting.password}
            onChange={(e) => setResetting({ ...resetting, password: e.target.value })} />
          <button disabled={busy} className="rounded bg-slate-900 px-3 py-2 text-white"
            onClick={() => run(async () => {
              await usersApi.resetPassword(resetting.id, resetting.password);
              setResetting(null);
            }, "Contraseña restablecida")}>Guardar</button>
          <button onClick={() => setResetting(null)} className="rounded border px-3 py-2">Cancelar</button>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Usuario</th><th className="p-3">Nombre</th><th className="p-3">Rol</th>
              <th className="p-3">Estado</th><th className="p-3"></th></tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className={`border-b ${u.active ? "" : "opacity-50"}`}>
                <td className="p-3 font-mono">{u.username}{u.id === me.id && " (tú)"}</td>
                <td className="p-3">{u.fullName}</td>
                <td className="p-3">{ROLES[u.role] ?? u.role}</td>
                <td className="p-3">
                  {!u.active ? "Inactivo" : u.locked
                    ? <span className="font-semibold text-red-600">Bloqueado</span> : "Activo"}
                </td>
                <td className="space-x-2 p-3 text-right">
                  <button className="underline" disabled={busy}
                    onClick={() => setEditing({ id: u.id, fullName: u.fullName, role: u.role })}>Editar</button>
                  <button className="underline" disabled={busy}
                    onClick={() => setResetting({ id: u.id, username: u.username, password: "" })}>
                    Restablecer clave</button>
                  {u.locked && (
                    <button className="underline" disabled={busy}
                      onClick={() => run(() => usersApi.unlock(u.id), "Usuario desbloqueado")}>Desbloquear</button>
                  )}
                  {u.id !== me.id && (
                    <button className="underline" disabled={busy}
                      onClick={() => run(() => usersApi.setActive(u.id, !u.active))}>
                      {u.active ? "Desactivar" : "Activar"}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}