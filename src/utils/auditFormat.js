import { formatMoney } from "./money";

// Categorías con color propio (clases completas para que Tailwind las incluya).
export const CATS = {
  ventas:      { label: "Ventas",         icon: "🧾", badge: "bg-emerald-100 text-emerald-800 ring-emerald-300", bar: "border-l-emerald-500", dot: "bg-emerald-500" },
  cotizaciones:{ label: "Cotizaciones",   icon: "📄", badge: "bg-indigo-100 text-indigo-800 ring-indigo-300",    bar: "border-l-indigo-500",  dot: "bg-indigo-500" },
  inventario:  { label: "Inventario",     icon: "📦", badge: "bg-amber-100 text-amber-800 ring-amber-300",       bar: "border-l-amber-500",   dot: "bg-amber-500" },
  catalogo:    { label: "Catálogo",       icon: "🏷️", badge: "bg-lime-100 text-lime-800 ring-lime-300",          bar: "border-l-lime-500",    dot: "bg-lime-500" },
  compras:     { label: "Compras y gastos", icon: "🛒", badge: "bg-orange-100 text-orange-800 ring-orange-300",  bar: "border-l-orange-500",  dot: "bg-orange-500" },
  cobranzas:   { label: "Cobranzas",      icon: "💵", badge: "bg-teal-100 text-teal-800 ring-teal-300",          bar: "border-l-teal-500",    dot: "bg-teal-500" },
  clientes:    { label: "Clientes",       icon: "👥", badge: "bg-cyan-100 text-cyan-800 ring-cyan-300",          bar: "border-l-cyan-500",    dot: "bg-cyan-500" },
  caja:        { label: "Caja",           icon: "🏧", badge: "bg-green-100 text-green-800 ring-green-300",       bar: "border-l-green-500",   dot: "bg-green-500" },
  config:      { label: "Configuración",  icon: "⚙️", badge: "bg-sky-100 text-sky-800 ring-sky-300",             bar: "border-l-sky-500",     dot: "bg-sky-500" },
  respaldos:   { label: "Respaldos",      icon: "💾", badge: "bg-blue-100 text-blue-800 ring-blue-300",          bar: "border-l-blue-500",    dot: "bg-blue-500" },
  usuarios:    { label: "Usuarios y sesiones", icon: "🔑", badge: "bg-violet-100 text-violet-800 ring-violet-300", bar: "border-l-violet-500", dot: "bg-violet-500" },
  seguridad:   { label: "Alertas de seguridad", icon: "🚨", badge: "bg-red-100 text-red-800 ring-red-300",       bar: "border-l-red-500",     dot: "bg-red-500" },
  otros:       { label: "Otros",          icon: "•",  badge: "bg-slate-100 text-slate-700 ring-slate-300",       bar: "border-l-slate-400",   dot: "bg-slate-400" },
};

