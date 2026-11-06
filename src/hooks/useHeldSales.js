import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../store/authStore";

// Las ventas en espera usan el prefijo "draft:" para que "Cerrar sesión" las descarte
// junto con los demás borradores (ver clearAllDrafts en useDraft.js).
const TTL_MS = 12 * 60 * 60 * 1000; // una venta en espera vive 12 horas
export const MAX_HELD = 10;

/**
 * Ventas en espera del usuario actual: carritos aparcados para atender a otro cliente
 * y retomarlos después. Se guardan en este equipo, no en la base de datos, y no descuentan stock.
 * Devuelve { held, hold(entry) -> boolean, remove(id) }.
 */
export function useHeldSales() {
  const uid = useAuth((s) => s.user?.id);
  const key = uid == null ? null : `draft:${uid}:held`;
  const [held, setHeld] = useState([]);

  const read = useCallback(() => {
    if (!key) return [];
    try {
      const raw = localStorage.getItem(key);
      const list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) return [];
      return list.filter((h) => h && typeof h.id === "string" && typeof h.t === "number"
        && Date.now() - h.t <= TTL_MS && Array.isArray(h.cart) && h.cart.length > 0);
    } catch { return []; }
  }, [key]);

  const write = useCallback((list) => {
    if (key) {
      try {
        if (list.length) localStorage.setItem(key, JSON.stringify(list));
        else localStorage.removeItem(key);
      } catch { /* sin almacenamiento o lleno */ }
    }
    setHeld(list);
  }, [key]);

  useEffect(() => { setHeld(read()); }, [read]);

  const hold = useCallback((entry) => {
    const list = read();
    if (list.length >= MAX_HELD) return false;
    write([{ ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, t: Date.now() }, ...list]);
    return true;
  }, [read, write]);

  const remove = useCallback((id) => write(read().filter((h) => h.id !== id)), [read, write]);

  return { held, hold, remove };
}
