-- Módulo: ventas a crédito y cuentas por cobrar
ALTER TABLE customers ADD COLUMN credit_limit_usd_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN credit_days INTEGER NOT NULL DEFAULT 15;

ALTER TABLE documents ADD COLUMN credit_sale INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN due_date TEXT;
ALTER TABLE documents ADD COLUMN paid_initial_minor INTEGER NOT NULL DEFAULT 0;
-- En devoluciones: parte de la nota de crédito que se descontó del saldo pendiente.
ALTER TABLE documents ADD COLUMN balance_applied_minor INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_documents_credit ON documents(customer_id) WHERE credit_sale = 1;

-- Recibos de abono
CREATE TABLE ar_receipts (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  method TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  exchange_rate_micro INTEGER NOT NULL,
  reference TEXT,
  notes TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  cash_session_id INTEGER REFERENCES cash_sessions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A qué ventas se aplicó cada abono (en la moneda de la venta).
CREATE TABLE ar_allocations (
  id INTEGER PRIMARY KEY,
  receipt_id INTEGER NOT NULL REFERENCES ar_receipts(id),
  document_id INTEGER NOT NULL REFERENCES documents(id),
  applied_doc_minor INTEGER NOT NULL CHECK (applied_doc_minor > 0)
);
CREATE INDEX idx_alloc_doc ON ar_allocations(document_id);
CREATE INDEX idx_alloc_receipt ON ar_allocations(receipt_id);
CREATE INDEX idx_receipts_customer ON ar_receipts(customer_id);

CREATE TRIGGER trg_receipts_no_update BEFORE UPDATE ON ar_receipts
BEGIN SELECT RAISE(ABORT, 'Los recibos no se modifican'); END;
CREATE TRIGGER trg_receipts_no_delete BEFORE DELETE ON ar_receipts
BEGIN SELECT RAISE(ABORT, 'Los recibos no se eliminan'); END;
CREATE TRIGGER trg_alloc_no_update BEFORE UPDATE ON ar_allocations
BEGIN SELECT RAISE(ABORT, 'Las aplicaciones de abono no se modifican'); END;
CREATE TRIGGER trg_alloc_no_delete BEFORE DELETE ON ar_allocations
BEGIN SELECT RAISE(ABORT, 'Las aplicaciones de abono no se eliminan'); END;

INSERT OR IGNORE INTO document_series (doc_type, series, is_fiscal, next_number)
VALUES ('RECIBO', 'R', 0, 1);