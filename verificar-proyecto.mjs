#!/usr/bin/env node
/*
  Verificador de estructura del proyecto (Tauri + React + Rust + SQLite).
  No instala nada ni modifica archivos: solo LEE el proyecto y reporta lo que falta o está roto.

  Uso:
    1) Copia este archivo a la raíz del proyecto (donde está package.json).
    2) Ejecuta:   node verificar-proyecto.mjs
    3) Revisa el resultado en pantalla y en el archivo reporte-verificacion.txt
*/
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const abs = (rel) => path.join(ROOT, rel);
const isFile = (rel) => {
  try { return fs.statSync(abs(rel)).isFile(); } catch { return false; }
};
const read = (rel) => (isFile(rel) ? fs.readFileSync(abs(rel), "utf8") : null);
const stripRust = (s) => s.replace(/\/\/[^\n]*/g, "");

const issues = []; // { level, area, msg }
let okCount = 0;
const bad = (area, msg) => issues.push({ level: "FALTA", area, msg });
const warn = (area, msg) => issues.push({ level: "REVISAR", area, msg });
const info = (area, msg) => issues.push({ level: "INFO", area, msg });
const ok = () => { okCount++; };

const RUST = "src-tauri/src";
const MIG = "src-tauri/migrations";

// ───────────────────────── Lo que debe existir ─────────────────────────
const MIGRATIONS = [
  "001_init.sql", "002_facturacion.sql", "003_indices_inventario.sql", "004_clientes_tasas.sql",
  "005_ventas.sql", "006_exoneraciones.sql", "007_caja.sql", "008_seguridad.sql",
  "009_usuarios.sql", "010_almacenes.sql", "011_compras.sql", "012_retenciones.sql",
  "013_descuentos_vuelto.sql", "014_devoluciones.sql", "015_cuentas_por_cobrar.sql",
  "016_cobranzas_avanzado.sql", "017_cuentas_por_pagar.sql", "018_gastos_caja.sql",
  "019_costos_ventas.sql", "020_importacion.sql", "021_cotizaciones.sql",
  "022_precios_promociones.sql", "023_ordenes_compra.sql", "024_lotes.sql",
  "025_retenciones_sufridas.sql", "026_migracion_qsl.sql", "027_auditoria_inmutable.sql", "028_tipos_almacen.sql", "029_inmutabilidad_financiera.sql", "030_cotizacion_formato.sql", "031_cotizaciones_emitidas.sql", "032_cotizaciones_hora_utc.sql",
];

