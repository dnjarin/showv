import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../store/authStore";
import { setupSchema } from "../schemas/auth";
import logoA from "../assets/brand/logo-a.png";
import logoB from "../assets/brand/logo-b.png";

const FIELDS = [
  ["rif", "RIF de la empresa"],
  ["legalName", "Razón social"],
  ["fiscalAddress", "Domicilio fiscal"],
  ["adminFullName", "Nombre del administrador"],
  ["adminUsername", "Usuario administrador"],
  ["adminPassword", "Contraseña (mín. 8 caracteres)", "password"],
];

export default function Setup() {
  const completeSetup = useAuth((s) => s.completeSetup);
  const navigate = useNavigate();
  const [form, setForm] = useState(Object.fromEntries(FIELDS.map(([k]) => [k, ""])));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    const parsed = setupSchema.safeParse(form);
    if (!parsed.success) return setError(parsed.error.issues[0].message);
    setBusy(true);
    setError("");
    try {
      await completeSetup(parsed.data);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh grid place-items-center bg-slate-100 p-4 dark:bg-slate-50">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-3 rounded-xl bg-white p-6 shadow dark:border">
        <img src={logoA} alt="TEKADDON" className="mx-auto mb-1 h-28 w-auto dark:hidden" />
          <img src={logoB} alt="TEKADDON" className="mx-auto mb-1 hidden h-28 w-auto dark:block" />
        <h1 className="text-xl font-semibold">Configuración inicial</h1>
        <p className="text-sm text-slate-500">Datos de tu empresa y cuenta del administrador.</p>
        {FIELDS.map(([key, label, type]) => (
          <input key={key} type={type || "text"} placeholder={label}
            className="w-full rounded border p-2" value={form[key]}
            onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
        ))}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button disabled={busy} className="w-full rounded bg-slate-900 p-2 text-white disabled:opacity-50">
          {busy ? "Creando…" : "Crear y entrar"}
        </button>
      </form>
    </div>
  );
}