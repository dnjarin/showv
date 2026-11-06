import { transportCall } from "./transport";

/**
 * @typedef {{id:number, username:string, fullName:string, role:'admin'|'cajero'|'almacen'}} User
 */

let onUnauthorized = () => { };
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function call(cmd, args) {
  try {
    return await transportCall(cmd, args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error inesperado";
    if (msg === "Debes iniciar sesión") onUnauthorized();
    throw new Error(msg);
  }
}

export const authApi = {
  /** @returns {Promise<boolean>} */
  needsSetup: () => call("needs_setup"),
  /** @returns {Promise<User>} */
  completeSetup: (input) => call("complete_setup", { input }),
  /** @returns {Promise<User>} */
  login: (username, password) => call("login", { username, password }),
  logout: () => call("logout"),
  /** @returns {Promise<User|null>} */
  currentUser: () => call("current_user"),
  keepAlive: () => call("keep_alive"),
  recover: (username, code, newPassword) => call("recover_admin", { username, code, newPassword }),
};
export const labelsApi = {
  context: () => call("label_context"),
  assign: (ids = null) => call("assign_barcodes", { ids }),
};
export const catalogApi = {
  options: () => call("catalog_options"),
  createCategory: (name) => call("create_category", { name }),
  categories: () => call("categories_overview"),
  renameCategory: (id, name) => call("rename_category", { id, name }),
  deleteCategory: (id) => call("delete_category", { id }),
  listProducts: (search, includeInactive, lowStockOnly, categoryId = null) =>
    call("list_products", { search, includeInactive, lowStockOnly, categoryId }),
  createProduct: (input) => call("create_product", { input }),
  updateProduct: (id, input) => call("update_product", { id, input }),
  setActive: (id, active) => call("set_product_active", { id, active }),
};

export const inventoryApi = {
  adjust: (input) => call("adjust_stock", { input }),
  movements: (filter) => call("list_movements", { filter }),
  overview: (filter) => call("stock_overview", { filter }),
  transfer: (input) => call("transfer_stock", { input }),
  transfers: (limit) => call("list_transfers", { limit }),
};

export const lotsApi = {
  list: (productId, warehouseId = null, includeEmpty = false) =>
    call("list_lots", { productId, warehouseId, includeEmpty }),
  forSale: (productId) => call("list_sale_lots", { productId }),
  report: (search, includeEmpty) => call("lots_report", { search, includeEmpty }),
  setProduct: (productId, enabled) => call("set_product_lots", { productId, enabled }),
  create: (input) => call("create_lot", { input }),
  update: (id, brand, notes) => call("update_lot", { id, brand, notes }),
};

export const warehousesApi = {
  list: (includeInactive = false) => call("list_warehouses", { includeInactive }),
  create: (code, name, address, kind) => call("create_warehouse", { code, name, address, kind }),
  update: (id, code, name, address, kind) => call("update_warehouse", { id, code, name, address, kind }),
  setActive: (id, active) => call("set_warehouse_active", { id, active }),
  setSales: (id) => call("set_sales_warehouse", { id }),
};
export const customersApi = {
  list: (search, includeInactive) => call("list_customers", { search, includeInactive }),
  create: (input) => call("create_customer", { input }),
  update: (id, input) => call("update_customer", { id, input }),
  setActive: (id, active) => call("set_customer_active", { id, active }),
};

export const ratesApi = {
  overview: () => call("exchange_rates_overview"),
  set: (input, confirm) => call("set_exchange_rate", { input, confirm }),
};
export const salesApi = {
  quote: (currencyCode, items, chargeTax = true, priceListId = null) =>
    call("quote_sale", { currencyCode, items, chargeTax, priceListId }),
  issue: (input) => call("issue_sale", { input }),
  get: (id) => call("get_document", { id }),
  list: (search, limit) => call("list_documents", { search, limit }),
  void: (id, reason) => call("void_document", { id, reason }),
};
export const returnsApi = {
  candidates: (documentId) => call("return_candidates", { documentId }),
  quote: (documentId, lines, refundIgtf = true) =>
    call("quote_return", { documentId, lines, refundIgtf }),
  create: (input) => call("create_return", { input }),
  get: (id) => call("get_return", { id }),
};
export const receivablesApi = {
  creditInfo: (customerId) => call("ar_credit_info", { customerId }),
  summary: () => call("ar_summary"),
  customer: (customerId) => call("ar_customer", { customerId }),
  setCredit: (customerId, limitUsdMinor, creditDays) =>
    call("ar_set_credit", { customerId, limitUsdMinor, creditDays }),
  receive: (input) => call("ar_receive", { input }),
  receipt: (id) => call("ar_get_receipt", { id }),
  applyCredit: (customerId, documentId = null) => call("ar_apply_credit", { customerId, documentId }),
  voidReceipt: (id, reason) => call("ar_void_receipt", { id, reason }),
};
export const saleRetentionsApi = {
  docInfo: (documentId) => call("sret_doc_info", { documentId }),
  register: (input) => call("sret_register", { input }),
  void: (id, reason) => call("sret_void", { id, reason }),
  list: (filter) => call("sret_list", { filter }),
};
export const cashApi = {
  current: () => call("cash_current"),
  open: (openingVesMinor, openingUsdMinor) =>
    call("cash_open", { openingVesMinor, openingUsdMinor }),
  close: (countedVesMinor, countedUsdMinor, notes) =>
    call("cash_close", { countedVesMinor, countedUsdMinor, notes }),
  history: () => call("cash_history"),
};

export const reportsApi = {
  sales: (from, to) => call("sales_report", { from, to }),
  top: (from, to, limit) => call("top_products", { from, to, limit }),
  valuation: () => call("inventory_valuation"),
  exportCsv: (filename, content) => call("write_export", { filename, content }),
};
export const usersApi = {
  list: () => call("list_users"),
  create: (username, fullName, password, role) =>
    call("create_user", { username, fullName, password, role }),
  update: (id, fullName, role) => call("update_user", { id, fullName, role }),
  setActive: (id, active) => call("set_user_active", { id, active }),
  resetPassword: (id, newPassword) => call("reset_user_password", { id, newPassword }),
  unlock: (id) => call("unlock_user", { id }),
  changeOwnPassword: (currentPassword, newPassword) =>
    call("change_own_password", { currentPassword, newPassword }),
};

export const backupApi = {
  status: () => call("backup_status"),
  create: () => call("backup_create"),
  setExtraDir: (path) => call("backup_set_extra_dir", { path }),
  restore: (name, confirm) => call("backup_restore", { name, confirm }),
};
export const settingsApi = {
  get: () => call("get_settings"),
  save: (input) => call("save_settings", { input }),
  generateRecoveryCode: () => call("generate_recovery_code"),
};

export const auditApi = {
  list: (from, to, search, limit) => call("list_audit", { from, to, search, limit }),
};
export const suppliersApi = {
  list: (search, includeInactive) => call("list_suppliers", { search, includeInactive }),
  create: (input) => call("create_supplier", { input }),
  update: (id, input) => call("update_supplier", { id, input }),
  setActive: (id, active) => call("set_supplier_active", { id, active }),
};

export const purchasesApi = {
  quote: (input) => call("quote_purchase", { input }),
  create: (input) => call("create_purchase", { input }),
  list: (filter) => call("list_purchases", { filter }),
  get: (id) => call("get_purchase", { id }),
  void: (id, reason) => call("void_purchase", { id, reason }),
};

export const payablesApi = {
  summary: () => call("ap_summary"),
  supplier: (supplierId) => call("ap_supplier", { supplierId }),
  pay: (input) => call("ap_pay", { input }),
  voidPayment: (id, reason) => call("ap_void_payment", { id, reason }),
  payment: (id) => call("ap_get_payment", { id }),
};

export const expensesApi = {
  categories: (includeInactive = false) => call("list_expense_categories", { includeInactive }),
  saveCategory: (id, name) => call("save_expense_category", { id, name }),
  setCategoryActive: (id, active) => call("set_expense_category_active", { id, active }),
  create: (input) => call("create_expense", { input }),
  list: (filter) => call("list_expenses", { filter }),
  void: (id, reason) => call("void_expense", { id, reason }),
  createMovement: (input) => call("create_cash_movement", { input }),
  listMovements: (filter) => call("list_cash_movements", { filter }),
  voidMovement: (id, reason) => call("void_cash_movement", { id, reason }),
};

export const booksApi = {
  sales: (from, to) => call("sales_book", { filter: { from, to } }),
  purchases: (from, to) => call("purchases_book", { filter: { from, to } }),
};

export const profitApi = {
  report: (from, to) => call("profit_report", { filter: { from, to } }),
};

export const purchaseOrdersApi = {
  create: (input) => call("po_create", { input }),
  list: (status, search) => call("po_list", { status, search }),
  get: (id) => call("po_get", { id }),
  cancel: (id) => call("po_cancel", { id }),
  toPurchase: (id) => call("po_to_purchase", { id }),
  markReceived: (id, purchaseId) => call("po_mark_received", { id, purchaseId }),
};

export const pricingApi = {
  options: () => call("price_list_options"),
  lists: () => call("price_lists_admin"),
  saveList: (input) => call("save_price_list", { input }),
  items: (listId) => call("price_list_items", { listId }),
  setItem: (listId, productId, priceMinor, currencyCode) =>
    call("set_price_list_item", { listId, productId, priceMinor, currencyCode }),
  removeItem: (listId, productId) => call("remove_price_list_item", { listId, productId }),
  promos: () => call("promotions_list"),
  savePromo: (input) => call("save_promotion", { input }),
  setPromoActive: (id, active) => call("set_promotion_active", { id, active }),
};

export const quotesApi = {
  preview: (currencyCode, items, priceListId = null) =>
    call("quote_preview", { currencyCode, items, priceListId }),
  create: (input) => call("quote_create", { input }),
  list: (status, search) => call("quote_list", { status, search }),
  get: (id) => call("quote_get", { id }),
  cancel: (id) => call("quote_cancel", { id }),
  toCart: (id) => call("quote_to_cart", { id }),
  markConverted: (id, documentId) => call("quote_mark_converted", { id, documentId }),
  styleGet: () => call("quote_style_get"),
  styleSave: (input) => call("quote_style_save", { input }),
  saveFile: (filename, data) => call("save_quote_file", { filename, data }),
  context: () => call("quote_context"),
  issue: (input) => call("quote_issue", { input }),
  docsList: (search) => call("quote_docs_list", { search }),
  docGet: (id) => call("quote_doc_get", { id }),
};

export const importApi = {
  preview: (input) => call("import_products_preview", { input }),
  apply: (id, skipErrors) => call("import_apply", { id, skipErrors }),
  cancel: (id) => call("import_cancel", { id }),
  batches: () => call("import_list_batches"),
  batch: (id) => call("import_get_batch", { id }),
  template: () => call("import_template"),
  exportProducts: (includeInactive) => call("export_products", { includeInactive }),
  errorReport: (id) => call("import_error_report", { id }),
};

export const legacyApi = {
  preview: (input) => call("legacy_preview", { input }),
  apply: (input) => call("legacy_apply", { input }),
  history: () => call("legacy_history"),
};

export const dashboardApi = {
  summary: () => call("dashboard_summary"),
};

export const retentionsApi = {
  options: () => call("retention_options"),
  config: () => call("get_withholding_config"),
  saveConfig: (input) => call("save_withholding_config", { input }),
  saveConcept: (input) => call("save_islr_concept", { input }),
  setConceptActive: (id, active) => call("set_islr_concept_active", { id, active }),
  setSupplierIva: (id, ivaRetentionBp) => call("set_supplier_retention", { id, ivaRetentionBp }),
  list: (filter) => call("list_withholdings", { filter }),
  voucher: (id) => call("get_withholding_voucher", { id }),
};

export const keyApi = {
  status: () => call("key_status"),
  show: (password) => call("key_recovery_show", { password }),
  confirm: (password) => call("key_confirm_saved", { password }),
};

export const lanApi = {
  /** Modo red con el que arrancó el programa (no requiere sesión). */
  info: () => call("lan_info"),
  settings: () => call("lan_settings_get"),
  save: (mode, port, bind, https = true) => call("lan_settings_save", { mode, port, bind: bind ?? "", https }),
};