// archivo de commands/ -> funciones #[tauri::command] que debe contener
const COMMANDS = {
  auth: ["needs_setup", "complete_setup", "login", "logout", "current_user", "keep_alive", "create_user"],
  users: ["list_users", "update_user", "set_user_active", "reset_user_password", "unlock_user", "change_own_password"],
  backups: ["backup_status", "backup_create", "backup_set_extra_dir", "backup_restore"],
  recovery: ["generate_recovery_code", "recover_admin"],
  settings: ["get_settings", "save_settings"],
  auditlog: ["list_audit"],
  catalog: ["catalog_options", "create_category", "categories_overview", "rename_category", "delete_category",
    "list_products", "create_product", "update_product", "set_product_active"],
  inventory: ["adjust_stock", "list_movements", "stock_overview", "transfer_stock", "list_transfers"],
  warehouses: ["list_warehouses", "create_warehouse", "update_warehouse", "set_warehouse_active", "set_sales_warehouse"],
  customers: ["list_customers", "create_customer", "update_customer", "set_customer_active"],
  rates: ["exchange_rates_overview", "set_exchange_rate"],
  sales: ["quote_sale", "issue_sale", "get_document", "list_documents", "void_document"],
  cash: ["cash_current", "cash_open", "cash_close", "cash_history"],
  reports: ["sales_report", "top_products", "inventory_valuation", "write_export"],
  purchases: ["list_suppliers", "create_supplier", "update_supplier", "set_supplier_active", "quote_purchase",
    "create_purchase", "list_purchases", "get_purchase", "void_purchase"],
  retentions: ["retention_options", "get_withholding_config", "save_withholding_config", "save_islr_concept",
    "set_islr_concept_active", "set_supplier_retention", "list_withholdings", "get_withholding_voucher"],
  returns: ["return_candidates", "quote_return", "create_return", "get_return"],
  receivables: ["ar_credit_info", "ar_summary", "ar_customer", "ar_set_credit", "ar_receive", "ar_apply_credit",
    "ar_void_receipt", "ar_get_receipt"],
  payables: ["ap_summary", "ap_supplier", "ap_pay", "ap_void_payment", "ap_get_payment"],
  expenses: ["list_expense_categories", "save_expense_category", "set_expense_category_active", "create_expense",
    "list_expenses", "void_expense", "create_cash_movement", "list_cash_movements", "void_cash_movement"],
  books: ["sales_book", "purchases_book"],
  profit: ["profit_report", "dashboard_summary"],
  imports: ["import_list_batches", "import_get_batch", "import_products_preview", "import_cancel", "import_apply",
    "import_template", "export_products", "import_error_report"],
  quotes: ["quote_preview", "quote_create", "quote_list", "quote_get", "quote_cancel", "quote_to_cart",
    "quote_mark_converted", "quote_style_get", "quote_style_save", "save_quote_file", "quote_context", "quote_issue", "quote_docs_list", "quote_doc_get"],
  pricing: ["price_list_options", "price_lists_admin", "save_price_list", "price_list_items", "set_price_list_item",
    "remove_price_list_item", "promotions_list", "save_promotion", "set_promotion_active"],
  purchase_orders: ["po_create", "po_list", "po_get", "po_cancel", "po_to_purchase", "po_mark_received"],
  lots: ["list_lots", "list_sale_lots", "lots_report", "set_product_lots", "create_lot", "update_lot"],
  sale_retentions: ["sret_doc_info", "sret_register", "sret_void", "sret_list"],
  legacy: ["legacy_preview", "legacy_apply", "legacy_history"],
  lan: ["lan_info", "lan_settings_get", "lan_settings_save"],
  keys: ["key_status", "key_recovery_show", "key_confirm_saved"],
};

// símbolos que deben aparecer dentro de ciertos archivos de Rust
const SYMBOLS = {
  "lib.rs": ["generate_handler", "AppState::new", "backup::auto_if_due", "db::open"],
  "db.rs": ["MIGRATIONS", "pub fn open", "pub fn migrate", "crypto::apply", "fn check_integrity", "quick_check"],
  "crypto.rs": ["pub fn prepare", "pub fn apply", "pub fn recovery_code", "pub fn status", "pub fn remove_plain_copy", "store::"],
  "keyplan.rs": ["pub fn plan", "pub fn normalize", "pub enum Plan"],
  "backup.rs": ["pub fn run", "pub fn restore", "pub fn check_restorable", "pub fn valid_name", "pub fn auto_if_due", "pub fn list"],
  "audit.rs": ["pub fn log"],
  "error.rs": ["enum AppError", "Validation", "Unauthorized", "Forbidden", "InvalidCredentials"],
  "security.rs": ["pub fn hash_password", "pub fn verify_password", "pub fn require_role", "pub fn require_session",
    "pub fn validate_password", "ALL_ROLES", "STOCK_MANAGERS", "SALES_ROLES"],
  "state.rs": ["struct AppState", "struct SessionUser", "must_change_password", "pub fn peek", "pub fn set_session",
    "pub fn clear_must_change", "SESSION_TIMEOUT", "pub fn take_session", "pub fn put_session"],
  "tls.rs": ["pub fn ensure", "pub fn current_fingerprint", "rcgen"],
  "lan.rs": ["pub fn start", "pub fn load_config", "pub fn save_config", "pub fn info", "LOCAL_ONLY", "lan_dispatch::dispatch",
    "lan_guard::is_private", "origin_allowed", "WORKERS", "MAX_BODY"],
  "lan_dispatch.rs": ["pub async fn dispatch"],
  "lan_guard.rs": ["pub fn is_private", "pub fn origin_allowed", "pub struct Limiter", "MAX_LOGIN_FAILS", "MAX_REQ_PER_MIN"],
  "commands/warehouses.rs": ["pub fn sales_warehouse_id"],
  "commands/retentions.rs": ["pub fn read_cfg", "pub struct WhCfg"],
};

