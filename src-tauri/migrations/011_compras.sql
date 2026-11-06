CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY,
  id_type TEXT NOT NULL CHECK (id_type IN ('V','E','J','G','P','C')),
  id_number TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (id_type, id_number)
);
CREATE INDEX idx_suppliers_name ON suppliers(name);

CREATE TABLE purchases (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  supplier_name TEXT NOT NULL,             -- copia al momento de la compra
  supplier_doc TEXT NOT NULL,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','voided')),
  invoice_number TEXT,
  invoice_date TEXT,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  exchange_rate_micro INTEGER,             -- tasa USD vigente al registrar (si existía)
  total_minor INTEGER NOT NULL,
  total_ves_minor INTEGER,
  costs_updated INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT,
  void_reason TEXT
);
CREATE INDEX idx_purchases_created ON purchases(created_at);
CREATE INDEX idx_purchases_supplier ON purchases(supplier_id);

CREATE TABLE purchase_items (
  id INTEGER PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  sku TEXT NOT NULL,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost_minor INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
  line_total_minor INTEGER NOT NULL
);
CREATE INDEX idx_purchase_items_purchase ON purchase_items(purchase_id);

ALTER TABLE stock_movements ADD COLUMN purchase_id INTEGER REFERENCES purchases(id);
CREATE INDEX idx_movements_purchase ON stock_movements(purchase_id);

INSERT OR IGNORE INTO document_series (doc_type, series, is_fiscal) VALUES ('COMPRA', 'A', 0);

-- Las compras no se borran; solo se anulan.
CREATE TRIGGER trg_purchases_no_delete BEFORE DELETE ON purchases
BEGIN SELECT RAISE(ABORT, 'Las compras no se pueden eliminar'); END;

CREATE TRIGGER trg_purchases_locked BEFORE UPDATE ON purchases
WHEN NEW.number <> OLD.number OR NEW.total_minor <> OLD.total_minor
  OR NEW.supplier_id <> OLD.supplier_id OR NEW.warehouse_id <> OLD.warehouse_id
  OR NEW.currency_code <> OLD.currency_code
  OR (OLD.status = 'voided' AND NEW.status <> 'voided')
BEGIN SELECT RAISE(ABORT, 'Compra registrada: solo se puede anular'); END;

CREATE TRIGGER trg_purchase_items_no_update BEFORE UPDATE ON purchase_items
BEGIN SELECT RAISE(ABORT, 'Las líneas de una compra no se pueden modificar'); END;

CREATE TRIGGER trg_purchase_items_no_delete BEFORE DELETE ON purchase_items
BEGIN SELECT RAISE(ABORT, 'Las líneas de una compra no se pueden eliminar'); END;