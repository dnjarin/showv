-- La auditoría solo se agrega: nadie (ni siquiera con acceso a la base desde otra herramienta o una inyección)
-- puede modificar ni borrar registros ya escritos sin primero eliminar estos disparadores, y eso quedaría a la vista.
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'La auditoría no se modifica'); END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'La auditoría no se elimina'); END;
