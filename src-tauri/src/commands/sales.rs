use crate::commands::lots;
use crate::{
    audit,
    error::AppError,
    security,
    state::{AppState, SessionUser},
};
use rusqlite::{named_params, params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

const METHODS: &[&str] = &["efectivo", "punto", "pago_movil", "transferencia", "zelle", "otro"];
const CURRENCIES: &[&str] = &["VES", "USD"];

fn default_true() -> bool {
    true
}

// ---------- Entradas ----------
/// Tope por pago (en unidades menores): evita desbordes aritméticos con montos absurdos.
const MAX_PAYMENT_MINOR: i64 = 1_000_000_000_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CartItem {
    pub(crate) product_id: i64,
    pub(crate) quantity: i64,
    #[serde(default)]
    pub(crate) discount_bp: i64,
    /// Lote del que sale la mercancía (obligatorio solo en productos con control de lotes).
    #[serde(default)]
    pub(crate) lot_id: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentInput {
    method: String,
    currency_code: String,
    amount_minor: i64,
    reference: Option<String>,
    tendered_minor: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleInput {
    customer_id: Option<i64>,
    currency_code: String,
    items: Vec<CartItem>,
    payments: Vec<PaymentInput>,
    notes: Option<String>,
    #[serde(default = "default_true")]
    charge_tax: bool,
    #[serde(default = "default_true")]
    charge_igtf: bool,
    waiver_reason: Option<String>,
    change_currency: Option<String>,
    #[serde(default)]
    on_credit: bool,
    #[serde(default)]
    price_list_id: Option<i64>,
}

// ---------- Salidas ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteLine {
    pub(crate) product_id: i64,
    pub(crate) sku: String,
    pub(crate) description: String,
    pub(crate) quantity: i64,
    pub(crate) unit_price_minor: i64,
    pub(crate) discount_bp: i64,
    pub(crate) promo_bp: i64,
    pub(crate) discount_minor: i64,
    pub(crate) tax_code: String,
    pub(crate) tax_rate_bp: i64,
    pub(crate) base_minor: i64,
    pub(crate) tax_minor: i64,
    pub(crate) line_total_minor: i64,
    pub(crate) track_stock: bool,
    pub(crate) lot_id: Option<i64>,
    pub(crate) lot_label: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub(crate) currency_code: String,
    pub(crate) usd_rate_micro: Option<i64>,
    pub(crate) igtf_bp: i64,
    pub(crate) lines: Vec<QuoteLine>,
    pub(crate) discount_minor: i64,
    pub(crate) max_discount_bp: i64,
    pub(crate) subtotal_minor: i64,
    pub(crate) exempt_minor: i64,
    pub(crate) tax_minor: i64,
    pub(crate) total_minor: i64,
    pub(crate) total_ves_minor: i64,
    pub(crate) tax_waived: bool,
}

// ---------- Utilidades de cálculo ----------
fn div_round(n: i128, d: i128) -> i64 {
    ((n + d / 2) / d) as i64
}

fn mul(a: i64, b: i64) -> Result<i64, AppError> {
    a.checked_mul(b).ok_or_else(|| AppError::Validation("Monto demasiado grande".into()))
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

pub(crate) fn usd_rate(conn: &Connection) -> Result<Option<i64>, AppError> {
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

fn igtf_bp(conn: &Connection) -> Result<i64, AppError> {
    let v: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'igtf_bp'", [], |r| r.get(0))
        .optional()?;
    Ok(v.and_then(|s| s.trim().parse().ok()).unwrap_or(300))
}

/// Solo el administrador puede emitir una venta sin IVA.
fn check_tax_waiver(me: &SessionUser, charge_tax: bool) -> Result<(), AppError> {
    if !charge_tax && me.role != "admin" {
        return Err(AppError::Validation(
            "Solo el administrador puede emitir una venta sin IVA".into(),
        ));
    }
    Ok(())
}

/// Descuento máximo por línea: el administrador hasta 100 %, el cajero según configuración.
pub(crate) fn max_discount_bp(conn: &Connection, me: &SessionUser) -> Result<i64, AppError> {
    if me.role == "admin" {
        return Ok(10_000);
    }
    let v: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'cashier_max_discount_bp'", [], |r| r.get(0))
        .optional()?;
    Ok(v.and_then(|s| s.trim().parse::<i64>().ok()).unwrap_or(1000).clamp(0, 10_000))
}

/// Calcula todo el documento. Es la ÚNICA fuente de verdad de los montos.
pub(crate) fn compute(
    check_stock: bool,
    conn: &Connection,
    currency: &str,
    items: &[CartItem],
    rate: Option<i64>,
    charge_tax: bool,
    max_bp: i64,
    price_list_id: Option<i64>,
) -> Result<Quote, AppError> {
    if !CURRENCIES.contains(&currency) {
        return Err(AppError::Validation("Moneda inválida".into()));
    }
    if items.is_empty() {
        return Err(AppError::Validation("El carrito está vacío".into()));
    }

    // Une líneas repetidas del mismo producto para validar el stock correctamente.
    let mut merged: Vec<(i64, i64, i64, Option<i64>)> = Vec::new();
    for it in items {
        if it.quantity <= 0 || it.quantity > 100_000 {
            return Err(AppError::Validation("Cantidad inválida".into()));
        }
        if it.discount_bp < 0 || it.discount_bp > 10_000 {
            return Err(AppError::Validation("Descuento inválido (0 a 100 %)".into()));
        }
        if it.discount_bp > max_bp {
            return Err(AppError::Validation(format!(
                "Tu descuento máximo permitido es {} %",
                max_bp as f64 / 100.0
            )));
        }
        match merged
            .iter_mut()
            .find(|m| m.0 == it.product_id && m.2 == it.discount_bp && m.3 == it.lot_id)
        {
            Some(m) => m.1 += it.quantity,
            None => merged.push((it.product_id, it.quantity, it.discount_bp, it.lot_id)),
        }
    }

    let (mut subtotal, mut exempt, mut tax_sum, mut disc_sum) = (0i64, 0i64, 0i64, 0i64);
    let mut any_taxable = false;
    let mut lines = Vec::new();
    let wh = crate::commands::warehouses::sales_warehouse_id(conn)?;

    for (pid, qty, disc_bp, lot_id) in merged.clone() {
        let (sku, name, price, pcur, track, tax_code, rate_bp, stock): (
            String, String, i64, String, i64, String, i64, i64,
        ) = conn
            .query_row(
                "SELECT p.sku, p.name, p.price_minor, p.price_currency, p.track_stock,
                        t.code, t.rate_bp,
                        COALESCE((SELECT SUM(m.quantity) FROM stock_movements m
                        WHERE m.product_id = p.id AND m.warehouse_id = ?2), 0)
                 FROM products p JOIN tax_rates t ON t.id = p.tax_rate_id
                 WHERE p.id = ?1 AND p.active = 1",
                params![pid, wh],
                |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))
                },
            )
            .optional()?
            .ok_or_else(|| AppError::Validation("Un producto del carrito no existe o está inactivo".into()))?;

        let (price, pcur) = crate::commands::pricing::list_price(conn, pid, price, pcur, price_list_id)?;

        // El stock se valida con la suma de todas las líneas del mismo producto.
        let lots_on = track == 1 && lots::uses_lots(conn, pid)?;
        let mut lot_label: Option<String> = None;
        let mut lot_ref: Option<i64> = None;
        if lots_on {
            match lot_id {
                Some(lid) => {
                    let info = lots::lot_of(conn, pid, lid)?;
                    lot_label = Some(info.label());
                    lot_ref = Some(lid);
                    let qty_lot: i64 = merged
                        .iter()
                        .filter(|m| m.0 == pid && m.3 == Some(lid))
                        .map(|m| m.1)
                        .sum();
                    let avail = lots::lot_stock(conn, lid, wh)?;
                    if check_stock && qty_lot > avail {
                        return Err(AppError::Validation(format!(
                            "Stock insuficiente de «{name}», lote {} (disponible: {avail})",
                            info.label()
                        )));
                    }
                }
                None if check_stock => {
                    return Err(AppError::Validation(format!("Elige el lote de «{name}»")));
                }
                None => {}
            }
        } else {
            let qty_total: i64 = merged.iter().filter(|m| m.0 == pid).map(|m| m.1).sum();
            if check_stock && track == 1 && qty_total > stock {
                return Err(AppError::Validation(format!(
                    "Stock insuficiente de «{name}» (disponible: {stock})"
                )));
            }
        }

        let unit = convert(price, &pcur, currency, rate)?;
        let gross = mul(unit, qty)?;
        let promo = crate::commands::pricing::promo_bp(conn, pid)?;
        let eff_bp = crate::commands::pricing::combine_bp(promo, disc_bp);
        let disc = div_round(gross as i128 * eff_bp as i128, 10_000);
        let base = gross - disc;
        disc_sum += disc;
        // Si la venta se emite sin IVA, el impuesto es cero (la alícuota queda registrada en la línea).
        let tax = if charge_tax {
            div_round(base as i128 * rate_bp as i128, 10_000)
        } else {
            0
        };

        if rate_bp == 0 {
            exempt += base;
        } else {
            subtotal += base;
            any_taxable = true;
        }
        tax_sum += tax;

        lines.push(QuoteLine {
            product_id: pid,
            sku,
            description: name,
            quantity: qty,
            unit_price_minor: unit,
            discount_bp: eff_bp,
            promo_bp: promo,
            discount_minor: disc,
            tax_code,
            tax_rate_bp: rate_bp,
            base_minor: base,
            tax_minor: tax,
            line_total_minor: base + tax,
            track_stock: track == 1,
            lot_id: lot_ref,
            lot_label,
        });
    }

    let total = subtotal + exempt + tax_sum;
    Ok(Quote {
        currency_code: currency.to_string(),
        usd_rate_micro: rate,
        igtf_bp: igtf_bp(conn)?,
        lines,
        discount_minor: disc_sum,
        max_discount_bp: max_bp,
        subtotal_minor: subtotal,
        exempt_minor: exempt,
        tax_minor: tax_sum,
        total_minor: total,
        total_ves_minor: convert(total, currency, "VES", rate)?,
        tax_waived: !charge_tax && any_taxable,
    })
}

// ---------- Comandos ----------
#[tauri::command]
pub async fn quote_sale(
    state: State<'_, AppState>,
    currency_code: String,
    items: Vec<CartItem>,
    charge_tax: Option<bool>,
    price_list_id: Option<i64>,
) -> Result<Quote, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    let charge_tax = charge_tax.unwrap_or(true);
    check_tax_waiver(&me, charge_tax)?;
    let db = state.conn()?;
    let rate = usd_rate(&db)?;
    let max_bp = max_discount_bp(&db, &me)?;
    let list = crate::commands::pricing::resolve_list(&db, &me, price_list_id)?;
    compute(true, &db, &currency_code, &items, rate, charge_tax, max_bp, list)
}

