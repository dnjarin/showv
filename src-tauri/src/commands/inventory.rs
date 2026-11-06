use crate::commands::lots;
use crate::{audit, error::AppError, security, state::AppState};
use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

const MAX_QTY: i64 = 1_000_000;

fn note_of(n: Option<String>) -> Option<String> {
    n.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

fn opt_date(v: &Option<String>) -> Result<Option<String>, AppError> {
    match v.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .map(|d| Some(d.format("%Y-%m-%d").to_string()))
            .map_err(|_| AppError::Validation("Fecha inválida".into())),
    }
}

fn stock_in(conn: &Connection, product_id: i64, warehouse_id: i64) -> Result<i64, AppError> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(quantity), 0) FROM stock_movements
         WHERE product_id = ?1 AND warehouse_id = ?2",
        params![product_id, warehouse_id],
        |r| r.get(0),
    )?)
}

/// Devuelve el nombre del almacén si existe y está activo.
fn active_warehouse(conn: &Connection, id: i64) -> Result<String, AppError> {
    conn.query_row("SELECT name FROM warehouses WHERE id = ?1 AND active = 1", [id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| AppError::Validation("El almacén no existe o está inactivo".into()))
}

// ---------- Entradas, salidas y ajustes ----------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustInput {
    product_id: i64,
    warehouse_id: i64,
    kind: String, // "entrada" | "salida" | "ajuste"
    quantity: i64,
    note: Option<String>,
    /// Obligatorio solo en productos con control de lotes.
    #[serde(default)]
    lot_id: Option<i64>,
}