const RUST_FILES = [
  "main.rs", "lib.rs", "db.rs", "crypto.rs", "keyplan.rs", "lan.rs", "lan_dispatch.rs", "lan_guard.rs", "tls.rs", "backup.rs", "audit.rs", "error.rs", "security.rs", "state.rs",
  "commands/mod.rs", ...Object.keys(COMMANDS).map((c) => `commands/${c}.rs`),
].map((f) => `${RUST}/${f}`);

const PAGES = ["Setup", "Login", "Dashboard", "Products", "Inventory", "Customers", "Rates", "Sales", "Documents",
  "Cash", "Reports", "Account", "Users", "Backups", "Settings", "Audit", "Purchases", "Receivables", "Payables",
  "Expenses", "Books", "Profit", "Quotes", "Pricing", "ImportProducts", "Labels", "Hubs", "LegacyMigration"];
const COMPONENTS = ["Layout", "ErrorBoundary", "CustomerPicker", "CheckoutModal", "Ticket", "LanCard", "KeyCard", "RateWatcher"];
const INVENTORY_COMPONENTS = ["StockTab", "MovementForm", "MovementsTab", "TransfersTab", "WarehousesTab", "CategoriesTab"];
const PURCHASE_COMPONENTS = ["SupplierPicker", "NewPurchaseTab", "HistoryTab", "SuppliersTab", "RetentionsTab",
  "RetentionConfigTab", "VoucherModal"];

const FRONT_FILES = [
  "src/main.jsx", "src/App.jsx", "src/index.css",
  ...COMPONENTS.map((c) => `src/components/${c}.jsx`),
  "src/components/inventory/labels.js",
  ...INVENTORY_COMPONENTS.map((c) => `src/components/inventory/${c}.jsx`),
  ...PURCHASE_COMPONENTS.map((c) => `src/components/purchases/${c}.jsx`),
  ...PAGES.map((p) => `src/pages/${p}.jsx`),
  "src/hooks/useSessionGuard.js", "src/schemas/auth.js", "src/services/api.js", "src/services/transport.js", "src/store/authStore.js",
  "src/utils/money.js", "src/utils/dates.js", "src/utils/csv.js", "src/utils/document.js",
];

const ROOT_FILES = [
  "package.json", "vite.config.js", "index.html",
  "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "src-tauri/build.rs", "src-tauri/capabilities/default.json",
];

const EXPORTS = {
  "src/utils/money.js": ["toMinor", "fromMinor", "formatMoney", "toMicro", "fromMicro", "convertMinor"],
  "src/utils/dates.js": ["localDate", "todayStr", "daysAgo"],
  "src/utils/csv.js": ["toCsv", "csvMoney"],
  "src/utils/document.js": ["parseDocument", "formatDocument", "searchTerm"],
  "src/store/authStore.js": ["useAuth"],
  "src/hooks/useSessionGuard.js": ["useSessionGuard"],
  "src/schemas/auth.js": ["loginSchema", "setupSchema"],
  "src/services/api.js": ["authApi", "catalogApi", "inventoryApi", "warehousesApi", "customersApi", "ratesApi",
    "salesApi", "cashApi", "reportsApi", "usersApi", "backupApi", "settingsApi", "auditApi", "suppliersApi",
    "purchasesApi", "retentionsApi", "lanApi", "keyApi", "setUnauthorizedHandler"],
  "src/services/transport.js": ["transportCall"],
};

const ROUTES = ["/setup", "/login", "/productos", "/inventario", "/compras", "/clientes", "/tasas", "/ventas",
  "/documentos", "/caja", "/reportes", "/usuarios", "/auditoria", "/configuracion", "/respaldos", "/cuenta"];

const TABLES = ["roles", "users", "settings", "audit_log", "company", "currencies", "exchange_rates", "tax_rates",
  "categories", "products", "customers", "stock_movements", "document_series", "documents", "document_items",
  "payments", "fiscal_outbox", "cash_sessions", "warehouses", "stock_transfers", "suppliers", "purchases",
  "purchase_items"];

