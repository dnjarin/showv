-- ========== CONFIGURACIÓN FISCAL / MONEDAS ==========
CREATE TABLE company (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rif TEXT NOT NULL,
  legal_name TEXT NOT NULL,
  trade_name TEXT,
  fiscal_address TEXT NOT NULL,
  phone TEXT,
  email TEXT
);

CREATE TABLE currencies (
  code TEXT PRIMARY KEY,                -- VES, USD
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  decimals INTEGER NOT NULL DEFAULT 2,
  is_base INTEGER NOT NULL DEFAULT 0    -- VES = 1
);

CREATE TABLE exchange_rates (
  id INTEGER PRIMARY KEY,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  rate_micro INTEGER NOT NULL,          -- Bs por 1 unidad × 1.000.000
  rate_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'BCV',   -- BCV, manual
  created_by INTEGER REFERENCES users(id),
  UNIQUE (currency_code, rate_date)
);

CREATE TABLE tax_rates (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,            -- GENERAL, REDUCIDA, ADICIONAL, EXENTO
  name TEXT NOT NULL,
  rate_bp INTEGER NOT NULL,             -- 1600 = 16%
  active INTEGER NOT NULL DEFAULT 1
);

-- ========== CATÁLOGOS ==========
CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT UNIQUE,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  tax_rate_id INTEGER NOT NULL REFERENCES tax_rates(id),
  cost_minor INTEGER NOT NULL DEFAULT 0,
  price_minor INTEGER NOT NULL,
  price_currency TEXT NOT NULL REFERENCES currencies(code),
  track_stock INTEGER NOT NULL DEFAULT 1,
  min_stock INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  id_type TEXT NOT NULL CHECK (id_type IN ('V','E','J','G','P','C')),
  id_number TEXT NOT NULL,              -- cédula o RIF
  name TEXT NOT NULL,
  fiscal_address TEXT,
  phone TEXT,
  email TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (id_type, id_number)
);

CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,            -- + entrada, - salida
  reason TEXT NOT NULL,                 -- compra, venta, ajuste, anulacion
  document_id INTEGER REFERENCES documents(id),
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ========== DOCUMENTOS (interno y fiscal en la misma estructura) ==========
CREATE TABLE document_series (
  id INTEGER PRIMARY KEY,
  doc_type TEXT NOT NULL,               -- COMPROBANTE, FACTURA, NOTA_CREDITO, NOTA_DEBITO, GUIA
  series TEXT NOT NULL DEFAULT 'A',
  is_fiscal INTEGER NOT NULL DEFAULT 0,
  next_number INTEGER NOT NULL DEFAULT 1,
  UNIQUE (doc_type, series)
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  doc_type TEXT NOT NULL,
  series TEXT NOT NULL,
  number INTEGER NOT NULL,              -- consecutivo
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('draft','issued','voided')),

  -- Estado fiscal (todo "NONE" mientras sea comprobante interno)
  fiscal_status TEXT NOT NULL DEFAULT 'NONE'
    CHECK (fiscal_status IN ('NONE','PENDING','ISSUED','REJECTED')),
  control_number TEXT,                  -- asignado por imprenta digital / máquina fiscal
  fiscal_provider TEXT,                 -- nombre de la imprenta o serial de la máquina
  fiscal_issued_at TEXT,

  -- Documento que se corrige (notas de crédito/débito)
  related_document_id INTEGER REFERENCES documents(id),

  -- Snapshot del emisor
  issuer_rif TEXT NOT NULL,
  issuer_name TEXT NOT NULL,
  issuer_address TEXT NOT NULL,

  -- Snapshot del receptor
  customer_id INTEGER REFERENCES customers(id),
  customer_id_type TEXT,
  customer_id_number TEXT,
  customer_name TEXT,
  customer_address TEXT,

  -- Moneda y totales
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  exchange_rate_micro INTEGER NOT NULL, -- tasa BCV usada (VES = 1.000.000)
  subtotal_minor INTEGER NOT NULL,
  exempt_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor INTEGER NOT NULL,
  igtf_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL,
  total_ves_minor INTEGER NOT NULL,     -- equivalente en bolívares

  cashier_id INTEGER NOT NULL REFERENCES users(id),
  notes TEXT,
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT,
  void_reason TEXT,

  UNIQUE (doc_type, series, number)
);

CREATE TABLE document_items (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL,            -- snapshot del nombre
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_minor INTEGER NOT NULL,
  discount_minor INTEGER NOT NULL DEFAULT 0,
  tax_code TEXT NOT NULL,               -- snapshot
  tax_rate_bp INTEGER NOT NULL,         -- snapshot de la alícuota
  tax_minor INTEGER NOT NULL,
  line_total_minor INTEGER NOT NULL
);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  method TEXT NOT NULL,                 -- efectivo, punto, pago_movil, transferencia, zelle
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  amount_minor INTEGER NOT NULL,        -- en la moneda del pago
  exchange_rate_micro INTEGER NOT NULL,
  igtf_applies INTEGER NOT NULL DEFAULT 0,
  igtf_minor INTEGER NOT NULL DEFAULT 0,
  reference TEXT
);

-- Cola de envío fiscal: permite emitir en modo interno y fiscalizar después,
-- o reintentar si falla la conexión con la imprenta digital.
CREATE TABLE fiscal_outbox (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  payload TEXT,                         -- JSON enviado al proveedor
  response TEXT,                        -- JSON recibido
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);

-- ========== INMUTABILIDAD ==========
CREATE TRIGGER trg_documents_no_delete
BEFORE DELETE ON documents
BEGIN SELECT RAISE(ABORT, 'Los documentos no se pueden eliminar'); END;

CREATE TRIGGER trg_documents_locked
BEFORE UPDATE ON documents
WHEN OLD.status IN ('issued','voided') AND (
     NEW.number <> OLD.number OR NEW.series <> OLD.series
  OR NEW.total_minor <> OLD.total_minor OR NEW.subtotal_minor <> OLD.subtotal_minor
  OR NEW.tax_minor <> OLD.tax_minor OR NEW.customer_name IS NOT OLD.customer_name
  OR NEW.customer_id_number IS NOT OLD.customer_id_number)
BEGIN SELECT RAISE(ABORT, 'Documento emitido: solo se corrige con nota de crédito/débito'); END;

CREATE TRIGGER trg_items_locked_upd
BEFORE UPDATE ON document_items
WHEN (SELECT status FROM documents WHERE id = OLD.document_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'Documento emitido: líneas bloqueadas'); END;

CREATE TRIGGER trg_items_locked_del
BEFORE DELETE ON document_items
WHEN (SELECT status FROM documents WHERE id = OLD.document_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'Documento emitido: líneas bloqueadas'); END;

-- ========== DATOS SEMILLA ==========
INSERT INTO currencies (code, name, symbol, decimals, is_base) VALUES
  ('VES','Bolívar','Bs.',2,1), ('USD','Dólar estadounidense','$',2,0);

INSERT INTO tax_rates (code, name, rate_bp) VALUES
  ('GENERAL','IVA general',1600), ('REDUCIDA','IVA reducida',800),
  ('ADICIONAL','IVA adicional (lujo)',1500), ('EXENTO','Exento',0);
-- Verifica las alícuotas vigentes antes de producción.

INSERT INTO document_series (doc_type, series, is_fiscal) VALUES
  ('COMPROBANTE','A',0), ('FACTURA','A',1),
  ('NOTA_CREDITO','A',1), ('NOTA_DEBITO','A',1);