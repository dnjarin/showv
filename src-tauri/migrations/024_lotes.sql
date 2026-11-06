-- Control de lotes OPCIONAL por producto.
-- Un producto con uses_lots = 1 maneja sus existencias por lote (fecha de llegada, marca y costo propios).
-- Los productos sin lotes funcionan exactamente como antes.
ALTER TABLE products ADD COLUMN uses_lots INTEGER NOT NULL DEFAULT 0;

CREATE TABLE lots (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  code TEXT NOT NULL,                              -- identificador visible del lote
  brand TEXT,
  received_date TEXT NOT NULL DEFAULT (date('now', 'localtime')),
  unit_cost_minor INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
  cost_currency TEXT NOT NULL REFERENCES currencies(code),
  notes TEXT,
  purchase_id INTEGER REFERENCES purchases(id),    -- compra que originó el lote, si la hay
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_lots_product_code ON lots(product_id, code COLLATE NOCASE);
CREATE INDEX idx_lots_product ON lots(product_id);

-- Cada movimiento de un producto con lotes indica de qué lote entra o sale.
ALTER TABLE stock_movements ADD COLUMN lot_id INTEGER REFERENCES lots(id);
CREATE INDEX idx_movements_lot ON stock_movements(lot_id);

-- Lote del que salió cada línea vendida (permite devolver al mismo lote y calcular la utilidad real).
ALTER TABLE item_costs ADD COLUMN lot_id INTEGER REFERENCES lots(id);

-- Red de seguridad: ningún camino del sistema puede dejar un movimiento sin lote en un producto con lotes,
-- ni asignarle el lote de otro producto.
CREATE TRIGGER trg_movement_needs_lot
BEFORE INSERT ON stock_movements
WHEN NEW.lot_id IS NULL AND (SELECT uses_lots FROM products WHERE id = NEW.product_id) = 1
BEGIN SELECT RAISE(ABORT, 'Este producto controla lotes: el movimiento debe indicar el lote'); END;

CREATE TRIGGER trg_movement_lot_matches
BEFORE INSERT ON stock_movements
WHEN NEW.lot_id IS NOT NULL
 AND (SELECT product_id FROM lots WHERE id = NEW.lot_id) IS NOT NEW.product_id
BEGIN SELECT RAISE(ABORT, 'El lote no pertenece a ese producto'); END;
