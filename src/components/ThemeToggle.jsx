import { useEffect, useState } from "react";
import { getTheme, setTheme } from "../utils/theme";

/** Botón claro/oscuro para la barra lateral y el menú superior. */
export default function ThemeToggle({ className = "" }) {
  const [mode, setMode] = useState(getTheme);
  useEffect(() => {
    const sync = () => setMode(getTheme());
    window.addEventListener("theme-change", sync);
    return () => window.removeEventListener("theme-change", sync);
  }, []);
  const next = mode === "dark" ? "light" : "dark";
  return (
    <button type="button" onClick={() => setTheme(next)}
      title={mode === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
      className={`rounded border border-slate-600 px-3 py-1 text-left text-sm text-slate-300 hover:bg-slate-800 ${className}`}>
      {mode === "dark" ? "☀ Modo claro" : "☾ Modo oscuro"}
    </button>
  );
}
