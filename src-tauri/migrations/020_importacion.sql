-- Importación masiva: cada archivo es un "lote" con su vista previa guardada.
CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL DEFAULT 'products',
  filename TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('both','create','update')),
  warehouse_id INTEGER REFERENCES warehouses(id),
  status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','applied','cancelled')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  new_rows INTEGER NOT NULL DEFAULT 0,
  update_rows INTEGER NOT NULL DEFAULT 0,
  unchanged_rows INTEGER NOT NULL DEFAULT 0,
  skipped_rows INTEGER NOT NULL DEFAULT 0,
  error_rows INTEGER NOT NULL DEFAULT 0,
  applied_rows INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_by INTEGER REFERENCES users(id),
  applied_at TEXT
);

CREATE TABLE import_rows (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('new','update','unchanged','skipped','error')),
  sku TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_import_rows_batch ON import_rows(batch_id, line_no);
