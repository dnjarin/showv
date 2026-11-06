//! Cuentas por cobrar: ventas a crédito, abonos y antigüedad de saldos.
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

/// Saldo pendiente de una venta a crédito, en la moneda del documento.
/// Fórmula: total − pago inicial − abonos − devoluciones aplicadas al saldo − retenciones sufridas.
pub(crate) const BALANCE_SQL: &str = "
    d.total_minor - d.paid_initial_minor
    - COALESCE((SELECT SUM(a.applied_doc_minor) FROM ar_allocations a
                JOIN ar_receipts v ON v.id = a.receipt_id
                WHERE a.document_id = d.id AND v.voided_at IS NULL), 0)
    - COALESCE((SELECT SUM(r.balance_applied_minor) FROM documents r
                WHERE r.related_document_id = d.id AND r.doc_type = 'DEVOLUCION'
                  AND r.status = 'issued'), 0)
    - COALESCE((SELECT SUM(w.amount_minor) FROM ar_withholdings w
                WHERE w.document_id = d.id AND w.voided_at IS NULL), 0)";

pub fn balance_of(conn: &Connection, doc_id: i64) -> Result<i64, AppError> {
    let sql = format!(
        "SELECT {BALANCE_SQL} FROM documents d
         WHERE d.id = ?1 AND d.credit_sale = 1 AND d.status = 'issued'"
    );
    Ok(conn.query_row(&sql, [doc_id], |r| r.get(0)).optional()?.unwrap_or(0).max(0))
}

/// Saldo a favor del cliente en una moneda.
pub fn credit_balance(conn: &Connection, customer_id: i64, cur: &str) -> Result<i64, AppError> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM ar_credit_entries
         WHERE customer_id = ?1 AND currency_code = ?2",
        params![customer_id, cur],
        |r| r.get(0),
    )?)
}

/// Inserta un recibo con su número consecutivo. Devuelve (id, número).
#[allow(clippy::too_many_arguments)]
fn insert_receipt(
    tx: &Connection,
    customer_id: i64,
    method: &str,
    cur: &str,
    amount: i64,
    rate: Option<i64>,
    reference: Option<&str>,
    notes: Option<&str>,
    user_id: i64,
    session_id: Option<i64>,
) -> Result<(i64, i64), AppError> {
    let number: i64 = tx.query_row(
        "SELECT next_number FROM document_series WHERE doc_type = 'RECIBO' AND series = 'R'",
        [],
        |r| r.get(0),
    )?;
    tx.execute(
        "UPDATE document_series SET next_number = next_number + 1
         WHERE doc_type = 'RECIBO' AND series = 'R'",
        [],
    )?;
    tx.execute(
        "INSERT INTO ar_receipts (number, customer_id, method, currency_code, amount_minor,
            exchange_rate_micro, reference, notes, user_id, cash_session_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![number, customer_id, method, cur, amount, rate.unwrap_or(1_000_000),
                reference, notes, user_id, session_id],
    )?;
    Ok((tx.last_insert_rowid(), number))
}

fn add_credit_entry(
    tx: &Connection,
    customer_id: i64,
    cur: &str,
    amount: i64,
    kind: &str,
    receipt_id: i64,
) -> Result<(), AppError> {
    tx.execute(
        "INSERT INTO ar_credit_entries (customer_id, currency_code, amount_minor, kind, receipt_id)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![customer_id, cur, amount, kind, receipt_id],
    )?;
    Ok(())
}

