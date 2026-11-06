import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../store/authStore";
import { usersApi } from "../services/api";

export default function Account() {
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();
  const forced = user.mustChangePassword;
  const [form, setForm] = useState({ current: "", next: "", repeat: "" });
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setMsg("");
    if (form.next !== form.repeat) return setError("Las contraseñas nuevas no coinciden");
    setBusy(true);
    try {
      await usersApi.changeOwnPassword(form.current, form.next);
      useAuth.setState((s) => ({ user: { ...s.user, mustChangePassword: false } }));
      setForm({ current: "", next: "", repeat: "" });
      if (forced) navigate("/", { replace: true });
      else setMsg("Contraseña actualizada");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const input = "mt-1 w-full rounded border p-2";
  return (
    <div className="max-w-md">
      <h1 className="mb-1 text-2xl font-semibold">Mi cuenta</h1>
      <p className="mb-4 text-sm text-slate-500">{user.fullName} · {user.username} · {user.role}</p>

      {forced && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Estás usando una contraseña temporal. <b>Debes cambiarla para poder continuar.</b>
        </div>
      )}

      <form onSubmit={submit} className="space-y-3 rounded-xl bg-white p-4 shadow">
        <h2 className="font-semibold">Cambiar contraseña</h2>
        <label className="block text-sm">Contraseña actual
          <input type="password" className={input} value={form.current}
            onChange={(e) => setForm({ ...form, current: e.target.value })} />
        </label>
        <label className="block text-sm">Contraseña nueva
          <input type="password" className={input} value={form.next}
            onChange={(e) => setForm({ ...form, next: e.target.value })} />
        </label>
        <label className="block text-sm">Repite la contraseña nueva
          <input type="password" className={input} value={form.repeat}
            onChange={(e) => setForm({ ...form, repeat: e.target.value })} />
        </label>
        <p className="text-xs text-slate-500">Mínimo 8 caracteres, con letras y números.</p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {msg && <p className="text-sm text-green-700">{msg}</p>}
        <button disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
          {busy ? "Guardando…" : "Cambiar contraseña"}
        </button>
      </form>
    </div>
  );
}