const SQL_PIECES = [
  ["users.failed_attempts", /ADD\s+COLUMN\s+failed_attempts/i],
  ["users.locked_until", /ADD\s+COLUMN\s+locked_until/i],
  ["users.must_change_password", /ADD\s+COLUMN\s+must_change_password/i],
  ["documents.tax_waived", /ADD\s+COLUMN\s+tax_waived/i],
  ["documents.igtf_waived", /ADD\s+COLUMN\s+igtf_waived/i],
  ["documents.cash_session_id", /ADD\s+COLUMN\s+cash_session_id/i],
  ["stock_movements.note", /ADD\s+COLUMN\s+note\b/i],
  ["stock_movements.warehouse_id", /ADD\s+COLUMN\s+warehouse_id/i],
  ["stock_movements.transfer_id", /ADD\s+COLUMN\s+transfer_id/i],
  ["stock_movements.purchase_id", /ADD\s+COLUMN\s+purchase_id/i],
  ["trigger trg_documents_locked", /CREATE\s+TRIGGER\s+trg_documents_locked/i],
  ["trigger trg_documents_no_delete", /CREATE\s+TRIGGER\s+trg_documents_no_delete/i],
  ["trigger trg_movement_needs_warehouse", /CREATE\s+TRIGGER\s+trg_movement_needs_warehouse/i],
  ["trigger trg_purchases_locked", /CREATE\s+TRIGGER\s+trg_purchases_locked/i],
];

// ───────────────────────── 1. Archivos ─────────────────────────
function checkFiles() {
  for (const rel of [...ROOT_FILES, ...RUST_FILES, ...FRONT_FILES]) {
    if (!isFile(rel)) { bad("Archivos", `No existe: ${rel}`); continue; }
    const size = fs.statSync(abs(rel)).size;
    if (size < 20 && !rel.endsWith("mod.rs")) warn("Archivos", `Está vacío o casi vacío: ${rel} (${size} bytes)`);
    else ok();
  }
  const jsxDefault = [
    ...PAGES.map((p) => `src/pages/${p}.jsx`),
    ...COMPONENTS.map((c) => `src/components/${c}.jsx`),
    ...INVENTORY_COMPONENTS.map((c) => `src/components/inventory/${c}.jsx`),
    ...PURCHASE_COMPONENTS.map((c) => `src/components/purchases/${c}.jsx`),
  ];
  for (const rel of jsxDefault) {
    const src = read(rel);
    if (src === null) continue;
    if (!/export\s+default\s/.test(src)) warn("Archivos", `${rel} no tiene «export default» (¿quedó incompleto?)`);
    else ok();
  }
}

