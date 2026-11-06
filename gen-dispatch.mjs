#!/usr/bin/env node
/*
  Genera src-tauri/src/lan_dispatch.rs: la tabla que permite al modo red llamar a cada comando
  #[tauri::command] desde el servidor HTTP, sin duplicar su lógica.

  Uso (desde la raíz del proyecto):
    node gen-dispatch.mjs          escribe src-tauri/src/lan_dispatch.rs
    node gen-dispatch.mjs --check  no escribe: falla si el archivo está desactualizado

  Cuándo ejecutarlo: cada vez que agregues, quites o cambies los parámetros de un comando
  (es decir, cuando cambie la lista de tauri::generate_handler! en lib.rs o la firma de un comando).
*/
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src-tauri", "src");
const OUT = path.join(SRC, "lan_dispatch.rs");
const check = process.argv.includes("--check");

const fail = (msg) => {
  console.error("ERROR: " + msg);
  process.exit(1);
};
const read = (p) => fs.readFileSync(p, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");

// 1) Comandos registrados en lib.rs
const lib = read(path.join(SRC, "lib.rs"));
const m = lib.match(/generate_handler!\s*\[([\s\S]*?)\]/);
if (!m) fail("No se encontró tauri::generate_handler! en lib.rs");
const handlers = [...m[1].matchAll(/commands::(\w+)::(\w+)/g)].map((x) => ({ mod: x[1], fn: x[2] }));
if (handlers.length === 0) fail("La lista de comandos está vacía");
const seen = new Set();
for (const h of handlers) {
  if (seen.has(h.fn)) fail(`Comando repetido en lib.rs: ${h.fn}`);
  seen.add(h.fn);
}

// 2) Firma de cada comando
function splitParams(text) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const c of text) {
    if ("<([{".includes(c)) depth++;
    if (">)]}".includes(c)) depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function signatures(src) {
  const map = new Map();
  const re = /#\[tauri::command([^\]]*)\]\s*(?:pub(?:\([^)]*\))?\s+)?(async\s+)?fn\s+(\w+)\s*(<[^>(]*>)?\s*\(/g;
  let r;
  while ((r = re.exec(src))) {
    if (r[1].trim()) fail(`El comando ${r[3]} usa atributos en #[tauri::command(...)]: no soportado por el generador`);
    if (!r[2]) fail(`El comando ${r[3]} no es async`);
    if (r[4]) fail(`El comando ${r[3]} usa genéricos/lifetimes en el nombre: no soportado`);
    let depth = 1;
    let i = re.lastIndex;
    while (depth > 0 && i < src.length) {
      const c = src[i++];
      if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    const raw = src.slice(re.lastIndex, i - 1).replace(/\/\/[^\n]*/g, "");
    map.set(r[3], splitParams(raw));
  }
  return map;
}

const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const cache = new Map();
const arms = [];
for (const h of handlers) {
  const file = path.join(SRC, "commands", `${h.mod}.rs`);
  if (!fs.existsSync(file)) fail(`No existe commands/${h.mod}.rs`);
  if (!cache.has(h.mod)) cache.set(h.mod, signatures(read(file)));
  const sig = cache.get(h.mod).get(h.fn);
  if (!sig) fail(`No se encontró #[tauri::command] ${h.fn} en commands/${h.mod}.rs`);
  const args = sig.map((p) => {
    const pm = p.match(/^(?:mut\s+)?(\w+)\s*:\s*([\s\S]+)$/);
    if (!pm) fail(`No se pudo leer el parámetro «${p}» de ${h.fn}`);
    const [, name, type] = pm;
    const t = type.trim();
    if (/^(tauri::)?State\s*</.test(t)) return "app.state::<AppState>()";
    if (/^(tauri::)?AppHandle\b/.test(t)) return "app.clone()";
    if (/^(tauri::)?(Window|WebviewWindow|Webview|Channel|Request)\b/.test(t) || t.includes("&"))
      fail(`El parámetro «${name}: ${t}» de ${h.fn} no se puede usar desde el modo red`);
    return `arg(args, "${camel(name)}")?`;
  });
  arms.push(`        "${h.fn}" => js(commands::${h.mod}::${h.fn}(${args.join(", ")}).await?),`);
}

const out = `// ARCHIVO GENERADO por gen-dispatch.mjs. No lo edites a mano: ejecuta \`node gen-dispatch.mjs\`.
// Permite al servidor del modo red (lan.rs) llamar a cada comando de Tauri con los mismos
// argumentos que envía el frontend (camelCase), sin duplicar su lógica.
use crate::{commands, error::AppError, state::AppState};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, AppError> {
    let v = args.get(key).cloned().unwrap_or(Value::Null);
    serde_json::from_value(v)
        .map_err(|_| AppError::Validation(format!("Dato inválido o faltante: {key}")))
}

fn js<T: Serialize>(v: T) -> Result<Value, AppError> {
    serde_json::to_value(v).map_err(|e| AppError::Internal(e.to_string()))
}

pub async fn dispatch(app: &AppHandle, cmd: &str, args: &Value) -> Result<Value, AppError> {
    match cmd {
${arms.join("\n")}
        _ => Err(AppError::Validation(format!("Comando desconocido: {cmd}"))),
    }
}
`;

if (check) {
  const cur = fs.existsSync(OUT) ? read(OUT) : "";
  if (cur !== out) fail("src-tauri/src/lan_dispatch.rs está desactualizado. Ejecuta: node gen-dispatch.mjs");
  console.log(`OK: lan_dispatch.rs al día (${handlers.length} comandos).`);
} else {
  fs.writeFileSync(OUT, out, "utf8");
  console.log(`Generado ${path.relative(ROOT, OUT)} con ${handlers.length} comandos.`);
}