#[tauri::command]
pub async fn issue_sale(state: State<'_, AppState>, input: SaleInput) -> Result<i64, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    check_tax_waiver(&me, input.charge_tax)?;

    if input.payments.is_empty() && !input.on_credit {
        return Err(AppError::Validation("Agrega al menos un pago".into()));
    }
    for p in &input.payments {
        if p.amount_minor <= 0 || p.amount_minor > MAX_PAYMENT_MINOR || p.tendered_minor.map_or(false, |t| t < 0 || t > MAX_PAYMENT_MINOR) {
            return Err(AppError::Validation("Monto de pago inválido (debe ser mayor que cero y razonable)".into()));
        }
        if !CURRENCIES.contains(&p.currency_code.as_str()) {
            return Err(AppError::Validation("Moneda de pago inválida".into()));
        }
        if !METHODS.contains(&p.method.as_str()) {
            return Err(AppError::Validation("Método de pago inválido".into()));
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
        .ok_or_else(|| AppError::Validation("Abre tu caja antes de vender (menú Caja)".into()))?;

    let rate = usd_rate(&tx)?;
    let max_bp = max_discount_bp(&tx, &me)?;
    let list = crate::commands::pricing::resolve_list(&tx, &me, input.price_list_id)?;
    let q = compute(true, &tx, &input.currency_code, &input.items, rate, input.charge_tax, max_bp, list)?;
    let doc_cur = q.currency_code.as_str();
    let bp = q.igtf_bp;

    // Exoneraciones: solo cuentan si afectan de verdad la venta.
    let has_foreign = input.payments.iter().any(|p| p.currency_code != "VES");
    let tax_waived = q.tax_waived;
    let igtf_waived = !input.charge_igtf && has_foreign;
    let waiver = tax_waived || igtf_waived;
    let waiver_reason = input
        .waiver_reason
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    if waiver && waiver_reason.as_deref().map_or(true, |r| r.len() < 3) {
        return Err(AppError::Validation(
            "Indica el motivo por el que no se cobra el IVA o el IGTF".into(),
        ));
    }
    let waiver_reason = if waiver { waiver_reason } else { None };

    // Pagos: monto aplicado + IGTF (solo en divisas y si se cobra), convertido a la moneda del documento.
    let mut paid_doc = 0i64;
    let mut igtf_doc = 0i64;
    let mut tol = 0i64;
    let mut pay_rows: Vec<(String, String, i64, i64, i64, Option<String>, Option<i64>)> = Vec::new();
    let mut surpluses: Vec<(String, i64)> = Vec::new();
    for p in &input.payments {
        let cur = p.currency_code.as_str();
        paid_doc += convert(p.amount_minor, cur, doc_cur, rate)?;
        let igtf = if input.charge_igtf && cur != "VES" {
            div_round(p.amount_minor as i128 * bp as i128, 10_000)
        } else {
            0
        };
        igtf_doc += convert(igtf, cur, doc_cur, rate)?;
        if cur != doc_cur {
            let t = match (cur, doc_cur) {
                ("USD", "VES") => (rate.unwrap_or(0) + 999_999) / 1_000_000,
                _ => 1,
            };
            tol = tol.max(t);
        }
        let reference = p.reference.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
        // Vuelto: solo en efectivo; lo recibido debe cubrir lo aplicado más el IGTF.
        let tendered = match p.tendered_minor {
            None => None,
            Some(t) => {
                if p.method != "efectivo" {
                    return Err(AppError::Validation("Solo los pagos en efectivo admiten monto recibido".into()));
                }
                let due = p.amount_minor + igtf;
                if t < due {
                    return Err(AppError::Validation(format!(
                        "El monto recibido ({}) no cubre lo que corresponde cobrar ({})",
                        fmt_minor(t),
                        fmt_minor(due)
                    )));
                }
                if t > due {
                    surpluses.push((cur.to_string(), t - due));
                }
                Some(t)
            }
        };
        pay_rows.push((p.method.clone(), cur.to_string(), p.amount_minor, igtf, rate.unwrap_or(1_000_000), reference, tendered));
    }
    let credit_balance = if input.on_credit {
        if input.customer_id.is_none() {
            return Err(AppError::Validation("La venta a crédito requiere un cliente registrado".into()));
        }
        let bal = q.total_minor - paid_doc;
        if bal <= tol {
            return Err(AppError::Validation(
                "El pago cubre el total: no queda saldo, no es una venta a crédito".into(),
            ));
        }
        bal
    } else {
        if (paid_doc - q.total_minor).abs() > tol {
            return Err(AppError::Validation(format!(
                "El monto pagado ({}) no coincide con el total ({})",
                fmt_minor(paid_doc),
                fmt_minor(q.total_minor)
            )));
        }
        0
    };

    // Vuelto total, expresado en una sola moneda.
    let (change_currency, change_minor) = if surpluses.is_empty() {
        (None, 0i64)
    } else {
        let target = match input.change_currency.as_deref() {
            Some(c) if CURRENCIES.contains(&c) => c.to_string(),
            Some(_) => return Err(AppError::Validation("Moneda del vuelto inválida".into())),
            None => surpluses[0].0.clone(),
        };
        let mut sum = 0i64;
        for (cur, amt) in &surpluses {
            sum += convert(*amt, cur, &target, rate)?;
        }
        (Some(target), sum)
    };

    // Snapshots de cliente y emisor.
    let (cid, ctype, cnum, cname, caddr) = match input.customer_id {
        Some(id) => tx
            .query_row(
                "SELECT id, id_type, id_number, name, fiscal_address
                 FROM customers WHERE id = ?1 AND active = 1",
                [id],
                |r| {
                    Ok((
                        Some(r.get::<_, i64>(0)?),
                        Some(r.get::<_, String>(1)?),
                        Some(r.get::<_, String>(2)?),
                        r.get::<_, String>(3)?,
                        r.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| AppError::Validation("Cliente no encontrado o inactivo".into()))?,
        None => (None, None, None, "Consumidor final".to_string(), None),
    };
    let (rif, iname, iaddr): (String, String, String) = tx.query_row(
        "SELECT rif, legal_name, fiscal_address FROM company WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;

    // Condiciones de crédito: límite autorizado y plazo.
    let (credit_sale, due_date, paid_initial) = if input.on_credit {
        let customer = cid.unwrap_or(0);
        let (limit_usd, days): (i64, i64) = tx.query_row(
            "SELECT credit_limit_usd_minor, credit_days FROM customers WHERE id = ?1",
            [customer],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if limit_usd <= 0 {
            return Err(AppError::Validation(
                "Este cliente no tiene crédito autorizado. El administrador puede asignarlo en Cuentas por cobrar".into(),
            ));
        }
        let owed = crate::commands::receivables::outstanding_usd(&tx, customer, rate)?;
        let new_usd = convert(credit_balance, doc_cur, "USD", rate)?;
        if owed + new_usd > limit_usd {
            return Err(AppError::Validation(format!(
                "Supera el límite de crédito: límite USD {}, deuda actual USD {}, esta venta deja USD {}",
                fmt_minor(limit_usd),
                fmt_minor(owed),
                fmt_minor(new_usd)
            )));
        }
        let due: String = tx.query_row(
            "SELECT date('now', 'localtime', ?1)",
            [format!("+{days} days")],
            |r| r.get(0),
        )?;
        (1i64, Some(due), paid_doc)
    } else {
        (0i64, None, 0i64)
    };

    // Numeración consecutiva.
    let number: i64 = tx.query_row(
        "SELECT next_number FROM document_series WHERE doc_type = 'COMPROBANTE' AND series = 'A'",
        [],
        |r| r.get(0),
    )?;
    tx.execute(
        "UPDATE document_series SET next_number = next_number + 1
         WHERE doc_type = 'COMPROBANTE' AND series = 'A'",
        [],
    )?;

    let notes = input.notes.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    tx.execute(
        "INSERT INTO documents (doc_type, series, number, status, fiscal_status,
            issuer_rif, issuer_name, issuer_address,
            customer_id, customer_id_type, customer_id_number, customer_name, customer_address,
            currency_code, exchange_rate_micro, subtotal_minor, exempt_minor, tax_minor,
             igtf_minor, total_minor, total_ves_minor, cashier_id, notes,
            tax_waived, igtf_waived, waiver_reason, cash_session_id,
            change_currency, change_minor, credit_sale, due_date, paid_initial_minor)
         VALUES ('COMPROBANTE', 'A', :number, 'issued', 'NONE',
            :rif, :iname, :iaddr,
            :cid, :ctype, :cnum, :cname, :caddr,
            :cur, :rate, :sub, :ex, :tax,
            :igtf, :total, :total_ves, :cashier, :notes,
            :tax_waived, :igtf_waived, :waiver_reason, :session,
            :change_cur, :change_minor, :credit_sale, :due_date, :paid_initial)",
        named_params! {
            ":number": number, ":rif": rif, ":iname": iname, ":iaddr": iaddr,
            ":cid": cid, ":ctype": ctype, ":cnum": cnum, ":cname": cname, ":caddr": caddr,
            ":cur": doc_cur, ":rate": rate.unwrap_or(1_000_000),
            ":sub": q.subtotal_minor, ":ex": q.exempt_minor, ":tax": q.tax_minor,
            ":igtf": igtf_doc, ":total": q.total_minor, ":total_ves": q.total_ves_minor,
            ":cashier": me.id, ":notes": notes,
            ":tax_waived": tax_waived as i64, ":igtf_waived": igtf_waived as i64,
            ":waiver_reason": waiver_reason,
            ":session": session_id,
            ":change_cur": change_currency, ":change_minor": change_minor,
            ":credit_sale": credit_sale, ":due_date": due_date, ":paid_initial": paid_initial,
        },
    )?;
    let doc_id = tx.last_insert_rowid();

    let wh = crate::commands::warehouses::sales_warehouse_id(&tx)?;
    for l in &q.lines {
        tx.execute(
            "INSERT INTO document_items (document_id, product_id, description, quantity,
                unit_price_minor, discount_minor, discount_bp, tax_code, tax_rate_bp, tax_minor, line_total_minor)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![doc_id, l.product_id, l.description, l.quantity, l.unit_price_minor,
                    l.discount_minor, l.discount_bp, l.tax_code, l.tax_rate_bp, l.tax_minor, l.line_total_minor],
        )?;
        // Costo del producto al momento de la venta (base del cálculo de utilidad).
        let item_id = tx.last_insert_rowid();
        // Con lotes, el costo es el del lote del que sale la mercancía.
        if let Some(lid) = l.lot_id {
            tx.execute(
                "INSERT INTO item_costs (item_id, unit_cost_minor, cost_currency, estimated, lot_id)
                 SELECT ?1, unit_cost_minor, cost_currency, 0, id FROM lots WHERE id = ?2",
                params![item_id, lid],
            )?;
        } else {
            tx.execute(
                "INSERT INTO item_costs (item_id, unit_cost_minor, cost_currency, estimated)
                 SELECT ?1, cost_minor, price_currency, 0 FROM products WHERE id = ?2",
                params![item_id, l.product_id],
            )?;
        }
        if l.track_stock {
            tx.execute(
                "INSERT INTO stock_movements (product_id, quantity, reason, document_id, user_id, warehouse_id, lot_id)
                 VALUES (?1, ?2, 'venta', ?3, ?4, ?5, ?6)",
                params![l.product_id, -l.quantity, doc_id, me.id, wh, l.lot_id],
            )?;
        }
    }

    for (method, cur, amount, igtf, prate, reference, tendered) in &pay_rows {
        tx.execute(
            "INSERT INTO payments (document_id, method, currency_code, amount_minor,
                exchange_rate_micro, igtf_applies, igtf_minor, reference, tendered_minor)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![doc_id, method, cur, amount, prate, (*igtf > 0) as i64, igtf, reference, tendered],
        )?;
    }

    let mut detail = format!("A-{number:06} total {} {}", fmt_minor(q.total_minor), doc_cur);
    if credit_sale == 1 {
        detail.push_str(&format!(" | A CRÉDITO, saldo {}", fmt_minor(credit_balance)));
    }
    if q.discount_minor > 0 {
        detail.push_str(&format!(" | descuentos {}", fmt_minor(q.discount_minor)));
    }
    if change_minor > 0 {
        detail.push_str(&format!(" | vuelto {} {}", fmt_minor(change_minor), change_currency.as_deref().unwrap_or("")));
    }
    if tax_waived {
        detail.push_str(" | SIN IVA");
    }
    if igtf_waived {
        detail.push_str(" | SIN IGTF");
    }
    if let Some(r) = &waiver_reason {
        detail.push_str(&format!(" | motivo: {r}"));
    }
    let action = if waiver { "sale_issued_waiver" } else { "sale_issued" };
    audit::log(&tx, Some(me.id), action, Some("document"), Some(doc_id), Some(&detail))?;
    tx.commit()?;
    Ok(doc_id)
}

// ---------- Consulta ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocRow {
    id: i64,
    series: String,
    number: i64,
    doc_type: String,
    issued_at: String,
    customer_name: Option<String>,
    currency_code: String,
    total_minor: i64,
    igtf_minor: i64,
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocItemOut {
    description: String,
    quantity: i64,
    unit_price_minor: i64,
    discount_minor: i64,
    discount_bp: i64,
    tax_code: String,
    tax_rate_bp: i64,
    line_total_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocPaymentOut {
    method: String,
    currency_code: String,
    amount_minor: i64,
    igtf_minor: i64,
    reference: Option<String>,
    tendered_minor: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDetail {
    id: i64,
    doc_type: String,
    series: String,
    number: i64,
    status: String,
    fiscal_status: String,
    issuer_rif: String,
    issuer_name: String,
    issuer_address: String,
    customer_name: Option<String>,
    customer_id_type: Option<String>,
    customer_id_number: Option<String>,
    customer_address: Option<String>,
    currency_code: String,
    exchange_rate_micro: i64,
    subtotal_minor: i64,
    exempt_minor: i64,
    tax_minor: i64,
    igtf_minor: i64,
    total_minor: i64,
    total_ves_minor: i64,
    cashier: Option<String>,
    issued_at: String,
    void_reason: Option<String>,
    tax_waived: bool,
    igtf_waived: bool,
    waiver_reason: Option<String>,
    change_currency: Option<String>,
    change_minor: i64,
    credit_sale: bool,
    due_date: Option<String>,
    paid_initial_minor: i64,
    balance_minor: i64,
    legend: Option<String>,
    items: Vec<DocItemOut>,
    payments: Vec<DocPaymentOut>,
}

#[tauri::command]
pub async fn list_documents(
    state: State<'_, AppState>,
    search: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<DocRow>, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let search = search.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT id, series, number, issued_at, customer_name, currency_code,
                    total_minor, igtf_minor, status, doc_type
             FROM documents
             WHERE (?1 IS NULL OR CAST(number AS TEXT) LIKE '%' || ?1 || '%'
                    OR customer_name LIKE '%' || ?1 || '%')
             ORDER BY id DESC LIMIT ?2",
        )?
        .query_map(params![search, limit], |r| {
            Ok(DocRow {
                id: r.get(0)?, series: r.get(1)?, number: r.get(2)?, issued_at: r.get(3)?,
                customer_name: r.get(4)?, currency_code: r.get(5)?, total_minor: r.get(6)?,
                igtf_minor: r.get(7)?, status: r.get(8)?, doc_type: r.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub async fn get_document(state: State<'_, AppState>, id: i64) -> Result<DocumentDetail, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;

    let mut doc = db
        .query_row(
            "SELECT d.id, d.doc_type, d.series, d.number, d.status, d.fiscal_status,
                    d.issuer_rif, d.issuer_name, d.issuer_address,
                    d.customer_name, d.customer_id_type, d.customer_id_number, d.customer_address,
                    d.currency_code, d.exchange_rate_micro, d.subtotal_minor, d.exempt_minor,
                    d.tax_minor, d.igtf_minor, d.total_minor, d.total_ves_minor,
                    u.username, d.issued_at, d.void_reason,
                    d.tax_waived, d.igtf_waived, d.waiver_reason,
                    d.change_currency, d.change_minor,
                    d.credit_sale, d.due_date, d.paid_initial_minor
             FROM documents d LEFT JOIN users u ON u.id = d.cashier_id
             WHERE d.id = ?1",
            [id],
            |r| {
                Ok(DocumentDetail {
                    id: r.get(0)?, doc_type: r.get(1)?, series: r.get(2)?, number: r.get(3)?,
                    status: r.get(4)?, fiscal_status: r.get(5)?, issuer_rif: r.get(6)?,
                    issuer_name: r.get(7)?, issuer_address: r.get(8)?, customer_name: r.get(9)?,
                    customer_id_type: r.get(10)?, customer_id_number: r.get(11)?,
                    customer_address: r.get(12)?, currency_code: r.get(13)?,
                    exchange_rate_micro: r.get(14)?, subtotal_minor: r.get(15)?,
                    exempt_minor: r.get(16)?, tax_minor: r.get(17)?, igtf_minor: r.get(18)?,
                    total_minor: r.get(19)?, total_ves_minor: r.get(20)?, cashier: r.get(21)?,
                    issued_at: r.get(22)?, void_reason: r.get(23)?,
                    tax_waived: r.get::<_, i64>(24)? != 0,
                    igtf_waived: r.get::<_, i64>(25)? != 0,
                    waiver_reason: r.get(26)?,
                    change_currency: r.get(27)?,
                    change_minor: r.get(28)?,
                    credit_sale: r.get::<_, i64>(29)? != 0,
                    due_date: r.get(30)?,
                    paid_initial_minor: r.get(31)?,
                    balance_minor: 0,
                    legend: None, items: vec![], payments: vec![],
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("El documento no existe".into()))?;

    doc.items = db
        .prepare(
            "SELECT description, quantity, unit_price_minor, discount_minor, discount_bp,
                    tax_code, tax_rate_bp, line_total_minor
             FROM document_items WHERE document_id = ?1 ORDER BY id",
        )?
        .query_map([id], |r| {
            Ok(DocItemOut {
                description: r.get(0)?, quantity: r.get(1)?, unit_price_minor: r.get(2)?,
                discount_minor: r.get(3)?, discount_bp: r.get(4)?,
                tax_code: r.get(5)?, tax_rate_bp: r.get(6)?, line_total_minor: r.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    doc.payments = db
        .prepare(
            "SELECT method, currency_code, amount_minor, igtf_minor, reference, tendered_minor
             FROM payments WHERE document_id = ?1 ORDER BY id",
        )?
        .query_map([id], |r| {
            Ok(DocPaymentOut {
                method: r.get(0)?, currency_code: r.get(1)?, amount_minor: r.get(2)?,
                igtf_minor: r.get(3)?, reference: r.get(4)?, tendered_minor: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    if doc.credit_sale {
        doc.balance_minor = crate::commands::receivables::balance_of(&db, id)?;
    }
    if doc.fiscal_status == "NONE" {
        doc.legend = db
            .query_row("SELECT value FROM settings WHERE key = 'receipt_legend'", [], |r| r.get(0))
            .optional()?;
    }
    Ok(doc)
}

#[tauri::command]
pub async fn void_document(
    state: State<'_, AppState>,
    id: i64,
    reason: String,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let reason = reason.trim().to_string();
    if reason.len() < 5 {
        return Err(AppError::Validation("Indica el motivo de la anulación (mínimo 5 caracteres)".into()));
    }

    let mut db = state.conn()?;
    let tx = db.transaction()?;

    let (status, fiscal, doc_type): (String, String, String) = tx
        .query_row("SELECT status, fiscal_status, doc_type FROM documents WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()?
        .ok_or_else(|| AppError::Validation("El documento no existe".into()))?;
    if doc_type != "COMPROBANTE" {
        return Err(AppError::Validation("Solo se pueden anular ventas".into()));
    }
    let returns: i64 = tx.query_row(
        "SELECT COUNT(*) FROM documents
         WHERE related_document_id = ?1 AND doc_type = 'DEVOLUCION' AND status = 'issued'",
        [id],
        |r| r.get(0),
    )?;
    let receipts: i64 = tx.query_row(
        "SELECT COUNT(*) FROM ar_allocations a JOIN ar_receipts v ON v.id = a.receipt_id
         WHERE a.document_id = ?1 AND v.voided_at IS NULL",
        [id],
        |r| r.get(0),
    )?;
    if receipts > 0 {
        return Err(AppError::Validation(
            "Esta venta a crédito ya tiene abonos registrados: no se puede anular".into(),
        ));
    }
    let withheld: i64 = tx.query_row(
        "SELECT COUNT(*) FROM ar_withholdings WHERE document_id = ?1 AND voided_at IS NULL",
        [id],
        |r| r.get(0),
    )?;
    if withheld > 0 {
        return Err(AppError::Validation(
            "Esta venta tiene retenciones registradas: anúlalas primero en Cuentas por cobrar".into(),
        ));
    }
    if returns > 0 {
        return Err(AppError::Validation(
            "Esta venta tiene devoluciones registradas: ya no se puede anular".into(),
        ));
    }
    if status != "issued" {
        return Err(AppError::Validation("Solo se pueden anular documentos emitidos".into()));
    }
    if fiscal != "NONE" {
        return Err(AppError::Validation(
            "Un documento fiscal se corrige con nota de crédito, no se anula aquí".into(),
        ));
    }

    tx.execute(
        "UPDATE documents SET status = 'voided', voided_at = datetime('now'), void_reason = ?2
         WHERE id = ?1",
        params![id, reason],
    )?;
    tx.execute(
        "INSERT INTO stock_movements (product_id, quantity, reason, note, document_id, user_id, warehouse_id, lot_id)
         SELECT product_id, -quantity, 'anulacion', ?2, document_id, ?3, warehouse_id, lot_id
         FROM stock_movements
         WHERE document_id = ?1 AND reason = 'venta'",
        params![id, reason, me.id],
    )?;
    audit::log(&tx, Some(me.id), "document_voided", Some("document"), Some(id), Some(&reason))?;
    tx.commit()?;
    Ok(())
}