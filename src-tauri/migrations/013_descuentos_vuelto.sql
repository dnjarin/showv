-- Módulo: descuentos por línea y vuelto
ALTER TABLE document_items ADD COLUMN discount_bp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN tendered_minor INTEGER;
ALTER TABLE documents ADD COLUMN change_currency TEXT;
ALTER TABLE documents ADD COLUMN change_minor INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO settings (key, value) VALUES ('cashier_max_discount_bp', '1000');