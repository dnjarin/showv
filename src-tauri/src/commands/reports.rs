use crate::{error::AppError, security, state::AppState};
use chrono::NaiveDate;
use rusqlite::params;
use serde::Serialize;
use std::collections::BTreeMap;
use tauri::{AppHandle, Manager, State};

fn range(from: &str, to: &str) -> Result<(String, String), AppError> {
    let parse = |s: &str| {
        NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
            .map_err(|_| AppError::Validation("Fecha inválida".into()))
    };
    let (f, t) = (parse(from)?, parse(to)?);
    if t < f {
        return Err(AppError::Validation("La fecha final es anterior a la inicial".into()));
    }
    if (t - f).num_days() > 366 {
        return Err(AppError::Validation("El rango máximo es de un año".into()));
    }
    Ok((f.format("%Y-%m-%d").to_string(), t.format("%Y-%m-%d").to_string()))
}

// ---------- Ventas ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyTotals {
    currency_code: String,
    docs: i64,
    base_minor: i64,
    tax_minor: i64,
    igtf_minor: i64,
    total_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayTotal {
    day: String,
    docs: i64,
    total_ves_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodCollected {
    method: String,
    currency_code: String,
    collected_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Waiver {
    series: String,
    number: i64,
    issued_at: String,
    cashier: Option<String>,
    tax_waived: bool,
    igtf_waived: bool,
    reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesReport {
    docs: i64,
    voided: i64,
    total_ves_minor: i64,
    by_currency: Vec<CurrencyTotals>,
    by_day: Vec<DayTotal>,
    by_method: Vec<MethodCollected>,
    waivers: Vec<Waiver>,
    returns_count: i64,
    returns_ves_minor: i64,
}

#[tauri::command]
pub async fn sales_report(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<SalesReport, AppError> {
    security::require_role(&state, &["admin"])?;
    let (f, t) = range(&from, &to)?;
    let db = state.conn()?;

    let by_currency = db
        .prepare(
            "SELECT currency_code, COUNT(*), SUM(subtotal_minor + exempt_minor),
                    SUM(tax_minor), SUM(igtf_minor), SUM(total_minor)
             FROM documents
             WHERE status = 'issued' AND doc_type = 'COMPROBANTE'
               AND date(issued_at, 'localtime') BETWEEN ?1 AND ?2
             GROUP BY currency_code ORDER BY currency_code",
        )?
        .query_map(params![f, t], |r| {
            Ok(CurrencyTotals {
                currency_code: r.get(0)?, docs: r.get(1)?, base_minor: r.get(2)?,
                tax_minor: r.get(3)?, igtf_minor: r.get(4)?, total_minor: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let by_day = db
        .prepare(
            "SELECT date(issued_at, 'localtime') AS d, COUNT(*), SUM(total_ves_minor)
             FROM documents
             WHERE status = 'issued' AND doc_type = 'COMPROBANTE'
               AND date(issued_at, 'localtime') BETWEEN ?1 AND ?2
             GROUP BY d ORDER BY d",
        )?
        .query_map(params![f, t], |r| {
            Ok(DayTotal { day: r.get(0)?, docs: r.get(1)?, total_ves_minor: r.get(2)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let by_method = db
        .prepare(
            "SELECT p.method, p.currency_code, SUM(p.amount_minor + p.igtf_minor)
             FROM payments p JOIN documents d ON d.id = p.document_id
             WHERE d.status = 'issued' AND d.doc_type = 'COMPROBANTE'
               AND date(d.issued_at, 'localtime') BETWEEN ?1 AND ?2
             GROUP BY p.method, p.currency_code ORDER BY p.currency_code, p.method",
        )?
        .query_map(params![f, t], |r| {
            Ok(MethodCollected { method: r.get(0)?, currency_code: r.get(1)?, collected_minor: r.get(2)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let waivers = db
        .prepare(
            "SELECT d.series, d.number, d.issued_at, u.username,
                    d.tax_waived, d.igtf_waived, d.waiver_reason
             FROM documents d LEFT JOIN users u ON u.id = d.cashier_id
             WHERE d.status = 'issued' AND d.doc_type = 'COMPROBANTE' AND (d.tax_waived = 1 OR d.igtf_waived = 1)
               AND date(d.issued_at, 'localtime') BETWEEN ?1 AND ?2
             ORDER BY d.id DESC LIMIT 200",
        )?
        .query_map(params![f, t], |r| {
            Ok(Waiver {
                series: r.get(0)?, number: r.get(1)?, issued_at: r.get(2)?, cashier: r.get(3)?,
                tax_waived: r.get::<_, i64>(4)? != 0, igtf_waived: r.get::<_, i64>(5)? != 0,
                reason: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let voided: i64 = db.query_row(
        "SELECT COUNT(*) FROM documents
         WHERE status = 'voided' AND date(issued_at, 'localtime') BETWEEN ?1 AND ?2",
        params![f, t],
        |r| r.get(0),
    )?;

    let (returns_count, returns_ves_minor): (i64, i64) = db.query_row(
        "SELECT COUNT(*), COALESCE(SUM(total_ves_minor), 0) FROM documents
         WHERE doc_type = 'DEVOLUCION' AND status = 'issued'
           AND date(issued_at, 'localtime') BETWEEN ?1 AND ?2",
        params![f, t],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;

    Ok(SalesReport {
        docs: by_day.iter().map(|d| d.docs).sum(),
        voided,
        total_ves_minor: by_day.iter().map(|d| d.total_ves_minor).sum(),
        by_currency,
        by_day,
        by_method,
        waivers,
        returns_count,
        returns_ves_minor,
    })
}

// ---------- Más vendidos ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopProduct {
    sku: Option<String>,
    description: String,
    quantity: i64,
    usd_minor: i64,
    ves_minor: i64,
}

#[tauri::command]
pub async fn top_products(
    state: State<'_, AppState>,
    from: String,
    to: String,
    limit: Option<i64>,
) -> Result<Vec<TopProduct>, AppError> {
    security::require_role(&state, &["admin"])?;
    let (f, t) = range(&from, &to)?;
    let limit = limit.unwrap_or(20).clamp(1, 100);
    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT MAX(p.sku), MAX(di.description),
                    SUM(CASE WHEN d.doc_type = 'DEVOLUCION' THEN -di.quantity ELSE di.quantity END),
                    SUM(CASE WHEN d.currency_code = 'USD'
                        THEN (CASE WHEN d.doc_type = 'DEVOLUCION' THEN -di.line_total_minor ELSE di.line_total_minor END)
                        ELSE 0 END),
                    SUM(CASE WHEN d.currency_code = 'VES'
                        THEN (CASE WHEN d.doc_type = 'DEVOLUCION' THEN -di.line_total_minor ELSE di.line_total_minor END)
                        ELSE 0 END)
             FROM document_items di
             JOIN documents d ON d.id = di.document_id
             LEFT JOIN products p ON p.id = di.product_id
             WHERE d.status = 'issued' AND d.doc_type IN ('COMPROBANTE', 'DEVOLUCION')
               AND date(d.issued_at, 'localtime') BETWEEN ?1 AND ?2
             GROUP BY di.product_id
             ORDER BY SUM(CASE WHEN d.doc_type = 'DEVOLUCION' THEN -di.quantity ELSE di.quantity END) DESC
             LIMIT ?3",
        )?
        .query_map(params![f, t, limit], |r| {
            Ok(TopProduct {
                sku: r.get(0)?, description: r.get(1)?, quantity: r.get(2)?,
                usd_minor: r.get(3)?, ves_minor: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

// ---------- Inventario valorizado ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValuationItem {
    sku: String,
    name: String,
    currency_code: String,
    stock: i64,
    cost_minor: i64,
    value_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyValue {
    currency_code: String,
    value_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Valuation {
    items: Vec<ValuationItem>,
    totals: Vec<CurrencyValue>,
}

#[tauri::command]
pub async fn inventory_valuation(state: State<'_, AppState>) -> Result<Valuation, AppError> {
    security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    let mut items = db
        .prepare(
            "SELECT p.sku, p.name, p.price_currency, p.cost_minor,
                    COALESCE((SELECT SUM(m.quantity) FROM stock_movements m WHERE m.product_id = p.id), 0)
             FROM products p
             WHERE p.active = 1 AND p.track_stock = 1
             ORDER BY p.name",
        )?
        .query_map([], |r| {
            Ok(ValuationItem {
                sku: r.get(0)?, name: r.get(1)?, currency_code: r.get(2)?,
                cost_minor: r.get(3)?, stock: r.get(4)?, value_minor: 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut totals: BTreeMap<String, i64> = BTreeMap::new();
    for it in items.iter_mut() {
        it.value_minor = it
            .stock
            .max(0)
            .checked_mul(it.cost_minor)
            .ok_or_else(|| AppError::Validation("Monto demasiado grande".into()))?;
        *totals.entry(it.currency_code.clone()).or_insert(0) += it.value_minor;
    }
    let totals = totals
        .into_iter()
        .map(|(currency_code, value_minor)| CurrencyValue { currency_code, value_minor })
        .collect();
    Ok(Valuation { items, totals })
}

// ---------- Exportación ----------
/// Guarda un CSV en la carpeta Descargas y devuelve la ruta.
#[tauri::command]
pub async fn write_export(
    app: AppHandle,
    state: State<'_, AppState>,
    filename: String,
    content: String,
) -> Result<String, AppError> {
    security::require_role(&state, &["admin"])?;
    let ok_name = filename.len() <= 80
        && filename.ends_with(".csv")
        && filename.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        && !filename.contains("..");
    if !ok_name {
        return Err(AppError::Validation("Nombre de archivo inválido".into()));
    }
    if content.len() > 5_000_000 {
        return Err(AppError::Validation("El reporte es demasiado grande".into()));
    }
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let path = dir.join(&filename);
    std::fs::write(&path, content).map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(path.display().to_string())
}