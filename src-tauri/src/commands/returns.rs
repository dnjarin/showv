//! Notas de crédito internas (devoluciones). Solo el administrador las emite.
use crate::{
    audit,
    error::AppError,
    security,
    state::AppState,
};
use rusqlite::{named_params, params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

const METHODS: &[&str] = &["efectivo", "punto", "pago_movil", "transferencia", "zelle", "otro"];
const CURRENCIES: &[&str] = &["VES", "USD"];

// ---------- Utilidades (mismas reglas que ventas) ----------
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

/// Parte proporcional acumulada: devolver k de q unidades de un monto X.
/// Al calcular con acumulados, varias devoluciones parciales suman exactamente el original.
fn part(x: i64, q: i64, k: i64) -> i64 {
    div_round(x as i128 * k as i128, q as i128)
}

// ---------- Entradas ----------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnLine {
    item_id: i64,
    quantity: i64,
    #[serde(default = "yes")]
    restock: bool,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundInput {
    method: String,
    currency_code: String,
    amount_minor: i64,
    reference: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnInput {
    document_id: i64,
    reason: String,
    lines: Vec<ReturnLine>,
    #[serde(default = "yes")]
    refund_igtf: bool,
    refunds: Vec<RefundInput>,
}

// ---------- Salidas ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateItem {
    item_id: i64,
    description: String,
    quantity: i64,
    returned: i64,
    available: i64,
    unit_price_minor: i64,
    discount_bp: i64,
    tax_rate_bp: i64,
    line_total_minor: i64,
    track_stock: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidates {
    document_id: i64,
    series: String,
    number: i64,
    customer_name: Option<String>,
    currency_code: String,
    igtf_minor: i64,
    igtf_refunded_minor: i64,
    total_minor: i64,
    items: Vec<CandidateItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotedLine {
    item_id: i64,
    description: String,
    quantity: i64,
    discount_minor: i64,
    tax_minor: i64,
    line_total_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnQuote {
    currency_code: String,
    usd_rate_micro: Option<i64>,
    lines: Vec<QuotedLine>,
    subtotal_minor: i64,
    exempt_minor: i64,
    tax_minor: i64,
    igtf_minor: i64,
    total_minor: i64,
    balance_applied_minor: i64,
    refund_due_minor: i64,
}

// Línea ya calculada, lista para guardar.
struct Calc {
    item_id: i64,
    product_id: Option<i64>,
    description: String,
    quantity: i64,
    unit_price_minor: i64,
    discount_minor: i64,
    discount_bp: i64,
    tax_code: String,
    tax_rate_bp: i64,
    tax_minor: i64,
    line_total_minor: i64,
    track_stock: bool,
    restock: bool,
}

struct Original {
    series: String,
    number: i64,
    currency_code: String,
    rate_micro: i64,
    igtf_minor: i64,
    total_minor: i64,
}

fn load_original(conn: &Connection, id: i64) -> Result<Original, AppError> {
    let (doc_type, status, series, number, cur, rate, igtf, total): (String, String, String, i64, String, i64, i64, i64) = conn
        .query_row(
            "SELECT doc_type, status, series, number, currency_code, exchange_rate_micro,
                    igtf_minor, total_minor
             FROM documents WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("El documento no existe".into()))?;
    if doc_type != "COMPROBANTE" {
        return Err(AppError::Validation("Solo se pueden devolver ventas (comprobantes)".into()));
    }
    if status != "issued" {
        return Err(AppError::Validation("La venta está anulada: no admite devoluciones".into()));
    }
    Ok(Original { series, number, currency_code: cur, rate_micro: rate, igtf_minor: igtf, total_minor: total })
}

fn returned_qty(conn: &Connection, item_id: i64) -> Result<i64, AppError> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(di.quantity), 0)
         FROM document_items di JOIN documents d ON d.id = di.document_id
         WHERE di.source_item_id = ?1 AND d.doc_type = 'DEVOLUCION' AND d.status = 'issued'",
        [item_id],
        |r| r.get(0),
    )?)
}

fn igtf_refunded(conn: &Connection, doc_id: i64) -> Result<i64, AppError> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(igtf_minor), 0) FROM documents
         WHERE related_document_id = ?1 AND doc_type = 'DEVOLUCION' AND status = 'issued'",
        [doc_id],
        |r| r.get(0),
    )?)
}

