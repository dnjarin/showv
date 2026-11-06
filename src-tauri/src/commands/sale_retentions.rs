//! Retenciones sufridas: IVA o ISLR que un cliente nos retiene al pagar una venta a crédito.
use crate::{audit, commands::receivables, error::AppError, security, state::AppState};
use chrono::{Local, NaiveDate};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

const KINDS: &[&str] = &["IVA", "ISLR"];

fn div_round(n: i128, d: i128) -> i64 {
    ((n + d / 2) / d) as i64
}

/// Monto en bolívares -> moneda de la venta, con la tasa de la propia venta.
fn to_doc_cur(ves_minor: i64, cur: &str, rate_micro: i64) -> Result<i64, AppError> {
    if cur == "VES" {
        return Ok(ves_minor);
    }
    if rate_micro <= 0 {
        return Err(AppError::Validation(
            "La venta no tiene una tasa válida".into(),
        ));
    }
    Ok(div_round(ves_minor as i128 * 1_000_000, rate_micro as i128))
}

fn date_arg(s: &str, what: &str) -> Result<NaiveDate, AppError> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
        .map_err(|_| AppError::Validation(format!("Fecha «{what}» inválida")))
}

// ---------- Datos de la venta para el formulario ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocInfo {
    document_id: i64,
    label: String,
    currency_code: String,
    exchange_rate_micro: i64,
    balance_minor: i64,
    tax_minor: i64,
    tax_ves_minor: i64,
    subtotal_ves_minor: i64,
    iva_default_bp: i64,
}

#[tauri::command]
pub async fn sret_doc_info(
    state: State<'_, AppState>,
    document_id: i64,
) -> Result<DocInfo, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;
    let (series, number, cur, rate, tax, sub, credit, status): (
        String,
        i64,
        String,
        i64,
        i64,
        i64,
        i64,
        String,
    ) = db
        .query_row(
            "SELECT series, number, currency_code, exchange_rate_micro, tax_minor, subtotal_minor,
                    credit_sale, status
             FROM documents WHERE id = ?1 AND doc_type <> 'DEVOLUCION'",
            [document_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("La venta no existe".into()))?;
    if status != "issued" || credit == 0 {
        return Err(AppError::Validation(
            "Solo se registran retenciones sobre ventas a crédito vigentes".into(),
        ));
    }
    let to_ves = |m: i64| -> i64 {
        if cur == "VES" {
            m
        } else {
            div_round(m as i128 * rate as i128, 1_000_000)
        }
    };
    let iva_default_bp: i64 = db
        .query_row(
            "SELECT value FROM settings WHERE key = 'wh_iva_default_bp'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(7500);
    Ok(DocInfo {
        document_id,
        label: format!("{series}-{number:06}"),
        currency_code: cur.clone(),
        exchange_rate_micro: rate,
        balance_minor: receivables::balance_of(&db, document_id)?,
        tax_minor: tax,
        tax_ves_minor: to_ves(tax),
        subtotal_ves_minor: to_ves(sub),
        iva_default_bp,
    })
}

// ---------- Registrar ----------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterInput {
    document_id: i64,
    kind: String,
    voucher_number: String,
    voucher_date: String,
    amount_ves_minor: i64,
    notes: Option<String>,
}

#[tauri::command]
pub async fn sret_register(
    state: State<'_, AppState>,
    input: RegisterInput,
) -> Result<i64, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    if !KINDS.contains(&input.kind.as_str()) {
        return Err(AppError::Validation("Tipo de retención inválido".into()));
    }
    let voucher = input.voucher_number.trim().to_string();
    if voucher.is_empty() || voucher.chars().count() > 40 {
        return Err(AppError::Validation(
            "Indica el número del comprobante (máximo 40 caracteres)".into(),
        ));
    }
    let date = date_arg(&input.voucher_date, "comprobante")?;
    if date > Local::now().date_naive() {
        return Err(AppError::Validation(
            "La fecha del comprobante no puede ser futura".into(),
        ));
    }
    if input.amount_ves_minor <= 0 || input.amount_ves_minor > 100_000_000_000 {
        return Err(AppError::Validation("Monto retenido inválido".into()));
    }
    let notes = input
        .notes
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    if notes.as_ref().is_some_and(|n| n.chars().count() > 200) {
        return Err(AppError::Validation(
            "Las notas son demasiado largas (máximo 200)".into(),
        ));
    }

    let mut db = state.conn()?;
    let tx = db.transaction()?;
    let (customer_id, series, number, cur, rate, credit, status): (Option<i64>, String, i64, String, i64, i64, String) = tx
        .query_row(
            "SELECT customer_id, series, number, currency_code, exchange_rate_micro, credit_sale, status
             FROM documents WHERE id = ?1 AND doc_type <> 'DEVOLUCION'",
            [input.document_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("La venta no existe".into()))?;
    let customer_id =
        customer_id.ok_or_else(|| AppError::Validation("La venta no tiene cliente".into()))?;
    if status != "issued" || credit == 0 {
        return Err(AppError::Validation(
            "Solo se registran retenciones sobre ventas a crédito vigentes".into(),
        ));
    }
    let amount = to_doc_cur(input.amount_ves_minor, &cur, rate)?;
    if amount <= 0 {
        return Err(AppError::Validation("El monto es demasiado pequeño".into()));
    }
    let balance = receivables::balance_of(&tx, input.document_id)?;
    if amount > balance {
        return Err(AppError::Validation(
            "La retención supera el saldo pendiente de la venta".into(),
        ));
    }
    let dup: i64 = tx.query_row(
        "SELECT COUNT(*) FROM ar_withholdings
         WHERE customer_id = ?1 AND kind = ?2 AND voucher_number = ?3 COLLATE NOCASE AND voided_at IS NULL",
        params![customer_id, input.kind, voucher],
        |r| r.get(0),
    )?;
    if dup > 0 {
        return Err(AppError::Validation(
            "Ese comprobante ya está registrado para este cliente".into(),
        ));
    }
    let period = date.format("%Y-%m").to_string();
    tx.execute(
        "INSERT INTO ar_withholdings (document_id, customer_id, kind, voucher_number, voucher_date, period,
            amount_ves_minor, amount_minor, exchange_rate_micro, notes, user_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            input.document_id, customer_id, input.kind, voucher, date.format("%Y-%m-%d").to_string(), period,
            input.amount_ves_minor, amount, rate, notes, me.id
        ],
    )?;
    let id = tx.last_insert_rowid();
    let detail = format!(
        "{} {} sobre {series}-{number:06}: Bs. {}",
        input.kind, voucher, input.amount_ves_minor
    );
    audit::log(
        &tx,
        Some(me.id),
        "ar_withholding_registered",
        Some("ar_withholding"),
        Some(id),
        Some(&detail),
    )?;
    tx.commit()?;
    Ok(id)
}

