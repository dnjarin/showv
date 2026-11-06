import { useEffect } from "react";
import { authApi, setUnauthorizedHandler } from "../services/api";
import { useAuth } from "../store/authStore";

/** Cierra la UI si Rust expiró la sesión, y renueva la sesión mientras haya actividad. */
export function useSessionGuard() {
  useEffect(() => {
    const lock = () => useAuth.setState({ user: null });
    setUnauthorizedHandler(lock);

    let last = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - last > 30_000) {
        last = now;
        authApi.keepAlive().catch(() => {});
      }
    };
    const events = ["mousedown", "keydown", "mousemove", "touchstart"];
    events.forEach((e) => window.addEventListener(e, onActivity));

    const timer = setInterval(() => {
      authApi.currentUser().then((u) => { if (!u) lock(); }).catch(() => {});
    }, 30_000);

    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity));
      clearInterval(timer);
    };
  }, []);
}