/// Devuelve el nuevo stock de ese producto en ese almacén. Todo ocurre en una transacción.
#[tauri::command]
pub async fn adjust_stock(state: State<'_, AppState>, input: AdjustInput) -> Result<i64, AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    let note = note_of(input.note);
    let need_note = || -> Result<(), AppError> {
        match &note {
            Some(n) if n.chars().count() >= 3 => Ok(()),
            _ => Err(AppError::Validation("Indica un motivo (mínimo 3 caracteres)".into())),
        }
    };
    if !(0..=MAX_QTY).contains(&input.quantity) {
        return Err(AppError::Validation("Cantidad fuera de rango".into()));
    }

    let mut db = state.conn()?;
    let tx = db.transaction()?;
    let wh_name = active_warehouse(&tx, input.warehouse_id)?;

    let track: i64 = tx
        .query_row(
            "SELECT track_stock FROM products WHERE id = ?1 AND active = 1",
            [input.product_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("El producto no existe o está inactivo".into()))?;
    if track == 0 {
        return Err(AppError::Validation("Este producto no controla inventario".into()));
    }

    let lot_id = if lots::uses_lots(&tx, input.product_id)? {
        let lid = input
            .lot_id
            .ok_or_else(|| AppError::Validation("Elige el lote de este movimiento".into()))?;
        lots::lot_of(&tx, input.product_id, lid)?;
        Some(lid)
    } else {
        None
    };
    // Con lotes, la existencia y el conteo se manejan por lote.
    let current = match lot_id {
        Some(lid) => lots::lot_stock(&tx, lid, input.warehouse_id)?,
        None => stock_in(&tx, input.product_id, input.warehouse_id)?,
    };
    let q = input.quantity;

    let (delta, reason) = match input.kind.as_str() {
        "entrada" => {
            if q <= 0 {
                return Err(AppError::Validation("La cantidad debe ser mayor que cero".into()));
            }
            (q, "entrada")
        }
        "salida" => {
            if q <= 0 {
                return Err(AppError::Validation("La cantidad debe ser mayor que cero".into()));
            }
            if q > current {
                return Err(AppError::Validation(format!(
                    "Stock insuficiente en {wh_name} (disponible: {current})"
                )));
            }
            need_note()?;
            (-q, "salida_manual")
        }
        "ajuste" => {
            // q = cantidad contada físicamente en ese almacén
            let delta = q - current;
            if delta == 0 {
                return Err(AppError::Validation("El conteo coincide con el stock actual".into()));
            }
            need_note()?;
            (delta, "ajuste")
        }
        _ => return Err(AppError::Validation("Tipo de movimiento inválido".into())),
    };

    tx.execute(
        "INSERT INTO stock_movements (product_id, quantity, reason, note, user_id, warehouse_id, lot_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![input.product_id, delta, reason, note, me.id, input.warehouse_id, lot_id],
    )?;
    let detail = format!("{wh_name}: {reason} {delta:+} (antes {current})");
    audit::log(&tx, Some(me.id), "stock_adjusted", Some("product"), Some(input.product_id), Some(&detail))?;
    tx.commit()?;
    Ok(current + delta)
}

// ---------- Kardex con filtros ----------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovementFilter {
    product_id: Option<i64>,
    warehouse_id: Option<i64>,
    reason: Option<String>,
    from: Option<String>,
    to: Option<String>,
    search: Option<String>,
    limit: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Movement {
    id: i64,
    product_id: i64,
    product_name: String,
    sku: String,
    warehouse_name: String,
    quantity: i64,
    reason: String,
    note: Option<String>,
    username: Option<String>,
    created_at: String,
    lot_code: Option<String>,
}

#[tauri::command]
pub async fn list_movements(
    state: State<'_, AppState>,
    filter: MovementFilter,
) -> Result<Vec<Movement>, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let from = opt_date(&filter.from)?;
    let to = opt_date(&filter.to)?;
    let reason = note_of(filter.reason);
    let search = note_of(filter.search);
    let limit = filter.limit.unwrap_or(300).clamp(1, 1000);

    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT m.id, m.product_id, p.name, p.sku, w.name, m.quantity, m.reason, m.note,
                    u.username, m.created_at, l.code
             FROM stock_movements m
             JOIN products p ON p.id = m.product_id
             JOIN warehouses w ON w.id = m.warehouse_id
             LEFT JOIN users u ON u.id = m.user_id
             LEFT JOIN lots l ON l.id = m.lot_id
             WHERE (?1 IS NULL OR m.product_id = ?1)
               AND (?2 IS NULL OR m.warehouse_id = ?2)
               AND (?3 IS NULL OR m.reason = ?3)
               AND (?4 IS NULL OR date(m.created_at, 'localtime') >= ?4)
               AND (?5 IS NULL OR date(m.created_at, 'localtime') <= ?5)
               AND (?6 IS NULL OR m.note LIKE '%' || ?6 || '%'
                    OR p.name LIKE '%' || ?6 || '%' OR p.sku LIKE '%' || ?6 || '%')
             ORDER BY m.id DESC LIMIT ?7",
        )?
        .query_map(
            params![filter.product_id, filter.warehouse_id, reason, from, to, search, limit],
            |r| {
                Ok(Movement {
                    id: r.get(0)?,
                    product_id: r.get(1)?,
                    product_name: r.get(2)?,
                    sku: r.get(3)?,
                    warehouse_name: r.get(4)?,
                    quantity: r.get(5)?,
                    reason: r.get(6)?,
                    note: r.get(7)?,
                    username: r.get(8)?,
                    created_at: r.get(9)?,
                    lot_code: r.get(10)?,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

// ---------- Existencias por almacén ----------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockFilter {
    search: Option<String>,
    category_id: Option<i64>,
    warehouse_id: Option<i64>,
    status: Option<String>, // all | available | low | zero
    #[serde(default)]
    include_inactive: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhLite {
    id: i64,
    name: String,
    is_sales: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhQty {
    warehouse_id: i64,
    quantity: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockRow {
    product_id: i64,
    sku: String,
    name: String,
    category_name: Option<String>,
    min_stock: i64,
    active: bool,
    by_warehouse: Vec<WhQty>,
    total: i64,
    uses_lots: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockOverview {
    warehouses: Vec<WhLite>,
    rows: Vec<StockRow>,
}

#[tauri::command]
pub async fn stock_overview(
    state: State<'_, AppState>,
    filter: StockFilter,
) -> Result<StockOverview, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let search = note_of(filter.search);
    let status = filter.status.unwrap_or_else(|| "all".into());
    let db = state.conn()?;

    let warehouses = db
        .prepare("SELECT id, name, is_sales FROM warehouses WHERE active = 1 ORDER BY is_sales DESC, name")?
        .query_map([], |r| {
            Ok(WhLite { id: r.get(0)?, name: r.get(1)?, is_sales: r.get::<_, i64>(2)? != 0 })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // Existencias por (producto, almacén) y total por producto, en una sola pasada.
    let mut qty: HashMap<(i64, i64), i64> = HashMap::new();
    let mut totals: HashMap<i64, i64> = HashMap::new();
    {
        let mut stmt = db.prepare(
            "SELECT product_id, warehouse_id, SUM(quantity)
             FROM stock_movements GROUP BY product_id, warehouse_id",
        )?;
        let it = stmt.query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
        })?;
        for x in it {
            let (p, w, q) = x?;
            qty.insert((p, w), q);
            *totals.entry(p).or_insert(0) += q;
        }
    }

    let products = db
        .prepare(
            "SELECT p.id, p.sku, p.name, c.name, p.min_stock, p.active, p.uses_lots
             FROM products p LEFT JOIN categories c ON c.id = p.category_id
             WHERE p.track_stock = 1
               AND (?1 IS NULL OR p.name LIKE '%' || ?1 || '%'
                    OR p.sku LIKE '%' || ?1 || '%' OR p.barcode = ?1)
               AND (?2 IS NULL OR p.category_id = ?2)
               AND (?3 = 1 OR p.active = 1)
             ORDER BY p.name LIMIT 2000",
        )?
        .query_map(params![search, filter.category_id, filter.include_inactive as i64], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut rows = Vec::new();
    for (id, sku, name, category_name, min_stock, active, uses_lots) in products {
        let total = *totals.get(&id).unwrap_or(&0);
        let scope = match filter.warehouse_id {
            Some(w) => *qty.get(&(id, w)).unwrap_or(&0),
            None => total,
        };
        let keep = match status.as_str() {
            "available" => scope > 0,
            "zero" => scope <= 0,
            "low" => total <= min_stock, // el mínimo se compara contra el total
            _ => true,
        };
        if !keep {
            continue;
        }
        let by_warehouse = warehouses
            .iter()
            .map(|w| WhQty {
                warehouse_id: w.id,
                quantity: *qty.get(&(id, w.id)).unwrap_or(&0),
            })
            .collect();
        rows.push(StockRow {
            product_id: id,
            sku,
            name,
            category_name,
            min_stock,
            active: active != 0,
            by_warehouse,
            total,
            uses_lots: uses_lots != 0,
        });
    }
    Ok(StockOverview { warehouses, rows })
}

// ---------- Transferencias ----------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferItem {
    product_id: i64,
    quantity: i64,
    #[serde(default)]
    lot_id: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferInput {
    from_warehouse_id: i64,
    to_warehouse_id: i64,
    note: Option<String>,
    items: Vec<TransferItem>,
}

#[tauri::command]
pub async fn transfer_stock(
    state: State<'_, AppState>,
    input: TransferInput,
) -> Result<i64, AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    if input.from_warehouse_id == input.to_warehouse_id {
        return Err(AppError::Validation("El origen y el destino deben ser distintos".into()));
    }
    if input.items.is_empty() || input.items.len() > 100 {
        return Err(AppError::Validation("Agrega entre 1 y 100 productos".into()));
    }

    // Une líneas repetidas del mismo producto
    let mut merged: Vec<(i64, i64, Option<i64>)> = Vec::new();
    for it in &input.items {
        if it.quantity <= 0 || it.quantity > MAX_QTY {
            return Err(AppError::Validation("Cantidad inválida".into()));
        }
        match merged.iter_mut().find(|m| m.0 == it.product_id && m.2 == it.lot_id) {
            Some(m) => m.1 += it.quantity,
            None => merged.push((it.product_id, it.quantity, it.lot_id)),
        }
    }
    let note = note_of(input.note);

    let mut db = state.conn()?;
    let tx = db.transaction()?;
    let from_name = active_warehouse(&tx, input.from_warehouse_id)?;
    let to_name = active_warehouse(&tx, input.to_warehouse_id)?;

    for &(pid, qty, lot_id) in &merged {
        let (name, track): (String, i64) = tx
            .query_row(
                "SELECT name, track_stock FROM products WHERE id = ?1 AND active = 1",
                [pid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::Validation("Un producto no existe o está inactivo".into()))?;
        if track == 0 {
            return Err(AppError::Validation(format!("«{name}» no controla inventario")));
        }
        let avail = if lots::uses_lots(&tx, pid)? {
            let lid = lot_id.ok_or_else(|| AppError::Validation(format!("Elige el lote de «{name}»")))?;
            lots::lot_of(&tx, pid, lid)?;
            lots::lot_stock(&tx, lid, input.from_warehouse_id)?
        } else {
            stock_in(&tx, pid, input.from_warehouse_id)?
        };
        if qty > avail {
            return Err(AppError::Validation(format!(
                "Stock insuficiente de «{name}» en {from_name} (disponible: {avail})"
            )));
        }
    }

    tx.execute(
        "INSERT INTO stock_transfers (from_warehouse_id, to_warehouse_id, note, user_id)
         VALUES (?1, ?2, ?3, ?4)",
        params![input.from_warehouse_id, input.to_warehouse_id, note, me.id],
    )?;
    let tid = tx.last_insert_rowid();

    for &(pid, qty, lot_id) in &merged {
        tx.execute(
            "INSERT INTO stock_movements
                (product_id, quantity, reason, note, user_id, warehouse_id, transfer_id, lot_id)
             VALUES (?1, ?2, 'transferencia_salida', ?3, ?4, ?5, ?6, ?7)",
            params![pid, -qty, note, me.id, input.from_warehouse_id, tid, lot_id],
        )?;
        tx.execute(
            "INSERT INTO stock_movements
                (product_id, quantity, reason, note, user_id, warehouse_id, transfer_id, lot_id)
             VALUES (?1, ?2, 'transferencia_entrada', ?3, ?4, ?5, ?6, ?7)",
            params![pid, qty, note, me.id, input.to_warehouse_id, tid, lot_id],
        )?;
    }

    let detail = format!("{from_name} -> {to_name}: {} producto(s)", merged.len());
    audit::log(&tx, Some(me.id), "stock_transferred", Some("transfer"), Some(tid), Some(&detail))?;
    tx.commit()?;
    Ok(tid)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferLine {
    sku: String,
    name: String,
    quantity: i64,
    lot_code: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRow {
    id: i64,
    created_at: String,
    from_name: String,
    to_name: String,
    username: Option<String>,
    note: Option<String>,
    lines: Vec<TransferLine>,
}

#[tauri::command]
pub async fn list_transfers(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<TransferRow>, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let limit = limit.unwrap_or(50).clamp(1, 200);
    let db = state.conn()?;

    let mut rows = db
        .prepare(
            "SELECT t.id, t.created_at, f.name, d.name, u.username, t.note
             FROM stock_transfers t
             JOIN warehouses f ON f.id = t.from_warehouse_id
             JOIN warehouses d ON d.id = t.to_warehouse_id
             LEFT JOIN users u ON u.id = t.user_id
             ORDER BY t.id DESC LIMIT ?1",
        )?
        .query_map([limit], |r| {
            Ok(TransferRow {
                id: r.get(0)?,
                created_at: r.get(1)?,
                from_name: r.get(2)?,
                to_name: r.get(3)?,
                username: r.get(4)?,
                note: r.get(5)?,
                lines: vec![],
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    for t in rows.iter_mut() {
        t.lines = db
            .prepare(
                "SELECT p.sku, p.name, m.quantity, l.code
                 FROM stock_movements m JOIN products p ON p.id = m.product_id
                 LEFT JOIN lots l ON l.id = m.lot_id
                 WHERE m.transfer_id = ?1 AND m.reason = 'transferencia_entrada'
                 ORDER BY m.id",
            )?
            .query_map([t.id], |r| {
                Ok(TransferLine { sku: r.get(0)?, name: r.get(1)?, quantity: r.get(2)?, lot_code: r.get(3)? })
            })?
            .collect::<Result<Vec<_>, _>>()?;
    }
    Ok(rows)
}