// ---------- Anular ----------
#[tauri::command]
pub async fn sret_void(
    state: State<'_, AppState>,
    id: i64,
    reason: String,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let reason = reason.trim().to_string();
    if reason.chars().count() < 5 {
        return Err(AppError::Validation(
            "Indica el motivo de la anulación (mínimo 5 caracteres)".into(),
        ));
    }
    let db = state.conn()?;
    let n = db.execute(
        "UPDATE ar_withholdings SET voided_at = datetime('now'), void_reason = ?2, voided_by = ?3
         WHERE id = ?1 AND voided_at IS NULL",
        params![id, reason, me.id],
    )?;
    if n == 0 {
        return Err(AppError::Validation(
            "La retención no existe o ya está anulada".into(),
        ));
    }
    audit::log(
        &db,
        Some(me.id),
        "ar_withholding_voided",
        Some("ar_withholding"),
        Some(id),
        Some(&reason),
    )?;
    Ok(())
}

// ---------- Consulta ----------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFilter {
    /// 'YYYY-MM'; vacío = todos los períodos.
    period: Option<String>,
    kind: Option<String>,
    customer_id: Option<i64>,
    #[serde(default)]
    include_voided: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhRow {
    id: i64,
    kind: String,
    voucher_number: String,
    voucher_date: String,
    period: String,
    customer_name: String,
    customer_doc: String,
    document_label: String,
    currency_code: String,
    amount_ves_minor: i64,
    amount_minor: i64,
    notes: Option<String>,
    username: Option<String>,
    voided: bool,
    void_reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhReport {
    rows: Vec<WhRow>,
    iva_ves_minor: i64,
    islr_ves_minor: i64,
}

#[tauri::command]
pub async fn sret_list(
    state: State<'_, AppState>,
    filter: ListFilter,
) -> Result<WhReport, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let period = filter
        .period
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    if let Some(p) = &period {
        NaiveDate::parse_from_str(&format!("{p}-01"), "%Y-%m-%d")
            .map_err(|_| AppError::Validation("Período inválido (AAAA-MM)".into()))?;
    }
    let kind = filter
        .kind
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    if kind.as_ref().is_some_and(|k| !KINDS.contains(&k.as_str())) {
        return Err(AppError::Validation("Tipo de retención inválido".into()));
    }
    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT w.id, w.kind, w.voucher_number, w.voucher_date, w.period, c.name, c.id_type || '-' || c.id_number,
                    d.series || '-' || printf('%06d', d.number), d.currency_code,
                    w.amount_ves_minor, w.amount_minor, w.notes, u.username, w.voided_at IS NOT NULL, w.void_reason
             FROM ar_withholdings w
             JOIN customers c ON c.id = w.customer_id
             JOIN documents d ON d.id = w.document_id
             LEFT JOIN users u ON u.id = w.user_id
             WHERE (?1 IS NULL OR w.period = ?1)
               AND (?2 IS NULL OR w.kind = ?2)
               AND (?3 IS NULL OR w.customer_id = ?3)
               AND (?4 = 1 OR w.voided_at IS NULL)
             ORDER BY w.voucher_date DESC, w.id DESC LIMIT 1000",
        )?
        .query_map(params![period, kind, filter.customer_id, filter.include_voided as i64], |r| {
            Ok(WhRow {
                id: r.get(0)?,
                kind: r.get(1)?,
                voucher_number: r.get(2)?,
                voucher_date: r.get(3)?,
                period: r.get(4)?,
                customer_name: r.get(5)?,
                customer_doc: r.get(6)?,
                document_label: r.get(7)?,
                currency_code: r.get(8)?,
                amount_ves_minor: r.get(9)?,
                amount_minor: r.get(10)?,
                notes: r.get(11)?,
                username: r.get(12)?,
                voided: r.get::<_, i64>(13)? != 0,
                void_reason: r.get(14)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let sum = |k: &str| {
        rows.iter()
            .filter(|r| !r.voided && r.kind == k)
            .map(|r| r.amount_ves_minor)
            .sum()
    };
    Ok(WhReport {
        iva_ves_minor: sum("IVA"),
        islr_ves_minor: sum("ISLR"),
        rows,
    })
}
