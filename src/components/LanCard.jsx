import { useEffect, useState } from "react";
import { lanApi } from "../services/api";

/** Configuración del modo red (varios puestos). Solo el administrador; se guarda desde el equipo principal. */
export default function LanCard() {
  const [info, setInfo] = useState(null);
  const [mode, setMode] = useState("single");
  const [port, setPort] = useState("8787");
  const [bind, setBind] = useState("");
  const [https, setHttps] = useState(true);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const s = await lanApi.settings();
      setInfo(s);
      setMode(s.saved.mode);
      setPort(String(s.saved.port));
      setBind(s.saved.bind ?? "");
      setHttps(s.saved.https !== false);
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => { load(); }, []);

  const save = async (e) => {
    e.preventDefault();
    setError(""); setMsg("");
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) {
      return setError("El puerto debe ser un número entre 1024 y 65535 (por ejemplo 8787).");
    }
    const b = bind.trim();
    if (b && !/^[0-9a-fA-F:.]+$/.test(b)) {
      return setError("La dirección de escucha debe ser una IP como 192.168.1.20 (o déjala vacía para todas).");
    }
    setBusy(true);
    try {
      await lanApi.save(mode, p, b, https);
      setMsg("Guardado. Para aplicarlo, cierra el programa por completo y ábrelo de nuevo.");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const active = info?.active;
  const runningServer = active?.mode === "server" && active?.running;

  return (
    <section className="rounded-xl bg-white p-4 shadow">
      <h2 className="mb-1 font-semibold">Varios puestos en la red local (opcional)</h2>
      <p className="mb-3 text-sm text-slate-600">
        Con el modo servidor, otras computadoras de la misma red usan el sistema desde su navegador, a la vez y cada
        una con su propio usuario. Los datos siguen guardados solo en este equipo, que debe estar encendido con el
        programa abierto.
      </p>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      {msg && <p className="mb-2 text-sm text-green-700">{msg}</p>}

      {info && (
        <p className="mb-3 text-sm">
          Ahora está: <b>{runningServer ? `modo servidor activo (puerto ${active.port})` : "un solo puesto"}</b>
          {info.needsRestart && <span className="text-amber-700"> · hay cambios guardados que se aplican al reiniciar.</span>}
          {active?.mode === "server" && !active?.running && (
            <span className="text-red-600"> · no se pudo abrir el puerto {active.port}; elige otro.</span>
          )}
        </p>
      )}

      <form onSubmit={save} className="space-y-3">
        <div className="space-y-2 text-sm">
          <label className="flex items-start gap-2">
            <input type="radio" name="lanmode" checked={mode === "single"} onChange={() => setMode("single")} className="mt-1" />
            <span><b>Un solo puesto</b> — funciona como siempre. No se abre ningún puerto de red.</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="lanmode" checked={mode === "server"} onChange={() => setMode("server")} className="mt-1" />
            <span><b>Servidor para varios puestos</b> — este equipo atiende a los demás.</span>
          </label>
        </div>

        {mode === "server" && (
          <div className="flex flex-wrap gap-4">
            <label className="block text-sm">Puerto
              <input className="mt-1 block w-32 rounded border p-2" value={port} inputMode="numeric"
                onChange={(e) => setPort(e.target.value)} />
            </label>
            <label className="block text-sm">Escuchar solo en esta dirección (opcional)
              <input className="mt-1 block w-56 rounded border p-2" value={bind} placeholder={info?.lanIp ?? "192.168.1.20"}
                onChange={(e) => setBind(e.target.value)} />
              <span className="mt-1 block text-xs text-slate-500">
                Vacío = todas las conexiones de este equipo. Si el equipo tiene Wi-Fi y cable, escribe la IP de la red del negocio.
              </span>
            </label>
          </div>
        )}

        {mode === "server" && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={https} onChange={(e) => setHttps(e.target.checked)} className="mt-1" />
            <span>
              <b>Conexión cifrada (HTTPS)</b> — recomendado. El programa crea su propio certificado. Los navegadores
              avisarán una vez que el sitio no es de confianza (ver abajo).
            </span>
          </label>
        )}

        <button disabled={busy} className="rounded bg-slate-900 px-5 py-2 text-white disabled:opacity-50">
          {busy ? "Guardando…" : "Guardar modo de red"}
        </button>
      </form>

      {mode === "server" && (
        <div className="mt-4 rounded-lg border p-3 text-sm">
          <div className="font-semibold">Cómo conectar los otros puestos</div>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-slate-700">
            <li>Guarda, cierra el programa por completo y ábrelo de nuevo en este equipo.</li>
            <li>Si Windows pregunta por el firewall, permite el acceso en <b>redes privadas</b>.</li>
            <li>
              En el navegador de cada puesto escribe:{" "}
              <b className="select-all font-mono">{info?.url ?? `http://(dirección de este equipo):${port}`}</b>
            </li>
            {https && (
              <li>
                El navegador avisará «La conexión no es privada» porque el certificado lo creó este programa y no una
                empresa certificadora. Elige <b>Avanzado → Continuar</b>. Para confirmar que es el equipo correcto,
                la huella del certificado debe coincidir:{" "}
                <span className="select-all break-all font-mono text-xs">{info?.fingerprint ?? "(aparece tras reiniciar el programa)"}</span>
              </li>
            )}
            <li>Cada persona entra con su propio usuario y contraseña.</li>
          </ol>
          {!info?.lanIp && (
            <p className="mt-2 text-xs text-slate-500">
              No pude detectar la dirección de este equipo. En Windows se ve con <i>ipconfig</i> (Dirección IPv4).
            </p>
          )}
          <p className="mt-2 text-xs text-slate-500">
            Úsalo solo en una red de confianza (la del negocio) y no lo expongas a internet.
            {https ? " La conexión viaja cifrada." : " La conexión NO está cifrada: cualquiera en la red podría leer los datos."} Solo se atienden equipos de la red local; cada equipo se bloquea 15 minutos tras 4 intentos
            fallidos de contraseña. El primer registro, la recuperación del administrador y la restauración de
            respaldos solo se pueden hacer desde este equipo.
          </p>
        </div>
      )}
    </section>
  );
}
