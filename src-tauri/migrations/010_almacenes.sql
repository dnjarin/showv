CREATE TABLE warehouses (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  address TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  is_sales INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Solo un almacén puede ser el de ventas.
CREATE UNIQUE INDEX ux_warehouse_sales ON warehouses(is_sales) WHERE is_sales = 1;

INSERT INTO warehouses (code, name, is_sales) VALUES ('PRINC', 'Principal', 1);

CREATE TABLE stock_transfers (
  id INTEGER PRIMARY KEY,
  from_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  to_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (from_warehouse_id <> to_warehouse_id)
);

ALTER TABLE stock_movements ADD COLUMN warehouse_id INTEGER REFERENCES warehouses(id);
ALTER TABLE stock_movements ADD COLUMN transfer_id INTEGER REFERENCES stock_transfers(id);

-- Todo el stock existente pasa al almacén «Principal».
UPDATE stock_movements
   SET warehouse_id = (SELECT id FROM warehouses WHERE is_sales = 1)
 WHERE warehouse_id IS NULL;

-- Desde ahora, ningún movimiento puede quedar sin almacén.
CREATE TRIGGER trg_movement_needs_warehouse
BEFORE INSERT ON stock_movements
WHEN NEW.warehouse_id IS NULL
BEGIN SELECT RAISE(ABORT, 'Todo movimiento de inventario requiere un almacén'); END;

CREATE INDEX idx_movements_wh_product ON stock_movements(warehouse_id, product_id);
CREATE INDEX idx_movements_created ON stock_movements(created_at);