// ───────────────────────── 2. Migraciones ─────────────────────────
function checkMigrations() {
  const dbrs = read(`${RUST}/db.rs`);
  if (dbrs === null) return;
  const listed = [...stripRust(dbrs).matchAll(/include_str!\(\s*"\.\.\/migrations\/([^"]+)"\s*\)/g)].map((m) => m[1]);
  if (listed.length === 0) { bad("Migraciones", "db.rs no registra ninguna migración (include_str!)"); return; }

  MIGRATIONS.forEach((name, i) => {
    if (listed[i] !== name) {
      bad("Migraciones", `En db.rs la migración nº ${i + 1} debería ser ${name} y es ${listed[i] ?? "(ninguna)"}`);
    } else ok();
  });
  for (const name of listed) {
    if (!isFile(`${MIG}/${name}`)) bad("Migraciones", `db.rs registra ${name}, pero el archivo no existe en ${MIG}/`);
    else ok();
  }
  const extra = listed.slice(MIGRATIONS.length);
  if (extra.length) info("Migraciones", `Migraciones adicionales registradas (módulos 10 en adelante): ${extra.join(", ")}`);

  let onDisk = [];
  try { onDisk = fs.readdirSync(abs(MIG)).filter((f) => f.endsWith(".sql")); } catch { /* sin carpeta */ }
  for (const f of onDisk) {
    if (!listed.includes(f)) warn("Migraciones", `${f} existe pero NO está registrada en db.rs (no se aplicará)`);
  }

  const sql = listed.map((n) => read(`${MIG}/${n}`) ?? "").join("\n");
  for (const t of TABLES) {
    if (!new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${t}\\b`, "i").test(sql)) {
      bad("Migraciones", `Ninguna migración crea la tabla «${t}»`);
    } else ok();
  }
  for (const [label, re] of SQL_PIECES) {
    if (!re.test(sql)) bad("Migraciones", `Falta en las migraciones: ${label}`); else ok();
  }

  // Módulos opcionales / posteriores
  const optional = [
    ["Módulo de descuentos y vuelto", /ADD\s+COLUMN\s+discount_bp/i],
    ["Módulo de retenciones (tabla withholdings)", /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?withholdings\b/i],
    ["Módulo de retenciones (tabla islr_concepts)", /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?islr_concepts\b/i],
  ];
  for (const [label, re] of optional) {
    info("Módulos opcionales", `${label}: ${re.test(sql) ? "aplicado" : "NO aplicado"}`);
  }
}

// ───────────────────────── 3. Rust ─────────────────────────
function checkRust() {
  const lib = read(`${RUST}/lib.rs`);
  if (lib !== null) {
    const libClean = stripRust(lib);
    const mods = [...libClean.matchAll(/^\s*mod\s+(\w+)\s*;/gm)].map((m) => m[1]);
    for (const m of ["audit", "backup", "commands", "db", "error", "lan", "lan_dispatch", "lan_guard", "security", "state", "tls", "keyplan"]) {
      if (!mods.includes(m)) bad("Rust", `lib.rs no declara «mod ${m};»`); else ok();
    }
    for (const m of mods) {
      if (!isFile(`${RUST}/${m}.rs`) && !isFile(`${RUST}/${m}/mod.rs`)) {
        bad("Rust", `lib.rs declara «mod ${m};» pero no existe ${RUST}/${m}.rs`);
      }
    }
  }

  const modrs = read(`${RUST}/commands/mod.rs`);
  if (modrs !== null) {
    const declared = [...stripRust(modrs).matchAll(/pub\s+mod\s+(\w+)\s*;/g)].map((m) => m[1]);
    for (const c of Object.keys(COMMANDS)) {
      const exists = isFile(`${RUST}/commands/${c}.rs`);
      if (exists && !declared.includes(c)) bad("Rust", `commands/${c}.rs existe pero falta «pub mod ${c};» en commands/mod.rs`);
      else if (!exists && declared.includes(c)) bad("Rust", `commands/mod.rs declara «${c}» pero falta commands/${c}.rs`);
      else if (exists) ok();
    }
  }

  // Comandos dentro de cada archivo
  const present = {};
  for (const [file, fns] of Object.entries(COMMANDS)) {
    const src = read(`${RUST}/commands/${file}.rs`);
    if (src === null) continue;
    const found = [...src.matchAll(/#\[tauri::command\](?:\s*\/\/[^\n]*)*\s*pub\s+async\s+fn\s+(\w+)/g)].map((m) => m[1]);
    present[file] = new Set(found);
    for (const fn of fns) {
      if (!found.includes(fn)) bad("Rust", `commands/${file}.rs: falta la función de comando «${fn}»`); else ok();
    }
  }

  // Registro en lib.rs
  let handlers = [];
  if (lib !== null) {
    const m = stripRust(lib).match(/generate_handler!\s*\[([\s\S]*?)\]\s*\)/);
    if (!m) bad("Rust", "lib.rs no tiene tauri::generate_handler![ ... ]");
    else handlers = [...m[1].matchAll(/commands::(\w+)::(\w+)/g)].map((x) => ({ mod: x[1], fn: x[2] }));
  }
  const registered = new Set(handlers.map((h) => `${h.mod}::${h.fn}`));
  if (lib !== null && handlers.length) {
    for (const [file, fns] of Object.entries(COMMANDS)) {
      for (const fn of fns) {
        if (!registered.has(`${file}::${fn}`)) bad("Rust", `lib.rs no registra commands::${file}::${fn} en generate_handler!`);
        else ok();
      }
    }
    for (const h of handlers) {
      if (COMMANDS[h.mod] === undefined) warn("Rust", `lib.rs registra commands::${h.mod}::${h.fn}, pero ese módulo no es conocido`);
      else if (present[h.mod] && !present[h.mod].has(h.fn)) bad("Rust", `lib.rs registra commands::${h.mod}::${h.fn}, pero esa función no existe`);
    }
  }
  globalThis.__handlerNames = new Set(handlers.map((h) => h.fn));

  // Modo red: cada comando registrado debe estar en la tabla generada (lan_dispatch.rs).
  const disp = read(`${RUST}/lan_dispatch.rs`);
  if (disp !== null && handlers.length) {
    const inDisp = new Set([...disp.matchAll(/^\s*"(\w+)"\s*=>/gm)].map((m) => m[1]));
    for (const h of handlers) {
      if (!inDisp.has(h.fn)) bad("Modo red", `lan_dispatch.rs no incluye el comando «${h.fn}». Ejecuta: node gen-dispatch.mjs`);
      else ok();
    }
    for (const n of inDisp) {
      if (!globalThis.__handlerNames.has(n)) bad("Modo red", `lan_dispatch.rs incluye «${n}», que ya no está en lib.rs. Ejecuta: node gen-dispatch.mjs`);
    }
  }

  // Símbolos clave
  for (const [file, needles] of Object.entries(SYMBOLS)) {
    const src = read(`${RUST}/${file}`);
    if (src === null) continue;
    for (const n of needles) {
      if (!src.includes(n)) bad("Rust", `${file}: no se encuentra «${n}»`); else ok();
    }
  }

  // Los saldos por cobrar/pagar deben salir de una sola fórmula (receivables.rs / payables.rs).
  const profit = read(`${RUST}/commands/profit.rs`);
  if (profit !== null) {
    if (/const\s+A[RP]_BALANCE\s*:\s*&str\s*=/.test(stripRust(profit))) {
      bad("Rust", "profit.rs define su propia fórmula de saldos; debe usar receivables::BALANCE_SQL y payables::BALANCE_SQL");
    } else ok();
  }
  for (const f of ["receivables", "payables"]) {
    const src = read(`${RUST}/commands/${f}.rs`);
    if (src !== null && !/pub\(crate\)\s+const\s+BALANCE_SQL/.test(src)) {
      bad("Rust", `commands/${f}.rs: BALANCE_SQL debe ser pub(crate) para compartirse con el panel de inicio`);
    } else if (src !== null) ok();
  }

  // Cargo.toml
  const cargo = read("src-tauri/Cargo.toml");
  if (cargo !== null) {
    const sec = cargo.match(/\[dependencies\]([\s\S]*?)(?=\n\[|$)/);
    if (!sec) bad("Cargo.toml", "No tiene la sección [dependencies]");
    else {
      const names = [...sec[1].matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]);
      const seen = new Set();
      for (const n of names) {
        if (seen.has(n)) bad("Cargo.toml", `Dependencia duplicada: ${n} (Cargo no compila con claves repetidas)`);
        seen.add(n);
      }
      for (const dep of ["tauri", "serde", "serde_json", "rusqlite", "rusqlite_migration", "argon2", "chrono", "thiserror", "tiny_http"]) {
        if (!seen.has(dep)) bad("Cargo.toml", `Falta la dependencia «${dep}»`); else ok();
      }
      const line = (dep) => (sec[1].match(new RegExp(`^${dep}\\s*=.*$`, "m")) ?? [""])[0];
      const rl = line("rusqlite");
      if (!/"bundled(-sqlcipher(-vendored-openssl)?)?"/.test(rl)) bad("Cargo.toml", 'rusqlite necesita la feature "bundled" o "bundled-sqlcipher-vendored-openssl"'); else ok();
      if (!rl.includes("sqlcipher")) warn("Cargo.toml", "rusqlite no usa SQLCipher: la base de datos queda sin cifrar");
      for (const f of ["chrono", "backup"]) {
        if (!rl.includes(`"${f}"`)) bad("Cargo.toml", `rusqlite necesita la feature "${f}"`); else ok();
      }
      if (!line("argon2").includes('"std"')) bad("Cargo.toml", 'argon2 necesita la feature "std" (para OsRng)'); else ok();
      if (seen.has("tauri-plugin-opener")) warn("Cargo.toml", "tauri-plugin-opener ya no se usa; puedes quitarlo (no rompe nada)");
      if (lib && lib.includes("tauri_plugin_opener") && !seen.has("tauri-plugin-opener")) {
        bad("Cargo.toml", "lib.rs usa tauri_plugin_opener pero no está en Cargo.toml");
      }
    }
  }
}

// ───────────────────────── 4. Frontend ─────────────────────────
function walk(dir, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(abs(dir), { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, acc);
    else if (/\.(jsx?|mjs)$/.test(e.name)) acc.push(rel);
  }
  return acc;
}

function checkFrontend() {
  const pkgRaw = read("package.json");
  let pkg = null;
  if (pkgRaw !== null) {
    try { pkg = JSON.parse(pkgRaw); } catch { bad("package.json", "No es un JSON válido"); }
  }
  const deps = pkg ? { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } : {};
  if (pkg) {
    for (const d of ["react", "react-dom", "react-router-dom", "zustand", "zod", "@tauri-apps/api", "vite",
      "tailwindcss", "@tailwindcss/vite", "@tauri-apps/cli"]) {
      if (!deps[d]) bad("package.json", `Falta la dependencia «${d}» (npm install ${d})`); else ok();
    }
    if (!pkg.scripts?.tauri) warn("package.json", 'No hay script "tauri"');
  }

  // Imports: relativos deben existir; paquetes deben estar instalados
  const IMPORT_RE = /(?:import|export)\s+(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const rel of walk("src")) {
    const src = read(rel) ?? "";
    const dir = path.posix.dirname(rel);
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (spec.startsWith(".")) {
        const base = path.posix.normalize(path.posix.join(dir, spec));
        const cands = [base, `${base}.js`, `${base}.jsx`, `${base}.json`, `${base}.css`, `${base}/index.js`, `${base}/index.jsx`];
        if (!cands.some(isFile)) bad("Imports", `${rel} importa «${spec}» y ese archivo no existe`);
        else ok();
      } else if (pkg) {
        const parts = spec.split("/");
        const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
        if (!deps[name]) bad("Imports", `${rel} importa el paquete «${name}», que no está en package.json`);
        else ok();
      }
    }
  }

  // Exportaciones esperadas
  for (const [file, names] of Object.entries(EXPORTS)) {
    const src = read(file);
    if (src === null) continue;
    const found = new Set([...src.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:const|let|function|class)\s+(\w+)/g)].map((m) => m[1]));
    for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) m[1].split(",").forEach((s) => found.add(s.trim().split(/\s+as\s+/).pop()));
    for (const n of names) {
      if (!found.has(n)) bad("Frontend", `${file}: falta exportar «${n}»`); else ok();
    }
  }

  // Comandos que el frontend invoca vs. los registrados en Rust
  const api = read("src/services/api.js");
  const handlerNames = globalThis.__handlerNames;
  if (api !== null && handlerNames && handlerNames.size) {
    const called = [...new Set([...api.matchAll(/call\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]))];
    for (const c of called) {
      if (!handlerNames.has(c)) bad("API", `api.js llama a «${c}» y Rust no lo registra en lib.rs`); else ok();
    }
    for (const h of handlerNames) {
      if (!called.includes(h)) warn("API", `El comando «${h}» está en Rust pero api.js no lo usa (¿falta en api.js?)`);
    }
  }

  // Rutas y menú
  const app = read("src/App.jsx");
  if (app !== null) {
    for (const r of ROUTES) {
      if (!app.includes(`path="${r}"`)) bad("Rutas", `App.jsx no tiene la ruta ${r}`); else ok();
    }
  }
  const layout = read("src/components/Layout.jsx");
  if (layout !== null) {
    for (const r of ROUTES.filter((x) => x !== "/setup" && x !== "/login")) {
      if (!layout.includes(`to="${r}"`)) warn("Menú", `Layout.jsx no tiene el enlace a ${r}`); else ok();
    }
  }

  // Estilos y configuración de Vite
  const css = read("src/index.css");
  if (css !== null && !/@import\s+["']tailwindcss["']/.test(css)) bad("Estilos", 'src/index.css no importa Tailwind ( @import "tailwindcss"; )');
  const vite = read("vite.config.js");
  if (vite !== null && !vite.includes("@tailwindcss/vite")) bad("Estilos", "vite.config.js no usa el plugin @tailwindcss/vite");
  const main = read("src/main.jsx");
  if (main !== null) {
    if (!/index\.css/.test(main)) bad("Estilos", "src/main.jsx no importa index.css");
    if (!/ErrorBoundary/.test(main)) warn("Frontend", "src/main.jsx no usa ErrorBoundary (una pantalla puede quedar en blanco ante un error)");
  }
}

// ───────────────────────── 5. Configuración de Tauri ─────────────────────────
function checkTauriConfig() {
  const raw = read("src-tauri/tauri.conf.json");
  if (raw !== null) {
    try {
      const conf = JSON.parse(raw);
      if (!conf.identifier) bad("tauri.conf.json", "Falta «identifier»"); else ok();
      const csp = conf.app?.security?.csp;
      if (!csp) warn("tauri.conf.json", "No hay CSP configurada (app.security.csp). Recomendado para producción");
      else ok();
      if (csp && !/connect-src[^;]*http:\/\/127\.0\.0\.1/.test(csp)) {
        bad("tauri.conf.json", "La CSP debe permitir conexiones a http://127.0.0.1:* (connect-src) para el modo red");
      } else if (csp) ok();
    } catch { bad("tauri.conf.json", "No es un JSON válido"); }
  }
  const capRaw = read("src-tauri/capabilities/default.json");
  if (capRaw !== null) {
    try {
      const cap = JSON.parse(capRaw);
      if (!(cap.permissions ?? []).includes("core:default")) warn("capabilities", 'default.json no incluye "core:default"');
      else ok();
    } catch { bad("capabilities", "default.json no es un JSON válido"); }
  }
}

// ───────────────────────── Ejecución e informe ─────────────────────────
const sections = [checkFiles, checkMigrations, checkRust, checkFrontend, checkTauriConfig];
for (const s of sections) {
  try { s(); } catch (e) { warn("Verificador", `Error interno en ${s.name}: ${e.message}`); }
}

const out = [];
const log = (s = "") => { console.log(s); out.push(s); };

if (!isFile("package.json") || !isFile("src-tauri/Cargo.toml")) {
  log("ATENCIÓN: no encuentro package.json o src-tauri/Cargo.toml en esta carpeta.");
  log(`Carpeta actual: ${ROOT}`);
  log("Copia este archivo a la raíz del proyecto y vuelve a ejecutarlo.\n");
}

const groups = { FALTA: [], REVISAR: [], INFO: [] };
for (const i of issues) groups[i.level].push(i);
const titles = {
  FALTA: "FALTA / ROTO (hay que corregirlo)",
  REVISAR: "REVISAR (puede no ser un error)",
  INFO: "INFORMACIÓN",
};
log("=== VERIFICACIÓN DEL PROYECTO ===");
log(`Carpeta: ${ROOT}`);
log(`Comprobaciones correctas: ${okCount}`);
log(`FALTA: ${groups.FALTA.length} · REVISAR: ${groups.REVISAR.length}\n`);
for (const level of ["FALTA", "REVISAR", "INFO"]) {
  if (!groups[level].length) continue;
  log(`--- ${titles[level]} ---`);
  for (const i of groups[level]) log(`[${i.level}] (${i.area}) ${i.msg}`);
  log("");
}
if (!groups.FALTA.length) log("Resultado: no falta ningún archivo ni registro. Si algo falla, el problema es el contenido de algún archivo.");
else log("Resultado: hay elementos que faltan o están rotos. Pega este reporte en el chat y te devuelvo los archivos.");

try {
  fs.writeFileSync(abs("reporte-verificacion.txt"), out.join("\n") + "\n", "utf8");
  console.log("\n(El reporte también quedó guardado en reporte-verificacion.txt)");
} catch { /* sin permisos de escritura */ }

process.exit(groups.FALTA.length ? 1 : 0);
