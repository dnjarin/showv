-- Migración desde el sistema anterior (QSL Sistemas): saldos iniciales y bitácora.

-- Una compra "de saldo inicial" es una deuda con un proveedor que viene del sistema
-- anterior: no mueve inventario ni entra a los libros de compras.
ALTER TABLE purchases ADD COLUMN opening INTEGER NOT NULL DEFAULT 0;

-- Los saldos por cobrar iniciales son documentos SALDO_INICIAL (a crédito, sin líneas).
-- No cuentan como ventas: los reportes, la caja y los libros solo leen COMPROBANTE y DEVOLUCION.
INSERT OR IGNORE INTO document_series (doc_type, series, is_fiscal, next_number)
VALUES ('SALDO_INICIAL', 'S', 0, 1);

-- Historial de cada migración aplicada (quién, cuándo, cuántas filas).
CREATE TABLE legacy_imports (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL CHECK (entity IN ('customers','suppliers','ar_balances','ap_balances')),
  filename TEXT NOT NULL,
  created_rows INTEGER NOT NULL DEFAULT 0,
  updated_rows INTEGER NOT NULL DEFAULT 0,
  skipped_rows INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER trg_legacy_imports_no_update BEFORE UPDATE ON legacy_imports
BEGIN SELECT RAISE(ABORT, 'El historial de migraciones no se modifica'); END;
CREATE TRIGGER trg_legacy_imports_no_delete BEFORE DELETE ON legacy_imports
BEGIN SELECT RAISE(ABORT, 'El historial de migraciones no se elimina'); END;
