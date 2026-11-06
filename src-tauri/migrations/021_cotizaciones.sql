CREATE TABLE quotes (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER REFERENCES customers(id),
  customer_name TEXT NOT NULL DEFAULT '',
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  usd_rate_micro INTEGER,
  valid_until TEXT NOT NULL,
  notes TEXT,
  discount_minor INTEGER NOT NULL DEFAULT 0,
  subtotal_minor INTEGER NOT NULL,
  exempt_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL,
  total_ves_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','converted','cancelled')),
  document_id INTEGER REFERENCES documents(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);

CREATE TABLE quote_items (
  id INTEGER PRIMARY KEY,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  sku TEXT NOT NULL,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price_minor INTEGER NOT NULL,
  discount_bp INTEGER NOT NULL DEFAULT 0,
  discount_minor INTEGER NOT NULL DEFAULT 0,
  tax_code TEXT NOT NULL,
  tax_rate_bp INTEGER NOT NULL,
  base_minor INTEGER NOT NULL,
  tax_minor INTEGER NOT NULL,
  line_total_minor INTEGER NOT NULL
);

CREATE INDEX idx_quotes_status ON quotes(status, id);
CREATE INDEX idx_quote_items_quote ON quote_items(quote_id);
