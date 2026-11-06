//! Gastos operativos y movimientos de caja (retiros, depósitos, ingresos de fondo).
use crate::{audit, error::AppError, security, state::AppState};
use chrono::{Local, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

const METHODS: &[&str] = &["efectivo", "punto", "pago_movil", "transferencia", "zelle", "otro"];
const CURRENCIES: &[&str] = &["VES", "USD"];
const MAX_AMOUNT: i64 = 1_000_000_000_000;

fn div_round(n: i128, d: i128) -> i64 {
    ((n + d / 2) / d) as i64
}

fn fmt_minor(v: i64) -> String {
    format!("{}.{:02}", v / 100, v % 100)
}

fn usd_rate(conn: &Connection) -> Result<Option<i64>, AppError> {
    Ok(conn
        .query_row(
            "SELECT rate_micro FROM exchange_rates
             WHERE currency_code = 'USD' AND rate_date <= date('now','localtime')
             ORDER BY rate_date DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?)
}

fn clean_text(s: &str, min: usize, max: usize, what: &str) -> Result<String, AppError> {
    let t = s.trim().to_string();
    let n = t.chars().count();
    if n < min || n > max {
        return Err(AppError::Validation(format!("{what}: entre {min} y {max} caracteres")));
    }
    Ok(t)
}

fn parse_date(s: &str) -> Result<NaiveDate, AppError> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|_| AppError::Validation("Fecha inválida (use AAAA-MM-DD)".into()))
}

fn opt_date(v: &Option<String>) -> Result<Option<String>, AppError> {
    match v.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(s) => Ok(Some(parse_date(s)?.format("%Y-%m-%d").to_string())),
    }
}

fn open_session(conn: &Connection, user_id: i64) -> Result<Option<i64>, AppError> {
    Ok(conn
        .query_row(
            "SELECT id FROM cash_sessions WHERE user_id = ?1 AND closed_at IS NULL",
            [user_id],
            |r| r.get(0),
        )
        .optional()?)
}

fn next_number(tx: &Connection, doc_type: &str, series: &str) -> Result<i64, AppError> {
    let n: i64 = tx.query_row(
        "SELECT next_number FROM document_series WHERE doc_type = ?1 AND series = ?2",
        params![doc_type, series],
        |r| r.get(0),
    )?;
    tx.execute(
        "UPDATE document_series SET next_number = next_number + 1 WHERE doc_type = ?1 AND series = ?2",
        params![doc_type, series],
    )?;
    Ok(n)
}

fn session_closed(conn: &Connection, session_id: i64) -> Result<bool, AppError> {
    let closed: Option<String> = conn.query_row(
        "SELECT closed_at FROM cash_sessions WHERE id = ?1",
        [session_id],
        |r| r.get(0),
    )?;
    Ok(closed.is_some())
}

// ---------- Categorías ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    id: i64,
    name: String,
    active: bool,
}

#[tauri::command]
pub async fn list_expense_categories(
    state: State<'_, AppState>,
    include_inactive: bool,
) -> Result<Vec<Category>, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT id, name, active FROM expense_categories
             WHERE (?1 = 1 OR active = 1) ORDER BY name",
        )?
        .query_map([include_inactive as i64], |r| {
            Ok(Category { id: r.get(0)?, name: r.get(1)?, active: r.get::<_, i64>(2)? != 0 })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub async fn save_expense_category(
    state: State<'_, AppState>,
    id: Option<i64>,
    name: String,
) -> Result<i64, AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let name = clean_text(&name, 2, 60, "El nombre de la categoría")?;
    let db = state.conn()?;
    let dup: i64 = db.query_row(
        "SELECT COUNT(*) FROM expense_categories WHERE name = ?1 AND (?2 IS NULL OR id <> ?2)",
        params![name, id],
        |r| r.get(0),
    )?;
    if dup > 0 {
        return Err(AppError::Validation("Ya existe una categoría con ese nombre".into()));
    }
    let rid = match id {
        Some(i) => {
            let n = db.execute("UPDATE expense_categories SET name = ?2 WHERE id = ?1", params![i, name])?;
            if n == 0 {
                return Err(AppError::Validation("La categoría no existe".into()));
            }
            i
        }
        None => {
            db.execute("INSERT INTO expense_categories (name) VALUES (?1)", [&name])?;
            db.last_insert_rowid()
        }
    };
    audit::log(&db, Some(me.id), "expense_category_saved", Some("expense_category"), Some(rid), Some(&name))?;
    Ok(rid)
}

#[tauri::command]
pub async fn set_expense_category_active(
    state: State<'_, AppState>,
    id: i64,
    active: bool,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    db.execute("UPDATE expense_categories SET active = ?2 WHERE id = ?1", params![id, active as i64])?;
    let action = if active { "expense_category_enabled" } else { "expense_category_disabled" };
    audit::log(&db, Some(me.id), action, Some("expense_category"), Some(id), None)?;
    Ok(())
}

// ---------- Gastos ----------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseInput {
    category_id: i64,
    description: String,
    /// AAAA-MM-DD; si falta, hoy.
    expense_date: Option<String>,
    method: String,
    currency_code: String,
    amount_minor: i64,
    reference: Option<String>,
}

