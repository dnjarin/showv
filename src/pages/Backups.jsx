import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../store/authStore";
import { backupApi } from "../services/api";

const KINDS = {
  auto: "Automático", manual: "Manual",
  premigracion: "Antes de actualizar", prerestauracion: "Antes de restaurar",
};
const size = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export default function Backups() {
  const [status, setStatus] = useState(null);
  const [extra, setExtra] = useState("");
  const [restoring, setRestoring] = useState(null); // nombre del respaldo
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await backupApi.status();
      setStatus(s);
      setExtra(s.extraDir ?? "");
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn) => {
    setError(""); setMsg(""); setBusy(true);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const create = () => run(async () => {
    const r = await backupApi.create();
    setMsg(r.warning ? `Respaldo creado. Aviso: ${r.warning}` : `Respaldo creado: ${r.name}`);
    await load();
  });

  const saveExtra = () => run(async () => {
    await backupApi.setExtraDir(extra.trim() || null);
    setMsg(extra.trim() ? "Carpeta externa guardada" : "Carpeta externa desactivada");
    await load();
  });

  const restore = () => run(async () => {
    await backupApi.restore(restoring, confirm);
    // La sesión se cerró en Rust: volvemos al inicio de sesión.
    useAuth.setState({ user: null });
  });

  const input = "rounded border p-2";
  if (!status) return <p className="text-slate-500">{error || "Cargando…"}</p>;

  return (
    <div className="max-w-4xl">
      <h1 className="mb-4 text-2xl font-semibold">Respaldos</h1>

      <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        Los respaldos guardados en esta misma computadora <b>no te protegen si el disco falla o se pierde el equipo</b>.
        Configura una carpeta externa (memoria USB, disco externo o una carpeta sincronizada) para tener una segunda copia.
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {msg && <p className="mb-3 text-sm text-green-700">{msg}</p>}

      <div className="mb-6 space-y-3 rounded-xl bg-white p-4 shadow">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm text-slate-500">
            Se crea uno automático cada 24 horas. Carpeta: <span className="font-mono">{status.dir}</span>
          </div>
          <button onClick={create} disabled={busy}
            className="shrink-0 rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
            Crear respaldo ahora
          </button>
        </div>
        <div className="flex items-end gap-2">
          <label className="flex-1 text-sm">Carpeta externa (opcional)
            <input className={`${input} mt-1 w-full`} placeholder="Ejemplo: E:\Respaldos"
              value={extra} onChange={(e) => setExtra(e.target.value)} />
          </label>
          <button onClick={saveExtra} disabled={busy} className="rounded border px-4 py-2 disabled:opacity-50">Guardar</button>
        </div>
      </div>

      {restoring && (
        <div className="mb-6 rounded-xl border border-red-300 bg-red-50 p-4">
          <h2 className="mb-1 font-semibold text-red-800">Restaurar «{restoring}»</h2>
          <p className="mb-3 text-sm text-red-900">
            Se reemplazarán <b>todos los datos actuales</b> (ventas, inventario, clientes y también los usuarios
            y contraseñas) por los del respaldo. Antes se guarda una copia del estado actual, y tendrás que
            iniciar sesión de nuevo.
          </p>
          <div className="flex gap-2">
            <input className={`${input} flex-1`} placeholder="Escribe RESTAURAR para confirmar"
              value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            <button onClick={restore} disabled={busy || confirm !== "RESTAURAR"}
              className="rounded bg-red-700 px-4 py-2 text-white disabled:opacity-50">Restaurar</button>
            <button onClick={() => { setRestoring(null); setConfirm(""); }}
              className="rounded border bg-white px-4 py-2">Cancelar</button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Fecha</th><th className="p-3">Tipo</th>
              <th className="p-3">Tamaño</th><th className="p-3">Archivo</th><th className="p-3"></th></tr>
          </thead>
          <tbody>
            {status.items.map((b) => (
              <tr key={b.name} className="border-b">
                <td className="p-3">{b.createdAt}</td>
                <td className="p-3">{KINDS[b.kind] ?? b.kind}</td>
                <td className="p-3">{size(b.sizeBytes)}</td>
                <td className="p-3 font-mono text-xs">{b.name}</td>
                <td className="p-3 text-right">
                  <button className="underline" disabled={busy}
                    onClick={() => { setRestoring(b.name); setConfirm(""); setError(""); setMsg(""); }}>
                    Restaurar
                  </button>
                </td>
              </tr>
            ))}
            {status.items.length === 0 && (
              <tr><td colSpan={5} className="p-6 text-center text-slate-500">Aún no hay respaldos</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}