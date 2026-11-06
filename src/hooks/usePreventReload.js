import { useEffect } from "react";

/**
 * En la app instalada (no en desarrollo) evita recargas accidentales de la vista web:
 * F5, Ctrl/Cmd+R, atajos de herramientas de desarrollo y el menú contextual del navegador.
 */
export function usePreventReload() {
  useEffect(() => {
    // Solo en el programa instalado: en un navegador (otro puesto) F5 y el menú deben funcionar normal.
    if (!import.meta.env.PROD || !window.__TAURI_INTERNALS__) return;
    const onKey = (e) => {
      const k = e.key?.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      const block =
        k === "f5" || k === "f12" ||
        (mod && k === "r") ||
        (mod && e.shiftKey && ["i", "j", "c", "r"].includes(k));
      if (block) { e.preventDefault(); e.stopPropagation(); }
    };
    const onMenu = (e) => {
      const t = e.target;
      const editable = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (!editable) e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("contextmenu", onMenu);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("contextmenu", onMenu);
    };
  }, []);
}