/// Calcula la nota de crédito. Única fuente de verdad de los montos.
fn compute(
    conn: &Connection,
    orig_id: i64,
    orig: &Original,
    lines: &[ReturnLine],
    refund_igtf: bool,
) -> Result<(Vec<Calc>, ReturnQuote), AppError> {
    if lines.is_empty() {
        return Err(AppError::Validation("Selecciona al menos un producto a devolver".into()));
    }
    // Une líneas repetidas de la misma línea original.
    let mut merged: Vec<(i64, i64, bool)> = Vec::new();
    for l in lines {
        if l.quantity <= 0 {
            return Err(AppError::Validation("Cantidad a devolver inválida".into()));
        }
        match merged.iter_mut().find(|m| m.0 == l.item_id) {
            Some(m) => {
                m.1 += l.quantity;
                m.2 = m.2 && l.restock;
            }
            None => merged.push((l.item_id, l.quantity, l.restock)),
        }
    }

    let (mut subtotal, mut exempt, mut tax_sum, mut total) = (0i64, 0i64, 0i64, 0i64);
    let mut calcs = Vec::new();
    for (item_id, qty, restock) in merged {
        let row = conn
            .query_row(
                "SELECT di.product_id, di.description, di.quantity, di.unit_price_minor,
                        di.discount_minor, di.discount_bp, di.tax_code, di.tax_rate_bp,
                        di.tax_minor, di.line_total_minor,
                        COALESCE((SELECT p.track_stock FROM products p WHERE p.id = di.product_id), 0)
                 FROM document_items di
                 WHERE di.id = ?1 AND di.document_id = ?2",
                params![item_id, orig_id],
                |r| {
                    Ok((
                        r.get::<_, Option<i64>>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?,
                        r.get::<_, String>(6)?, r.get::<_, i64>(7)?, r.get::<_, i64>(8)?,
                        r.get::<_, i64>(9)?, r.get::<_, i64>(10)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| AppError::Validation("Una línea no pertenece a esta venta".into()))?;
        let (product_id, description, q, unit, disc, disc_bp, tax_code, rate_bp, tax, line_total, track) = row;

        let prev = returned_qty(conn, item_id)?;
        if qty > q - prev {
            return Err(AppError::Validation(format!(
                "«{description}»: solo quedan {} unidades por devolver",
                q - prev
            )));
        }
        let c_total = part(line_total, q, prev + qty) - part(line_total, q, prev);
        let c_tax = part(tax, q, prev + qty) - part(tax, q, prev);
        let c_disc = part(disc, q, prev + qty) - part(disc, q, prev);
        let base = c_total - c_tax;
        if rate_bp == 0 {
            exempt += base;
        } else {
            subtotal += base;
        }
        tax_sum += c_tax;
        total += c_total;

        calcs.push(Calc {
            item_id,
            product_id,
            description,
            quantity: qty,
            unit_price_minor: unit,
            discount_minor: c_disc,
            discount_bp: disc_bp,
            tax_code,
            tax_rate_bp: rate_bp,
            tax_minor: c_tax,
            line_total_minor: c_total,
            track_stock: track == 1,
            restock,
        });
    }

    // IGTF proporcional, sin pasar de lo que quede por reintegrar.
    let igtf = if refund_igtf && orig.igtf_minor > 0 && orig.total_minor > 0 {
        let prop = div_round(orig.igtf_minor as i128 * total as i128, orig.total_minor as i128);
        prop.min(orig.igtf_minor - igtf_refunded(conn, orig_id)?).max(0)
    } else {
        0
    };

    // Venta a crédito con saldo: la devolución descuenta primero la deuda.
    let balance_applied = crate::commands::receivables::balance_of(conn, orig_id)?.min(total);

    let rate = usd_rate(conn)?;
    let quote = ReturnQuote {
        currency_code: orig.currency_code.clone(),
        usd_rate_micro: rate,
        lines: calcs
            .iter()
            .map(|c| QuotedLine {
                item_id: c.item_id,
                description: c.description.clone(),
                quantity: c.quantity,
                discount_minor: c.discount_minor,
                tax_minor: c.tax_minor,
                line_total_minor: c.line_total_minor,
            })
            .collect(),
        subtotal_minor: subtotal,
        exempt_minor: exempt,
        tax_minor: tax_sum,
        igtf_minor: igtf,
        total_minor: total,
        balance_applied_minor: balance_applied,
        refund_due_minor: total - balance_applied + igtf,
    };
    Ok((calcs, quote))
}

// ---------- Comandos ----------
#[tauri::command]
pub async fn return_candidates(
    state: State<'_, AppState>,
    document_id: i64,
) -> Result<Candidates, AppError> {
    security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    let orig = load_original(&db, document_id)?;
    let customer_name: Option<String> = db.query_row(
        "SELECT customer_name FROM documents WHERE id = ?1",
        [document_id],
        |r| r.get(0),
    )?;

    let raw = db
        .prepare(
            "SELECT di.id, di.description, di.quantity, di.unit_price_minor, di.discount_bp,
                    di.tax_rate_bp, di.line_total_minor,
                    COALESCE((SELECT p.track_stock FROM products p WHERE p.id = di.product_id), 0)
             FROM document_items di WHERE di.document_id = ?1 ORDER BY di.id",
        )?
        .query_map([document_id], |r| {
            Ok((
                r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?, r.get::<_, i64>(7)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut items = Vec::new();
    for (id, description, quantity, unit, disc_bp, rate_bp, line_total, track) in raw {
        let returned = returned_qty(&db, id)?;
        items.push(CandidateItem {
            item_id: id,
            description,
            quantity,
            returned,
            available: quantity - returned,
            unit_price_minor: unit,
            discount_bp: disc_bp,
            tax_rate_bp: rate_bp,
            line_total_minor: line_total,
            track_stock: track == 1,
        });
    }
    Ok(Candidates {
        document_id,
        series: orig.series,
        number: orig.number,
        customer_name,
        currency_code: orig.currency_code,
        igtf_minor: orig.igtf_minor,
        igtf_refunded_minor: igtf_refunded(&db, document_id)?,
        total_minor: orig.total_minor,
        items,
    })
}

#[tauri::command]
pub async fn quote_return(
    state: State<'_, AppState>,
    document_id: i64,
    lines: Vec<ReturnLine>,
    refund_igtf: Option<bool>,
) -> Result<ReturnQuote, AppError> {
    security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    let orig = load_original(&db, document_id)?;
    let (_, q) = compute(&db, document_id, &orig, &lines, refund_igtf.unwrap_or(true))?;
    Ok(q)
}

#[tauri::command]
pub async fn create_return(state: State<'_, AppState>, input: ReturnInput) -> Result<i64, AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let reason = input.reason.trim().to_string();
    if reason.chars().count() < 5 {
        return Err(AppError::Validation("Indica el motivo de la devolución (mínimo 5 caracteres)".into()));
    }
    for p in &input.refunds {
        if p.amount_minor <= 0 {
            return Err(AppError::Validation("Los montos del reintegro deben ser mayores que cero".into()));
        }
        if !CURRENCIES.contains(&p.currency_code.as_str()) {
            return Err(AppError::Validation("Moneda del reintegro inválida".into()));
        }
        if !METHODS.contains(&p.method.as_str()) {
            return Err(AppError::Validation("Método del reintegro inválido".into()));
        }
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
        .ok_or_else(|| AppError::Validation("Abre tu caja antes de registrar una devolución (menú Caja)".into()))?;

    let orig = load_original(&tx, input.document_id)?;
    let (calcs, q) = compute(&tx, input.document_id, &orig, &input.lines, input.refund_igtf)?;
    let doc_cur = orig.currency_code.as_str();
    let rate = q.usd_rate_micro;
    if q.refund_due_minor > 0 && input.refunds.is_empty() {
        return Err(AppError::Validation("Indica cómo se le devuelve el dinero al cliente".into()));
    }

    // El dinero entregado debe cuadrar con lo que se debe reintegrar.
    let mut paid_doc = 0i64;
    let mut tol = 0i64;
    for p in &input.refunds {
        paid_doc += convert(p.amount_minor, &p.currency_code, doc_cur, rate)?;
        if p.currency_code != doc_cur {
            let t = match (p.currency_code.as_str(), doc_cur) {
                ("USD", "VES") => (rate.unwrap_or(0) + 999_999) / 1_000_000,
                _ => 1,
            };
            tol = tol.max(t);
        }
    }
    if (paid_doc - q.refund_due_minor).abs() > tol {
        return Err(AppError::Validation(format!(
            "El reintegro ({}) no coincide con lo que se debe devolver ({})",
            fmt_minor(paid_doc),
            fmt_minor(q.refund_due_minor)
        )));
    }

    let total_ves = if doc_cur == "VES" {
        q.total_minor
    } else {
        div_round(q.total_minor as i128 * orig.rate_micro as i128, 1_000_000)
    };

    let number: i64 = tx.query_row(
        "SELECT next_number FROM document_series WHERE doc_type = 'DEVOLUCION' AND series = 'D'",
        [],
        |r| r.get(0),
    )?;
    tx.execute(
        "UPDATE document_series SET next_number = next_number + 1
         WHERE doc_type = 'DEVOLUCION' AND series = 'D'",
        [],
    )?;

    tx.execute(
        "INSERT INTO documents (doc_type, series, number, status, fiscal_status, related_document_id,
            issuer_rif, issuer_name, issuer_address,
            customer_id, customer_id_type, customer_id_number, customer_name, customer_address,
            currency_code, exchange_rate_micro, subtotal_minor, exempt_minor, tax_minor,
            igtf_minor, total_minor, total_ves_minor, cashier_id, notes, cash_session_id,
            balance_applied_minor)
         SELECT 'DEVOLUCION', 'D', :number, 'issued', 'NONE', id,
            issuer_rif, issuer_name, issuer_address,
            customer_id, customer_id_type, customer_id_number, customer_name, customer_address,
            currency_code, exchange_rate_micro, :sub, :ex, :tax,
            :igtf, :total, :total_ves, :cashier, :notes, :session, :bal_applied
         FROM documents WHERE id = :orig",
        named_params! {
            ":number": number, ":sub": q.subtotal_minor, ":ex": q.exempt_minor, ":tax": q.tax_minor,
            ":igtf": q.igtf_minor, ":total": q.total_minor, ":total_ves": total_ves,
            ":cashier": me.id, ":notes": reason, ":session": session_id, ":orig": input.document_id,
            ":bal_applied": q.balance_applied_minor,
        },
    )?;
    let doc_id = tx.last_insert_rowid();

    let wh = crate::commands::warehouses::sales_warehouse_id(&tx)?;
    for c in &calcs {
        let restocked = c.track_stock && c.restock;
        tx.execute(
            "INSERT INTO document_items (document_id, product_id, description, quantity,
                unit_price_minor, discount_minor, discount_bp, tax_code, tax_rate_bp, tax_minor,
                line_total_minor, source_item_id, restocked)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![doc_id, c.product_id, c.description, c.quantity, c.unit_price_minor,
                    c.discount_minor, c.discount_bp, c.tax_code, c.tax_rate_bp, c.tax_minor,
                    c.line_total_minor, c.item_id, restocked as i64],
        )?;
        if restocked {
            if let Some(pid) = c.product_id {
                // La mercancía vuelve al mismo lote del que salió.
                let lot_id = crate::commands::lots::return_lot(&tx, pid, c.item_id)?;
                tx.execute(
                    "INSERT INTO stock_movements (product_id, quantity, reason, note, document_id, user_id, warehouse_id, lot_id)
                     VALUES (?1, ?2, 'devolucion', ?3, ?4, ?5, ?6, ?7)",
                    params![pid, c.quantity, reason, doc_id, me.id, wh, lot_id],
                )?;
            }
        }
    }

    for p in &input.refunds {
        let reference = p.reference.as_deref().map(str::trim).filter(|s| !s.is_empty());
        tx.execute(
            "INSERT INTO refunds (document_id, method, currency_code, amount_minor, exchange_rate_micro, reference)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![doc_id, p.method, p.currency_code, p.amount_minor, rate.unwrap_or(1_000_000), reference],
        )?;
    }

    let detail = format!(
        "D-{number:06} sobre {}-{:06}: {} {} | motivo: {reason}",
        orig.series, orig.number, fmt_minor(q.refund_due_minor), doc_cur
    );
    audit::log(&tx, Some(me.id), "return_issued", Some("document"), Some(doc_id), Some(&detail))?;
    tx.commit()?;
    Ok(doc_id)
}

// ---------- Consulta para el comprobante ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnItemOut {
    description: String,
    quantity: i64,
    unit_price_minor: i64,
    discount_minor: i64,
    tax_rate_bp: i64,
    line_total_minor: i64,
    restocked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundOut {
    method: String,
    currency_code: String,
    amount_minor: i64,
    reference: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnDetail {
    id: i64,
    series: String,
    number: i64,
    status: String,
    issued_at: String,
    reason: Option<String>,
    cashier: Option<String>,
    issuer_rif: String,
    issuer_name: String,
    issuer_address: String,
    customer_name: Option<String>,
    customer_id_type: Option<String>,
    customer_id_number: Option<String>,
    currency_code: String,
    subtotal_minor: i64,
    exempt_minor: i64,
    tax_minor: i64,
    igtf_minor: i64,
    total_minor: i64,
    balance_applied_minor: i64,
    original_series: String,
    original_number: i64,
    legend: Option<String>,
    items: Vec<ReturnItemOut>,
    refunds: Vec<RefundOut>,
}

#[tauri::command]
pub async fn get_return(state: State<'_, AppState>, id: i64) -> Result<ReturnDetail, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;
    let mut d = db
        .query_row(
            "SELECT d.id, d.series, d.number, d.status, d.issued_at, d.notes, u.username,
                    d.issuer_rif, d.issuer_name, d.issuer_address,
                    d.customer_name, d.customer_id_type, d.customer_id_number,
                    d.currency_code, d.subtotal_minor, d.exempt_minor, d.tax_minor,
                    d.igtf_minor, d.total_minor, d.balance_applied_minor, o.series, o.number
             FROM documents d
             JOIN documents o ON o.id = d.related_document_id
             LEFT JOIN users u ON u.id = d.cashier_id
             WHERE d.id = ?1 AND d.doc_type = 'DEVOLUCION'",
            [id],
            |r| {
                Ok(ReturnDetail {
                    id: r.get(0)?, series: r.get(1)?, number: r.get(2)?, status: r.get(3)?,
                    issued_at: r.get(4)?, reason: r.get(5)?, cashier: r.get(6)?,
                    issuer_rif: r.get(7)?, issuer_name: r.get(8)?, issuer_address: r.get(9)?,
                    customer_name: r.get(10)?, customer_id_type: r.get(11)?,
                    customer_id_number: r.get(12)?, currency_code: r.get(13)?,
                    subtotal_minor: r.get(14)?, exempt_minor: r.get(15)?, tax_minor: r.get(16)?,
                    igtf_minor: r.get(17)?, total_minor: r.get(18)?,
                    balance_applied_minor: r.get(19)?,
                    original_series: r.get(20)?, original_number: r.get(21)?,
                    legend: None, items: vec![], refunds: vec![],
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("La nota de crédito no existe".into()))?;

    d.items = db
        .prepare(
            "SELECT description, quantity, unit_price_minor, discount_minor, tax_rate_bp,
                    line_total_minor, restocked
             FROM document_items WHERE document_id = ?1 ORDER BY id",
        )?
        .query_map([id], |r| {
            Ok(ReturnItemOut {
                description: r.get(0)?, quantity: r.get(1)?, unit_price_minor: r.get(2)?,
                discount_minor: r.get(3)?, tax_rate_bp: r.get(4)?, line_total_minor: r.get(5)?,
                restocked: r.get::<_, i64>(6)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    d.refunds = db
        .prepare("SELECT method, currency_code, amount_minor, reference FROM refunds WHERE document_id = ?1 ORDER BY id")?
        .query_map([id], |r| {
            Ok(RefundOut {
                method: r.get(0)?, currency_code: r.get(1)?, amount_minor: r.get(2)?, reference: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    d.legend = db
        .query_row("SELECT value FROM settings WHERE key = 'receipt_legend'", [], |r| r.get(0))
        .optional()?;
    Ok(d)
}