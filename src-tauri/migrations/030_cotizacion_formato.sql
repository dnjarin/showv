-- Condición de pago de la cotización (contado o crédito), para el formato de cotización.
ALTER TABLE quotes ADD COLUMN pay_condition TEXT NOT NULL DEFAULT 'CONTADO'
  CHECK (pay_condition IN ('CONTADO','CREDITO'));
