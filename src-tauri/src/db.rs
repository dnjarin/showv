use crate::{audit, backup, crypto, error::AppError};
use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};
use std::path::Path;

/// Solo se agregan al final; nunca se editan ni se reordenan.
pub const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_init.sql"),
    include_str!("../migrations/002_facturacion.sql"),
    include_str!("../migrations/003_indices_inventario.sql"),
    include_str!("../migrations/004_clientes_tasas.sql"),
    include_str!("../migrations/005_ventas.sql"),
    include_str!("../migrations/006_exoneraciones.sql"),
    include_str!("../migrations/007_caja.sql"),
    include_str!("../migrations/008_seguridad.sql"),
    include_str!("../migrations/009_usuarios.sql"),    
    include_str!("../migrations/010_almacenes.sql"),    
    include_str!("../migrations/011_compras.sql"),
    include_str!("../migrations/012_retenciones.sql"),
    include_str!("../migrations/013_descuentos_vuelto.sql"),
    include_str!("../migrations/014_devoluciones.sql"),
    include_str!("../migrations/015_cuentas_por_cobrar.sql"),
    include_str!("../migrations/016_cobranzas_avanzado.sql"),
    include_str!("../migrations/017_cuentas_por_pagar.sql"),
    include_str!("../migrations/018_gastos_caja.sql"),
    include_str!("../migrations/019_costos_ventas.sql"),
    include_str!("../migrations/020_importacion.sql"),
    include_str!("../migrations/021_cotizaciones.sql"),
    include_str!("../migrations/022_precios_promociones.sql"),
    include_str!("../migrations/023_ordenes_compra.sql"),
    include_str!("../migrations/024_lotes.sql"),
    include_str!("../migrations/025_retenciones_sufridas.sql"),
    include_str!("../migrations/026_migracion_qsl.sql"),
    include_str!("../migrations/027_auditoria_inmutable.sql"),
    include_str!("../migrations/028_tipos_almacen.sql"),
    include_str!("../migrations/029_inmutabilidad_financiera.sql"),
    include_str!("../migrations/030_cotizacion_formato.sql"),
    include_str!("../migrations/031_cotizaciones_emitidas.sql"),
    include_str!("../migrations/032_cotizaciones_hora_utc.sql"),
];

fn migrations() -> Migrations<'static> {
    Migrations::new(MIGRATIONS.iter().map(|sql| M::up(*sql)).collect())
}

pub fn migrate(conn: &mut Connection) -> Result<(), AppError> {
    migrations().to_latest(conn)?;
    Ok(())
}

pub fn open(path: &Path) -> Result<Connection, AppError> {
    crypto::prepare(path)?; // llave de cifrado; convierte la base anterior si estaba sin cifrar
    let mut conn = Connection::open(path)?;
    crypto::apply(&conn)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;

    // Base existente con migraciones pendientes: respaldo previo.
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version > 0 && (version as usize) < MIGRATIONS.len() {
        if let Some(parent) = path.parent() {
            if let Err(e) = backup::run(&conn, &backup::dir(parent), "premigracion") {
                eprintln!("No se pudo crear el respaldo previo a la migración: {e}");
            }
        }
    }

    migrate(&mut conn)?;
    check_integrity(&conn, path);
    Ok(conn)
}

/// Revisión rápida de la base al abrir. Si encuentra daño no impide abrir el programa (para poder
/// restaurar un respaldo): deja un aviso en la bitácora de auditoría y un archivo de alerta junto a la base.
fn check_integrity(conn: &Connection, path: &Path) {
    let detail = match conn.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0)) {
        Ok(s) if s.trim().eq_ignore_ascii_case("ok") => return,
        Ok(s) => s,
        Err(e) => format!("no se pudo revisar: {e}"),
    };
    let detail: String = detail.chars().take(500).collect();
    eprintln!("ALERTA: la revisión de integridad de la base falló: {detail}");
    if let Err(e) = audit::log(conn, None, "integrity_check_failed", Some("database"), None, Some(&detail)) {
        eprintln!("No se pudo registrar la alerta de integridad: {e}");
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::write(
            parent.join("ALERTA_INTEGRIDAD.txt"),
            format!(
                "La revisión automática de la base de datos encontró un problema:\r\n{detail}\r\n\r\n\
                 Qué hacer: no sigas registrando operaciones. Entra como administrador, ve a Respaldos y restaura \
                 el respaldo más reciente. Guarda una copia de esta carpeta antes de cambiar nada.\r\n"
            ),
        );
    }
}