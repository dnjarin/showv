//! Órdenes de compra a proveedores: documento de pedido. No mueven stock ni contabilidad;
//! al recibir la mercadería se registra la compra normal (pre-llenada desde la orden).

use crate::{audit, error::AppError, security, state::AppState};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderLineInput {
    product_id: i64,
    quantity: i64,
    unit_cost_minor: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderInput {
    supplier_id: i64,
    currency_code: String,
    expected_date: Option<String>,
    notes: Option<String>,
    items: Vec<OrderLineInput>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderRow {
    id: i64,
    number: String,
    supplier_name: String,
    currency_code: String,
    total_minor: i64,
    status: String,
    expected_date: Option<String>,
    overdue: bool,
    created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderItemOut {
    product_id: i64,
    sku: String,
    description: String,
    quantity: i64,
    unit_cost_minor: i64,
    line_total_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderDetail {
    id: i64,
    number: String,
    supplier_name: String,
    supplier_doc: String,
    supplier_phone: Option<String>,
    supplier_address: Option<String>,
    currency_code: String,
    expected_date: Option<String>,
    notes: Option<String>,
    total_minor: i64,
    status: String,
    created_at: String,
    created_by_name: Option<String>,
    issuer_name: String,
    issuer_rif: String,
    issuer_address: String,
    items: Vec<OrderItemOut>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierOut {
    id: i64,
    id_type: String,
    id_number: String,
    name: String,
    phone: Option<String>,
    address: Option<String>,
    active: bool,
    iva_retention_bp: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivePrefill {
    id: i64,
    number: String,
    supplier: SupplierOut,
    currency_code: String,
    items: Vec<OrderItemOut>,
}

#[tauri::command]
pub async fn po_create(state: State<'_, AppState>, input: OrderInput) -> Result<i64, AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    if !["VES", "USD"].contains(&input.currency_code.as_str()) {
        return Err(AppError::Validation("Moneda inválida".into()));
    }
    if input.items.is_empty() {
        return Err(AppError::Validation("Agrega al menos un producto".into()));
    }
    if input.items.len() > 300 {
        return Err(AppError::Validation("Máximo 300 líneas por orden".into()));
    }
    let expected = match input.expected_date.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => {
            chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                .map_err(|_| AppError::Validation("Fecha esperada inválida".into()))?;
            Some(s.to_string())
        }
        None => None,
    };
    let notes = input.notes.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    if notes.as_ref().map_or(false, |n| n.chars().count() > 500) {
        return Err(AppError::Validation("Las notas son demasiado largas (máx. 500)".into()));
    }

    let mut db = state.conn()?;
    let tx = db.transaction()?;
    let active: Option<i64> = tx
        .query_row("SELECT active FROM suppliers WHERE id = ?1", [input.supplier_id], |r| r.get(0))
        .optional()?;
    match active {
        None => return Err(AppError::Validation("El proveedor no existe".into())),
        Some(0) => return Err(AppError::Validation("El proveedor está inactivo".into())),
        Some(_) => {}
    }

    let mut lines: Vec<(i64, String, String, i64, i64, i64)> = Vec::new();
    let mut total = 0i64;
    for l in &input.items {
        if l.quantity <= 0 || l.quantity > 1_000_000 {
            return Err(AppError::Validation("Cantidad inválida".into()));
        }
        if l.unit_cost_minor < 0 {
            return Err(AppError::Validation("El costo no puede ser negativo".into()));
        }
        if lines.iter().any(|x| x.0 == l.product_id) {
            return Err(AppError::Validation("Hay un producto repetido en la orden".into()));
        }
        let (sku, name): (String, String) = tx
            .query_row(
                "SELECT sku, name FROM products WHERE id = ?1 AND active = 1",
                [l.product_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::Validation("Un producto no existe o está inactivo".into()))?;
        let line_total = l
            .quantity
            .checked_mul(l.unit_cost_minor)
            .ok_or_else(|| AppError::Validation("Monto demasiado grande".into()))?;
        total = total
            .checked_add(line_total)
            .ok_or_else(|| AppError::Validation("Monto demasiado grande".into()))?;
        lines.push((l.product_id, sku, name, l.quantity, l.unit_cost_minor, line_total));
    }

    tx.execute(
        "INSERT INTO purchase_orders (number, supplier_id, currency_code, expected_date, notes,
                                      total_minor, created_by)
         VALUES ('OC-' || printf('%06d', (SELECT COALESCE(MAX(id), 0) + 1 FROM purchase_orders)),
                 ?1, ?2, ?3, ?4, ?5, ?6)",
        params![input.supplier_id, input.currency_code, expected, notes, total, me.id],
    )?;
    let id = tx.last_insert_rowid();
    for (pid, sku, name, qty, cost, lt) in &lines {
        tx.execute(
            "INSERT INTO purchase_order_items (order_id, product_id, sku, description, quantity,
                                               unit_cost_minor, line_total_minor)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, pid, sku, name, qty, cost, lt],
        )?;
    }
    let number: String = tx.query_row("SELECT number FROM purchase_orders WHERE id = ?1", [id], |r| r.get(0))?;
    audit::log(&tx, Some(me.id), "purchase_order_created", Some("purchase_order"), Some(id), Some(&number))?;
    tx.commit()?;
    Ok(id)
}

#[tauri::command]
pub async fn po_list(
    state: State<'_, AppState>,
    status: Option<String>,
    search: Option<String>,
) -> Result<Vec<OrderRow>, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let status = status.filter(|s| ["open", "received", "cancelled"].contains(&s.as_str()));
    let search = search.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT o.id, o.number, s.name, o.currency_code, o.total_minor, o.status, o.expected_date,
                    o.status = 'open' AND o.expected_date IS NOT NULL
                      AND o.expected_date < date('now','localtime'),
                    o.created_at
             FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id
             WHERE (?1 IS NULL OR o.status = ?1)
               AND (?2 IS NULL OR o.number LIKE '%' || ?2 || '%' OR s.name LIKE '%' || ?2 || '%')
             ORDER BY o.id DESC LIMIT 300",
        )?
        .query_map(params![status, search], |r| {
            Ok(OrderRow {
                id: r.get(0)?,
                number: r.get(1)?,
                supplier_name: r.get(2)?,
                currency_code: r.get(3)?,
                total_minor: r.get(4)?,
                status: r.get(5)?,
                expected_date: r.get(6)?,
                overdue: r.get::<_, i64>(7)? != 0,
                created_at: r.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn items_of(conn: &rusqlite::Connection, id: i64) -> Result<Vec<OrderItemOut>, AppError> {
    Ok(conn
        .prepare(
            "SELECT product_id, sku, description, quantity, unit_cost_minor, line_total_minor
             FROM purchase_order_items WHERE order_id = ?1 ORDER BY id",
        )?
        .query_map([id], |r| {
            Ok(OrderItemOut {
                product_id: r.get(0)?,
                sku: r.get(1)?,
                description: r.get(2)?,
                quantity: r.get(3)?,
                unit_cost_minor: r.get(4)?,
                line_total_minor: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?)
}

#[tauri::command]
pub async fn po_get(state: State<'_, AppState>, id: i64) -> Result<OrderDetail, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let db = state.conn()?;
    let mut d = db
        .query_row(
            "SELECT o.id, o.number, s.name, s.id_type || '-' || s.id_number, s.phone, s.address,
                    o.currency_code, o.expected_date, o.notes, o.total_minor, o.status,
                    o.created_at, u.full_name
             FROM purchase_orders o
             JOIN suppliers s ON s.id = o.supplier_id
             LEFT JOIN users u ON u.id = o.created_by
             WHERE o.id = ?1",
            [id],
            |r| {
                Ok(OrderDetail {
                    id: r.get(0)?,
                    number: r.get(1)?,
                    supplier_name: r.get(2)?,
                    supplier_doc: r.get(3)?,
                    supplier_phone: r.get(4)?,
                    supplier_address: r.get(5)?,
                    currency_code: r.get(6)?,
                    expected_date: r.get(7)?,
                    notes: r.get(8)?,
                    total_minor: r.get(9)?,
                    status: r.get(10)?,
                    created_at: r.get(11)?,
                    created_by_name: r.get(12)?,
                    issuer_name: String::new(),
                    issuer_rif: String::new(),
                    issuer_address: String::new(),
                    items: Vec::new(),
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("La orden no existe".into()))?;
    let (rif, name, addr): (String, String, String) = db.query_row(
        "SELECT rif, legal_name, fiscal_address FROM company WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    d.issuer_rif = rif;
    d.issuer_name = name;
    d.issuer_address = addr;
    d.items = items_of(&db, id)?;
    Ok(d)
}

#[tauri::command]
pub async fn po_cancel(state: State<'_, AppState>, id: i64) -> Result<(), AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    let db = state.conn()?;
    let n = db.execute(
        "UPDATE purchase_orders SET status = 'cancelled', closed_at = datetime('now')
         WHERE id = ?1 AND status = 'open'",
        [id],
    )?;
    if n == 0 {
        return Err(AppError::Validation("Solo se pueden anular órdenes abiertas".into()));
    }
    audit::log(&db, Some(me.id), "purchase_order_cancelled", Some("purchase_order"), Some(id), None)?;
    Ok(())
}

/// Datos para pre-llenar «Nueva compra» al recibir la mercadería.
#[tauri::command]
pub async fn po_to_purchase(state: State<'_, AppState>, id: i64) -> Result<ReceivePrefill, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let db = state.conn()?;
    let (number, status, currency, sid): (String, String, String, i64) = db
        .query_row(
            "SELECT number, status, currency_code, supplier_id FROM purchase_orders WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("La orden no existe".into()))?;
    if status != "open" {
        return Err(AppError::Validation("La orden ya no está abierta".into()));
    }
    let supplier = db.query_row(
        "SELECT id, id_type, id_number, name, phone, address, active, iva_retention_bp
         FROM suppliers WHERE id = ?1",
        [sid],
        |r| {
            Ok(SupplierOut {
                id: r.get(0)?,
                id_type: r.get(1)?,
                id_number: r.get(2)?,
                name: r.get(3)?,
                phone: r.get(4)?,
                address: r.get(5)?,
                active: r.get::<_, i64>(6)? != 0,
                iva_retention_bp: r.get(7)?,
            })
        },
    )?;
    let items = items_of(&db, id)?;
    Ok(ReceivePrefill { id, number, supplier, currency_code: currency, items })
}

/// Se llama después de registrar la compra hecha a partir de la orden.
#[tauri::command]
pub async fn po_mark_received(
    state: State<'_, AppState>,
    id: i64,
    purchase_id: i64,
) -> Result<(), AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    let db = state.conn()?;
    let ok: i64 = db.query_row("SELECT COUNT(*) FROM purchases WHERE id = ?1", [purchase_id], |r| r.get(0))?;
    if ok == 0 {
        return Err(AppError::Validation("La compra no existe".into()));
    }
    let n = db.execute(
        "UPDATE purchase_orders SET status = 'received', purchase_id = ?2, closed_at = datetime('now')
         WHERE id = ?1 AND status = 'open'",
        params![id, purchase_id],
    )?;
    if n > 0 {
        let detail = format!("compra {purchase_id}");
        audit::log(&db, Some(me.id), "purchase_order_received", Some("purchase_order"), Some(id), Some(&detail))?;
    }
    Ok(())
}
