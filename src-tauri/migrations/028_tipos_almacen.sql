-- Tipo de almacén: general (mercancía de venta), garantía (equipos en garantía),
-- dañado (merma / equipos dañados) y exhibición. Los existentes quedan como «general».
ALTER TABLE warehouses ADD COLUMN kind TEXT NOT NULL DEFAULT 'general'
  CHECK (kind IN ('general', 'garantia', 'danado', 'exhibicion'));
