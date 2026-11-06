// Estructura del menú: un solo lugar para agregar o mover páginas.
// `roles` en un grupo o ítem limita quién lo ve (sin `roles` = todos). El servidor valida igualmente cada acción.
const ADMIN = ["admin"];
const SELL = ["admin", "cajero"];
const STOCK = ["admin", "almacen"];

export const NAV = [
  {
    id: "vender", label: "Vender", icon: "cart", roles: SELL,
    items: [
      { label: "Nueva venta", to: "/ventas" },
      { label: "Cotizaciones", to: "/cotizaciones" },
      { label: "Documentos", to: "/documentos" },
      { label: "Clientes", to: "/clientes" },
    ],
  },
  {
    id: "caja", label: "Cobrar y caja", icon: "cash", roles: SELL,
    items: [
      { label: "Cuentas", to: "/cuentas", hidePalette: true },
      { label: "Caja y gastos", to: "/caja" },
      { label: "Tasas de cambio", to: "/tasas" },
    ],
  },
  {
    id: "inventario", label: "Inventario y compras", icon: "box",
    items: [
      { label: "Productos", to: "/productos" },
      { label: "Inventario", to: "/inventario", roles: STOCK },
      { label: "Compras", to: "/compras", roles: STOCK },
      { label: "Listas y promociones", to: "/precios", roles: ADMIN },
    ],
  },
  {
    id: "informes", label: "Informes", icon: "chart", roles: ADMIN,
    items: [
      { label: "Libros de compras y ventas", to: "/libros" },
      { label: "Utilidad y rentabilidad", to: "/utilidad" },
      { label: "Reportes", to: "/reportes" },
    ],
  },
  {
    id: "sistema", label: "Sistema", icon: "sliders", roles: ADMIN,
    items: [
      { label: "Usuarios", to: "/usuarios" },
      { label: "Auditoría", to: "/auditoria" },
      { label: "Configuración", to: "/configuracion" },
      { label: "Respaldos", to: "/respaldos" },
      { label: "Migración desde QSL", to: "/migracion", keywords: "importar clientes proveedores saldos sistema anterior" },
    ],
  },
];

// Accesos directos que solo aparecen en el buscador (Ctrl+K): pestañas dentro de las páginas.
const EXTRAS = [
  { label: "Inicio", to: "/", group: "General" },
  { label: "Cuentas por cobrar", to: "/cuentas?tab=cobrar", group: "Cobrar y caja", roles: SELL, keywords: "cobranzas abonos clientes deuda" },
  { label: "Cuentas por pagar", to: "/cuentas?tab=pagar", group: "Cobrar y caja", roles: ADMIN, keywords: "proveedores pagos deuda" },
  { label: "Gastos", to: "/caja?tab=gastos", group: "Cobrar y caja", roles: SELL },
  { label: "Movimientos de caja", to: "/caja?tab=mov", group: "Cobrar y caja", roles: SELL, keywords: "entrada salida efectivo" },
  { label: "Categorías de gasto", to: "/caja?tab=cats", group: "Cobrar y caja", roles: ADMIN },
  { label: "Importar / exportar productos", to: "/productos?tab=importar", group: "Inventario y compras", roles: STOCK, keywords: "csv plantilla catalogo" },
  { label: "Etiquetas y códigos de barras", to: "/productos?tab=etiquetas", group: "Inventario y compras", roles: STOCK, keywords: "imprimir etiqueta codigo barras ean precio" },
  { label: "Órdenes de compra", to: "/compras", group: "Inventario y compras", roles: STOCK, keywords: "pedidos proveedores" },
  { label: "Promociones", to: "/precios", group: "Inventario y compras", roles: ADMIN, keywords: "descuentos ofertas" },
  { label: "Mi cuenta", to: "/cuenta", group: "General", keywords: "contrasena clave" },
];

const allowed = (roles, role) => !roles || roles.includes(role);

/** Grupos e ítems que ve este rol (los grupos vacíos desaparecen). */
export function navFor(role) {
  return NAV.filter((g) => allowed(g.roles, role))
    .map((g) => ({ ...g, items: g.items.filter((i) => allowed(i.roles, role)) }))
    .filter((g) => g.items.length > 0);
}

/** Entradas del buscador rápido para este rol. */
export function paletteFor(role) {
  const fromMenu = navFor(role).flatMap((g) =>
    g.items.filter((i) => !i.hidePalette).map((i) => ({ label: i.label, to: i.to, group: g.label, keywords: i.keywords || "" })));
  const extras = EXTRAS.filter((e) => allowed(e.roles, role)).map((e) => ({ keywords: "", ...e }));
  return [...fromMenu, ...extras];
}

export const normalize = (s) =>
  String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
