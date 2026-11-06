-- Costo de cada línea vendida al momento de la venta (base del cálculo de utilidad).
-- Tabla aparte: las líneas de los documentos emitidos son inmutables.
CREATE TABLE item_costs (
  item_id INTEGER PRIMARY KEY REFERENCES document_items(id),
  unit_cost_minor INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
  cost_currency TEXT NOT NULL REFERENCES currencies(code),
  estimated INTEGER NOT NULL DEFAULT 0     -- 1 = ventas anteriores a este módulo (costo actual del producto)
);

-- Ventas anteriores: se estima con el costo actual del producto.
INSERT INTO item_costs (item_id, unit_cost_minor, cost_currency, estimated)
SELECT di.id, p.cost_minor, p.price_currency, 1
FROM document_items di
JOIN documents d ON d.id = di.document_id
JOIN products p ON p.id = di.product_id
WHERE d.doc_type = 'COMPROBANTE';

CREATE TRIGGER trg_item_costs_no_update BEFORE UPDATE ON item_costs
BEGIN SELECT RAISE(ABORT, 'El costo de una venta registrada no se modifica'); END;
CREATE TRIGGER trg_item_costs_no_delete BEFORE DELETE ON item_costs
BEGIN SELECT RAISE(ABORT, 'El costo de una venta registrada no se elimina'); END;
