// Tema claro/oscuro. Se guarda en este equipo (localStorage) y por defecto es claro.
const KEY = "theme";
const root = () => document.documentElement;

export function getTheme() {
  try { return localStorage.getItem(KEY) === "dark" ? "dark" : "light"; } catch { return "light"; }
}

export function applyTheme(mode = getTheme()) {
  const dark = mode === "dark";
  root().classList.toggle("dark", dark);
  root().style.colorScheme = dark ? "dark" : "light";
}

export function setTheme(mode) {
  try { localStorage.setItem(KEY, mode === "dark" ? "dark" : "light"); } catch { /* sin almacenamiento */ }
  applyTheme(mode);
  window.dispatchEvent(new Event("theme-change"));
}

/** Aplica el tema guardado. Al imprimir se vuelve temporalmente al tema claro. */
export function initTheme() {
  applyTheme();
  window.addEventListener("beforeprint", () => {
    root().classList.remove("dark");
    root().style.colorScheme = "light";
  });
  window.addEventListener("afterprint", () => applyTheme());
}
