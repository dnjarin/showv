import { useEffect, useState } from "react";
import { keyApi } from "../services/api";

/** Protección de la llave de cifrado de la base de datos y llave de recuperación. Solo administrador. */
export default function KeyCard() {
  const [st, setSt] = useState(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { setSt(await keyApi.status()); } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const show = async (e) => {
    e.preventDefault();
    setError(""); setMsg(""); setBusy(true);
    try {
      setCode(await keyApi.show(password));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setError(""); setMsg(""); setBusy(true);
    try {
      const removed = await keyApi.confirm(password);
      setCode("");
      setPassword("");
      setMsg(removed ? "Listo. Se eliminó la copia de la llave que estaba sin proteger." : "Listo. Quedó anotado que guardaste la llave de recuperación.");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const print = () => window.print();

  return (
    <section className="rounded-xl bg-white p-4 shadow">
      <h2 className="mb-1 font-semibold">Llave de cifrado de los datos</h2>
      <p className="mb-3 text-sm text-slate-600">
        Tus datos están cifrados. La llave que los abre se guarda protegida por el sistema (en Windows, con tu cuenta de
        usuario), de modo que copiar la carpeta de datos a otro equipo no permite leerlos. Guarda además una
        <b> llave de recuperación</b> en papel: la necesitarás si cambias de computadora o reinstalas Windows.
      </p>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      {msg && <p className="mb-2 text-sm text-green-700">{msg}</p>}

      {st && (
        <ul className="mb-3 space-y-1 text-sm">
          <li>
            Protección:{" "}
            {st.protected
              ? <b className="text-green-700">llave protegida por el sistema</b>
              : <b className="text-amber-700">llave guardada en un archivo (este equipo no ofrece almacén protegido)</b>}
          </li>
          <li>
            Llave de recuperación:{" "}
            {st.recoveryConfirmed
              ? <b className="text-green-700">guardada</b>
              : <b className="text-amber-700">falta guardarla — muéstrala, imprímela y confirma</b>}
          </li>
          {st.protected && st.plainCopy && (
            <li className="text-amber-700">
              Queda una copia de la llave sin proteger en la carpeta de datos (de la versión anterior). Se elimina al confirmar
              que guardaste la llave de recuperación.
            </li>
          )}
        </ul>
      )}

      {!code ? (
        <form onSubmit={show} className="flex flex-wrap items-end gap-3">
          <label className="block text-sm">Tu contraseña de administrador
            <input type="password" className="mt-1 block w-64 rounded border p-2" value={password}
              onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          <button disabled={busy || !password} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
            Mostrar llave de recuperación
          </button>
        </form>
      ) : (
        <div className="rounded-lg border-2 border-amber-400 bg-amber-50 p-3">
          <div className="mb-2 text-sm font-semibold">Llave de recuperación — guárdala en papel, en un lugar seguro</div>
          <div className="select-all break-all font-mono text-base tracking-wide">{code}</div>
          <p className="mt-2 text-xs text-slate-600">
            Quien tenga esta llave y una copia de los datos puede leerlos. No la envíes por correo ni la guardes en este equipo.
            Para usarla en otro equipo: crea un archivo <i>inventario.key</i> junto a la base y pega esta llave dentro.
          </p>
          <div className="mt-3 flex gap-3">
            <button onClick={print} className="rounded border px-4 py-2 text-sm">Imprimir</button>
            <button onClick={confirm} disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">
              Ya la guardé
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
