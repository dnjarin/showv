-- Módulo: anulación de recibos, saldo a favor (anticipos) y estado de cuenta
ALTER TABLE ar_receipts ADD COLUMN voided_at TEXT;
ALTER TABLE ar_receipts ADD COLUMN void_reason TEXT;
ALTER TABLE ar_receipts ADD COLUMN voided_by INTEGER REFERENCES users(id);

-- Un recibo solo puede anularse (una vez); sus datos no cambian.
DROP TRIGGER trg_receipts_no_update;
CREATE TRIGGER trg_receipts_no_update BEFORE UPDATE ON ar_receipts
WHEN OLD.voided_at IS NOT NULL
  OR NEW.number <> OLD.number OR NEW.customer_id <> OLD.customer_id
  OR NEW.method <> OLD.method OR NEW.currency_code <> OLD.currency_code
  OR NEW.amount_minor <> OLD.amount_minor OR NEW.created_at <> OLD.created_at
  OR NEW.cash_session_id IS NOT OLD.cash_session_id
BEGIN SELECT RAISE(ABORT, 'Los recibos no se modifican; solo pueden anularse'); END;

-- Libro del saldo a favor de cada cliente (positivo = a favor, negativo = usado).
CREATE TABLE ar_credit_entries (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
  kind TEXT NOT NULL CHECK (kind IN ('anticipo','aplicacion','reverso')),
  receipt_id INTEGER REFERENCES ar_receipts(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_credit_customer ON ar_credit_entries(customer_id, currency_code);
CREATE INDEX idx_credit_receipt ON ar_credit_entries(receipt_id);

CREATE TRIGGER trg_credit_no_update BEFORE UPDATE ON ar_credit_entries
BEGIN SELECT RAISE(ABORT, 'El libro de saldo a favor no se modifica'); END;
CREATE TRIGGER trg_credit_no_delete BEFORE DELETE ON ar_credit_entries
BEGIN SELECT RAISE(ABORT, 'El libro de saldo a favor no se elimina'); END;