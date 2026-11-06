import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../store/authStore";

const PREFIX = "draft:";
const TTL_MS = 12 * 60 * 60 * 1000; // un borrador vive 12 horas

/** Borra todos los borradores (se usa al cerrar sesión de forma explícita). */
export function clearAllDrafts() {
  try {
    Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => localStorage.removeItem(k));
  } catch { /* sin almacenamiento */ }
}

/**
 * Guarda automáticamente el formulario en curso y lo ofrece al volver a entrar.
 * - data: objeto serializable con lo que hay en pantalla.
 * - isEmpty(data): true si no hay nada que valga la pena guardar.
 * - onRestore(data): recibe lo guardado (validar formas antes de usarlo).
 * Devuelve { restored, clear, dismiss }.
 */
export function useDraft(name, { data, isEmpty, onRestore, enabled = true }) {
  const uid = useAuth((s) => s.user?.id);
  const key = `${PREFIX}${uid}:${name}`;
  const [restored, setRestored] = useState(false);
  const skipNext = useRef(true);
  const timer = useRef(null);
  const restoreRef = useRef(onRestore);
  restoreRef.current = onRestore;
  const empty = isEmpty(data);

  // Recuperar al montar
  useEffect(() => {
    if (!enabled || uid == null) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (!d || typeof d.t !== "number" || Date.now() - d.t > TTL_MS) { localStorage.removeItem(key); return; }
      if (restoreRef.current(d.v)) setRestored(true);
    } catch { try { localStorage.removeItem(key); } catch { /* nada */ } }
  }, [key, enabled, uid]);

  // Guardar con retraso (la primera pasada es la del montaje: no pisa lo guardado)
  const json = enabled ? JSON.stringify(data) : "";
  useEffect(() => {
    if (!enabled || uid == null) return;
    if (skipNext.current) { skipNext.current = false; return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      try {
        if (empty) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: JSON.parse(json) }));
      } catch { /* sin almacenamiento o lleno */ }
    }, 400);
    return () => clearTimeout(timer.current);
  }, [json, empty, key, enabled, uid]);

  // Avisar si se intenta cerrar/recargar con trabajo sin guardar
  useEffect(() => {
    if (!enabled || empty) return;
    const h = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [enabled, empty]);

  const clear = useCallback(() => {
    clearTimeout(timer.current);
    try { localStorage.removeItem(key); } catch { /* nada */ }
    setRestored(false);
  }, [key]);
  const dismiss = useCallback(() => setRestored(false), []);

  return { restored, clear, dismiss };
}
