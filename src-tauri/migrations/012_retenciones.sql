-- Proveedores: porcentaje de retención de IVA propio (NULL = el predeterminado)
ALTER TABLE suppliers ADD COLUMN iva_retention_bp INTEGER;

-- Compras: impuestos de la factura del proveedor
ALTER TABLE purchases ADD COLUMN invoice_control TEXT;
ALTER TABLE purchases ADD COLUMN iva_rate_bp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN exempt_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN iva_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN invoice_total_minor INTEGER;   -- NULL en compras anteriores
ALTER TABLE purchases ADD COLUMN net_payable_minor INTEGER;
ALTER TABLE purchases ADD COLUMN ret_skip_reason TEXT;

-- Catálogo de conceptos de ISLR (editable; los de fábrica nacen DESACTIVADOS)
CREATE TABLE islr_concepts (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  rate_pnr_bp INTEGER,                      -- persona natural residente
  rate_pjd_bp INTEGER,                      -- persona jurídica domiciliada
  base_pct_bp INTEGER NOT NULL DEFAULT 10000,
  min_base_ut_milli INTEGER NOT NULL DEFAULT 0,   -- mínimo en milésimas de UT
  sustraendo_pnr INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO islr_concepts (code, name, rate_pnr_bp, rate_pjd_bp, sustraendo_pnr, active) VALUES
  ('HONORARIOS', 'Honorarios profesionales', 300, 500, 1, 0),
  ('COMISIONES', 'Comisiones mercantiles',   300, 500, 1, 0),
  ('INTERESES',  'Intereses',                300, 500, 1, 0);

-- Retenciones practicadas (una fila por comprobante)
CREATE TABLE withholdings (
  id INTEGER PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  kind TEXT NOT NULL CHECK (kind IN ('IVA','ISLR')),
  voucher_number TEXT NOT NULL UNIQUE,
  period TEXT NOT NULL,                     -- 'YYYY-MM' en hora local
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  concept_id INTEGER REFERENCES islr_concepts(id),
  concept_name TEXT,
  base_ves_minor INTEGER NOT NULL,          -- IVA: base imponible · ISLR: monto sujeto
  tax_ves_minor INTEGER NOT NULL DEFAULT 0, -- IVA: impuesto de la factura
  rate_bp INTEGER NOT NULL,                 -- IVA: % retenido · ISLR: tarifa
  sustraendo_ves_minor INTEGER NOT NULL DEFAULT 0,
  prior_base_ves_minor INTEGER NOT NULL DEFAULT 0,
  prior_ret_ves_minor INTEGER NOT NULL DEFAULT 0,
  amount_ves_minor INTEGER NOT NULL CHECK (amount_ves_minor > 0),
  amount_minor INTEGER NOT NULL,            -- en la moneda de la compra
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT
);
CREATE INDEX idx_wh_period ON withholdings(period, kind);
CREATE INDEX idx_wh_supplier ON withholdings(supplier_id, concept_id, period);
CREATE INDEX idx_wh_purchase ON withholdings(purchase_id);

CREATE TRIGGER trg_withholdings_no_delete BEFORE DELETE ON withholdings
BEGIN SELECT RAISE(ABORT, 'Los comprobantes de retención no se pueden eliminar'); END;

CREATE TRIGGER trg_withholdings_locked BEFORE UPDATE ON withholdings
WHEN NEW.amount_ves_minor <> OLD.amount_ves_minor OR NEW.voucher_number <> OLD.voucher_number
  OR NEW.purchase_id <> OLD.purchase_id OR NEW.kind <> OLD.kind
  OR (OLD.status = 'voided' AND NEW.status <> 'voided')
BEGIN SELECT RAISE(ABORT, 'Comprobante emitido: solo se puede anular'); END;

INSERT OR IGNORE INTO document_series (doc_type, series, is_fiscal) VALUES
  ('RET_IVA', 'A', 0), ('RET_ISLR', 'A', 0);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('wh_agent_iva', '0'), ('wh_agent_islr', '0'), ('wh_iva_default_bp', '7500');