#[tauri::command]
pub async fn create_expense(state: State<'_, AppState>, input: ExpenseInput) -> Result<i64, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    if input.amount_minor <= 0 || input.amount_minor > MAX_AMOUNT {
        return Err(AppError::Validation("Monto inválido".into()));
    }
    if !CURRENCIES.contains(&input.currency_code.as_str()) {
        return Err(AppError::Validation("Moneda inválida".into()));
    }
    if !METHODS.contains(&input.method.as_str()) {
        return Err(AppError::Validation("Método de pago inválido".into()));
    }
    let description = clean_text(&input.description, 3, 120, "La descripción")?;
    let reference = match input.reference.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(r) => Some(clean_text(r, 1, 60, "La referencia")?),
    };
    let today = Local::now().date_naive();
    let date = match input.expense_date.as_deref().map(str::trim) {
        None | Some("") => today,
        Some(s) => parse_date(s)?,
    };
    if date > today {
        return Err(AppError::Validation("La fecha del gasto no puede ser futura".into()));
    }

    let mut db = state.conn()?;
    let tx = db.transaction()?;
    let cat_active: Option<i64> = tx
        .query_row("SELECT active FROM expense_categories WHERE id = ?1", [input.category_id], |r| r.get(0))
        .optional()?;
    match cat_active {
        None => return Err(AppError::Validation("La categoría no existe".into())),
        Some(0) => return Err(AppError::Validation("La categoría está desactivada".into())),
        _ => {}
    }

    // El efectivo sale de la caja abierta del usuario.
    let session_id = if input.method == "efectivo" {
        Some(open_session(&tx, me.id)?.ok_or_else(|| {
            AppError::Validation("Abre tu caja para registrar un gasto en efectivo (menú Caja)".into())
        })?)
    } else {
        None
    };

    let rate = usd_rate(&tx)?;
    let usd = if input.currency_code == "USD" {
        input.amount_minor
    } else {
        let r = rate.ok_or_else(|| {
            AppError::Validation("No hay tasa USD vigente. Regístrala en Tasas de cambio.".into())
        })?;
        div_round(input.amount_minor as i128 * 1_000_000, r as i128)
    };

    let number = next_number(&tx, "GASTO", "G")?;
    tx.execute(
        "INSERT INTO expenses (number, category_id, description, expense_date, method, currency_code,
            amount_minor, exchange_rate_micro, amount_usd_minor, reference, user_id, cash_session_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![number, input.category_id, description, date.format("%Y-%m-%d").to_string(),
                input.method, input.currency_code, input.amount_minor, rate, usd, reference,
                me.id, session_id],
    )?;
    let id = tx.last_insert_rowid();
    let detail = format!(
        "G-{number:06}: {description} · {} {} ({})",
        fmt_minor(input.amount_minor),
        input.currency_code,
        input.method
    );
    audit::log(&tx, Some(me.id), "expense_created", Some("expense"), Some(id), Some(&detail))?;
    tx.commit()?;
    Ok(id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseFilter {
    from: Option<String>,
    to: Option<String>,
    category_id: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseRow {
    id: i64,
    number: i64,
    expense_date: String,
    category: String,
    description: String,
    method: String,
    currency_code: String,
    amount_minor: i64,
    amount_usd_minor: i64,
    reference: Option<String>,
    user: Option<String>,
    from_cash: bool,
    voided: bool,
    void_reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTotal {
    category: String,
    count: i64,
    total_usd_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseList {
    rows: Vec<ExpenseRow>,
    by_category: Vec<CategoryTotal>,
    total_usd_minor: i64,
}

#[tauri::command]
pub async fn list_expenses(
    state: State<'_, AppState>,
    filter: ExpenseFilter,
) -> Result<ExpenseList, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    let from = opt_date(&filter.from)?;
    let to = opt_date(&filter.to)?;
    // El cajero solo ve sus propios gastos; el administrador ve todos.
    let only_user: Option<i64> = if me.role == "admin" { None } else { Some(me.id) };

    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT e.id, e.number, e.expense_date, c.name, e.description, e.method, e.currency_code,
                    e.amount_minor, e.amount_usd_minor, e.reference, u.username,
                    e.cash_session_id IS NOT NULL, e.voided_at IS NOT NULL, e.void_reason
             FROM expenses e
             JOIN expense_categories c ON c.id = e.category_id
             LEFT JOIN users u ON u.id = e.user_id
             WHERE (?1 IS NULL OR e.expense_date >= ?1)
               AND (?2 IS NULL OR e.expense_date <= ?2)
               AND (?3 IS NULL OR e.category_id = ?3)
               AND (?4 IS NULL OR e.user_id = ?4)
             ORDER BY e.expense_date DESC, e.id DESC LIMIT 500",
        )?
        .query_map(params![from, to, filter.category_id, only_user], |r| {
            Ok(ExpenseRow {
                id: r.get(0)?, number: r.get(1)?, expense_date: r.get(2)?, category: r.get(3)?,
                description: r.get(4)?, method: r.get(5)?, currency_code: r.get(6)?,
                amount_minor: r.get(7)?, amount_usd_minor: r.get(8)?, reference: r.get(9)?,
                user: r.get(10)?,
                from_cash: r.get::<_, i64>(11)? != 0,
                voided: r.get::<_, i64>(12)? != 0,
                void_reason: r.get(13)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let by_category = db
        .prepare(
            "SELECT c.name, COUNT(*), SUM(e.amount_usd_minor)
             FROM expenses e JOIN expense_categories c ON c.id = e.category_id
             WHERE e.voided_at IS NULL
               AND (?1 IS NULL OR e.expense_date >= ?1)
               AND (?2 IS NULL OR e.expense_date <= ?2)
               AND (?3 IS NULL OR e.category_id = ?3)
               AND (?4 IS NULL OR e.user_id = ?4)
             GROUP BY c.id ORDER BY SUM(e.amount_usd_minor) DESC",
        )?
        .query_map(params![from, to, filter.category_id, only_user], |r| {
            Ok(CategoryTotal { category: r.get(0)?, count: r.get(1)?, total_usd_minor: r.get(2)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let total = by_category.iter().map(|c| c.total_usd_minor).sum();
    Ok(ExpenseList { rows, by_category, total_usd_minor: total })
}

#[tauri::command]
pub async fn void_expense(state: State<'_, AppState>, id: i64, reason: String) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let reason = clean_text(&reason, 5, 120, "El motivo de la anulación")?;
    let mut db = state.conn()?;
    let tx = db.transaction()?;
    let (number, voided, session): (i64, Option<String>, Option<i64>) = tx
        .query_row(
            "SELECT number, voided_at, cash_session_id FROM expenses WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("El gasto no existe".into()))?;
    if voided.is_some() {
        return Err(AppError::Validation("El gasto ya está anulado".into()));
    }
    if let Some(sid) = session {
        if session_closed(&tx, sid)? {
            return Err(AppError::Validation(
                "La caja de la que salió este gasto ya fue cerrada: no se puede anular".into(),
            ));
        }
    }
    tx.execute(
        "UPDATE expenses SET voided_at = datetime('now'), void_reason = ?2, voided_by = ?3 WHERE id = ?1",
        params![id, reason, me.id],
    )?;
    let detail = format!("G-{number:06} anulado | motivo: {reason}");
    audit::log(&tx, Some(me.id), "expense_voided", Some("expense"), Some(id), Some(&detail))?;
    tx.commit()?;
    Ok(())
}

// ---------- Movimientos de caja ----------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovementInput {
    kind: String,
    concept: String,
    currency_code: String,
    amount_minor: i64,
}

#[tauri::command]
pub async fn create_cash_movement(
    state: State<'_, AppState>,
    input: MovementInput,
) -> Result<i64, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    if input.kind != "entrada" && input.kind != "salida" {
        return Err(AppError::Validation("Tipo de movimiento inválido".into()));
    }
    if input.amount_minor <= 0 || input.amount_minor > MAX_AMOUNT {
        return Err(AppError::Validation("Monto inválido".into()));
    }
    if !CURRENCIES.contains(&input.currency_code.as_str()) {
        return Err(AppError::Validation("Moneda inválida".into()));
    }
    let concept = clean_text(&input.concept, 3, 120, "El concepto")?;

    let mut db = state.conn()?;
    let tx = db.transaction()?;
    let session_id = open_session(&tx, me.id)?
        .ok_or_else(|| AppError::Validation("Abre tu caja antes de registrar un movimiento (menú Caja)".into()))?;
    let number = next_number(&tx, "MOVCAJA", "M")?;
    tx.execute(
        "INSERT INTO cash_movements (number, kind, concept, currency_code, amount_minor, user_id, cash_session_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![number, input.kind, concept, input.currency_code, input.amount_minor, me.id, session_id],
    )?;
    let id = tx.last_insert_rowid();
    let detail = format!(
        "M-{number:06} {}: {concept} · {} {}",
        input.kind,
        fmt_minor(input.amount_minor),
        input.currency_code
    );
    audit::log(&tx, Some(me.id), "cash_movement_created", Some("cash_movement"), Some(id), Some(&detail))?;
    tx.commit()?;
    Ok(id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovementRow {
    id: i64,
    number: i64,
    created_at: String,
    kind: String,
    concept: String,
    currency_code: String,
    amount_minor: i64,
    user: Option<String>,
    session_open: bool,
    voided: bool,
    void_reason: Option<String>,
}

#[tauri::command]
pub async fn list_cash_movements(
    state: State<'_, AppState>,
    filter: ExpenseFilter,
) -> Result<Vec<MovementRow>, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    let from = opt_date(&filter.from)?;
    let to = opt_date(&filter.to)?;
    let only_user: Option<i64> = if me.role == "admin" { None } else { Some(me.id) };
    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT m.id, m.number, m.created_at, m.kind, m.concept, m.currency_code, m.amount_minor,
                    u.username, s.closed_at IS NULL, m.voided_at IS NOT NULL, m.void_reason
             FROM cash_movements m
             JOIN cash_sessions s ON s.id = m.cash_session_id
             LEFT JOIN users u ON u.id = m.user_id
             WHERE (?1 IS NULL OR date(m.created_at, 'localtime') >= ?1)
               AND (?2 IS NULL OR date(m.created_at, 'localtime') <= ?2)
               AND (?3 IS NULL OR m.user_id = ?3)
             ORDER BY m.id DESC LIMIT 500",
        )?
        .query_map(params![from, to, only_user], |r| {
            Ok(MovementRow {
                id: r.get(0)?, number: r.get(1)?, created_at: r.get(2)?, kind: r.get(3)?,
                concept: r.get(4)?, currency_code: r.get(5)?, amount_minor: r.get(6)?,
                user: r.get(7)?,
                session_open: r.get::<_, i64>(8)? != 0,
                voided: r.get::<_, i64>(9)? != 0,
                void_reason: r.get(10)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub async fn void_cash_movement(
    state: State<'_, AppState>,
    id: i64,
    reason: String,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let reason = clean_text(&reason, 5, 120, "El motivo de la anulación")?;
    let mut db = state.conn()?;
    let tx = db.transaction()?;
    let (number, voided, session): (i64, Option<String>, i64) = tx
        .query_row(
            "SELECT number, voided_at, cash_session_id FROM cash_movements WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("El movimiento no existe".into()))?;
    if voided.is_some() {
        return Err(AppError::Validation("El movimiento ya está anulado".into()));
    }
    if session_closed(&tx, session)? {
        return Err(AppError::Validation("La caja de este movimiento ya fue cerrada: no se puede anular".into()));
    }
    tx.execute(
        "UPDATE cash_movements SET voided_at = datetime('now'), void_reason = ?2, voided_by = ?3 WHERE id = ?1",
        params![id, reason, me.id],
    )?;
    let detail = format!("M-{number:06} anulado | motivo: {reason}");
    audit::log(&tx, Some(me.id), "cash_movement_voided", Some("cash_movement"), Some(id), Some(&detail))?;
    tx.commit()?;
    Ok(())
}
