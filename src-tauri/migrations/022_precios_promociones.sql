-- Listas de precios: ajuste porcentual sobre el precio base + precios específicos por producto.
CREATE TABLE price_lists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  adjust_bp INTEGER NOT NULL DEFAULT 0 CHECK (adjust_bp BETWEEN -9000 AND 10000),
  cashier_can_use INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE price_list_items (
  price_list_id INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  PRIMARY KEY (price_list_id, product_id)
);

-- Promociones: descuento automático por fechas (a un producto, a una categoría o a todo).
CREATE TABLE promotions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('all','category','product')),
  product_id INTEGER REFERENCES products(id),
  category_id INTEGER REFERENCES categories(id),
  percent_bp INTEGER NOT NULL CHECK (percent_bp BETWEEN 1 AND 9000),
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_promotions_active ON promotions(active, starts_on, ends_on);

ALTER TABLE quotes ADD COLUMN price_list_id INTEGER REFERENCES price_lists(id);
