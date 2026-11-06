-- Registro liviano de cotizaciones emitidas (solo auditoría): una fila por documento,
-- sin líneas, sin stock y sin relaciones. El detalle completo va en `payload` (JSON).
-- El número visible es COT-<id con 6 dígitos>.
CREATE TABLE IF NOT EXISTS quote_docs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    INTEGER,
  customer_name TEXT NOT NULL DEFAULT '',
  currency_code TEXT NOT NULL CHECK (currency_code IN ('USD','VES')),
  rate_micro    INTEGER,
  total_minor   INTEGER NOT NULL,
  payload       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quote_docs_created ON quote_docs(created_at);
