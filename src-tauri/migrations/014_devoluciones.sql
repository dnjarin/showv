-- Módulo: notas de crédito internas (devoluciones)
INSERT OR IGNORE INTO document_series (doc_type, series, is_fiscal, next_number)
VALUES ('DEVOLUCION', 'D', 0, 1);

-- Línea de la venta original que se devuelve, y si el producto volvió al inventario.
ALTER TABLE document_items ADD COLUMN source_item_id INTEGER REFERENCES document_items(id);
ALTER TABLE document_items ADD COLUMN restocked INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_items_source ON document_items(source_item_id);
CREATE INDEX idx_documents_related ON documents(related_document_id);

-- Dinero entregado al cliente en una devolución.
CREATE TABLE refunds (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  method TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  exchange_rate_micro INTEGER NOT NULL,
  reference TEXT
);
CREATE INDEX idx_refunds_doc ON refunds(document_id);

CREATE TRIGGER trg_refunds_no_update BEFORE UPDATE ON refunds
BEGIN SELECT RAISE(ABORT, 'Los reintegros no se modifican'); END;
CREATE TRIGGER trg_refunds_no_delete BEFORE DELETE ON refunds
BEGIN SELECT RAISE(ABORT, 'Los reintegros no se eliminan'); END;