/// Deuda total del cliente expresada en USD (para validar el límite de crédito).
pub fn outstanding_usd(conn: &Connection, customer_id: i64, rate: Option<i64>) -> Result<i64, AppError> {
    let sql = format!(
        "SELECT d.currency_code, {BALANCE_SQL} FROM documents d
         WHERE d.customer_id = ?1 AND d.credit_sale = 1 AND d.status = 'issued'"
    );
    let rows = conn
        .prepare(&sql)?
        .query_map([customer_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut total = 0i64;
    for (cur, bal) in rows {
        if bal > 0 {
            total += convert(bal, &cur, "USD", rate)?;
        }
    }
    Ok(total)
}

// ---------- Salidas ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditInfo {
    limit_usd_minor: i64,
    credit_days: i64,
    outstanding_usd_minor: i64,
    available_usd_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtorRow {
    customer_id: i64,
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
pub struct OpenDoc {
    id: i64,
    series: String,
    number: i64,
    issued_at: String,
    due_date: Option<String>,
    currency_code: String,
    total_minor: i64,
    balance_minor: i64,
    days_overdue: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptRow {
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
pub struct CustomerAccount {
    customer_id: i64,
    name: String,
    id_type: String,
    id_number: String,
    phone: Option<String>,
    credit: CreditInfo,
    docs: Vec<OpenDoc>,
    receipts: Vec<ReceiptRow>,
    aging_usd_minor: [i64; 4], // 1-15, 16-30, 31-60, +60 días de atraso (en USD equiv.)
    not_due_usd_minor: i64,
    credit_ves_minor: i64,
    credit_usd_minor: i64,
    issuer_name: String,
    issuer_rif: String,
    issuer_address: String,
}

fn credit_info(conn: &Connection, customer_id: i64) -> Result<CreditInfo, AppError> {
    let (limit, days): (i64, i64) = conn
        .query_row(
            "SELECT credit_limit_usd_minor, credit_days FROM customers WHERE id = ?1",
            [customer_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("Cliente no encontrado".into()))?;
    let rate = usd_rate(conn)?;
    let out = outstanding_usd(conn, customer_id, rate).unwrap_or(0);
    Ok(CreditInfo {
        limit_usd_minor: limit,
        credit_days: days,
        outstanding_usd_minor: out,
        available_usd_minor: (limit - out).max(0),
    })
}

fn open_docs(conn: &Connection, customer_id: Option<i64>) -> Result<Vec<(i64, OpenDoc, i64)>, AppError> {
    // Devuelve (customer_id, documento, id) ordenado por vencimiento.
    let sql = format!(
        "SELECT d.customer_id, d.id, d.series, d.number, d.issued_at, d.due_date, d.currency_code,
                d.total_minor, {BALANCE_SQL} AS bal,
                CASE WHEN d.due_date IS NULL THEN 0
                     ELSE CAST(julianday(date('now','localtime')) - julianday(d.due_date) AS INTEGER) END
         FROM documents d
         WHERE d.credit_sale = 1 AND d.status = 'issued' AND d.customer_id IS NOT NULL
           AND (?1 IS NULL OR d.customer_id = ?1)
         ORDER BY COALESCE(d.due_date, d.issued_at), d.id"
    );
    let rows = conn
        .prepare(&sql)?
        .query_map([customer_id], |r| {
            let bal: i64 = r.get(8)?;
            Ok((
                r.get::<_, i64>(0)?,
                OpenDoc {
                    id: r.get(1)?, series: r.get(2)?, number: r.get(3)?, issued_at: r.get(4)?,
                    due_date: r.get(5)?, currency_code: r.get(6)?, total_minor: r.get(7)?,
                    balance_minor: bal, days_overdue: r.get(9)?,
                },
                bal,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows.into_iter().filter(|(_, _, b)| *b > 0).map(|(c, d, b)| (c, d, b)).collect())
}

// ---------- Comandos ----------
#[tauri::command]
pub async fn ar_credit_info(state: State<'_, AppState>, customer_id: i64) -> Result<CreditInfo, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;
    credit_info(&db, customer_id)
}

#[tauri::command]
pub async fn ar_summary(state: State<'_, AppState>) -> Result<Vec<DebtorRow>, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;
    let docs = open_docs(&db, None)?;
    let mut rows: Vec<DebtorRow> = Vec::new();
    for (cid, d, bal) in docs {
        let idx = match rows.iter().position(|r| r.customer_id == cid) {
            Some(i) => i,
            None => {
                let (name, t, n): (String, String, String) = db.query_row(
                    "SELECT name, id_type, id_number FROM customers WHERE id = ?1",
                    [cid],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
                rows.push(DebtorRow {
                    customer_id: cid, name, id_type: t, id_number: n, docs: 0,
                    balance_usd_minor: 0, balance_ves_minor: 0, overdue_docs: 0, max_days_overdue: 0,
                });
                rows.len() - 1
            }
        };
        let r = &mut rows[idx];
        r.docs += 1;
        if d.currency_code == "USD" {
            r.balance_usd_minor += bal;
        } else {
            r.balance_ves_minor += bal;
        }
        if d.days_overdue > 0 {
            r.overdue_docs += 1;
            r.max_days_overdue = r.max_days_overdue.max(d.days_overdue);
        }
    }
    rows.sort_by(|a, b| b.max_days_overdue.cmp(&a.max_days_overdue).then(a.name.cmp(&b.name)));
    Ok(rows)
}

#[tauri::command]
pub async fn ar_customer(state: State<'_, AppState>, customer_id: i64) -> Result<CustomerAccount, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;
    let (name, t, n, phone): (String, String, String, Option<String>) = db
        .query_row(
            "SELECT name, id_type, id_number, phone FROM customers WHERE id = ?1",
            [customer_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("Cliente no encontrado".into()))?;

    let rate = usd_rate(&db)?;
    let docs: Vec<OpenDoc> = open_docs(&db, Some(customer_id))?.into_iter().map(|(_, d, _)| d).collect();

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

    let receipts = db
        .prepare(
            "SELECT id, number, created_at, method, currency_code, amount_minor, voided_at IS NOT NULL
             FROM ar_receipts WHERE customer_id = ?1 ORDER BY id DESC LIMIT 30",
        )?
        .query_map([customer_id], |r| {
            Ok(ReceiptRow {
                id: r.get(0)?, number: r.get(1)?, created_at: r.get(2)?, method: r.get(3)?,
                currency_code: r.get(4)?, amount_minor: r.get(5)?,
                voided: r.get::<_, i64>(6)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let (irif, iname, iaddr): (String, String, String) = db.query_row(
        "SELECT rif, legal_name, fiscal_address FROM company WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;

    Ok(CustomerAccount {
        customer_id, name, id_type: t, id_number: n, phone,
        credit: credit_info(&db, customer_id)?,
        docs, receipts, aging_usd_minor: aging, not_due_usd_minor: not_due,
        credit_ves_minor: credit_balance(&db, customer_id, "VES")?,
        credit_usd_minor: credit_balance(&db, customer_id, "USD")?,
        issuer_name: iname, issuer_rif: irif, issuer_address: iaddr,
    })
}

#[tauri::command]
pub async fn ar_set_credit(
    state: State<'_, AppState>,
    customer_id: i64,
    limit_usd_minor: i64,
    credit_days: i64,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    if limit_usd_minor < 0 || limit_usd_minor > 100_000_000_00 {
        return Err(AppError::Validation("Límite de crédito inválido".into()));
    }
    if !(0..=365).contains(&credit_days) {
        return Err(AppError::Validation("Los días de plazo deben estar entre 0 y 365".into()));
    }
    let db = state.conn()?;
    let n = db.execute(
        "UPDATE customers SET credit_limit_usd_minor = ?2, credit_days = ?3 WHERE id = ?1",
        params![customer_id, limit_usd_minor, credit_days],
    )?;
    if n == 0 {
        return Err(AppError::Validation("Cliente no encontrado".into()));
    }
    let detail = format!("límite USD {} / plazo {} días", fmt_minor(limit_usd_minor), credit_days);
    audit::log(&db, Some(me.id), "credit_terms_set", Some("customer"), Some(customer_id), Some(&detail))?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiveInput {
    customer_id: i64,
    /// Si es None, el abono se aplica a las deudas más antiguas primero.
    document_id: Option<i64>,
    method: String,
    currency_code: String,
    amount_minor: i64,
    reference: Option<String>,
    notes: Option<String>,
    /// Si el abono excede la deuda (o no hay deuda), el excedente queda como saldo a favor.
    #[serde(default)]
    allow_advance: bool,
}

#[tauri::command]
pub async fn ar_receive(state: State<'_, AppState>, input: ReceiveInput) -> Result<i64, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    if input.amount_minor <= 0 {
        return Err(AppError::Validation("El monto del abono debe ser mayor que cero".into()));
    }
    if !CURRENCIES.contains(&input.currency_code.as_str()) {
        return Err(AppError::Validation("Moneda inválida".into()));
    }
    if !METHODS.contains(&input.method.as_str()) {
        return Err(AppError::Validation("Método de pago inválido".into()));
    }

    let mut db = state.conn()?;
    let tx = db.transaction()?;
    let session_id: i64 = tx
        .query_row(
            "SELECT id FROM cash_sessions WHERE user_id = ?1 AND closed_at IS NULL",
            [me.id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("Abre tu caja antes de cobrar un abono (menú Caja)".into()))?;

    let rate = usd_rate(&tx)?;
    let mut docs = open_docs(&tx, Some(input.customer_id))?;
    if let Some(doc_id) = input.document_id {
        docs.retain(|(_, d, _)| d.id == doc_id);
    }
    if docs.is_empty() && !input.allow_advance {
        return Err(AppError::Validation(
            "El cliente no tiene deudas pendientes. Marca «Guardar excedente como saldo a favor» para registrar un anticipo".into(),
        ));
    }

    // Reparto del abono, de la deuda más antigua a la más nueva.
    let cur = input.currency_code.as_str();
    let mut remaining = input.amount_minor;
    let mut allocs: Vec<(i64, i64)> = Vec::new(); // (document_id, aplicado en moneda del documento)
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
    // Sobrante: el redondeo entre monedas se tolera; lo demás es excedente.
    let tol = if docs.iter().any(|(_, d, _)| d.currency_code != cur) {
        match (cur, rate) {
            ("VES", Some(r)) => (r + 999_999) / 1_000_000,
            _ => 1,
        }
    } else {
        0
    };
    let advance = if remaining > tol { remaining } else { 0 };
    if advance > 0 && !input.allow_advance {
        return Err(AppError::Validation(format!(
            "El abono excede la deuda pendiente por {} {}. Marca «Guardar excedente como saldo a favor» si quieres registrarlo como anticipo",
            fmt_minor(advance),
            cur
        )));
    }
    if allocs.is_empty() && advance == 0 {
        return Err(AppError::Validation("El monto es demasiado pequeño para aplicarse".into()));
    }
    let amount = input.amount_minor - if advance > 0 { 0 } else { remaining.max(0) };

    let reference = input.reference.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let notes = input.notes.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let (receipt_id, number) = insert_receipt(
        &tx, input.customer_id, &input.method, cur, amount, rate, reference, notes, me.id, Some(session_id),
    )?;
    for (doc_id, applied) in &allocs {
        tx.execute(
            "INSERT INTO ar_allocations (receipt_id, document_id, applied_doc_minor) VALUES (?1, ?2, ?3)",
            params![receipt_id, doc_id, applied],
        )?;
    }
    if advance > 0 {
        add_credit_entry(&tx, input.customer_id, cur, advance, "anticipo", receipt_id)?;
    }
    let mut detail = format!("R-{number:06}: {} {} ({})", fmt_minor(amount), cur, input.method);
    if advance > 0 {
        detail.push_str(&format!(" | saldo a favor {}", fmt_minor(advance)));
    }
    audit::log(&tx, Some(me.id), "ar_receipt", Some("customer"), Some(input.customer_id), Some(&detail))?;
    tx.commit()?;
    Ok(receipt_id)
}

/// Aplica el saldo a favor del cliente a sus deudas (de la más antigua a la más nueva).
/// Genera un recibo con forma de pago «saldo_favor» por cada moneda utilizada.
#[tauri::command]
pub async fn ar_apply_credit(
    state: State<'_, AppState>,
    customer_id: i64,
    document_id: Option<i64>,
) -> Result<Vec<i64>, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    let mut db = state.conn()?;
    let tx = db.transaction()?;
    let rate = usd_rate(&tx)?;

    let mut docs = open_docs(&tx, Some(customer_id))?;
    if let Some(doc_id) = document_id {
        docs.retain(|(_, d, _)| d.id == doc_id);
    }
    if docs.is_empty() {
        return Err(AppError::Validation("El cliente no tiene deudas pendientes".into()));
    }

    let mut avail: Vec<(&str, i64)> = vec![
        ("VES", credit_balance(&tx, customer_id, "VES")?),
        ("USD", credit_balance(&tx, customer_id, "USD")?),
    ];
    if avail.iter().all(|a| a.1 <= 0) {
        return Err(AppError::Validation("El cliente no tiene saldo a favor".into()));
    }
    // moneda del saldo -> (total usado, aplicaciones)
    let mut used: Vec<(&str, i64, Vec<(i64, i64)>)> = vec![("VES", 0, vec![]), ("USD", 0, vec![])];

    for (_, d, bal) in &docs {
        let mut b = *bal;
        let order: [&str; 2] = if d.currency_code == "USD" { ["USD", "VES"] } else { ["VES", "USD"] };
        for c in order {
            if b <= 0 {
                break;
            }
            let slot = avail.iter_mut().find(|x| x.0 == c).unwrap();
            if slot.1 <= 0 {
                continue;
            }
            let needed = match convert(b, &d.currency_code, c, rate) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let (used_c, applied_doc) = if slot.1 >= needed {
                (needed, b)
            } else {
                match convert(slot.1, c, &d.currency_code, rate) {
                    Ok(v) => (slot.1, v.min(b)),
                    Err(_) => continue,
                }
            };
            if used_c <= 0 || applied_doc <= 0 {
                continue;
            }
            slot.1 -= used_c;
            b -= applied_doc;
            let u = used.iter_mut().find(|x| x.0 == c).unwrap();
            u.1 += used_c;
            u.2.push((d.id, applied_doc));
        }
    }

    let mut ids = Vec::new();
    for (c, total, allocs) in used {
        if total <= 0 || allocs.is_empty() {
            continue;
        }
        let (rid, number) = insert_receipt(
            &tx, customer_id, "saldo_favor", c, total, rate, None, Some("Aplicación de saldo a favor"), me.id, None,
        )?;
        for (doc_id, applied) in allocs {
            tx.execute(
                "INSERT INTO ar_allocations (receipt_id, document_id, applied_doc_minor) VALUES (?1, ?2, ?3)",
                params![rid, doc_id, applied],
            )?;
        }
        add_credit_entry(&tx, customer_id, c, -total, "aplicacion", rid)?;
        let detail = format!("R-{number:06}: saldo a favor aplicado {} {}", fmt_minor(total), c);
        audit::log(&tx, Some(me.id), "ar_credit_applied", Some("customer"), Some(customer_id), Some(&detail))?;
        ids.push(rid);
    }
    if ids.is_empty() {
        return Err(AppError::Validation(
            "No se pudo aplicar el saldo a favor (¿falta la tasa USD para convertir entre monedas?)".into(),
        ));
    }
    tx.commit()?;
    Ok(ids)
}

/// Anula un recibo: la deuda vuelve a su saldo anterior. Solo el administrador.
#[tauri::command]
pub async fn ar_void_receipt(state: State<'_, AppState>, id: i64, reason: String) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let reason = reason.trim().to_string();
    if reason.chars().count() < 5 {
        return Err(AppError::Validation("Indica el motivo de la anulación (mínimo 5 caracteres)".into()));
    }
    let mut db = state.conn()?;
    let tx = db.transaction()?;
    let (customer_id, number, method, cur, amount, voided, session): (i64, i64, String, String, i64, Option<String>, Option<i64>) = tx
        .query_row(
            "SELECT customer_id, number, method, currency_code, amount_minor, voided_at, cash_session_id
             FROM ar_receipts WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("El recibo no existe".into()))?;
    if voided.is_some() {
        return Err(AppError::Validation("El recibo ya está anulado".into()));
    }

    if method == "saldo_favor" {
        // Se devuelve el saldo a favor que había sido consumido.
        add_credit_entry(&tx, customer_id, &cur, amount, "reverso", id)?;
    } else {
        // El dinero se cobró en una caja: solo se puede revertir mientras esa caja siga abierta.
        if let Some(sid) = session {
            let closed: Option<String> = tx.query_row(
                "SELECT closed_at FROM cash_sessions WHERE id = ?1",
                [sid],
                |r| r.get(0),
            )?;
            if closed.is_some() {
                return Err(AppError::Validation(
                    "La caja donde se cobró este recibo ya fue cerrada: no se puede anular. Corrige con un ajuste manual".into(),
                ));
            }
        }
        // Si el abono generó saldo a favor, ese saldo no debe haberse usado.
        let advance: i64 = tx.query_row(
            "SELECT COALESCE(SUM(amount_minor), 0) FROM ar_credit_entries
             WHERE receipt_id = ?1 AND kind = 'anticipo'",
            [id],
            |r| r.get(0),
        )?;
        if advance > 0 {
            if credit_balance(&tx, customer_id, &cur)? < advance {
                return Err(AppError::Validation(
                    "El saldo a favor generado por este abono ya fue utilizado: anula primero esa aplicación".into(),
                ));
            }
            add_credit_entry(&tx, customer_id, &cur, -advance, "reverso", id)?;
        }
    }

    tx.execute(
        "UPDATE ar_receipts SET voided_at = datetime('now'), void_reason = ?2, voided_by = ?3 WHERE id = ?1",
        params![id, reason, me.id],
    )?;
    let detail = format!("R-{number:06} anulado | motivo: {reason}");
    audit::log(&tx, Some(me.id), "ar_receipt_voided", Some("customer"), Some(customer_id), Some(&detail))?;
    tx.commit()?;
    Ok(())
}

// ---------- Recibo ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocOut {
    series: String,
    number: i64,
    currency_code: String,
    applied_minor: i64,
    balance_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptDetail {
    id: i64,
    number: i64,
    created_at: String,
    method: String,
    currency_code: String,
    amount_minor: i64,
    exchange_rate_micro: i64,
    reference: Option<String>,
    notes: Option<String>,
    cashier: Option<String>,
    voided: bool,
    void_reason: Option<String>,
    advance_minor: i64,
    customer_name: String,
    customer_id_type: String,
    customer_id_number: String,
    issuer_name: String,
    issuer_rif: String,
    issuer_address: String,
    legend: Option<String>,
    allocations: Vec<AllocOut>,
}

#[tauri::command]
pub async fn ar_get_receipt(state: State<'_, AppState>, id: i64) -> Result<ReceiptDetail, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;
    let mut d = db
        .query_row(
            "SELECT r.id, r.number, r.created_at, r.method, r.currency_code, r.amount_minor,
                    r.exchange_rate_micro, r.reference, r.notes, u.username,
                    c.name, c.id_type, c.id_number, r.voided_at, r.void_reason
             FROM ar_receipts r
             JOIN customers c ON c.id = r.customer_id
             LEFT JOIN users u ON u.id = r.user_id
             WHERE r.id = ?1",
            [id],
            |r| {
                Ok(ReceiptDetail {
                    id: r.get(0)?, number: r.get(1)?, created_at: r.get(2)?, method: r.get(3)?,
                    currency_code: r.get(4)?, amount_minor: r.get(5)?, exchange_rate_micro: r.get(6)?,
                    reference: r.get(7)?, notes: r.get(8)?, cashier: r.get(9)?,
                    voided: r.get::<_, Option<String>>(13)?.is_some(),
                    void_reason: r.get(14)?,
                    advance_minor: 0,
                    customer_name: r.get(10)?, customer_id_type: r.get(11)?, customer_id_number: r.get(12)?,
                    issuer_name: String::new(), issuer_rif: String::new(), issuer_address: String::new(),
                    legend: None, allocations: vec![],
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("El recibo no existe".into()))?;

    let (rif, name, addr): (String, String, String) = db.query_row(
        "SELECT rif, legal_name, fiscal_address FROM company WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    d.issuer_rif = rif;
    d.issuer_name = name;
    d.issuer_address = addr;

    let rows = db
        .prepare(
            "SELECT doc.id, doc.series, doc.number, doc.currency_code, a.applied_doc_minor
             FROM ar_allocations a JOIN documents doc ON doc.id = a.document_id
             WHERE a.receipt_id = ?1 ORDER BY a.id",
        )?
        .query_map([id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?, r.get::<_, i64>(4)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (doc_id, series, number, cur, applied) in rows {
        d.allocations.push(AllocOut {
            series, number, currency_code: cur, applied_minor: applied,
            balance_minor: balance_of(&db, doc_id)?,
        });
    }
    d.advance_minor = db.query_row(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM ar_credit_entries
         WHERE receipt_id = ?1 AND kind = 'anticipo'",
        [id],
        |r| r.get(0),
    )?;
    d.legend = db
        .query_row("SELECT value FROM settings WHERE key = 'receipt_legend'", [], |r| r.get(0))
        .optional()?;
    Ok(d)
}