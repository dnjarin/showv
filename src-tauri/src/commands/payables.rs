//! Cuentas por pagar: compras a crédito, pagos a proveedores y antigüedad de saldos.
use crate::{audit, error::AppError, security, state::AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

const METHODS: &[&str] = &["efectivo", "punto", "pago_movil", "transferencia", "zelle", "otro"];
const CURRENCIES: &[&str] = &["VES", "USD"];

// ---------- Utilidades ----------
fn div_round(n: i128, d: i128) -> i64 {
    ((n + d / 2) / d) as i64
}

fn fmt_minor(v: i64) -> String {
    format!("{}.{:02}", v / 100, v % 100)
}

fn convert(minor: i64, from: &str, to: &str, usd_rate: Option<i64>) -> Result<i64, AppError> {
    if from == to {
        return Ok(minor);
    }
    let rate = usd_rate.ok_or_else(|| {
        AppError::Validation("No hay tasa USD vigente. Regístrala en Tasas de cambio.".into())
    })? as i128;
    let m = minor as i128;
    match (from, to) {
        ("VES", "USD") => Ok(div_round(m * 1_000_000, rate)),
        ("USD", "VES") => Ok(div_round(m * rate, 1_000_000)),
        _ => Err(AppError::Validation("Conversión de moneda no soportada".into())),
    }
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

/// Saldo de una compra a crédito, en la moneda de la compra.
/// Se debe el neto a pagar (factura menos retenciones) menos los pagos vigentes.
pub(crate) const BALANCE_SQL: &str = "
    COALESCE(p.net_payable_minor, p.total_minor)
    - COALESCE((SELECT SUM(a.applied_doc_minor) FROM ap_allocations a
                JOIN ap_payments v ON v.id = a.payment_id
                WHERE a.purchase_id = p.id AND v.voided_at IS NULL), 0)";

// ---------- Tipos ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPurchase {
    id: i64,
    number: i64,
    invoice_number: Option<String>,
    created_at: String,
    due_date: Option<String>,
    currency_code: String,
    payable_minor: i64,
    balance_minor: i64,
    days_overdue: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierDebt {
    supplier_id: i64,
    name: String,
    id_type: String,
    id_number: String,
    docs: i64,
    balance_usd_minor: i64,
    balance_ves_minor: i64,
    overdue_docs: i64,
    max_days_overdue: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentRow {
    id: i64,
    number: i64,
    created_at: String,
    method: String,
    currency_code: String,
    amount_minor: i64,
    voided: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierAccount {
    supplier_id: i64,
    name: String,
    id_type: String,
    id_number: String,
    phone: Option<String>,
    docs: Vec<OpenPurchase>,
    payments: Vec<PaymentRow>,
    aging_usd_minor: [i64; 4],
    not_due_usd_minor: i64,
    debt_usd_minor: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayInput {
    supplier_id: i64,
    /// Si es None, el pago se aplica a las deudas más antiguas primero.
    purchase_id: Option<i64>,
    method: String,
    currency_code: String,
    amount_minor: i64,
    reference: Option<String>,
    notes: Option<String>,
}

// ---------- Consulta ----------
/// Devuelve (supplier_id, compra, saldo) ordenado por vencimiento; solo saldos > 0.
fn open_purchases(
    conn: &Connection,
    supplier_id: Option<i64>,
) -> Result<Vec<(i64, OpenPurchase, i64)>, AppError> {
    let sql = format!(
        "SELECT p.supplier_id, p.id, p.number, p.invoice_number, p.created_at, p.due_date,
                p.currency_code, COALESCE(p.net_payable_minor, p.total_minor), {BALANCE_SQL} AS bal,
                CASE WHEN p.due_date IS NULL THEN 0
                     ELSE CAST(julianday(date('now','localtime')) - julianday(p.due_date) AS INTEGER) END
         FROM purchases p
         WHERE p.on_credit = 1 AND p.status = 'received'
           AND (?1 IS NULL OR p.supplier_id = ?1)
         ORDER BY COALESCE(p.due_date, p.created_at), p.id"
    );
    let rows = conn
        .prepare(&sql)?
        .query_map([supplier_id], |r| {
            let bal: i64 = r.get(8)?;
            Ok((
                r.get::<_, i64>(0)?,
                OpenPurchase {
                    id: r.get(1)?, number: r.get(2)?, invoice_number: r.get(3)?, created_at: r.get(4)?,
                    due_date: r.get(5)?, currency_code: r.get(6)?, payable_minor: r.get(7)?,
                    balance_minor: bal, days_overdue: r.get(9)?,
                },
                bal,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows.into_iter().filter(|(_, _, b)| *b > 0).collect())
}

/// Saldo pendiente de una compra (0 si no es a crédito o está anulada).
pub fn purchase_balance(conn: &Connection, purchase_id: i64) -> Result<i64, AppError> {
    let sql = format!(
        "SELECT {BALANCE_SQL} FROM purchases p
         WHERE p.id = ?1 AND p.on_credit = 1 AND p.status = 'received'"
    );
    Ok(conn.query_row(&sql, [purchase_id], |r| r.get(0)).optional()?.unwrap_or(0).max(0))
}

#[tauri::command]
pub async fn ap_summary(state: State<'_, AppState>) -> Result<Vec<SupplierDebt>, AppError> {
    security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    let mut rows: Vec<SupplierDebt> = Vec::new();
    for (sid, p, bal) in open_purchases(&db, None)? {
        let idx = match rows.iter().position(|r| r.supplier_id == sid) {
            Some(i) => i,
            None => {
                let (name, t, n): (String, String, String) = db.query_row(
                    "SELECT name, id_type, id_number FROM suppliers WHERE id = ?1",
                    [sid],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
                rows.push(SupplierDebt {
                    supplier_id: sid, name, id_type: t, id_number: n, docs: 0,
                    balance_usd_minor: 0, balance_ves_minor: 0, overdue_docs: 0, max_days_overdue: 0,
                });
                rows.len() - 1
            }
        };
        let r = &mut rows[idx];
        r.docs += 1;
        if p.currency_code == "USD" {
            r.balance_usd_minor += bal;
        } else {
            r.balance_ves_minor += bal;
        }
        if p.days_overdue > 0 {
            r.overdue_docs += 1;
            r.max_days_overdue = r.max_days_overdue.max(p.days_overdue);
        }
    }
    rows.sort_by(|a, b| b.max_days_overdue.cmp(&a.max_days_overdue).then(a.name.cmp(&b.name)));
    Ok(rows)
}

#[tauri::command]
pub async fn ap_supplier(state: State<'_, AppState>, supplier_id: i64) -> Result<SupplierAccount, AppError> {
    security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    let (name, t, n, phone): (String, String, String, Option<String>) = db
        .query_row(
            "SELECT name, id_type, id_number, phone FROM suppliers WHERE id = ?1",
            [supplier_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("Proveedor no encontrado".into()))?;

    let rate = usd_rate(&db)?;
    let docs: Vec<OpenPurchase> =
        open_purchases(&db, Some(supplier_id))?.into_iter().map(|(_, d, _)| d).collect();

    let mut aging = [0i64; 4];
    let mut not_due = 0i64;
    for d in &docs {
        let usd = convert(d.balance_minor, &d.currency_code, "USD", rate).unwrap_or(0);
        match d.days_overdue {
            x if x <= 0 => not_due += usd,
            1..=15 => aging[0] += usd,
            16..=30 => aging[1] += usd,
            31..=60 => aging[2] += usd,
            _ => aging[3] += usd,
        }
    }
    let debt = not_due + aging.iter().sum::<i64>();

    let payments = db
        .prepare(
            "SELECT id, number, created_at, method, currency_code, amount_minor, voided_at IS NOT NULL
             FROM ap_payments WHERE supplier_id = ?1 ORDER BY id DESC LIMIT 30",
        )?
        .query_map([supplier_id], |r| {
            Ok(PaymentRow {
                id: r.get(0)?, number: r.get(1)?, created_at: r.get(2)?, method: r.get(3)?,
                currency_code: r.get(4)?, amount_minor: r.get(5)?,
                voided: r.get::<_, i64>(6)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(SupplierAccount {
        supplier_id, name, id_type: t, id_number: n, phone, docs, payments,
        aging_usd_minor: aging, not_due_usd_minor: not_due, debt_usd_minor: debt,
    })
}

// ---------- Pagos ----------
#[tauri::command]
pub async fn ap_pay(state: State<'_, AppState>, input: PayInput) -> Result<i64, AppError> {
    let me = security::require_role(&state, &["admin"])?;
    if input.amount_minor <= 0 {
        return Err(AppError::Validation("El monto del pago debe ser mayor que cero".into()));
    }
    if !CURRENCIES.contains(&input.currency_code.as_str()) {
        return Err(AppError::Validation("Moneda inválida".into()));
    }
    if !METHODS.contains(&input.method.as_str()) {
        return Err(AppError::Validation("Método de pago inválido".into()));
    }
    let cur = input.currency_code.as_str();

    let mut db = state.conn()?;
    let tx = db.transaction()?;

    // El efectivo sale de la caja abierta del administrador.
    let session_id: Option<i64> = if input.method == "efectivo" {
        Some(
            tx.query_row(
                "SELECT id FROM cash_sessions WHERE user_id = ?1 AND closed_at IS NULL",
                [me.id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| {
                AppError::Validation("Abre tu caja para pagar en efectivo (menú Caja)".into())
            })?,
        )
    } else {
        None
    };

    let rate = usd_rate(&tx)?;
    let mut docs = open_purchases(&tx, Some(input.supplier_id))?;
    if let Some(pid) = input.purchase_id {
        docs.retain(|(_, d, _)| d.id == pid);
    }
    if docs.is_empty() {
        return Err(AppError::Validation("No hay deudas pendientes con este proveedor".into()));
    }

    // Reparto del pago, de la deuda más antigua a la más nueva.
    let mut remaining = input.amount_minor;
    let mut allocs: Vec<(i64, i64)> = Vec::new(); // (purchase_id, aplicado en moneda de la compra)
    for (_, d, bal) in &docs {
        if remaining <= 0 {
            break;
        }
        let needed = convert(*bal, &d.currency_code, cur, rate)?;
        if remaining >= needed {
            allocs.push((d.id, *bal));
            remaining -= needed;
        } else {
            let applied = convert(remaining, cur, &d.currency_code, rate)?.min(*bal);
            if applied > 0 {
                allocs.push((d.id, applied));
            }
            remaining = 0;
        }
    }
    let tol = if docs.iter().any(|(_, d, _)| d.currency_code != cur) {
        match (cur, rate) {
            ("VES", Some(r)) => (r + 999_999) / 1_000_000,
            _ => 1,
        }
    } else {
        0
    };
    if remaining > tol {
        return Err(AppError::Validation(format!(
            "El pago excede la deuda pendiente por {} {}",
            fmt_minor(remaining),
            cur
        )));
    }
    if allocs.is_empty() {
        return Err(AppError::Validation("El monto es demasiado pequeño para aplicarse".into()));
    }
    let amount = input.amount_minor - remaining.max(0);

    let number: i64 = tx.query_row(
        "SELECT next_number FROM document_series WHERE doc_type = 'PAGO' AND series = 'P'",
        [],
        |r| r.get(0),
    )?;
    tx.execute(
        "UPDATE document_series SET next_number = next_number + 1
         WHERE doc_type = 'PAGO' AND series = 'P'",
        [],
    )?;
    let reference = input.reference.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let notes = input.notes.as_deref().map(str::trim).filter(|s| !s.is_empty());
    tx.execute(
        "INSERT INTO ap_payments (number, supplier_id, method, currency_code, amount_minor,
            exchange_rate_micro, reference, notes, user_id, cash_session_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![number, input.supplier_id, input.method, cur, amount, rate.unwrap_or(1_000_000),
                reference, notes, me.id, session_id],
    )?;
    let payment_id = tx.last_insert_rowid();
    for (pid, applied) in &allocs {
        tx.execute(
            "INSERT INTO ap_allocations (payment_id, purchase_id, applied_doc_minor) VALUES (?1, ?2, ?3)",
            params![payment_id, pid, applied],
        )?;
    }
    let detail = format!("P-{number:06}: {} {} ({})", fmt_minor(amount), cur, input.method);
    audit::log(&tx, Some(me.id), "ap_payment", Some("supplier"), Some(input.supplier_id), Some(&detail))?;
    tx.commit()?;
    Ok(payment_id)
}

#[tauri::command]
pub async fn ap_void_payment(state: State<'_, AppState>, id: i64, reason: String) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let reason = reason.trim().to_string();
    if reason.chars().count() < 5 {
        return Err(AppError::Validation("Indica el motivo de la anulación (mínimo 5 caracteres)".into()));
    }
    let mut db = state.conn()?;
    let tx = db.transaction()?;
    let (supplier_id, number, voided, session): (i64, i64, Option<String>, Option<i64>) = tx
        .query_row(
            "SELECT supplier_id, number, voided_at, cash_session_id FROM ap_payments WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("El pago no existe".into()))?;
    if voided.is_some() {
        return Err(AppError::Validation("El pago ya está anulado".into()));
    }
    if let Some(sid) = session {
        let closed: Option<String> =
            tx.query_row("SELECT closed_at FROM cash_sessions WHERE id = ?1", [sid], |r| r.get(0))?;
        if closed.is_some() {
            return Err(AppError::Validation(
                "La caja de la que salió este pago ya fue cerrada: no se puede anular".into(),
            ));
        }
    }
    tx.execute(
        "UPDATE ap_payments SET voided_at = datetime('now'), void_reason = ?2, voided_by = ?3 WHERE id = ?1",
        params![id, reason, me.id],
    )?;
    let detail = format!("P-{number:06} anulado | motivo: {reason}");
    audit::log(&tx, Some(me.id), "ap_payment_voided", Some("supplier"), Some(supplier_id), Some(&detail))?;
    tx.commit()?;
    Ok(())
}

// ---------- Comprobante de pago ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayAlloc {
    purchase_number: i64,
    invoice_number: Option<String>,
    currency_code: String,
    applied_minor: i64,
    balance_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentDetail {
    id: i64,
    number: i64,
    created_at: String,
    method: String,
    currency_code: String,
    amount_minor: i64,
    exchange_rate_micro: i64,
    reference: Option<String>,
    notes: Option<String>,
    user: Option<String>,
    voided: bool,
    void_reason: Option<String>,
    supplier_name: String,
    supplier_id_type: String,
    supplier_id_number: String,
    issuer_name: String,
    issuer_rif: String,
    issuer_address: String,
    allocations: Vec<PayAlloc>,
}

#[tauri::command]
pub async fn ap_get_payment(state: State<'_, AppState>, id: i64) -> Result<PaymentDetail, AppError> {
    security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    let mut d = db
        .query_row(
            "SELECT p.id, p.number, p.created_at, p.method, p.currency_code, p.amount_minor,
                    p.exchange_rate_micro, p.reference, p.notes, u.username,
                    s.name, s.id_type, s.id_number, p.voided_at, p.void_reason
             FROM ap_payments p
             JOIN suppliers s ON s.id = p.supplier_id
             LEFT JOIN users u ON u.id = p.user_id
             WHERE p.id = ?1",
            [id],
            |r| {
                Ok(PaymentDetail {
                    id: r.get(0)?, number: r.get(1)?, created_at: r.get(2)?, method: r.get(3)?,
                    currency_code: r.get(4)?, amount_minor: r.get(5)?, exchange_rate_micro: r.get(6)?,
                    reference: r.get(7)?, notes: r.get(8)?, user: r.get(9)?,
                    voided: r.get::<_, Option<String>>(13)?.is_some(),
                    void_reason: r.get(14)?,
                    supplier_name: r.get(10)?, supplier_id_type: r.get(11)?, supplier_id_number: r.get(12)?,
                    issuer_name: String::new(), issuer_rif: String::new(), issuer_address: String::new(),
                    allocations: vec![],
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("El pago no existe".into()))?;

    let (rif, name, addr): (String, String, String) = db.query_row(
        "SELECT rif, legal_name, fiscal_address FROM company WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    d.issuer_rif = rif;
    d.issuer_name = name;
    d.issuer_address = addr;

    let sql = format!(
        "SELECT p.number, p.invoice_number, p.currency_code, a.applied_doc_minor, {BALANCE_SQL}
         FROM ap_allocations a JOIN purchases p ON p.id = a.purchase_id
         WHERE a.payment_id = ?1 ORDER BY a.id"
    );
    d.allocations = db
        .prepare(&sql)?
        .query_map([id], |r| {
            Ok(PayAlloc {
                purchase_number: r.get(0)?, invoice_number: r.get(1)?, currency_code: r.get(2)?,
                applied_minor: r.get(3)?, balance_minor: r.get::<_, i64>(4)?.max(0),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(d)
}
