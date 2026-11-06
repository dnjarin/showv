use crate::{audit, error::AppError, security, state::AppState};
use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

const MAX_QTY: i64 = 1_000_000;
const CURRENCIES: &[&str] = &["VES", "USD"];
/// Código del lote que agrupa la existencia que ya había cuando se activó el control de lotes.
pub(crate) const INITIAL_LOT: &str = "INICIAL";

// ---------- Utilidades compartidas con ventas, compras, inventario y devoluciones ----------

/// ¿Este producto maneja sus existencias por lote?
pub(crate) fn uses_lots(conn: &Connection, product_id: i64) -> Result<bool, AppError> {
    let v: Option<i64> = conn
        .query_row(
            "SELECT uses_lots FROM products WHERE id = ?1",
            [product_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(v.unwrap_or(0) != 0)
}

/// Existencia de un lote en un almacén.
pub(crate) fn lot_stock(
    conn: &Connection,
    lot_id: i64,
    warehouse_id: i64,
) -> Result<i64, AppError> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(quantity), 0) FROM stock_movements WHERE lot_id = ?1 AND warehouse_id = ?2",
        params![lot_id, warehouse_id],
        |r| r.get(0),
    )?)
}

pub(crate) struct LotInfo {
    pub code: String,
    pub brand: Option<String>,
}

impl LotInfo {
    /// Texto corto para mostrar: «C-000012 · HP».
    pub fn label(&self) -> String {
        match &self.brand {
            Some(b) if !b.is_empty() => format!("{} · {}", self.code, b),
            _ => self.code.clone(),
        }
    }
}

