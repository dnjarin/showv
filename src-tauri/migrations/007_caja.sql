CREATE TABLE cash_sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  opening_ves_minor INTEGER NOT NULL DEFAULT 0,
  opening_usd_minor INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT,
  counted_ves_minor INTEGER,
  counted_usd_minor INTEGER,
  expected_ves_minor INTEGER,
  expected_usd_minor INTEGER,
  notes TEXT
);

-- Un cajero solo puede tener UNA caja abierta a la vez.
CREATE UNIQUE INDEX ux_cash_open_user ON cash_sessions(user_id) WHERE closed_at IS NULL;

ALTER TABLE documents ADD COLUMN cash_session_id INTEGER REFERENCES cash_sessions(id);
CREATE INDEX idx_documents_session ON documents(cash_session_id);