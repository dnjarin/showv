ALTER TABLE stock_movements ADD COLUMN note TEXT;

CREATE INDEX idx_stock_movements_product ON stock_movements(product_id);
CREATE INDEX idx_products_name ON products(name);
CREATE INDEX idx_documents_issued_at ON documents(issued_at);
CREATE INDEX idx_document_items_doc ON document_items(document_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);