/// Comprueba que el lote exista y sea de ese producto.
pub(crate) fn lot_of(conn: &Connection, product_id: i64, lot_id: i64) -> Result<LotInfo, AppError> {
    conn.query_row(
        "SELECT code, brand FROM lots WHERE id = ?1 AND product_id = ?2",
        params![lot_id, product_id],
        |r| {
            Ok(LotInfo {
                code: r.get(0)?,
                brand: r.get(1)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::Validation("El lote no existe o no es de este producto".into()))
}

/// Lote al que vuelve una devolución: el de la línea vendida o, si la venta fue anterior al control
/// de lotes, el lote «INICIAL» del producto.
pub(crate) fn return_lot(
    conn: &Connection,
    product_id: i64,
    source_item_id: i64,
) -> Result<Option<i64>, AppError> {
    if !uses_lots(conn, product_id)? {
        return Ok(None);
    }
    let from_sale: Option<i64> = conn
        .query_row(
            "SELECT lot_id FROM item_costs WHERE item_id = ?1",
            [source_item_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    if from_sale.is_some() {
        return Ok(from_sale);
    }
    let initial: Option<i64> = conn
        .query_row(
            "SELECT id FROM lots WHERE product_id = ?1 AND code = ?2 COLLATE NOCASE",
            params![product_id, INITIAL_LOT],
            |r| r.get(0),
        )
        .optional()?;
    initial.map(Some).ok_or_else(|| {
        AppError::Validation(
            "No se encontró el lote de origen de esta venta para devolver la mercancía".into(),
        )
    })
}

fn clean_text(v: Option<String>, max: usize, what: &str) -> Result<Option<String>, AppError> {
    let t = v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if t.as_ref().is_some_and(|s| s.chars().count() > max) {
        return Err(AppError::Validation(format!(
            "{what}: máximo {max} caracteres"
        )));
    }
    Ok(t)
}

fn clean_date(v: &Option<String>) -> Result<Option<String>, AppError> {
    match v.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .map(|d| Some(d.format("%Y-%m-%d").to_string()))
            .map_err(|_| AppError::Validation("Fecha del lote inválida".into())),
    }
}

/// Crea el lote o reutiliza uno existente con el mismo código, costo y moneda (por ejemplo, una segunda
/// entrega del mismo lote). Un código repetido con otro costo se rechaza: cada lote conserva su costo.
pub(crate) fn receive_lot(
    conn: &Connection,
    product_id: i64,
    code: Option<String>,
    brand: Option<String>,
    received_date: Option<String>,
    default_code: &str,
    unit_cost_minor: i64,
    currency: &str,
    purchase_id: Option<i64>,
) -> Result<i64, AppError> {
    let code = clean_text(code, 30, "Código del lote")?
        .map(|c| c.to_uppercase())
        .unwrap_or_else(|| default_code.to_string());
    let brand = clean_text(brand, 40, "Marca")?;
    let date = clean_date(&received_date)?;

    let existing: Option<(i64, i64, String)> = conn
        .query_row(
            "SELECT id, unit_cost_minor, cost_currency FROM lots
             WHERE product_id = ?1 AND code = ?2 COLLATE NOCASE",
            params![product_id, code],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if let Some((id, cost, cur)) = existing {
        if cost != unit_cost_minor || cur != currency {
            return Err(AppError::Validation(format!(
                "El lote «{code}» ya existe con otro costo. Usa otro código de lote"
            )));
        }
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO lots (product_id, code, brand, received_date, unit_cost_minor, cost_currency, purchase_id)
         VALUES (?1, ?2, ?3, COALESCE(?4, date('now','localtime')), ?5, ?6, ?7)",
        params![product_id, code, brand, date, unit_cost_minor, currency, purchase_id],
    )?;
    Ok(conn.last_insert_rowid())
}

// ---------- Consulta ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LotWh {
    warehouse_id: i64,
    quantity: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LotRow {
    id: i64,
    product_id: i64,
    sku: String,
    product_name: String,
    code: String,
    brand: Option<String>,
    received_date: String,
    notes: Option<String>,
    /// El costo no se muestra al cajero.
    unit_cost_minor: Option<i64>,
    cost_currency: Option<String>,
    stock: i64,
    by_warehouse: Vec<LotWh>,
}

fn read_lots(
    conn: &Connection,
    show_cost: bool,
    product_id: Option<i64>,
    search: Option<String>,
    warehouse_id: Option<i64>,
    include_empty: bool,
) -> Result<Vec<LotRow>, AppError> {
    let mut rows = conn
        .prepare(
            "SELECT l.id, l.product_id, p.sku, p.name, l.code, l.brand, l.received_date, l.notes,
                    l.unit_cost_minor, l.cost_currency,
                    COALESCE((SELECT SUM(m.quantity) FROM stock_movements m
                              WHERE m.lot_id = l.id AND (?3 IS NULL OR m.warehouse_id = ?3)), 0)
             FROM lots l JOIN products p ON p.id = l.product_id
             WHERE (?1 IS NULL OR l.product_id = ?1)
               AND (?2 IS NULL OR p.name LIKE '%' || ?2 || '%' OR p.sku LIKE '%' || ?2 || '%'
                    OR l.code LIKE '%' || ?2 || '%' OR l.brand LIKE '%' || ?2 || '%')
             ORDER BY p.name, l.received_date, l.id
             LIMIT 1500",
        )?
        .query_map(params![product_id, search, warehouse_id], |r| {
            Ok(LotRow {
                id: r.get(0)?,
                product_id: r.get(1)?,
                sku: r.get(2)?,
                product_name: r.get(3)?,
                code: r.get(4)?,
                brand: r.get(5)?,
                received_date: r.get(6)?,
                notes: r.get(7)?,
                unit_cost_minor: if show_cost { Some(r.get(8)?) } else { None },
                cost_currency: if show_cost { Some(r.get(9)?) } else { None },
                stock: r.get(10)?,
                by_warehouse: vec![],
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if !include_empty {
        rows.retain(|l| l.stock > 0);
    }
    for l in rows.iter_mut() {
        l.by_warehouse = conn
            .prepare(
                "SELECT warehouse_id, SUM(quantity) FROM stock_movements
                 WHERE lot_id = ?1 GROUP BY warehouse_id HAVING SUM(quantity) <> 0",
            )?
            .query_map([l.id], |r| {
                Ok(LotWh {
                    warehouse_id: r.get(0)?,
                    quantity: r.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
    }
    Ok(rows)
}

/// Lotes de un producto. Con `warehouse_id`, la existencia es la de ese almacén
/// (así el cajero ve solo lo que puede vender).
#[tauri::command]
pub async fn list_lots(
    state: State<'_, AppState>,
    product_id: i64,
    warehouse_id: Option<i64>,
    include_empty: bool,
) -> Result<Vec<LotRow>, AppError> {
    let me = security::require_role(&state, security::ALL_ROLES)?;
    let db = state.conn()?;
    read_lots(
        &db,
        me.role != "cajero",
        Some(product_id),
        None,
        warehouse_id,
        include_empty,
    )
}

/// Lotes de la venta: los del almacén de ventas con existencia.
#[tauri::command]
pub async fn list_sale_lots(
    state: State<'_, AppState>,
    product_id: i64,
) -> Result<Vec<LotRow>, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;
    let wh = crate::commands::warehouses::sales_warehouse_id(&db)?;
    read_lots(
        &db,
        me.role != "cajero",
        Some(product_id),
        None,
        Some(wh),
        false,
    )
}

/// Reporte de todos los lotes (pantalla Inventario → Lotes).
#[tauri::command]
pub async fn lots_report(
    state: State<'_, AppState>,
    search: Option<String>,
    include_empty: bool,
) -> Result<Vec<LotRow>, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let search = clean_text(search, 60, "Búsqueda")?;
    let db = state.conn()?;
    read_lots(&db, true, None, search, None, include_empty)
}

// ---------- Activar o desactivar el control de lotes ----------
#[tauri::command]
pub async fn set_product_lots(
    state: State<'_, AppState>,
    product_id: i64,
    enabled: bool,
) -> Result<(), AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    let mut db = state.conn()?;
    let tx = db.transaction()?;

    let (name, track, current, cost, cur): (String, i64, i64, i64, String) = tx
        .query_row(
            "SELECT name, track_stock, uses_lots, cost_minor, price_currency FROM products WHERE id = ?1",
            [product_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("El producto no existe".into()))?;

    if enabled {
        if track == 0 {
            return Err(AppError::Validation(format!(
                "«{name}» no controla inventario"
            )));
        }
        if current != 0 {
            return Err(AppError::Validation(format!("«{name}» ya controla lotes")));
        }
        let loose: i64 = tx.query_row(
            "SELECT COUNT(*) FROM stock_movements WHERE product_id = ?1 AND lot_id IS NULL",
            [product_id],
            |r| r.get(0),
        )?;
        if loose > 0 {
            // Lo que ya existía pasa a un lote «INICIAL»; las cantidades no cambian.
            let existing: Option<i64> = tx
                .query_row(
                    "SELECT id FROM lots WHERE product_id = ?1 AND code = ?2 COLLATE NOCASE",
                    params![product_id, INITIAL_LOT],
                    |r| r.get(0),
                )
                .optional()?;
            let lot_id = match existing {
                Some(id) => id,
                None => {
                    tx.execute(
                        "INSERT INTO lots (product_id, code, received_date, unit_cost_minor, cost_currency, notes)
                         VALUES (?1, ?2,
                                 COALESCE((SELECT date(MIN(created_at), 'localtime') FROM stock_movements
                                           WHERE product_id = ?1), date('now','localtime')),
                                 ?3, ?4, 'Existencia previa al control de lotes')",
                        params![product_id, INITIAL_LOT, cost, cur],
                    )?;
                    tx.last_insert_rowid()
                }
            };
            tx.execute(
                "UPDATE stock_movements SET lot_id = ?1 WHERE product_id = ?2 AND lot_id IS NULL",
                params![lot_id, product_id],
            )?;
        }
        tx.execute(
            "UPDATE products SET uses_lots = 1 WHERE id = ?1",
            [product_id],
        )?;
        audit::log(
            &tx,
            Some(me.id),
            "lots_enabled",
            Some("product"),
            Some(product_id),
            Some(&name),
        )?;
    } else {
        if current == 0 {
            return Err(AppError::Validation(format!("«{name}» no controla lotes")));
        }
        let with_stock: i64 = tx.query_row(
            "SELECT COUNT(*) FROM (SELECT lot_id FROM stock_movements
                                   WHERE product_id = ?1 GROUP BY lot_id HAVING SUM(quantity) <> 0)",
            [product_id],
            |r| r.get(0),
        )?;
        if with_stock > 1 {
            return Err(AppError::Validation(format!(
                "«{name}» tiene {with_stock} lotes con existencias. Para dejar de controlar lotes debe quedar \
                 como máximo uno con existencias"
            )));
        }
        tx.execute(
            "UPDATE products SET uses_lots = 0 WHERE id = ?1",
            [product_id],
        )?;
        audit::log(
            &tx,
            Some(me.id),
            "lots_disabled",
            Some("product"),
            Some(product_id),
            Some(&name),
        )?;
    }
    tx.commit()?;
    Ok(())
}

// ---------- Crear y editar lotes ----------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewLotInput {
    product_id: i64,
    code: String,
    brand: Option<String>,
    received_date: Option<String>,
    unit_cost_minor: i64,
    cost_currency: String,
    notes: Option<String>,
    warehouse_id: Option<i64>,
    quantity: Option<i64>,
}

/// Crea un lote a mano, con existencia inicial opcional (por ejemplo, al migrar desde otro sistema).
#[tauri::command]
pub async fn create_lot(state: State<'_, AppState>, input: NewLotInput) -> Result<i64, AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    if input.code.trim().is_empty() {
        return Err(AppError::Validation("Indica el código del lote".into()));
    }
    if input.unit_cost_minor < 0 {
        return Err(AppError::Validation(
            "El costo no puede ser negativo".into(),
        ));
    }
    if !CURRENCIES.contains(&input.cost_currency.as_str()) {
        return Err(AppError::Validation("Moneda inválida".into()));
    }
    let qty = input.quantity.unwrap_or(0);
    if !(0..=MAX_QTY).contains(&qty) {
        return Err(AppError::Validation("Cantidad fuera de rango".into()));
    }
    let notes = clean_text(input.notes, 200, "Notas")?;

    let mut db = state.conn()?;
    let tx = db.transaction()?;
    if !uses_lots(&tx, input.product_id)? {
        return Err(AppError::Validation(
            "Primero activa el control de lotes de este producto".into(),
        ));
    }
    let existing: i64 = tx.query_row(
        "SELECT COUNT(*) FROM lots WHERE product_id = ?1 AND code = ?2 COLLATE NOCASE",
        params![input.product_id, input.code.trim()],
        |r| r.get(0),
    )?;
    if existing > 0 {
        return Err(AppError::Validation(
            "Ya existe un lote con ese código en este producto".into(),
        ));
    }
    let lot_id = receive_lot(
        &tx,
        input.product_id,
        Some(input.code),
        input.brand,
        input.received_date,
        "",
        input.unit_cost_minor,
        &input.cost_currency,
        None,
    )?;
    if let Some(n) = notes {
        tx.execute(
            "UPDATE lots SET notes = ?1 WHERE id = ?2",
            params![n, lot_id],
        )?;
    }
    if qty > 0 {
        let wh = input.warehouse_id.ok_or_else(|| {
            AppError::Validation("Indica el almacén de la existencia inicial".into())
        })?;
        let ok: i64 = tx.query_row(
            "SELECT COUNT(*) FROM warehouses WHERE id = ?1 AND active = 1",
            [wh],
            |r| r.get(0),
        )?;
        if ok == 0 {
            return Err(AppError::Validation(
                "El almacén no existe o está inactivo".into(),
            ));
        }
        tx.execute(
            "INSERT INTO stock_movements (product_id, quantity, reason, note, user_id, warehouse_id, lot_id)
             VALUES (?1, ?2, 'entrada', 'Alta de lote', ?3, ?4, ?5)",
            params![input.product_id, qty, me.id, wh, lot_id],
        )?;
    }
    let detail = format!("lote creado, {qty} unidad(es) iniciales");
    audit::log(
        &tx,
        Some(me.id),
        "lot_created",
        Some("lot"),
        Some(lot_id),
        Some(&detail),
    )?;
    tx.commit()?;
    Ok(lot_id)
}

/// Solo se corrigen la marca y las notas: el código, la fecha y el costo del lote no se cambian.
#[tauri::command]
pub async fn update_lot(
    state: State<'_, AppState>,
    id: i64,
    brand: Option<String>,
    notes: Option<String>,
) -> Result<(), AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    let brand = clean_text(brand, 40, "Marca")?;
    let notes = clean_text(notes, 200, "Notas")?;
    let db = state.conn()?;
    let n = db.execute(
        "UPDATE lots SET brand = ?1, notes = ?2 WHERE id = ?3",
        params![brand, notes, id],
    )?;
    if n == 0 {
        return Err(AppError::Validation("El lote no existe".into()));
    }
    audit::log(&db, Some(me.id), "lot_updated", Some("lot"), Some(id), None)?;
    Ok(())
}
