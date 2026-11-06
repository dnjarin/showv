import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../store/authStore";
import { authApi } from "../services/api";
import { loginSchema } from "../schemas/auth";
import logoA from "../assets/brand/logo-a.png";
import logoB from "../assets/brand/logo-b.png";

export default function Login() {
  const login = useAuth((s) => s.login);
  const navigate = useNavigate();
  const [mode, setMode] = useState("login"); // "login" | "recover"
  const [form, setForm] = useState({ username: "", password: "" });
  const [rec, setRec] = useState({ username: "", code: "", password: "" });
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    const parsed = loginSchema.safeParse(form);
    if (!parsed.success) return setError(parsed.error.issues[0].message);
    setBusy(true);
    setError("");
    try {
      await login(form.username, form.password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const onRecover = async (e) => {
    e.preventDefault();
    setError(""); setMsg("");
    if (!rec.username.trim() || !rec.code.trim() || !rec.password) {
      return setError("Completa los tres campos");
    }
    setBusy(true);
    try {
      await authApi.recover(rec.username, rec.code, rec.password);
      setMsg("Contraseña restablecida. Ya puedes iniciar sesión.");
      setForm({ username: rec.username, password: "" });
      setRec({ username: "", code: "", password: "" });
      setMode("login");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full rounded border p-2";
  return (
    <div className="grid min-h-dvh place-items-center bg-slate-100 p-4 dark:bg-slate-50">
      {mode === "login" ? (
        <form onSubmit={onSubmit} className="w-full max-w-xs space-y-4 rounded-xl bg-white p-6 shadow dark:border">
          <img src={logoA} alt="TEKADDON" className="mx-auto mb-1 h-28 w-auto dark:hidden" />
          <img src={logoB} alt="TEKADDON" className="mx-auto mb-1 hidden h-28 w-auto dark:block" />
          <h1 className="text-xl font-semibold">Iniciar sesión</h1>
          <input className={input} placeholder="Usuario" autoFocus value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <input className={input} type="password" placeholder="Contraseña" value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} />
          {error && <p className="text-sm text-red-600">{error}</p>}
          {msg && <p className="text-sm text-green-700">{msg}</p>}
          <button disabled={busy} className="w-full rounded bg-slate-900 p-2 text-white disabled:opacity-50">
            {busy ? "Verificando…" : "Entrar"}
          </button>
          <button type="button" className="w-full text-sm underline"
            onClick={() => { setMode("recover"); setError(""); setMsg(""); }}>
            Olvidé mi contraseña (administrador)
          </button>
        </form>
      ) : (
        <form onSubmit={onRecover} className="w-full max-w-sm space-y-3 rounded-xl bg-white p-6 shadow dark:border">
          <img src={logoA} alt="TEKADDON" className="mx-auto mb-1 h-28 w-auto dark:hidden" />
          <img src={logoB} alt="TEKADDON" className="mx-auto mb-1 hidden h-28 w-auto dark:block" />
          <h1 className="text-xl font-semibold">Recuperar acceso del administrador</h1>
          <p className="text-sm text-slate-500">
            Necesitas el código de recuperación que generaste en Configuración. Si eres cajero o almacenista,
            pide a un administrador que restablezca tu clave.
          </p>
          <input className={input} placeholder="Usuario administrador" autoFocus value={rec.username}
            onChange={(e) => setRec({ ...rec, username: e.target.value })} />
          <input className={`${input} font-mono`} placeholder="Código: XXXXX-XXXXX-XXXXX-XXXXX" value={rec.code}
            onChange={(e) => setRec({ ...rec, code: e.target.value })} />
          <input className={input} type="password" placeholder="Nueva contraseña (8+, letras y números)"
            value={rec.password} onChange={(e) => setRec({ ...rec, password: e.target.value })} />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button disabled={busy} className="w-full rounded bg-slate-900 p-2 text-white disabled:opacity-50">
            {busy ? "Verificando…" : "Restablecer contraseña"}
          </button>
          <button type="button" className="w-full text-sm underline"
            onClick={() => { setMode("login"); setError(""); }}>
            ← Volver al inicio de sesión
          </button>
        </form>
      )}
      <p>Designed by Asdrubal Aguero</p>
    </div>
  );
}