use crate::{audit, error::AppError, security, state::AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Warehouse {
    id: i64,
    code: String,
    name: String,
    address: Option<String>,
    active: bool,
    is_sales: bool,
    products_with_stock: i64,
    units: i64,
    kind: String,
}

/// Almacén desde el que se vende. Lo usan la cotización, la emisión y el stock inicial.
pub fn sales_warehouse_id(conn: &Connection) -> Result<i64, AppError> {
    conn.query_row(
        "SELECT id FROM warehouses WHERE is_sales = 1 AND active = 1",
        [],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| {
        AppError::Validation(
            "No hay un almacén de ventas configurado (Inventario → Almacenes)".into(),
        )
    })
}

const KINDS: [&str; 4] = ["general", "garantia", "danado", "exhibicion"];

fn clean_kind(kind: Option<String>) -> Result<String, AppError> {
    let k = kind.map(|k| k.trim().to_lowercase()).filter(|k| !k.is_empty()).unwrap_or_else(|| "general".into());
    if !KINDS.contains(&k.as_str()) {
        return Err(AppError::Validation("Tipo de almacén no válido".into()));
    }
    Ok(k)
}

fn clean_fields(
    code: &str,
    name: &str,
    address: Option<String>,
) -> Result<(String, String, Option<String>), AppError> {
    let code = code.trim().to_uppercase();
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let address = address.map(|a| a.trim().to_string()).filter(|a| !a.is_empty());

    if !(2..=10).contains(&code.chars().count())
        || !code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(AppError::Validation(
            "El código debe tener de 2 a 10 letras, números o guiones".into(),
        ));
    }
    if !(2..=40).contains(&name.chars().count()) {
        return Err(AppError::Validation("El nombre debe tener entre 2 y 40 caracteres".into()));
    }
    if address.as_ref().map_or(false, |a| a.chars().count() > 120) {
        return Err(AppError::Validation("La dirección es demasiado larga (máximo 120)".into()));
    }
    Ok((code, name, address))
}

fn map_unique(e: rusqlite::Error) -> AppError {
    match &e {
        rusqlite::Error::SqliteFailure(f, _)
            if f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
        {
            AppError::Validation("Ya existe un almacén con ese código o nombre".into())
        }
        _ => AppError::Db(e),
    }
}

#[tauri::command]
pub async fn list_warehouses(
    state: State<'_, AppState>,
    include_inactive: bool,
) -> Result<Vec<Warehouse>, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT w.id, w.code, w.name, w.address, w.active, w.is_sales,
                    (SELECT COUNT(*) FROM (
                        SELECT product_id FROM stock_movements m
                        WHERE m.warehouse_id = w.id
                        GROUP BY product_id HAVING SUM(quantity) > 0)),
                    COALESCE((SELECT SUM(quantity) FROM stock_movements m
                              WHERE m.warehouse_id = w.id), 0),
                    w.kind
             FROM warehouses w
             WHERE (?1 = 1 OR w.active = 1)
             ORDER BY w.is_sales DESC, w.name",
        )?
        .query_map([include_inactive as i64], |r| {
            Ok(Warehouse {
                id: r.get(0)?,
                code: r.get(1)?,
                name: r.get(2)?,
                address: r.get(3)?,
                active: r.get::<_, i64>(4)? != 0,
                is_sales: r.get::<_, i64>(5)? != 0,
                products_with_stock: r.get(6)?,
                units: r.get(7)?,
                kind: r.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub async fn create_warehouse(
    state: State<'_, AppState>,
    code: String,
    name: String,
    address: Option<String>,
    kind: Option<String>,
) -> Result<i64, AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let (code, name, address) = clean_fields(&code, &name, address)?;
    let kind = clean_kind(kind)?;
    let db = state.conn()?;
    db.execute(
        "INSERT INTO warehouses (code, name, address, kind) VALUES (?1, ?2, ?3, ?4)",
        params![code, name, address, kind],
    )
    .map_err(map_unique)?;
    let id = db.last_insert_rowid();
    audit::log(&db, Some(me.id), "warehouse_created", Some("warehouse"), Some(id), Some(&name))?;
    Ok(id)
}

#[tauri::command]
pub async fn update_warehouse(
    state: State<'_, AppState>,
    id: i64,
    code: String,
    name: String,
    address: Option<String>,
    kind: Option<String>,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let (code, name, address) = clean_fields(&code, &name, address)?;
    let kind = clean_kind(kind)?;
    let db = state.conn()?;
    let (cur_kind, is_sales): (String, i64) = db
        .query_row("SELECT kind, is_sales FROM warehouses WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?
        .ok_or_else(|| AppError::Validation("El almacén no existe".into()))?;
    if is_sales == 1 && kind != "general" && kind != cur_kind {
        return Err(AppError::Validation(
            "Es el almacén de ventas: solo puede ser de tipo General".into(),
        ));
    }
    let n = db
        .execute(
            "UPDATE warehouses SET code = ?1, name = ?2, address = ?3, kind = ?4 WHERE id = ?5",
            params![code, name, address, kind, id],
        )
        .map_err(map_unique)?;
    if n == 0 {
        return Err(AppError::Validation("El almacén no existe".into()));
    }
    audit::log(&db, Some(me.id), "warehouse_updated", Some("warehouse"), Some(id), Some(&name))?;
    Ok(())
}

#[tauri::command]
pub async fn set_warehouse_active(
    state: State<'_, AppState>,
    id: i64,
    active: bool,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let db = state.conn()?;

    let is_sales: i64 = db
        .query_row("SELECT is_sales FROM warehouses WHERE id = ?1", [id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| AppError::Validation("El almacén no existe".into()))?;

    if !active {
        if is_sales == 1 {
            return Err(AppError::Validation(
                "Es el almacén de ventas: elige otro para ventas antes de desactivarlo".into(),
            ));
        }
        let with_stock: i64 = db.query_row(
            "SELECT COUNT(*) FROM (
                SELECT product_id FROM stock_movements WHERE warehouse_id = ?1
                GROUP BY product_id HAVING SUM(quantity) <> 0)",
            [id],
            |r| r.get(0),
        )?;
        if with_stock > 0 {
            return Err(AppError::Validation(format!(
                "Aún tiene existencias de {with_stock} producto(s). Transfiérelas o ajústalas primero"
            )));
        }
    }
    db.execute("UPDATE warehouses SET active = ?1 WHERE id = ?2", params![active as i64, id])?;
    let action = if active { "warehouse_activated" } else { "warehouse_deactivated" };
    audit::log(&db, Some(me.id), action, Some("warehouse"), Some(id), None)?;
    Ok(())
}

#[tauri::command]
pub async fn set_sales_warehouse(state: State<'_, AppState>, id: i64) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let mut db = state.conn()?;
    let tx = db.transaction()?;

    let (name, kind): (String, String) = tx
        .query_row("SELECT name, kind FROM warehouses WHERE id = ?1 AND active = 1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?
        .ok_or_else(|| AppError::Validation("El almacén no existe o está inactivo".into()))?;
    if kind != "general" {
        return Err(AppError::Validation(
            "Solo un almacén de tipo General puede ser el almacén de ventas".into(),
        ));
    }
    tx.execute("UPDATE warehouses SET is_sales = 0 WHERE is_sales = 1", [])?;
    tx.execute("UPDATE warehouses SET is_sales = 1 WHERE id = ?1", [id])?;
    audit::log(&tx, Some(me.id), "sales_warehouse_set", Some("warehouse"), Some(id), Some(&name))?;
    tx.commit()?;
    Ok(())
}