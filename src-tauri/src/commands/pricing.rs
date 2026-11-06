//! Listas de precios y promociones.
//! Precio de una línea = precio de la lista (o el base) -> luego la promoción vigente y el
//! descuento manual se combinan en un solo descuento. `sales::compute` es quien las aplica.

use crate::{
    audit,
    error::AppError,
    security,
    state::{AppState, SessionUser},
};
use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

fn round_div(n: i128, d: i128) -> i64 {
    if n >= 0 {
        ((n + d / 2) / d) as i64
    } else {
        -(((-n) + d / 2) / d) as i64
    }
}

// ---------- Funciones que usa el cálculo de ventas ----------

/// Valida que la lista exista, esté activa y que el usuario pueda usarla.
pub(crate) fn resolve_list(
    conn: &Connection,
    me: &SessionUser,
    list_id: Option<i64>,
) -> Result<Option<i64>, AppError> {
    let id = match list_id {
        Some(i) => i,
        None => return Ok(None),
    };
    let row: Option<(i64, i64)> = conn
        .query_row(
            "SELECT active, cashier_can_use FROM price_lists WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match row {
        None => Err(AppError::Validation("La lista de precios no existe".into())),
        Some((active, _)) if active == 0 => {
            Err(AppError::Validation("La lista de precios está inactiva".into()))
        }
        Some((_, can)) if can == 0 && me.role != "admin" => {
            Err(AppError::Validation("No tienes permiso para usar esa lista de precios".into()))
        }
        Some(_) => Ok(Some(id)),
    }
}

/// Precio unitario (monto, moneda) según la lista; sin lista devuelve el base.
pub(crate) fn list_price(
    conn: &Connection,
    product_id: i64,
    base: i64,
    base_currency: String,
    list_id: Option<i64>,
) -> Result<(i64, String), AppError> {
    let lid = match list_id {
        Some(l) => l,
        None => return Ok((base, base_currency)),
    };
    let over: Option<(i64, String)> = conn
        .query_row(
            "SELECT price_minor, currency_code FROM price_list_items
             WHERE price_list_id = ?1 AND product_id = ?2",
            params![lid, product_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some(o) = over {
        return Ok(o);
    }
    let adjust: i64 = conn.query_row("SELECT adjust_bp FROM price_lists WHERE id = ?1", [lid], |r| r.get(0))?;
    let price = (base + round_div(base as i128 * adjust as i128, 10_000)).max(0);
    Ok((price, base_currency))
}

/// Mayor promoción vigente hoy para el producto (no se acumulan entre sí).
pub(crate) fn promo_bp(conn: &Connection, product_id: i64) -> Result<i64, AppError> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(percent_bp), 0) FROM promotions
         WHERE active = 1
           AND starts_on <= date('now','localtime') AND ends_on >= date('now','localtime')
           AND (scope = 'all'
                OR (scope = 'product' AND product_id = ?1)
                OR (scope = 'category' AND category_id = (SELECT category_id FROM products WHERE id = ?1)))",
        [product_id],
        |r| r.get(0),
    )?)
}

/// Combina promoción y descuento manual: 1 - (1-promo)(1-manual).
pub(crate) fn combine_bp(promo: i64, manual: i64) -> i64 {
    if promo <= 0 {
        return manual;
    }
    10_000 - round_div((10_000 - promo) as i128 * (10_000 - manual) as i128, 10_000)
}