// acción → [texto, categoría, explicación cuando no trae detalle]
const A = {
  login: ["Inicio de sesión", "usuarios", "Entró al sistema"],
  logout: ["Cierre de sesión", "usuarios", "Salió del sistema"],
  login_failed: ["Intento de acceso fallido", "seguridad", "Usuario o clave incorrectos"],
  login_blocked: ["Acceso bloqueado", "seguridad", "Intentó entrar a una cuenta bloqueada"],
  account_locked: ["Cuenta bloqueada", "seguridad", "Se bloqueó por demasiados intentos fallidos"],
  recovery_failed: ["Recuperación fallida", "seguridad", "Código de recuperación incorrecto"],
  key_reauth_failed: ["Reautenticación fallida", "seguridad", "Clave incorrecta al pedir la llave de cifrado"],
  integrity_check_failed: ["Fallo de integridad", "seguridad", "La verificación de la base de datos detectó un problema"],
  admin_recovered: ["Administrador recuperado", "seguridad", "Se recuperó el acceso del administrador con el código de recuperación"],
  recovery_code_generated: ["Código de recuperación generado", "seguridad", "Se creó un nuevo código de recuperación"],
  key_recovery_shown: ["Llave de recuperación mostrada", "seguridad", "Se mostró la llave de recuperación de la base de datos"],
  key_recovery_confirmed: ["Llave de recuperación confirmada", "seguridad", "Se confirmó que la llave fue guardada"],
  user_created: ["Usuario creado", "usuarios", "Se creó una cuenta de usuario"],
  user_updated: ["Usuario editado", "usuarios", "Se modificaron datos o rol de un usuario"],
  user_activated: ["Usuario activado", "usuarios", "Se reactivó una cuenta"],
  user_deactivated: ["Usuario desactivado", "usuarios", "Se desactivó una cuenta"],
  user_unlocked: ["Usuario desbloqueado", "usuarios", "Se desbloqueó una cuenta"],
  password_reset: ["Clave restablecida", "usuarios", "Un administrador restableció la clave de un usuario"],
  password_changed: ["Clave cambiada", "usuarios", "El usuario cambió su propia clave"],
  setup_completed: ["Configuración inicial completada", "config", "Se terminó el asistente de instalación"],
  settings_updated: ["Configuración cambiada", "config", "Se modificaron los datos de la empresa o ajustes"],
  lan_config_changed: ["Modo red modificado", "config", "Se cambió la configuración del servidor en red local"],
  quote_style_saved: ["Formato de cotización guardado", "config", "Se actualizó el logo, las garantías o el pie de las cotizaciones"],
  retention_config_saved: ["Retenciones configuradas", "config", "Se cambió la configuración de retenciones"],
  islr_concept_saved: ["Concepto de ISLR guardado", "config", "Se creó o editó un concepto de ISLR"],
  islr_concept_activated: ["Concepto de ISLR activado", "config", ""],
  islr_concept_deactivated: ["Concepto de ISLR desactivado", "config", ""],
  expense_category_saved: ["Categoría de gasto guardada", "config", "Se creó o editó una categoría de gastos"],
  exchange_rate_set: ["Tasa de cambio registrada", "config", "Se registró la tasa del día"],
  backup_created: ["Respaldo creado", "respaldos", "Se generó una copia de seguridad"],
  backup_dir_set: ["Carpeta de respaldos cambiada", "respaldos", "Se eligió otra carpeta para los respaldos"],
  backup_restored: ["Respaldo restaurado", "respaldos", "Se restauró la base de datos desde un respaldo"],
  sale_issued: ["Venta emitida", "ventas", "Se emitió una factura o nota de entrega"],
  sale_issued_waiver: ["Venta con exoneración", "ventas", "Se emitió una venta exonerada de IVA"],
  document_voided: ["Documento anulado", "ventas", "Se anuló un documento de venta"],
  return_issued: ["Devolución emitida", "ventas", "Se registró una devolución de venta"],
  quote_issued: ["Cotización emitida", "cotizaciones", "Se generó una cotización"],
  quote_created: ["Cotización creada", "cotizaciones", ""],
  quote_cancelled: ["Cotización anulada", "cotizaciones", ""],
  quote_converted: ["Cotización convertida en venta", "cotizaciones", ""],
  stock_adjusted: ["Ajuste de inventario", "inventario", "Se corrigió la existencia de un producto"],
  stock_transferred: ["Traslado entre almacenes", "inventario", "Se movió mercancía de un almacén a otro"],
  lot_updated: ["Lote actualizado", "inventario", "Se editó un lote de producto"],
  warehouse_created: ["Almacén creado", "inventario", ""],
  warehouse_updated: ["Almacén editado", "inventario", ""],
  sales_warehouse_set: ["Almacén de ventas definido", "inventario", "Se eligió el almacén desde el que se vende"],
  product_created: ["Producto creado", "catalogo", ""],
  product_updated: ["Producto editado", "catalogo", ""],
  product_activated: ["Producto activado", "catalogo", ""],
  product_deactivated: ["Producto desactivado", "catalogo", ""],
  products_imported: ["Productos importados", "catalogo", "Carga masiva de productos desde archivo"],
  category_created: ["Categoría creada", "catalogo", ""],
  category_renamed: ["Categoría renombrada", "catalogo", ""],
  category_deleted: ["Categoría eliminada", "catalogo", ""],
  promotion_created: ["Promoción creada", "catalogo", ""],
  price_list_saved: ["Lista de precios guardada", "catalogo", ""],
  price_list_item_set: ["Precio de lista definido", "catalogo", ""],
  price_list_item_removed: ["Precio de lista quitado", "catalogo", ""],
  purchase_created: ["Compra registrada", "compras", ""],
  purchase_voided: ["Compra anulada", "compras", ""],
  purchase_order_created: ["Orden de compra creada", "compras", ""],
  purchase_order_received: ["Orden de compra recibida", "compras", "Entró la mercancía al inventario"],
  purchase_order_cancelled: ["Orden de compra cancelada", "compras", ""],
  supplier_created: ["Proveedor creado", "compras", ""],
  supplier_updated: ["Proveedor editado", "compras", ""],
  supplier_retention_set: ["Retención de IVA del proveedor", "compras", ""],
  ap_payment: ["Pago a proveedor", "compras", "Se registró un pago de cuenta por pagar"],
  ap_payment_voided: ["Pago a proveedor anulado", "compras", ""],
  expense_created: ["Gasto registrado", "compras", ""],
  expense_voided: ["Gasto anulado", "compras", ""],
  ar_receipt: ["Cobro registrado", "cobranzas", "Se cobró una cuenta por cobrar"],
  ar_receipt_voided: ["Cobro anulado", "cobranzas", ""],
  ar_credit_applied: ["Crédito aplicado", "cobranzas", "Se aplicó saldo a favor del cliente"],
  credit_terms_set: ["Condiciones de crédito definidas", "cobranzas", ""],
  customer_created: ["Cliente creado", "clientes", ""],
  customer_updated: ["Cliente editado", "clientes", ""],
  customer_activated: ["Cliente activado", "clientes", ""],
  customer_deactivated: ["Cliente desactivado", "clientes", ""],
  cash_opened: ["Caja abierta", "caja", "Se abrió el turno de caja"],
  cash_closed: ["Caja cerrada", "caja", "Se cerró el turno de caja"],
  cash_movement_created: ["Movimiento de caja", "caja", "Entrada o salida manual de efectivo"],
  cash_movement_voided: ["Movimiento de caja anulado", "caja", ""],
};

