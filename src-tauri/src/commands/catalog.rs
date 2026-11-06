use crate::{audit, error::AppError, security, state::AppState};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    id: i64,
    sku: String,
    barcode: Option<String>,
    name: String,
    category_id: Option<i64>,
    category_name: Option<String>,
    tax_rate_id: i64,
    tax_code: String,
    cost_minor: i64,
    price_minor: i64,
    price_currency: String,
    track_stock: bool,
    min_stock: i64,
    active: bool,
    stock: i64,       // total en todos los almacenes
    sales_stock: i64, // lo que hay en el almacén de ventas
    uses_lots: bool,
}

#[derive(Serialize)]
pub struct Category {
    id: i64,
    name: String,
}

#[derive(Serialize)]
pub struct CategoryResult {
    id: i64,
    name: String,
    existed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryRow {
    id: i64,
    name: String,
    products: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxRate {
    id: i64,
    code: String,
    name: String,
    rate_bp: i64,
}

#[derive(Serialize)]
pub struct Currency {
    code: String,
    symbol: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogOptions {
    categories: Vec<Category>,
    tax_rates: Vec<TaxRate>,
    currencies: Vec<Currency>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductInput {
    sku: String,
    barcode: Option<String>,
    name: String,
    category_id: Option<i64>,
    tax_rate_id: i64,
    cost_minor: i64,
    price_minor: i64,
    price_currency: String,
    track_stock: bool,
    min_stock: i64,
    initial_stock: Option<i64>,
    warehouse_id: Option<i64>,
}

const PRODUCT_SELECT: &str = "
  SELECT p.id, p.sku, p.barcode, p.name, p.category_id, c.name,
         p.tax_rate_id, t.code, p.cost_minor, p.price_minor, p.price_currency,
         p.track_stock, p.min_stock, p.active,
         COALESCE((SELECT SUM(m.quantity) FROM stock_movements m WHERE m.product_id = p.id), 0),
         COALESCE((SELECT SUM(m.quantity) FROM stock_movements m
                   WHERE m.product_id = p.id
                     AND m.warehouse_id = (SELECT id FROM warehouses WHERE is_sales = 1)), 0),
         p.uses_lots
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  JOIN tax_rates t ON t.id = p.tax_rate_id";

fn map_product(r: &Row) -> rusqlite::Result<Product> {
    Ok(Product {
        id: r.get(0)?,
        sku: r.get(1)?,
        barcode: r.get(2)?,
        name: r.get(3)?,
        category_id: r.get(4)?,
        category_name: r.get(5)?,
        tax_rate_id: r.get(6)?,
        tax_code: r.get(7)?,
        cost_minor: r.get(8)?,
        price_minor: r.get(9)?,
        price_currency: r.get(10)?,
        track_stock: r.get::<_, i64>(11)? != 0,
        min_stock: r.get(12)?,
        active: r.get::<_, i64>(13)? != 0,
        stock: r.get(14)?,
        sales_stock: r.get(15)?,
        uses_lots: r.get::<_, i64>(16)? != 0,
    })
}

fn fetch_product(conn: &Connection, id: i64) -> Result<Product, AppError> {
    let sql = format!("{PRODUCT_SELECT} WHERE p.id = ?1");
    Ok(conn.query_row(&sql, [id], map_product)?)
}

fn map_unique(e: rusqlite::Error) -> AppError {
    match &e {
        rusqlite::Error::SqliteFailure(f, _)
            if f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
        {
            AppError::Validation("Ya existe un producto con ese SKU o código de barras".into())
        }
        _ => AppError::Db(e),
    }
}

fn clean(input: &mut ProductInput) -> Result<(), AppError> {
    input.sku = input.sku.trim().to_uppercase();
    input.name = input.name.trim().to_string();
    input.barcode = input
        .barcode
        .take()
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty());
    if input.sku.is_empty() || input.name.is_empty() {
        return Err(AppError::Validation("SKU y nombre son obligatorios".into()));
    }
    if input.cost_minor < 0 || input.price_minor < 0 || input.min_stock < 0 {
        return Err(AppError::Validation("Costo, precio y stock mínimo no pueden ser negativos".into()));
    }
    if input.initial_stock.unwrap_or(0) < 0 {
        return Err(AppError::Validation("El stock inicial no puede ser negativo".into()));
    }
    if !["VES", "USD"].contains(&input.price_currency.as_str()) {
        return Err(AppError::Validation("Moneda inválida".into()));
    }
    Ok(())
}

// ---------- Opciones del catálogo ----------
#[tauri::command]
pub async fn catalog_options(state: State<'_, AppState>) -> Result<CatalogOptions, AppError> {
    security::require_role(&state, security::ALL_ROLES)?;
    let db = state.conn()?;

    let categories = db
        .prepare("SELECT id, name FROM categories ORDER BY name")?
        .query_map([], |r| Ok(Category { id: r.get(0)?, name: r.get(1)? }))?
        .collect::<Result<Vec<_>, _>>()?;
    let tax_rates = db
        .prepare("SELECT id, code, name, rate_bp FROM tax_rates WHERE active = 1 ORDER BY rate_bp DESC")?
        .query_map([], |r| {
            Ok(TaxRate { id: r.get(0)?, code: r.get(1)?, name: r.get(2)?, rate_bp: r.get(3)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let currencies = db
        .prepare("SELECT code, symbol FROM currencies ORDER BY is_base DESC")?
        .query_map([], |r| Ok(Currency { code: r.get(0)?, symbol: r.get(1)? }))?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(CatalogOptions { categories, tax_rates, currencies })
}

// ---------- Categorías ----------
fn clean_category(raw: &str) -> Result<String, AppError> {
    let n = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if !(2..=40).contains(&n.chars().count()) {
        return Err(AppError::Validation(
            "El nombre de la categoría debe tener entre 2 y 40 caracteres".into(),
        ));
    }
    Ok(n)
}

/// Busca una categoría con ese nombre sin distinguir mayúsculas (ignorando `except_id`).
fn find_category(conn: &Connection, name: &str, except_id: i64) -> Result<Option<(i64, String)>, AppError> {
    Ok(conn
        .query_row(
            "SELECT id, name FROM categories WHERE lower(name) = lower(?1) AND id <> ?2",
            params![name, except_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

/// Crea la categoría o, si ya existe, devuelve la existente (así el formulario del producto no falla).
#[tauri::command]
pub async fn create_category(state: State<'_, AppState>, name: String) -> Result<CategoryResult, AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    let name = clean_category(&name)?;
    let db = state.conn()?;
    if let Some((id, existing)) = find_category(&db, &name, 0)? {
        return Ok(CategoryResult { id, name: existing, existed: true });
    }
    db.execute("INSERT INTO categories (name) VALUES (?1)", [&name])?;
    let id = db.last_insert_rowid();
    audit::log(&db, Some(me.id), "category_created", Some("category"), Some(id), Some(&name))?;
    Ok(CategoryResult { id, name, existed: false })
}

#[tauri::command]
pub async fn categories_overview(state: State<'_, AppState>) -> Result<Vec<CategoryRow>, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT c.id, c.name, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id)
             FROM categories c ORDER BY c.name",
        )?
        .query_map([], |r| Ok(CategoryRow { id: r.get(0)?, name: r.get(1)?, products: r.get(2)? }))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub async fn rename_category(state: State<'_, AppState>, id: i64, name: String) -> Result<(), AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    let name = clean_category(&name)?;
    let db = state.conn()?;
    let old: String = db
        .query_row("SELECT name FROM categories WHERE id = ?1", [id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| AppError::Validation("La categoría no existe".into()))?;
    if find_category(&db, &name, id)?.is_some() {
        return Err(AppError::Validation("Ya existe otra categoría con ese nombre".into()));
    }
    db.execute("UPDATE categories SET name = ?1 WHERE id = ?2", params![name, id])?;
    let detail = format!("{old} -> {name}");
    audit::log(&db, Some(me.id), "category_renamed", Some("category"), Some(id), Some(&detail))?;
    Ok(())
}

#[tauri::command]
pub async fn delete_category(state: State<'_, AppState>, id: i64) -> Result<(), AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    let db = state.conn()?;
    let name: String = db
        .query_row("SELECT name FROM categories WHERE id = ?1", [id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| AppError::Validation("La categoría no existe".into()))?;
    let n: i64 = db.query_row("SELECT COUNT(*) FROM products WHERE category_id = ?1", [id], |r| r.get(0))?;
    if n > 0 {
        return Err(AppError::Validation(format!(
            "Tiene {n} producto(s). Muévelos a otra categoría antes de eliminarla"
        )));
    }
    db.execute("DELETE FROM categories WHERE id = ?1", [id])?;
    audit::log(&db, Some(me.id), "category_deleted", Some("category"), Some(id), Some(&name))?;
    Ok(())
}

// ---------- Productos ----------
#[tauri::command]
pub async fn list_products(
    state: State<'_, AppState>,
    search: Option<String>,
    include_inactive: bool,
    low_stock_only: bool,
    category_id: Option<i64>,
) -> Result<Vec<Product>, AppError> {
    security::require_role(&state, security::ALL_ROLES)?;
    let search = search.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let db = state.conn()?;
    let sql = format!(
        "{PRODUCT_SELECT}
         WHERE (?1 IS NULL OR p.name LIKE '%' || ?1 || '%'
                OR p.sku LIKE '%' || ?1 || '%' OR p.barcode = ?1)
           AND (?2 = 1 OR p.active = 1)
           AND (?3 IS NULL OR p.category_id = ?3)
         ORDER BY p.name LIMIT 500"
    );
    let mut stmt = db.prepare(&sql)?;
    let rows = stmt.query_map(params![search, include_inactive as i64, category_id], map_product)?;
    let mut out = Vec::new();
    for r in rows {
        let p = r?;
        if !low_stock_only || (p.track_stock && p.stock <= p.min_stock) {
            out.push(p);
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn create_product(
    state: State<'_, AppState>,
    mut input: ProductInput,
) -> Result<Product, AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    clean(&mut input)?;

    let mut db = state.conn()?;
    let tx = db.transaction()?;
    tx.execute(
        "INSERT INTO products (sku, barcode, name, category_id, tax_rate_id, cost_minor,
                               price_minor, price_currency, track_stock, min_stock)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            input.sku, input.barcode, input.name, input.category_id, input.tax_rate_id,
            input.cost_minor, input.price_minor, input.price_currency,
            input.track_stock as i64, input.min_stock
        ],
    )
    .map_err(map_unique)?;
    let id = tx.last_insert_rowid();

    let initial = input.initial_stock.unwrap_or(0);
    if input.track_stock && initial > 0 {
        // Almacén elegido o, si no se indicó, el de ventas
        let wh = match input.warehouse_id {
            Some(w) => {
                let ok: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM warehouses WHERE id = ?1 AND active = 1",
                    [w],
                    |r| r.get(0),
                )?;
                if ok == 0 {
                    return Err(AppError::Validation("El almacén no existe o está inactivo".into()));
                }
                w
            }
            None => crate::commands::warehouses::sales_warehouse_id(&tx)?,
        };
        tx.execute(
            "INSERT INTO stock_movements (product_id, quantity, reason, note, user_id, warehouse_id)
             VALUES (?1, ?2, 'stock_inicial', 'Existencia inicial', ?3, ?4)",
            params![id, initial, me.id, wh],
        )?;
    }
    audit::log(&tx, Some(me.id), "product_created", Some("product"), Some(id), Some(&input.sku))?;
    tx.commit()?;
    fetch_product(&db, id)
}

#[tauri::command]
pub async fn update_product(
    state: State<'_, AppState>,
    id: i64,
    mut input: ProductInput,
) -> Result<Product, AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    clean(&mut input)?;

    let db = state.conn()?;
    let old = fetch_product(&db, id).map_err(|_| AppError::Validation("El producto no existe".into()))?;

    db.execute(
        "UPDATE products SET sku=?1, barcode=?2, name=?3, category_id=?4, tax_rate_id=?5,
                cost_minor=?6, price_minor=?7, price_currency=?8, track_stock=?9, min_stock=?10
         WHERE id=?11",
        params![
            input.sku, input.barcode, input.name, input.category_id, input.tax_rate_id,
            input.cost_minor, input.price_minor, input.price_currency,
            input.track_stock as i64, input.min_stock, id
        ],
    )
    .map_err(map_unique)?;

    let detail = format!(
        "precio {}->{} {}, costo {}->{}",
        old.price_minor, input.price_minor, input.price_currency, old.cost_minor, input.cost_minor
    );
    audit::log(&db, Some(me.id), "product_updated", Some("product"), Some(id), Some(&detail))?;
    fetch_product(&db, id)
}

#[tauri::command]
pub async fn set_product_active(
    state: State<'_, AppState>,
    id: i64,
    active: bool,
) -> Result<(), AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    let db = state.conn()?;
    let n = db.execute("UPDATE products SET active = ?1 WHERE id = ?2", params![active as i64, id])?;
    if n == 0 {
        return Err(AppError::Validation("El producto no existe".into()));
    }
    let action = if active { "product_activated" } else { "product_deactivated" };
    audit::log(&db, Some(me.id), action, Some("product"), Some(id), None)?;
    Ok(())
}