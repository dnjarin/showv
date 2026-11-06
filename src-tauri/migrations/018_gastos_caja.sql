-- Gastos operativos y movimientos de caja (retiros, depósitos, ingresos de fondo)
CREATE TABLE expense_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO expense_categories (name) VALUES
  ('Servicios (luz, agua, internet)'), ('Alquiler'), ('Sueldos y comisiones'),
  ('Transporte y fletes'), ('Mantenimiento y reparaciones'), ('Papelería y útiles'),
  ('Impuestos y tasas'), ('Otros gastos');

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  category_id INTEGER NOT NULL REFERENCES expense_categories(id),
  description TEXT NOT NULL,
  expense_date TEXT NOT NULL,                 -- YYYY-MM-DD (hora local)
  method TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  exchange_rate_micro INTEGER,
  amount_usd_minor INTEGER NOT NULL,          -- equivalente en USD al registrar
  reference TEXT,
  user_id INTEGER REFERENCES users(id),
  cash_session_id INTEGER REFERENCES cash_sessions(id),   -- solo si salió de caja (efectivo)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT,
  void_reason TEXT,
  voided_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_expenses_date ON expenses(expense_date);
CREATE INDEX idx_expenses_category ON expenses(category_id);
CREATE INDEX idx_expenses_session ON expenses(cash_session_id);

CREATE TABLE cash_movements (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('entrada','salida')),
  concept TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  user_id INTEGER REFERENCES users(id),
  cash_session_id INTEGER NOT NULL REFERENCES cash_sessions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT,
  void_reason TEXT,
  voided_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_cash_mov_session ON cash_movements(cash_session_id);

CREATE TRIGGER trg_expenses_no_delete BEFORE DELETE ON expenses
BEGIN SELECT RAISE(ABORT, 'Los gastos no se eliminan; solo se anulan'); END;
CREATE TRIGGER trg_expenses_no_update BEFORE UPDATE ON expenses
WHEN OLD.voided_at IS NOT NULL
  OR NEW.number <> OLD.number OR NEW.category_id <> OLD.category_id
  OR NEW.description <> OLD.description OR NEW.expense_date <> OLD.expense_date
  OR NEW.method <> OLD.method OR NEW.currency_code <> OLD.currency_code
  OR NEW.amount_minor <> OLD.amount_minor OR NEW.amount_usd_minor <> OLD.amount_usd_minor
  OR NEW.cash_session_id IS NOT OLD.cash_session_id
BEGIN SELECT RAISE(ABORT, 'Los gastos no se modifican; solo pueden anularse'); END;

CREATE TRIGGER trg_cash_mov_no_delete BEFORE DELETE ON cash_movements
BEGIN SELECT RAISE(ABORT, 'Los movimientos de caja no se eliminan; solo se anulan'); END;
CREATE TRIGGER trg_cash_mov_no_update BEFORE UPDATE ON cash_movements
WHEN OLD.voided_at IS NOT NULL
  OR NEW.number <> OLD.number OR NEW.kind <> OLD.kind OR NEW.concept <> OLD.concept
  OR NEW.currency_code <> OLD.currency_code OR NEW.amount_minor <> OLD.amount_minor
  OR NEW.cash_session_id <> OLD.cash_session_id
BEGIN SELECT RAISE(ABORT, 'Los movimientos no se modifican; solo pueden anularse'); END;

INSERT OR IGNORE INTO document_series (doc_type, series, is_fiscal) VALUES
  ('GASTO', 'G', 0), ('MOVCAJA', 'M', 0);
