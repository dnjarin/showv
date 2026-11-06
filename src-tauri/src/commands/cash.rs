use crate::{audit, error::AppError, security, state::AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodTotal {
    method: String,
    currency_code: String,
    count: i64,
    collected_minor: i64, // monto aplicado + IGTF = lo que realmente se cobró
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CashSession {
    id: i64,
    username: String,
    opened_at: String,
    opening_ves_minor: i64,
    opening_usd_minor: i64,
    closed_at: Option<String>,
    counted_ves_minor: Option<i64>,
    counted_usd_minor: Option<i64>,
    expected_ves_minor: i64,
    expected_usd_minor: i64,
    notes: Option<String>,
    sales_count: i64,
    voided_count: i64,
    methods: Vec<MethodTotal>,
    refunds: Vec<MethodTotal>,
    receipts: Vec<MethodTotal>,
    payments: Vec<MethodTotal>,
    expenses: Vec<MethodTotal>,
    movements: Vec<MethodTotal>,
    change_ves_minor: i64,
    change_usd_minor: i64,
}

fn build(conn: &Connection, id: i64) -> Result<CashSession, AppError> {
    let mut s = conn.query_row(
        "SELECT c.id, u.username, c.opened_at, c.opening_ves_minor, c.opening_usd_minor,
                c.closed_at, c.counted_ves_minor, c.counted_usd_minor,
                c.expected_ves_minor, c.expected_usd_minor, c.notes
         FROM cash_sessions c JOIN users u ON u.id = c.user_id WHERE c.id = ?1",
        [id],
        |r| {
            Ok(CashSession {
                id: r.get(0)?,
                username: r.get(1)?,
                opened_at: r.get(2)?,
                opening_ves_minor: r.get(3)?,
                opening_usd_minor: r.get(4)?,
                closed_at: r.get(5)?,
                counted_ves_minor: r.get(6)?,
                counted_usd_minor: r.get(7)?,
                expected_ves_minor: r.get::<_, Option<i64>>(8)?.unwrap_or(0),
                expected_usd_minor: r.get::<_, Option<i64>>(9)?.unwrap_or(0),
                notes: r.get(10)?,
                sales_count: 0,
                voided_count: 0,
                methods: vec![],
                refunds: vec![],
                receipts: vec![],
                payments: vec![],
                expenses: vec![],
                movements: vec![],
                change_ves_minor: 0,
                change_usd_minor: 0,
            })
        },
    )?;

    let (issued, voided): (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(status = 'issued'), 0), COALESCE(SUM(status = 'voided'), 0)
         FROM documents WHERE cash_session_id = ?1 AND doc_type = 'COMPROBANTE'",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    s.sales_count = issued;
    s.voided_count = voided;

    s.methods = conn
        .prepare(
            "SELECT p.method, p.currency_code, COUNT(*), SUM(p.amount_minor + p.igtf_minor)
             FROM payments p JOIN documents d ON d.id = p.document_id
             WHERE d.cash_session_id = ?1 AND d.status = 'issued'
             GROUP BY p.method, p.currency_code
             ORDER BY p.currency_code, p.method",
        )?
        .query_map([id], |r| {
            Ok(MethodTotal {
                method: r.get(0)?,
                currency_code: r.get(1)?,
                count: r.get(2)?,
                collected_minor: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // Dinero devuelto a clientes (devoluciones) en esta caja.
    s.refunds = conn
        .prepare(
            "SELECT r.method, r.currency_code, COUNT(*), SUM(r.amount_minor)
             FROM refunds r JOIN documents d ON d.id = r.document_id
             WHERE d.cash_session_id = ?1 AND d.status = 'issued'
             GROUP BY r.method, r.currency_code
             ORDER BY r.currency_code, r.method",
        )?
        .query_map([id], |r| {
            Ok(MethodTotal {
                method: r.get(0)?,
                currency_code: r.get(1)?,
                count: r.get(2)?,
                collected_minor: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // Abonos de cuentas por cobrar recibidos en esta caja.
    s.receipts = conn
        .prepare(
            "SELECT method, currency_code, COUNT(*), SUM(amount_minor)
             FROM ar_receipts WHERE cash_session_id = ?1 AND voided_at IS NULL
             GROUP BY method, currency_code ORDER BY currency_code, method",
        )?
        .query_map([id], |r| {
            Ok(MethodTotal {
                method: r.get(0)?,
                currency_code: r.get(1)?,
                count: r.get(2)?,
                collected_minor: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    // Pagos a proveedores hechos desde esta caja.
    s.payments = conn
        .prepare(
            "SELECT method, currency_code, COUNT(*), SUM(amount_minor)
             FROM ap_payments WHERE cash_session_id = ?1 AND voided_at IS NULL
             GROUP BY method, currency_code ORDER BY currency_code, method",
        )?
        .query_map([id], |r| {
            Ok(MethodTotal {
                method: r.get(0)?,
                currency_code: r.get(1)?,
                count: r.get(2)?,
                collected_minor: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    // Gastos pagados desde esta caja.
    s.expenses = conn
        .prepare(
            "SELECT method, currency_code, COUNT(*), SUM(amount_minor)
             FROM expenses WHERE cash_session_id = ?1 AND voided_at IS NULL
             GROUP BY method, currency_code ORDER BY currency_code, method",
        )?
        .query_map([id], |r| {
            Ok(MethodTotal {
                method: r.get(0)?,
                currency_code: r.get(1)?,
                count: r.get(2)?,
                collected_minor: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let expenses_cash = |cur: &str| -> i64 {
        s.expenses
            .iter()
            .filter(|m| m.method == "efectivo" && m.currency_code == cur)
            .map(|m| m.collected_minor)
            .sum()
    };
    // Movimientos manuales de caja (en `method` va el tipo: entrada o salida).
    s.movements = conn
        .prepare(
            "SELECT kind, currency_code, COUNT(*), SUM(amount_minor)
             FROM cash_movements WHERE cash_session_id = ?1 AND voided_at IS NULL
             GROUP BY kind, currency_code ORDER BY currency_code, kind",
        )?
        .query_map([id], |r| {
            Ok(MethodTotal {
                method: r.get(0)?,
                currency_code: r.get(1)?,
                count: r.get(2)?,
                collected_minor: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let movements_net = |cur: &str| -> i64 {
        s.movements
            .iter()
            .filter(|m| m.currency_code == cur)
            .map(|m| if m.method == "entrada" { m.collected_minor } else { -m.collected_minor })
            .sum()
    };
    let payments_cash = |cur: &str| -> i64 {
        s.payments
            .iter()
            .filter(|m| m.method == "efectivo" && m.currency_code == cur)
            .map(|m| m.collected_minor)
            .sum()
    };
    let receipts_cash = |cur: &str| -> i64 {
        s.receipts
            .iter()
            .filter(|m| m.method == "efectivo" && m.currency_code == cur)
            .map(|m| m.collected_minor)
            .sum()
    };

    // Vuelto entregado, por moneda.
    let change = |cur: &str| -> Result<i64, AppError> {
        Ok(conn.query_row(
            "SELECT COALESCE(SUM(change_minor), 0) FROM documents
             WHERE cash_session_id = ?1 AND status = 'issued' AND doc_type = 'COMPROBANTE'
               AND change_currency = ?2",
            params![id, cur],
            |r| r.get(0),
        )?)
    };
    s.change_ves_minor = change("VES")?;
    s.change_usd_minor = change("USD")?;

    // Efectivo que entró físicamente: lo recibido (si se registró) o lo aplicado.
    let cash_in = |cur: &str| -> Result<i64, AppError> {
        Ok(conn.query_row(
            "SELECT COALESCE(SUM(COALESCE(p.tendered_minor, p.amount_minor + p.igtf_minor)), 0)
             FROM payments p JOIN documents d ON d.id = p.document_id
             WHERE d.cash_session_id = ?1 AND d.status = 'issued'
               AND p.method = 'efectivo' AND p.currency_code = ?2",
            params![id, cur],
            |r| r.get(0),
        )?)
    };
    let refunds_cash = |cur: &str| -> i64 {
        s.refunds
            .iter()
            .filter(|m| m.method == "efectivo" && m.currency_code == cur)
            .map(|m| m.collected_minor)
            .sum()
    };

    // Mientras la caja está abierta, el esperado se calcula en vivo.
    // Al cerrar se guarda y ya no cambia.
    if s.closed_at.is_none() {
        s.expected_ves_minor =
            s.opening_ves_minor + cash_in("VES")? + receipts_cash("VES") - s.change_ves_minor
                - refunds_cash("VES")
                - payments_cash("VES")
                - expenses_cash("VES")
                + movements_net("VES");
        s.expected_usd_minor =
            s.opening_usd_minor + cash_in("USD")? + receipts_cash("USD") - s.change_usd_minor
                - refunds_cash("USD")
                - payments_cash("USD")
                - expenses_cash("USD")
                + movements_net("USD");
    }
    Ok(s)
}

fn open_session_id(conn: &Connection, user_id: i64) -> Result<Option<i64>, AppError> {
    Ok(conn
        .query_row(
            "SELECT id FROM cash_sessions WHERE user_id = ?1 AND closed_at IS NULL",
            [user_id],
            |r| r.get(0),
        )
        .optional()?)
}

#[tauri::command]
pub async fn cash_current(state: State<'_, AppState>) -> Result<Option<CashSession>, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;
    match open_session_id(&db, me.id)? {
        Some(id) => Ok(Some(build(&db, id)?)),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn cash_open(
    state: State<'_, AppState>,
    opening_ves_minor: i64,
    opening_usd_minor: i64,
) -> Result<CashSession, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    if opening_ves_minor < 0 || opening_usd_minor < 0 {
        return Err(AppError::Validation("El fondo inicial no puede ser negativo".into()));
    }
    let db = state.conn()?;
    db.execute(
        "INSERT INTO cash_sessions (user_id, opening_ves_minor, opening_usd_minor)
         VALUES (?1, ?2, ?3)",
        params![me.id, opening_ves_minor, opening_usd_minor],
    )
    .map_err(|e| match &e {
        rusqlite::Error::SqliteFailure(f, _)
            if f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
        {
            AppError::Validation("Ya tienes una caja abierta".into())
        }
        _ => AppError::Db(e),
    })?;
    let id = db.last_insert_rowid();
    let detail = format!("fondo VES {} / USD {} (centavos)", opening_ves_minor, opening_usd_minor);
    audit::log(&db, Some(me.id), "cash_opened", Some("cash_session"), Some(id), Some(&detail))?;
    build(&db, id)
}

#[tauri::command]
pub async fn cash_close(
    state: State<'_, AppState>,
    counted_ves_minor: i64,
    counted_usd_minor: i64,
    notes: Option<String>,
) -> Result<CashSession, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    if counted_ves_minor < 0 || counted_usd_minor < 0 {
        return Err(AppError::Validation("El conteo no puede ser negativo".into()));
    }
    let notes = notes.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());

    let mut db = state.conn()?;
    let tx = db.transaction()?;
    let id = open_session_id(&tx, me.id)?
        .ok_or_else(|| AppError::Validation("No tienes una caja abierta".into()))?;
    let s = build(&tx, id)?;

    let diff_ves = counted_ves_minor - s.expected_ves_minor;
    let diff_usd = counted_usd_minor - s.expected_usd_minor;
    if (diff_ves != 0 || diff_usd != 0) && notes.as_deref().map_or(true, |n| n.len() < 3) {
        return Err(AppError::Validation(
            "Hay diferencia en el cuadre: explica el motivo en las notas".into(),
        ));
    }

    tx.execute(
        "UPDATE cash_sessions SET closed_at = datetime('now'),
            counted_ves_minor = ?2, counted_usd_minor = ?3,
            expected_ves_minor = ?4, expected_usd_minor = ?5, notes = ?6
         WHERE id = ?1",
        params![id, counted_ves_minor, counted_usd_minor,
                s.expected_ves_minor, s.expected_usd_minor, notes],
    )?;
    let detail = format!("diferencia VES {diff_ves:+} / USD {diff_usd:+} (centavos)");
    audit::log(&tx, Some(me.id), "cash_closed", Some("cash_session"), Some(id), Some(&detail))?;
    tx.commit()?;
    build(&db, id)
}

#[tauri::command]
pub async fn cash_history(state: State<'_, AppState>) -> Result<Vec<CashSession>, AppError> {
    security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    let ids = db
        .prepare("SELECT id FROM cash_sessions ORDER BY id DESC LIMIT 50")?
        .query_map([], |r| r.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    ids.into_iter().map(|id| build(&db, id)).collect()
}