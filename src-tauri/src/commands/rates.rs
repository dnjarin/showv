use crate::{audit, error::AppError, security, state::AppState};
use chrono::{Duration, Local, NaiveDate};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rate {
    id: i64,
    currency_code: String,
    rate_micro: i64,
    rate_date: String,
    source: String,
    username: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RatesOverview {
    current: Vec<Rate>,
    history: Vec<Rate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateInput {
    currency_code: String,
    rate_micro: i64,   // Bs por 1 unidad × 1.000.000
    rate_date: String, // YYYY-MM-DD
    source: String,    // "BCV" | "manual"
}

const RATE_SELECT: &str = "SELECT e.id, e.currency_code, e.rate_micro, e.rate_date, e.source, u.username
    FROM exchange_rates e LEFT JOIN users u ON u.id = e.created_by";

fn map_rate(r: &Row) -> rusqlite::Result<Rate> {
    Ok(Rate {
        id: r.get(0)?,
        currency_code: r.get(1)?,
        rate_micro: r.get(2)?,
        rate_date: r.get(3)?,
        source: r.get(4)?,
        username: r.get(5)?,
    })
}

fn fmt_micro(v: i64) -> String {
    format!("{}.{:06}", v / 1_000_000, v % 1_000_000)
}

#[tauri::command]
pub async fn exchange_rates_overview(state: State<'_, AppState>) -> Result<RatesOverview, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;

    let codes = db
        .prepare("SELECT code FROM currencies WHERE is_base = 0")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut current = Vec::new();
    for code in codes {
        let sql = format!(
            "{RATE_SELECT} WHERE e.currency_code = ?1 AND e.rate_date <= date('now','localtime')
             ORDER BY e.rate_date DESC LIMIT 1"
        );
        if let Some(r) = db.query_row(&sql, [&code], map_rate).optional()? {
            current.push(r);
        }
    }

    let history = db
        .prepare(&format!("{RATE_SELECT} ORDER BY e.rate_date DESC, e.id DESC LIMIT 60"))?
        .query_map([], map_rate)?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(RatesOverview { current, history })
}

#[tauri::command]
pub async fn set_exchange_rate(
    state: State<'_, AppState>,
    input: RateInput,
    confirm: bool,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;

    let code = input.currency_code.trim().to_uppercase();
    let date = NaiveDate::parse_from_str(input.rate_date.trim(), "%Y-%m-%d")
        .map_err(|_| AppError::Validation("Fecha inválida".into()))?;
    if date > Local::now().date_naive() + Duration::days(7) {
        return Err(AppError::Validation("La fecha no puede ser más de 7 días futura".into()));
    }
    if input.rate_micro <= 0 || input.rate_micro > 1_000_000_000_000_000 {
        return Err(AppError::Validation("Tasa fuera de rango".into()));
    }
    if !["BCV", "manual"].contains(&input.source.as_str()) {
        return Err(AppError::Validation("Fuente inválida".into()));
    }
    let date_str = date.format("%Y-%m-%d").to_string();

    let db = state.conn()?;
    let is_base: Option<i64> = db
        .query_row("SELECT is_base FROM currencies WHERE code = ?1", [&code], |r| r.get(0))
        .optional()?;
    match is_base {
        None => return Err(AppError::Validation("Moneda inválida".into())),
        Some(1) => return Err(AppError::Validation("La moneda base no lleva tasa".into())),
        _ => {}
    }

    // Protección contra errores de digitación: variación mayor a 30%.
    let prev: Option<i64> = db
        .query_row(
            "SELECT rate_micro FROM exchange_rates
             WHERE currency_code = ?1 AND rate_date <> ?2
             ORDER BY rate_date DESC LIMIT 1",
            params![code, date_str],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(p) = prev {
        let n = input.rate_micro;
        if !confirm && (n < p * 7 / 10 || n > p * 13 / 10) {
            return Err(AppError::Validation(format!(
                "La tasa varía más de 30% respecto a la anterior ({}). Confirma para guardarla.",
                fmt_micro(p)
            )));
        }
    }

    let old: Option<i64> = db
        .query_row(
            "SELECT rate_micro FROM exchange_rates WHERE currency_code = ?1 AND rate_date = ?2",
            params![code, date_str],
            |r| r.get(0),
        )
        .optional()?;

    db.execute(
        "INSERT INTO exchange_rates (currency_code, rate_micro, rate_date, source, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(currency_code, rate_date) DO UPDATE SET
           rate_micro = excluded.rate_micro, source = excluded.source, created_by = excluded.created_by",
        params![code, input.rate_micro, date_str, input.source, me.id],
    )?;

    let detail = match old {
        Some(o) => format!("{code} {date_str}: {} -> {}", fmt_micro(o), fmt_micro(input.rate_micro)),
        None => format!("{code} {date_str}: {}", fmt_micro(input.rate_micro)),
    };
    audit::log(&db, Some(me.id), "exchange_rate_set", Some("exchange_rate"), None, Some(&detail))?;
    Ok(())
}