const ENTITIES = {
  exchange_rate: "Tasa", customer: "Cliente", quote_doc: "Cotización", quote: "Cotización", user: "Usuario", product: "Producto",
  document: "Documento", warehouse: "Almacén", supplier: "Proveedor", settings: "Configuración",
  expense_category: "Categoría de gasto", islr_concept: "Concepto ISLR", promotion: "Promoción",
};
const METHODS = {
  pago_movil: "Pago móvil", efectivo: "Efectivo", cash: "Efectivo", transferencia: "Transferencia",
  transfer: "Transferencia", zelle: "Zelle", punto: "Punto de venta", tarjeta: "Tarjeta", divisas: "Divisas",
};

const WARN = new Set(["document_voided", "purchase_voided", "ap_payment_voided", "expense_voided", "cash_movement_voided",
  "ar_receipt_voided", "purchase_order_cancelled", "quote_cancelled", "backup_restored", "password_reset",
  "admin_recovered", "stock_adjusted", "category_deleted", "user_deactivated"]);
const DANGER = new Set(["login_failed", "login_blocked", "account_locked", "recovery_failed", "key_reauth_failed", "integrity_check_failed"]);

const humanize = (s) => { const t = s.replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };
const num = (s, d = 2) => Number(s).toLocaleString("es-VE", { minimumFractionDigits: d, maximumFractionDigits: Math.max(d, 4) });
const dmy = (s) => s.split("-").reverse().join("/");
const cur = (c) => (c === "USD" ? "$" : "Bs.");

/** { label, cat, level: "info"|"warn"|"danger", text, entity } listo para mostrar. */
export function describe(row) {
  const a = A[row.action];
  const label = a ? a[0] : humanize(row.action);
  const cat = a ? a[1] : (row.action.startsWith("quote") ? "cotizaciones" : "otros");
  const level = DANGER.has(row.action) ? "danger" : WARN.has(row.action) ? "warn" : "info";
  const d = (row.detail ?? "").trim();
  let text = d;
  let m;
  if ((m = /^(COT-\d+) (USD|VES) (-?\d+)$/.exec(d))) {
    text = `${m[1]} por ${formatMoney(Number(m[3]), m[2])} (${m[2] === "USD" ? "pago en divisas" : "pago en bolívares"})`;
  } else if ((m = /^([A-Z]{3}) (\d{4}-\d{2}-\d{2}): ([\d.]+)$/.exec(d))) {
    text = `Tasa ${m[1]} del ${dmy(m[2])}: Bs. ${num(m[3])} por ${m[1] === "USD" ? "dólar" : m[1]}`;
  } else if ((m = /^(\S+): ([\d.]+) ([A-Z]{3}) \(([\w ]+)\)$/.exec(d))) {
    text = `${m[1]} · ${cur(m[3])} ${num(m[2])} · ${METHODS[m[4]] ?? humanize(m[4])}`;
  } else if (!d && a && a[2]) {
    text = a[2];
  }
  const ent = row.entity ? `${ENTITIES[row.entity] ?? humanize(row.entity)}${row.entityId ? ` #${row.entityId}` : ""}` : "";
  return { label, cat, level, text, entity: ent };
}

/** Fecha y hora locales (la base guarda UTC). */
export function splitDate(s) {
  if (!s) return { day: "—", time: "" };
  const d = new Date(String(s).replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return { day: String(s), time: "" };
  return {
    day: d.toLocaleDateString("es-VE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }),
    time: d.toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  };
}
