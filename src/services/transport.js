import { invoke } from "@tauri-apps/api/core";

/*
  Cómo habla la interfaz con el sistema:
  - "tauri": programa de escritorio en modo normal (un solo puesto). Llamadas directas, como siempre.
  - "http":  modo red. Las llamadas viajan por HTTP al equipo principal con una sesión propia (token).
             Aplica a los navegadores de otros puestos y también a la ventana del equipo principal
             cuando el modo red está activo.
*/

const TOKEN_KEY = "tekaddon_token";
const API_KEY = "tekaddon_api";
let memToken = null;
let memApi = null;

const getToken = () => {
  try { return sessionStorage.getItem(TOKEN_KEY) ?? memToken; } catch { return memToken; }
};
const setToken = (t) => {
  memToken = t;
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* sin almacenamiento: queda en memoria */ }
};

const hasTauri = () => typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

let planPromise = null;
async function resolvePlan() {
  if (hasTauri()) {
    try {
      const info = await invoke("lan_info");
      if (info && info.mode === "server" && info.localRunning) {
        // Entrada local (solo este equipo, sin cifrar): no depende del certificado.
        return { kind: "http", base: `http://127.0.0.1:${info.localPort}` };
      }
    } catch { /* se usa el modo normal */ }
    return { kind: "tauri" };
  }
  // Navegador: el mismo equipo que sirvió la página. Con ?api=http://host:puerto se puede indicar otro
  // (útil para probar en desarrollo).
  let base = "";
  try {
    const q = new URLSearchParams(window.location.search).get("api");
    if (q) sessionStorage.setItem(API_KEY, q);
    base = sessionStorage.getItem(API_KEY) || "";
  } catch { base = memApi || ""; }
  return { kind: "http", base: base.replace(/\/+$/, "") };
}
const getPlan = () => (planPromise ??= resolvePlan());

function browserDownload({ filename, content }) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function httpCall(plan, cmd, args) {
  const token = getToken();
  let res;
  try {
    res = await fetch(`${plan.base}/api/${cmd}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(args ?? {}),
    });
  } catch {
    throw new Error("No se pudo conectar con el equipo principal. Revisa la red e intenta de nuevo.");
  }
  let env;
  try {
    env = await res.json();
  } catch {
    throw new Error("El equipo principal respondió algo inesperado.");
  }
  if (!env.ok) {
    if (env.error === "Debes iniciar sesión") setToken(null);
    throw new Error(env.error || "Error inesperado");
  }
  if (env.token) setToken(env.token);
  if (cmd === "logout") setToken(null);
  if (env.download) {
    browserDownload(env.download);
    return `Descargas de tu navegador (${env.download.filename})`;
  }
  return env.data;
}

/** Llama a un comando del sistema por el camino que corresponda. Lanza Error con el mensaje. */
export async function transportCall(cmd, args) {
  const plan = await getPlan();
  if (plan.kind === "tauri") {
    try {
      return await invoke(cmd, args);
    } catch (e) {
      throw new Error(typeof e === "string" ? e : "Error inesperado");
    }
  }
  return httpCall(plan, cmd, args);
}
