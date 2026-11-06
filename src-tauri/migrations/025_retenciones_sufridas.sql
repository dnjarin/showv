-- Retenciones sufridas: las que un cliente agente de retención nos aplica al pagar una venta a crédito.
-- Cada comprobante reduce el saldo pendiente de la venta y queda registrado por período.
CREATE TABLE ar_withholdings (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  kind TEXT NOT NULL CHECK (kind IN ('IVA','ISLR')),
  voucher_number TEXT NOT NULL,              -- número del comprobante que entrega el cliente
  voucher_date TEXT NOT NULL,                -- fecha del comprobante (YYYY-MM-DD)
  period TEXT NOT NULL,                      -- 'YYYY-MM' de la fecha del comprobante
  amount_ves_minor INTEGER NOT NULL CHECK (amount_ves_minor > 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),  -- en la moneda de la venta
  exchange_rate_micro INTEGER NOT NULL,      -- tasa de la venta usada para convertir
  notes TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT,
  void_reason TEXT,
  voided_by INTEGER REFERENCES users(id)
);
-- El mismo comprobante de un cliente no se registra dos veces (los anulados no cuentan).
CREATE UNIQUE INDEX ux_ar_wh_voucher ON ar_withholdings(customer_id, kind, voucher_number COLLATE NOCASE)
  WHERE voided_at IS NULL;
CREATE INDEX idx_ar_wh_doc ON ar_withholdings(document_id);
CREATE INDEX idx_ar_wh_period ON ar_withholdings(period, kind);

CREATE TRIGGER trg_ar_wh_no_delete BEFORE DELETE ON ar_withholdings
BEGIN SELECT RAISE(ABORT, 'Las retenciones sufridas no se eliminan; solo se anulan'); END;

CREATE TRIGGER trg_ar_wh_locked BEFORE UPDATE ON ar_withholdings
WHEN OLD.voided_at IS NOT NULL
  OR NEW.document_id <> OLD.document_id OR NEW.customer_id <> OLD.customer_id
  OR NEW.kind <> OLD.kind OR NEW.voucher_number <> OLD.voucher_number
  OR NEW.voucher_date <> OLD.voucher_date OR NEW.period <> OLD.period
  OR NEW.amount_ves_minor <> OLD.amount_ves_minor OR NEW.amount_minor <> OLD.amount_minor
BEGIN SELECT RAISE(ABORT, 'Retención registrada: solo se puede anular'); END;
