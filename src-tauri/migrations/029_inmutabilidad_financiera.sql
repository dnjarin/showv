-- Protección de integridad: el sistema solo AGREGA registros en pagos, movimientos de inventario, traspasos y
-- tasas; las correcciones se hacen con nuevos registros (anulaciones, devoluciones, notas), no editando los
-- anteriores. Así, un cambio hecho desde fuera de la aplicación (otra herramienta, una inyección) es rechazado
-- y, para saltarse la protección, habría que eliminar estos disparadores, algo que queda a la vista.

-- ===== Pagos recibidos =====
CREATE TRIGGER trg_payments_no_update BEFORE UPDATE ON payments
BEGIN SELECT RAISE(ABORT, 'Los pagos no se modifican'); END;
CREATE TRIGGER trg_payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'Los pagos no se eliminan'); END;
CREATE TRIGGER trg_payments_valid BEFORE INSERT ON payments
WHEN NEW.amount_minor < 0 OR NEW.exchange_rate_micro <= 0 OR NEW.igtf_minor < 0
BEGIN SELECT RAISE(ABORT, 'Pago con monto, tasa o IGTF no válidos'); END;

-- ===== Movimientos de inventario (kardex) =====
-- Única modificación permitida: asignar el lote a un movimiento que no lo tenía (al activar lotes en un producto).
CREATE TRIGGER trg_movements_no_update BEFORE UPDATE ON stock_movements
WHEN NOT (
      OLD.lot_id IS NULL AND NEW.lot_id IS NOT NULL
  AND NEW.product_id = OLD.product_id AND NEW.quantity = OLD.quantity AND NEW.reason = OLD.reason
  AND NEW.document_id IS OLD.document_id AND NEW.user_id IS OLD.user_id AND NEW.created_at = OLD.created_at
  AND NEW.note IS OLD.note AND NEW.warehouse_id IS OLD.warehouse_id AND NEW.transfer_id IS OLD.transfer_id
  AND NEW.purchase_id IS OLD.purchase_id)
BEGIN SELECT RAISE(ABORT, 'Los movimientos de inventario no se modifican; corrige con un ajuste'); END;
CREATE TRIGGER trg_movements_no_delete BEFORE DELETE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'Los movimientos de inventario no se eliminan'); END;

-- ===== Traspasos entre almacenes =====
CREATE TRIGGER trg_transfers_no_update BEFORE UPDATE ON stock_transfers
BEGIN SELECT RAISE(ABORT, 'Los traspasos no se modifican'); END;
CREATE TRIGGER trg_transfers_no_delete BEFORE DELETE ON stock_transfers
BEGIN SELECT RAISE(ABORT, 'Los traspasos no se eliminan'); END;

-- ===== Tasas de cambio =====
-- El sistema puede corregir la tasa de una fecha (queda en la auditoría), pero no borrar tasas ni cambiar a qué
-- moneda o fecha pertenecen, y la tasa siempre debe ser positiva.
CREATE TRIGGER trg_rates_no_delete BEFORE DELETE ON exchange_rates
BEGIN SELECT RAISE(ABORT, 'Las tasas de cambio no se eliminan'); END;
CREATE TRIGGER trg_rates_identity BEFORE UPDATE ON exchange_rates
WHEN NEW.currency_code <> OLD.currency_code OR NEW.rate_date <> OLD.rate_date
BEGIN SELECT RAISE(ABORT, 'No se puede cambiar la moneda ni la fecha de una tasa'); END;
CREATE TRIGGER trg_rates_valid_ins BEFORE INSERT ON exchange_rates
WHEN NEW.rate_micro <= 0
BEGIN SELECT RAISE(ABORT, 'La tasa debe ser positiva'); END;
CREATE TRIGGER trg_rates_valid_upd BEFORE UPDATE ON exchange_rates
WHEN NEW.rate_micro <= 0
BEGIN SELECT RAISE(ABORT, 'La tasa debe ser positiva'); END;

-- ===== Sesiones de caja =====
-- Se puede cerrar una caja abierta, pero una caja cerrada queda congelada y ninguna se elimina.
CREATE TRIGGER trg_cash_sessions_no_delete BEFORE DELETE ON cash_sessions
BEGIN SELECT RAISE(ABORT, 'Las sesiones de caja no se eliminan'); END;
CREATE TRIGGER trg_cash_sessions_closed BEFORE UPDATE ON cash_sessions
WHEN OLD.closed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'La caja cerrada no se modifica'); END;
CREATE TRIGGER trg_cash_sessions_core BEFORE UPDATE ON cash_sessions
WHEN NEW.user_id <> OLD.user_id OR NEW.opened_at <> OLD.opened_at
  OR NEW.opening_ves_minor <> OLD.opening_ves_minor OR NEW.opening_usd_minor <> OLD.opening_usd_minor
BEGIN SELECT RAISE(ABORT, 'La apertura de una caja no se modifica'); END;
CREATE TRIGGER trg_cash_sessions_valid BEFORE INSERT ON cash_sessions
WHEN NEW.opening_ves_minor < 0 OR NEW.opening_usd_minor < 0
BEGIN SELECT RAISE(ABORT, 'Monto de apertura no válido'); END;
