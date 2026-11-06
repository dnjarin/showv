-- Cuentas por pagar: compras a crédito y pagos a proveedores
ALTER TABLE purchases ADD COLUMN on_credit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN due_date TEXT;

CREATE TABLE ap_payments (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  method TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  exchange_rate_micro INTEGER,
  reference TEXT,
  notes TEXT,
  user_id INTEGER REFERENCES users(id),
  cash_session_id INTEGER REFERENCES cash_sessions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT,
  void_reason TEXT,
  voided_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_ap_payments_supplier ON ap_payments(supplier_id);
CREATE INDEX idx_ap_payments_session ON ap_payments(cash_session_id);

CREATE TABLE ap_allocations (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES ap_payments(id),
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  applied_doc_minor INTEGER NOT NULL CHECK (applied_doc_minor > 0)
);
CREATE INDEX idx_ap_alloc_purchase ON ap_allocations(purchase_id);
CREATE INDEX idx_ap_alloc_payment ON ap_allocations(payment_id);

CREATE TRIGGER trg_ap_payments_no_delete BEFORE DELETE ON ap_payments
BEGIN SELECT RAISE(ABORT, 'Los pagos no se eliminan; solo se anulan'); END;

CREATE TRIGGER trg_ap_payments_no_update BEFORE UPDATE ON ap_payments
WHEN OLD.voided_at IS NOT NULL
  OR NEW.number <> OLD.number OR NEW.supplier_id <> OLD.supplier_id
  OR NEW.method <> OLD.method OR NEW.currency_code <> OLD.currency_code
  OR NEW.amount_minor <> OLD.amount_minor OR NEW.created_at <> OLD.created_at
  OR NEW.cash_session_id IS NOT OLD.cash_session_id
BEGIN SELECT RAISE(ABORT, 'Los pagos no se modifican; solo pueden anularse'); END;

CREATE TRIGGER trg_ap_alloc_no_update BEFORE UPDATE ON ap_allocations
BEGIN SELECT RAISE(ABORT, 'Las aplicaciones de pago no se modifican'); END;
CREATE TRIGGER trg_ap_alloc_no_delete BEFORE DELETE ON ap_allocations
BEGIN SELECT RAISE(ABORT, 'Las aplicaciones de pago no se eliminan'); END;

INSERT OR IGNORE INTO document_series (doc_type, series, is_fiscal) VALUES ('PAGO', 'P', 0);