// ---------- Listas de precios ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListOption {
    id: i64,
    name: String,
    adjust_bp: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRow {
    id: i64,
    name: String,
    adjust_bp: i64,
    cashier_can_use: bool,
    active: bool,
    items: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListInput {
    id: Option<i64>,
    name: String,
    adjust_bp: i64,
    cashier_can_use: bool,
    active: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListItemRow {
    product_id: i64,
    sku: String,
    name: String,
    price_minor: i64,
    currency_code: String,
    base_minor: i64,
    base_currency: String,
}

/// Listas que el usuario actual puede elegir en «Nueva venta».
#[tauri::command]
pub async fn price_list_options(state: State<'_, AppState>) -> Result<Vec<ListOption>, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;
    let all = me.role == "admin";
    let rows = db
        .prepare(
            "SELECT id, name, adjust_bp FROM price_lists
             WHERE active = 1 AND (?1 = 1 OR cashier_can_use = 1) ORDER BY name",
        )?
        .query_map([all as i64], |r| {
            Ok(ListOption { id: r.get(0)?, name: r.get(1)?, adjust_bp: r.get(2)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub async fn price_lists_admin(state: State<'_, AppState>) -> Result<Vec<ListRow>, AppError> {
    security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT l.id, l.name, l.adjust_bp, l.cashier_can_use, l.active,
                    (SELECT COUNT(*) FROM price_list_items i WHERE i.price_list_id = l.id)
             FROM price_lists l ORDER BY l.name",
        )?
        .query_map([], |r| {
            Ok(ListRow {
                id: r.get(0)?,
                name: r.get(1)?,
                adjust_bp: r.get(2)?,
                cashier_can_use: r.get::<_, i64>(3)? != 0,
                active: r.get::<_, i64>(4)? != 0,
                items: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub async fn save_price_list(state: State<'_, AppState>, input: ListInput) -> Result<i64, AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let name = input.name.split_whitespace().collect::<Vec<_>>().join(" ");
    if !(2..=40).contains(&name.chars().count()) {
        return Err(AppError::Validation("El nombre debe tener entre 2 y 40 caracteres".into()));
    }
    if !(-9000..=10000).contains(&input.adjust_bp) {
        return Err(AppError::Validation("El ajuste debe estar entre -90 % y +100 %".into()));
    }
    let db = state.conn()?;
    let dup: i64 = db.query_row(
        "SELECT COUNT(*) FROM price_lists WHERE name = ?1 AND id <> ?2",
        params![name, input.id.unwrap_or(0)],
        |r| r.get(0),
    )?;
    if dup > 0 {
        return Err(AppError::Validation("Ya existe una lista con ese nombre".into()));
    }
    let id = match input.id {
        Some(id) => {
            let n = db.execute(
                "UPDATE price_lists SET name = ?1, adjust_bp = ?2, cashier_can_use = ?3, active = ?4
                 WHERE id = ?5",
                params![name, input.adjust_bp, input.cashier_can_use as i64, input.active as i64, id],
            )?;
            if n == 0 {
                return Err(AppError::Validation("La lista no existe".into()));
            }
            id
        }
        None => {
            db.execute(
                "INSERT INTO price_lists (name, adjust_bp, cashier_can_use, active)
                 VALUES (?1, ?2, ?3, ?4)",
                params![name, input.adjust_bp, input.cashier_can_use as i64, input.active as i64],
            )?;
            db.last_insert_rowid()
        }
    };
    let detail = format!("{name} ({:+} bp)", input.adjust_bp);
    audit::log(&db, Some(me.id), "price_list_saved", Some("price_list"), Some(id), Some(&detail))?;
    Ok(id)
}

#[tauri::command]
pub async fn price_list_items(
    state: State<'_, AppState>,
    list_id: i64,
) -> Result<Vec<ListItemRow>, AppError> {
    security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT p.id, p.sku, p.name, i.price_minor, i.currency_code, p.price_minor, p.price_currency
             FROM price_list_items i JOIN products p ON p.id = i.product_id
             WHERE i.price_list_id = ?1 ORDER BY p.name",
        )?
        .query_map([list_id], |r| {
            Ok(ListItemRow {
                product_id: r.get(0)?,
                sku: r.get(1)?,
                name: r.get(2)?,
                price_minor: r.get(3)?,
                currency_code: r.get(4)?,
                base_minor: r.get(5)?,
                base_currency: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub async fn set_price_list_item(
    state: State<'_, AppState>,
    list_id: i64,
    product_id: i64,
    price_minor: i64,
    currency_code: String,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    if price_minor < 0 {
        return Err(AppError::Validation("El precio no puede ser negativo".into()));
    }
    if !["VES", "USD"].contains(&currency_code.as_str()) {
        return Err(AppError::Validation("Moneda inválida".into()));
    }
    let db = state.conn()?;
    let ok: i64 = db.query_row(
        "SELECT (SELECT COUNT(*) FROM price_lists WHERE id = ?1) * (SELECT COUNT(*) FROM products WHERE id = ?2)",
        params![list_id, product_id],
        |r| r.get(0),
    )?;
    if ok == 0 {
        return Err(AppError::Validation("La lista o el producto no existe".into()));
    }
    db.execute(
        "INSERT INTO price_list_items (price_list_id, product_id, price_minor, currency_code)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(price_list_id, product_id)
         DO UPDATE SET price_minor = excluded.price_minor, currency_code = excluded.currency_code",
        params![list_id, product_id, price_minor, currency_code],
    )?;
    let detail = format!("lista {list_id}, producto {product_id}: {price_minor} {currency_code}");
    audit::log(&db, Some(me.id), "price_list_item_set", Some("price_list"), Some(list_id), Some(&detail))?;
    Ok(())
}

#[tauri::command]
pub async fn remove_price_list_item(
    state: State<'_, AppState>,
    list_id: i64,
    product_id: i64,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    db.execute(
        "DELETE FROM price_list_items WHERE price_list_id = ?1 AND product_id = ?2",
        params![list_id, product_id],
    )?;
    let detail = format!("lista {list_id}, producto {product_id}");
    audit::log(&db, Some(me.id), "price_list_item_removed", Some("price_list"), Some(list_id), Some(&detail))?;
    Ok(())
}

// ---------- Promociones ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoRow {
    id: i64,
    name: String,
    scope: String,
    target: String,
    percent_bp: i64,
    starts_on: String,
    ends_on: String,
    active: bool,
    state: String, // vigente | programada | vencida | inactiva
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoInput {
    name: String,
    scope: String,
    product_id: Option<i64>,
    category_id: Option<i64>,
    percent_bp: i64,
    starts_on: String,
    ends_on: String,
}

#[tauri::command]
pub async fn promotions_list(state: State<'_, AppState>) -> Result<Vec<PromoRow>, AppError> {
    security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT pr.id, pr.name, pr.scope,
                    CASE pr.scope WHEN 'all' THEN 'Todo el catálogo'
                                  WHEN 'category' THEN 'Categoría: ' || COALESCE(c.name, '?')
                                  ELSE COALESCE(p.sku || ' · ' || p.name, '?') END,
                    pr.percent_bp, pr.starts_on, pr.ends_on, pr.active,
                    CASE WHEN pr.active = 0 THEN 'inactiva'
                         WHEN pr.ends_on < date('now','localtime') THEN 'vencida'
                         WHEN pr.starts_on > date('now','localtime') THEN 'programada'
                         ELSE 'vigente' END
             FROM promotions pr
             LEFT JOIN products p ON p.id = pr.product_id
             LEFT JOIN categories c ON c.id = pr.category_id
             ORDER BY pr.id DESC LIMIT 300",
        )?
        .query_map([], |r| {
            Ok(PromoRow {
                id: r.get(0)?,
                name: r.get(1)?,
                scope: r.get(2)?,
                target: r.get(3)?,
                percent_bp: r.get(4)?,
                starts_on: r.get(5)?,
                ends_on: r.get(6)?,
                active: r.get::<_, i64>(7)? != 0,
                state: r.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub async fn save_promotion(state: State<'_, AppState>, input: PromoInput) -> Result<i64, AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let name = input.name.split_whitespace().collect::<Vec<_>>().join(" ");
    if !(2..=60).contains(&name.chars().count()) {
        return Err(AppError::Validation("El nombre debe tener entre 2 y 60 caracteres".into()));
    }
    if !(1..=9000).contains(&input.percent_bp) {
        return Err(AppError::Validation("El descuento debe estar entre 0,01 % y 90 %".into()));
    }
    let parse = |s: &str| {
        NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
            .map_err(|_| AppError::Validation("Fecha inválida".into()))
    };
    let (from, to) = (parse(&input.starts_on)?, parse(&input.ends_on)?);
    if to < from {
        return Err(AppError::Validation("La fecha final es anterior a la inicial".into()));
    }
    let db = state.conn()?;
    let (product_id, category_id) = match input.scope.as_str() {
        "all" => (None, None),
        "product" => {
            let p = input
                .product_id
                .ok_or_else(|| AppError::Validation("Elige el producto".into()))?;
            let ok: i64 = db.query_row("SELECT COUNT(*) FROM products WHERE id = ?1", [p], |r| r.get(0))?;
            if ok == 0 {
                return Err(AppError::Validation("El producto no existe".into()));
            }
            (Some(p), None)
        }
        "category" => {
            let c = input
                .category_id
                .ok_or_else(|| AppError::Validation("Elige la categoría".into()))?;
            let ok: i64 = db.query_row("SELECT COUNT(*) FROM categories WHERE id = ?1", [c], |r| r.get(0))?;
            if ok == 0 {
                return Err(AppError::Validation("La categoría no existe".into()));
            }
            (None, Some(c))
        }
        _ => return Err(AppError::Validation("Alcance inválido".into())),
    };
    db.execute(
        "INSERT INTO promotions (name, scope, product_id, category_id, percent_bp, starts_on, ends_on, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            name,
            input.scope,
            product_id,
            category_id,
            input.percent_bp,
            from.format("%Y-%m-%d").to_string(),
            to.format("%Y-%m-%d").to_string(),
            me.id
        ],
    )?;
    let id = db.last_insert_rowid();
    let detail = format!("{name}: {} bp, {} a {}", input.percent_bp, input.starts_on, input.ends_on);
    audit::log(&db, Some(me.id), "promotion_created", Some("promotion"), Some(id), Some(&detail))?;
    Ok(id)
}

#[tauri::command]
pub async fn set_promotion_active(
    state: State<'_, AppState>,
    id: i64,
    active: bool,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    let n = db.execute("UPDATE promotions SET active = ?1 WHERE id = ?2", params![active as i64, id])?;
    if n == 0 {
        return Err(AppError::Validation("La promoción no existe".into()));
    }
    let action = if active { "promotion_activated" } else { "promotion_deactivated" };
    audit::log(&db, Some(me.id), action, Some("promotion"), Some(id), None)?;
    Ok(())
}
