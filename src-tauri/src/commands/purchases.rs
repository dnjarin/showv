use crate::commands::lots;
use crate::{
    audit,
    commands::retentions::{read_cfg, WhCfg},
    error::AppError,
    security,
    state::AppState,
};
use chrono::{Local, NaiveDate};
use rusqlite::{named_params, params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::State;

const CURRENCIES: &[&str] = &["VES", "USD"];
const MAX_QTY: i64 = 1_000_000;
const MAX_COST: i64 = 1_000_000_000_000;

fn default_true() -> bool {
    true
}

// ---------- Utilidades ----------
fn div_round(n: i128, d: i128) -> i64 {
    ((n + d / 2) / d) as i64
}

fn fmt_minor(v: i64) -> String {
    format!("{}.{:02}", v / 100, v % 100)
}

fn opt(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn short_text(s: Option<String>, max: usize, msg: &str) -> Result<Option<String>, AppError> {
    let v = opt(s);
    if v.as_ref().map_or(false, |t| t.chars().count() > max) {
        return Err(AppError::Validation(msg.to_string()));
    }
    Ok(v)
}

fn opt_date(v: &Option<String>) -> Result<Option<String>, AppError> {
    match v.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .map(|d| Some(d.format("%Y-%m-%d").to_string()))
            .map_err(|_| AppError::Validation("Fecha inválida".into())),
    }
}

/// Convierte entre VES y USD con la tasa USD. Devuelve None si falta la tasa.
fn convert(minor: i64, from: &str, to: &str, rate: Option<i64>) -> Option<i64> {
    if from == to {
        return Some(minor);
    }
    let r = rate? as i128;
    let m = minor as i128;
    match (from, to) {
        ("VES", "USD") => Some(div_round(m * 1_000_000, r)),
        ("USD", "VES") => Some(div_round(m * r, 1_000_000)),
        _ => None,
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

fn stock_in(conn: &Connection, product_id: i64, warehouse_id: i64) -> Result<i64, AppError> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(quantity), 0) FROM stock_movements
         WHERE product_id = ?1 AND warehouse_id = ?2",
        params![product_id, warehouse_id],
        |r| r.get(0),
    )?)
}

fn no_rate() -> AppError {
    AppError::Validation(
        "No hay tasa USD vigente para expresar la retención en bolívares. Regístrala en Tasas de cambio".into(),
    )
}

// ======================= PROVEEDORES =======================
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Supplier {
    id: i64,
    id_type: String,
    id_number: String,
    name: String,
    phone: Option<String>,
    address: Option<String>,
    active: bool,
    iva_retention_bp: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierInput {
    id_type: String,
    id_number: String,
    name: String,
    phone: Option<String>,
    address: Option<String>,
}

const SUPPLIER_SELECT: &str =
    "SELECT id, id_type, id_number, name, phone, address, active, iva_retention_bp FROM suppliers";

fn map_supplier(r: &Row) -> rusqlite::Result<Supplier> {
    Ok(Supplier {
        id: r.get(0)?,
        id_type: r.get(1)?,
        id_number: r.get(2)?,
        name: r.get(3)?,
        phone: r.get(4)?,
        address: r.get(5)?,
        active: r.get::<_, i64>(6)? != 0,
        iva_retention_bp: r.get(7)?,
    })
}

fn clean_supplier(input: &mut SupplierInput) -> Result<(), AppError> {
    input.id_type = input.id_type.trim().to_uppercase();
    input.name = input.name.split_whitespace().collect::<Vec<_>>().join(" ");
    input.phone = opt(input.phone.take());
    input.address = opt(input.address.take());

    if input.name.chars().count() < 2 {
        return Err(AppError::Validation("El nombre o razón social es obligatorio".into()));
    }
    if input.name.chars().count() > 100 {
        return Err(AppError::Validation("El nombre es demasiado largo (máximo 100)".into()));
    }

    let id: String = input
        .id_number
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_uppercase();
    let all_digits = id.chars().all(|c| c.is_ascii_digit());

    match input.id_type.as_str() {
        "V" | "E" => {
            if !(all_digits && (5..=9).contains(&id.len())) {
                return Err(AppError::Validation("Cédula inválida (5 a 9 dígitos)".into()));
            }
        }
        "J" | "G" | "C" => {
            if !(all_digits && id.len() == 9) {
                return Err(AppError::Validation(
                    "El RIF debe tener 9 dígitos (8 + dígito verificador)".into(),
                ));
            }
        }
        "P" => {
            if !(5..=15).contains(&id.len()) {
                return Err(AppError::Validation("Pasaporte inválido (5 a 15 caracteres)".into()));
            }
        }
        _ => return Err(AppError::Validation("Tipo de documento inválido".into())),
    }
    input.id_number = id;
    Ok(())
}

fn map_unique(e: rusqlite::Error) -> AppError {
    match &e {
        rusqlite::Error::SqliteFailure(f, _)
            if f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
        {
            AppError::Validation("Ya existe un proveedor con ese documento".into())
        }
        _ => AppError::Db(e),
    }
}

#[tauri::command]
pub async fn list_suppliers(
    state: State<'_, AppState>,
    search: Option<String>,
    include_inactive: bool,
) -> Result<Vec<Supplier>, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let search = opt(search);
    let db = state.conn()?;
    let sql = format!(
        "{SUPPLIER_SELECT}
         WHERE (?1 IS NULL OR name LIKE '%' || ?1 || '%' OR id_number LIKE '%' || ?1 || '%')
           AND (?2 = 1 OR active = 1)
         ORDER BY name LIMIT 200"
    );
    let rows = db
        .prepare(&sql)?
        .query_map(params![search, include_inactive as i64], map_supplier)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub async fn create_supplier(
    state: State<'_, AppState>,
    mut input: SupplierInput,
) -> Result<Supplier, AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    clean_supplier(&mut input)?;
    let db = state.conn()?;
    db.execute(
        "INSERT INTO suppliers (id_type, id_number, name, phone, address)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![input.id_type, input.id_number, input.name, input.phone, input.address],
    )
    .map_err(map_unique)?;
    let id = db.last_insert_rowid();
    let detail = format!("{}-{}", input.id_type, input.id_number);
    audit::log(&db, Some(me.id), "supplier_created", Some("supplier"), Some(id), Some(&detail))?;
    Ok(db.query_row(&format!("{SUPPLIER_SELECT} WHERE id = ?1"), [id], map_supplier)?)
}

#[tauri::command]
pub async fn update_supplier(
    state: State<'_, AppState>,
    id: i64,
    mut input: SupplierInput,
) -> Result<Supplier, AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    clean_supplier(&mut input)?;
    let db = state.conn()?;
    let n = db
        .execute(
            "UPDATE suppliers SET id_type = ?1, id_number = ?2, name = ?3, phone = ?4, address = ?5
             WHERE id = ?6",
            params![input.id_type, input.id_number, input.name, input.phone, input.address, id],
        )
        .map_err(map_unique)?;
    if n == 0 {
        return Err(AppError::Validation("El proveedor no existe".into()));
    }
    audit::log(&db, Some(me.id), "supplier_updated", Some("supplier"), Some(id), None)?;
    Ok(db.query_row(&format!("{SUPPLIER_SELECT} WHERE id = ?1"), [id], map_supplier)?)
}

#[tauri::command]
pub async fn set_supplier_active(
    state: State<'_, AppState>,
    id: i64,
    active: bool,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    let n = db.execute("UPDATE suppliers SET active = ?1 WHERE id = ?2", params![active as i64, id])?;
    if n == 0 {
        return Err(AppError::Validation("El proveedor no existe".into()));
    }
    let action = if active { "supplier_activated" } else { "supplier_deactivated" };
    audit::log(&db, Some(me.id), action, Some("supplier"), Some(id), None)?;
    Ok(())
}

// ======================= CÁLCULO DE IMPUESTOS Y RETENCIONES =======================
struct SupplierRef {
    id: i64,
    id_type: String,
    iva_retention_bp: Option<i64>,
}

fn load_supplier_ref(conn: &Connection, id: i64) -> Result<SupplierRef, AppError> {
    conn.query_row(
        "SELECT id, id_type, iva_retention_bp FROM suppliers WHERE id = ?1 AND active = 1",
        [id],
        |r| Ok(SupplierRef { id: r.get(0)?, id_type: r.get(1)?, iva_retention_bp: r.get(2)? }),
    )
    .optional()?
    .ok_or_else(|| AppError::Validation("El proveedor no existe o está inactivo".into()))
}

struct CalcIn<'a> {
    supplier: Option<&'a SupplierRef>,
    currency: &'a str,
    lines_total: i64,
    exempt: i64,
    iva_rate_bp: i64,
    iva_override: Option<i64>,
    concept_id: Option<i64>,
    retain_iva: bool,
    retain_islr: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IslrCalc {
    concept_id: i64,
    concept_name: String,
    person_type: String,
    base_ves_minor: i64,
    rate_bp: i64,
    sustraendo_ves_minor: i64,
    prior_base_ves_minor: i64,
    prior_ret_ves_minor: i64,
    amount_ves_minor: i64,
    amount_minor: i64,
    note: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Calc {
    total_minor: i64,
    exempt_minor: i64,
    taxable_minor: i64,
    iva_rate_bp: i64,
    iva_minor: i64,
    invoice_total_minor: i64,
    agent_iva: bool,
    agent_islr: bool,
    iva_ret_bp: i64,
    iva_ret_minor: i64,
    iva_ret_ves_minor: i64,
    iva_base_ves_minor: i64,
    iva_ves_minor: i64,
    islr: Option<IslrCalc>,
    net_payable_minor: i64,
    needs_supplier: bool,
    notes: Vec<String>,
}

fn compute_islr(
    conn: &Connection,
    rate: Option<i64>,
    cfg: &WhCfg,
    s: &SupplierRef,
    cid: i64,
    lines_total: i64,
    cur: &str,
) -> Result<IslrCalc, AppError> {
    let row: Option<(String, Option<i64>, Option<i64>, i64, i64, i64)> = conn
        .query_row(
            "SELECT name, rate_pnr_bp, rate_pjd_bp, base_pct_bp, min_base_ut_milli, sustraendo_pnr
             FROM islr_concepts WHERE id = ?1 AND active = 1",
            [cid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()?;
    let (name, rate_pnr, rate_pjd, base_pct, min_milli, sust) = row
        .ok_or_else(|| AppError::Validation("El concepto de ISLR no existe o no está activo".into()))?;

    // La letra del RIF o cédula decide el tipo de proveedor (se asume residente/domiciliado).
    let person = match s.id_type.as_str() {
        "V" | "E" => "PNR",
        "J" | "G" | "C" => "PJD",
        _ => {
            return Err(AppError::Validation(
                "La retención de ISLR no está soportada para proveedores con pasaporte (no residentes). \
                 Gestiónala manualmente"
                    .into(),
            ))
        }
    };
    let rate_bp = (if person == "PNR" { rate_pnr } else { rate_pjd }).ok_or_else(|| {
        AppError::Validation(format!("El concepto «{name}» no tiene tarifa para este tipo de proveedor"))
    })?;
    let use_sust = person == "PNR" && sust == 1;

    let ut = match cfg.tax_unit_minor {
        Some(u) => u,
        None if use_sust || min_milli > 0 => {
            return Err(AppError::Validation(
                "Configura el valor de la unidad tributaria en la pestaña «Config. retenciones»".into(),
            ))
        }
        None => 0,
    };

    let base_ves = convert(lines_total, cur, "VES", rate).ok_or_else(no_rate)?;
    let subject = div_round(base_ves as i128 * base_pct as i128, 10_000);
    let period = Local::now().format("%Y-%m").to_string();

    // Acumulado del mes para ese proveedor y concepto (solo retenciones vigentes)
    let (prior_base, prior_ret): (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(base_ves_minor), 0), COALESCE(SUM(amount_ves_minor), 0)
         FROM withholdings
         WHERE kind = 'ISLR' AND status = 'active'
           AND supplier_id = ?1 AND concept_id = ?2 AND period = ?3",
        params![s.id, cid, period],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;

    let cum_base = prior_base + subject;
    let min_base = div_round(ut as i128 * min_milli as i128, 1000);
    // sustraendo = UT × tarifa × 83,3334
    let sust_ves = if use_sust {
        div_round(ut as i128 * rate_bp as i128 * 833_334, 100_000_000)
    } else {
        0
    };
    let cum_ret = if min_milli > 0 && cum_base < min_base {
        0
    } else {
        (div_round(cum_base as i128 * rate_bp as i128, 10_000) - sust_ves).max(0)
    };
    let amount_ves = (cum_ret - prior_ret).max(0);
    let amount = convert(amount_ves, "VES", cur, rate).unwrap_or(0);
    let note = if amount_ves == 0 {
        Some("No procede retención de ISLR en este pago (por debajo del mínimo o cubierto por el sustraendo)".to_string())
    } else {
        None
    };

    Ok(IslrCalc {
        concept_id: cid,
        concept_name: name,
        person_type: person.to_string(),
        base_ves_minor: subject,
        rate_bp,
        sustraendo_ves_minor: sust_ves,
        prior_base_ves_minor: prior_base,
        prior_ret_ves_minor: prior_ret,
        amount_ves_minor: amount_ves,
        amount_minor: amount,
        note,
    })
}

/// Única fuente de verdad de IVA, retenciones y neto a pagar.
fn compute(conn: &Connection, rate: Option<i64>, p: &CalcIn) -> Result<Calc, AppError> {
    let cfg = read_cfg(conn)?;
    let cur = p.currency;

    if p.exempt < 0 || p.exempt > p.lines_total {
        return Err(AppError::Validation(
            "El monto exento no puede ser mayor que el total de la compra".into(),
        ));
    }
    if !(0..=3000).contains(&p.iva_rate_bp) {
        return Err(AppError::Validation("Alícuota de IVA inválida".into()));
    }
    let taxable = p.lines_total - p.exempt;
    let computed = if p.iva_rate_bp == 0 {
        0
    } else {
        div_round(taxable as i128 * p.iva_rate_bp as i128, 10_000)
    };
    let iva = match p.iva_override {
        None => computed,
        Some(v) => {
            if v < 0 {
                return Err(AppError::Validation("El IVA indicado no puede ser negativo".into()));
            }
            if p.iva_rate_bp == 0 && v != 0 {
                return Err(AppError::Validation("No puede haber IVA si la compra es sin IVA".into()));
            }
            // La factura del proveedor puede diferir por redondeo, pero no mucho
            if (v - computed).abs() > std::cmp::max(2, computed / 50) {
                return Err(AppError::Validation(format!(
                    "El IVA indicado ({}) difiere mucho del calculado ({}). Revisa la base o la alícuota",
                    fmt_minor(v),
                    fmt_minor(computed)
                )));
            }
            v
        }
    };
    let invoice_total = p
        .lines_total
        .checked_add(iva)
        .ok_or_else(|| AppError::Validation("Monto demasiado grande".into()))?;

    let to_ves = |m: i64| -> Result<i64, AppError> { convert(m, cur, "VES", rate).ok_or_else(no_rate) };

    let mut notes: Vec<String> = Vec::new();
    let mut needs_supplier = false;
    let (mut iva_ret_bp, mut iva_ret, mut iva_ret_ves, mut iva_base_ves, mut iva_ves) =
        (0i64, 0i64, 0i64, 0i64, 0i64);

    if cfg.agent_iva && p.retain_iva && iva > 0 {
        match p.supplier {
            None => needs_supplier = true,
            Some(s) => {
                let pct = s.iva_retention_bp.unwrap_or(cfg.iva_default_bp);
                if pct == 0 {
                    notes.push("Este proveedor está marcado como «no retener IVA».".to_string());
                } else {
                    iva_ret = div_round(iva as i128 * pct as i128, 10_000);
                    iva_ret_bp = pct;
                    if iva_ret > 0 {
                        iva_ret_ves = to_ves(iva_ret)?;
                        iva_base_ves = to_ves(taxable)?;
                        iva_ves = to_ves(iva)?;
                    }
                }
            }
        }
    }

    let islr = if cfg.agent_islr && p.retain_islr {
        match (p.concept_id, p.supplier) {
            (Some(cid), Some(s)) => Some(compute_islr(conn, rate, &cfg, s, cid, p.lines_total, cur)?),
            (Some(_), None) => {
                needs_supplier = true;
                None
            }
            _ => None,
        }
    } else {
        None
    };

    let islr_amount = islr.as_ref().map_or(0, |i| i.amount_minor);
    Ok(Calc {
        total_minor: p.lines_total,
        exempt_minor: p.exempt,
        taxable_minor: taxable,
        iva_rate_bp: p.iva_rate_bp,
        iva_minor: iva,
        invoice_total_minor: invoice_total,
        agent_iva: cfg.agent_iva,
        agent_islr: cfg.agent_islr,
        iva_ret_bp,
        iva_ret_minor: iva_ret,
        iva_ret_ves_minor: iva_ret_ves,
        iva_base_ves_minor: iva_base_ves,
        iva_ves_minor: iva_ves,
        islr,
        net_payable_minor: invoice_total - iva_ret - islr_amount,
        needs_supplier,
        notes,
    })
}

fn next_voucher(conn: &Connection, doc_type: &str, ym: &str) -> Result<String, AppError> {
    let n: i64 = conn.query_row(
        "SELECT next_number FROM document_series WHERE doc_type = ?1 AND series = 'A'",
        [doc_type],
        |r| r.get(0),
    )?;
    conn.execute(
        "UPDATE document_series SET next_number = next_number + 1
         WHERE doc_type = ?1 AND series = 'A'",
        [doc_type],
    )?;
    Ok(format!("{ym}{n:08}"))
}

// ======================= COMPRAS =======================
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseItemInput {
    product_id: i64,
    quantity: i64,
    unit_cost_minor: i64,
    /// Datos del lote (solo se usan en productos con control de lotes).
    #[serde(default)]
    lot_code: Option<String>,
    #[serde(default)]
    lot_brand: Option<String>,
    #[serde(default)]
    lot_date: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseInput {
    supplier_id: i64,
    warehouse_id: i64,
    currency_code: String,
    invoice_number: Option<String>,
    invoice_control: Option<String>,
    invoice_date: Option<String>,
    notes: Option<String>,
    update_cost: bool,
    items: Vec<PurchaseItemInput>,
    #[serde(default)]
    exempt_minor: i64,
    #[serde(default)]
    iva_rate_bp: i64,
    iva_override_minor: Option<i64>,
    islr_concept_id: Option<i64>,
    #[serde(default = "default_true")]
    retain_iva: bool,
    #[serde(default = "default_true")]
    retain_islr: bool,
    skip_reason: Option<String>,
    #[serde(default)]
    on_credit: bool,
    credit_days: Option<i64>,
}

#[derive(Serialize)]
pub struct PurchaseCreated {
    id: i64,
    number: i64,
    vouchers: Vec<String>,
}

struct Line {
    product_id: i64,
    sku: String,
    name: String,
    qty: i64,
    cost: i64,
    total: i64,
    pcur: String,
    old_cost: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteLineIn {
    quantity: i64,
    unit_cost_minor: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteInput {
    supplier_id: Option<i64>,
    currency_code: String,
    lines: Vec<QuoteLineIn>,
    #[serde(default)]
    exempt_minor: i64,
    #[serde(default)]
    iva_rate_bp: i64,
    iva_override_minor: Option<i64>,
    islr_concept_id: Option<i64>,
    #[serde(default = "default_true")]
    retain_iva: bool,
    #[serde(default = "default_true")]
    retain_islr: bool,
}

/// Vista previa de impuestos y retenciones, calculada por Rust con las mismas reglas de la emisión.
#[tauri::command]
pub async fn quote_purchase(state: State<'_, AppState>, input: QuoteInput) -> Result<Calc, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    if !CURRENCIES.contains(&input.currency_code.as_str()) {
        return Err(AppError::Validation("Moneda inválida".into()));
    }
    if input.lines.is_empty() || input.lines.len() > 200 {
        return Err(AppError::Validation("Agrega entre 1 y 200 productos".into()));
    }
    let mut total = 0i64;
    for l in &input.lines {
        if l.quantity <= 0 || l.quantity > MAX_QTY {
            return Err(AppError::Validation("Cantidad inválida".into()));
        }
        if l.unit_cost_minor < 0 || l.unit_cost_minor > MAX_COST {
            return Err(AppError::Validation("Costo inválido".into()));
        }
        let lt = l
            .unit_cost_minor
            .checked_mul(l.quantity)
            .ok_or_else(|| AppError::Validation("Monto demasiado grande".into()))?;
        total = total
            .checked_add(lt)
            .ok_or_else(|| AppError::Validation("Monto demasiado grande".into()))?;
    }
    let db = state.conn()?;
    let rate = usd_rate(&db)?;
    let supplier = match input.supplier_id {
        Some(id) => Some(load_supplier_ref(&db, id)?),
        None => None,
    };
    compute(
        &db,
        rate,
        &CalcIn {
            supplier: supplier.as_ref(),
            currency: &input.currency_code,
            lines_total: total,
            exempt: input.exempt_minor,
            iva_rate_bp: input.iva_rate_bp,
            iva_override: input.iva_override_minor,
            concept_id: input.islr_concept_id,
            retain_iva: input.retain_iva,
            retain_islr: input.retain_islr,
        },
    )
}

#[tauri::command]
pub async fn create_purchase(
    state: State<'_, AppState>,
    input: PurchaseInput,
) -> Result<PurchaseCreated, AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;

    if !CURRENCIES.contains(&input.currency_code.as_str()) {
        return Err(AppError::Validation("Moneda inválida".into()));
    }
    if input.items.is_empty() || input.items.len() > 200 {
        return Err(AppError::Validation("Agrega entre 1 y 200 productos".into()));
    }
    let mut seen = HashSet::new();
    for it in &input.items {
        if it.quantity <= 0 || it.quantity > MAX_QTY {
            return Err(AppError::Validation("Cantidad inválida".into()));
        }
        if it.unit_cost_minor < 0 || it.unit_cost_minor > MAX_COST {
            return Err(AppError::Validation("Costo inválido".into()));
        }
        if !seen.insert(it.product_id) {
            return Err(AppError::Validation(
                "Hay un producto repetido: usa una sola línea con la cantidad total".into(),
            ));
        }
    }

    let invoice_number = short_text(
        input.invoice_number.clone(),
        40,
        "El número de factura es demasiado largo (máximo 40)",
    )?;
    let invoice_control = short_text(
        input.invoice_control.clone(),
        40,
        "El número de control es demasiado largo (máximo 40)",
    )?;
    let credit_days = if input.on_credit {
        let d = input.credit_days.unwrap_or(0);
        if !(0..=365).contains(&d) {
            return Err(AppError::Validation("Los días de crédito deben estar entre 0 y 365".into()));
        }
        Some(d)
    } else {
        None
    };
    let notes = short_text(input.notes.clone(), 200, "Las notas son demasiado largas (máximo 200)")?;
    let skip_reason = short_text(input.skip_reason.clone(), 120, "El motivo es demasiado largo (máximo 120)")?;
    let invoice_date = opt_date(&input.invoice_date)?;
    if let Some(d) = &invoice_date {
        let today = Local::now().date_naive().format("%Y-%m-%d").to_string();
        if d > &today {
            return Err(AppError::Validation("La fecha de la factura no puede ser futura".into()));
        }
    }
    let cur = input.currency_code.as_str();

    let mut db = state.conn()?;
    let tx = db.transaction()?;

    let (sup_name, sup_doc): (String, String) = tx
        .query_row(
            "SELECT name, id_type || '-' || id_number FROM suppliers WHERE id = ?1 AND active = 1",
            [input.supplier_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("El proveedor no existe o está inactivo".into()))?;
    let supplier = load_supplier_ref(&tx, input.supplier_id)?;

    let wh_name: String = tx
        .query_row(
            "SELECT name FROM warehouses WHERE id = ?1 AND active = 1",
            [input.warehouse_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("El almacén no existe o está inactivo".into()))?;

    if let Some(inv) = &invoice_number {
        let dup: i64 = tx.query_row(
            "SELECT COUNT(*) FROM purchases
             WHERE supplier_id = ?1 AND invoice_number = ?2 AND status = 'received'",
            params![input.supplier_id, inv],
            |r| r.get(0),
        )?;
        if dup > 0 {
            return Err(AppError::Validation(format!(
                "Ya registraste la factura {inv} de ese proveedor"
            )));
        }
    }

    let rate = usd_rate(&tx)?;

    let mut lines: Vec<Line> = Vec::new();
    let mut total = 0i64;
    for it in &input.items {
        let (sku, name, track, pcur, old_cost): (String, String, i64, String, i64) = tx
            .query_row(
                "SELECT sku, name, track_stock, price_currency, cost_minor
                 FROM products WHERE id = ?1 AND active = 1",
                [it.product_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::Validation("Un producto no existe o está inactivo".into()))?;
        if track == 0 {
            return Err(AppError::Validation(format!("«{name}» no controla inventario")));
        }
        let line_total = it
            .unit_cost_minor
            .checked_mul(it.quantity)
            .ok_or_else(|| AppError::Validation("Monto demasiado grande".into()))?;
        total = total
            .checked_add(line_total)
            .ok_or_else(|| AppError::Validation("Monto demasiado grande".into()))?;
        lines.push(Line {
            product_id: it.product_id,
            sku,
            name,
            qty: it.quantity,
            cost: it.unit_cost_minor,
            total: line_total,
            pcur,
            old_cost,
        });
    }
    let total_ves = convert(total, cur, "VES", rate);

    // Impuestos y retenciones (Rust es la única fuente de verdad)
    let mk = |retain_iva: bool, retain_islr: bool| CalcIn {
        supplier: Some(&supplier),
        currency: cur,
        lines_total: total,
        exempt: input.exempt_minor,
        iva_rate_bp: input.iva_rate_bp,
        iva_override: input.iva_override_minor,
        concept_id: input.islr_concept_id,
        retain_iva,
        retain_islr,
    };
    let calc = compute(&tx, rate, &mk(input.retain_iva, input.retain_islr))?;

    // Si siendo agente se decidió NO retener algo que correspondía, el motivo es obligatorio
    let mut skipped = false;
    if !input.retain_iva || !input.retain_islr {
        if let Ok(full) = compute(&tx, rate, &mk(true, true)) {
            skipped = (!input.retain_iva && full.iva_ret_minor > 0)
                || (!input.retain_islr && full.islr.as_ref().map_or(false, |i| i.amount_minor > 0));
        }
    }
    if skipped && skip_reason.as_deref().map_or(true, |r| r.chars().count() < 3) {
        return Err(AppError::Validation(
            "Indica el motivo por el que no se retiene (la compra tiene retenciones que corresponderían)".into(),
        ));
    }
    let skip_reason = if skipped { skip_reason } else { None };

    // Numeración consecutiva de la compra
    let number: i64 = tx.query_row(
        "SELECT next_number FROM document_series WHERE doc_type = 'COMPRA' AND series = 'A'",
        [],
        |r| r.get(0),
    )?;
    tx.execute(
        "UPDATE document_series SET next_number = next_number + 1
         WHERE doc_type = 'COMPRA' AND series = 'A'",
        [],
    )?;

    tx.execute(
        "INSERT INTO purchases (number, supplier_id, supplier_name, supplier_doc, warehouse_id,
            invoice_number, invoice_control, invoice_date, currency_code, exchange_rate_micro,
            total_minor, total_ves_minor, notes, user_id, iva_rate_bp, exempt_minor, iva_minor,
            invoice_total_minor, net_payable_minor, ret_skip_reason)
         VALUES (:number, :supplier_id, :supplier_name, :supplier_doc, :warehouse_id,
            :invoice_number, :invoice_control, :invoice_date, :currency, :rate,
            :total, :total_ves, :notes, :user_id, :iva_rate_bp, :exempt, :iva,
            :invoice_total, :net, :skip_reason)",
        named_params! {
            ":number": number, ":supplier_id": input.supplier_id, ":supplier_name": sup_name,
            ":supplier_doc": sup_doc, ":warehouse_id": input.warehouse_id,
            ":invoice_number": invoice_number, ":invoice_control": invoice_control,
            ":invoice_date": invoice_date, ":currency": cur, ":rate": rate,
            ":total": total, ":total_ves": total_ves, ":notes": notes, ":user_id": me.id,
            ":iva_rate_bp": calc.iva_rate_bp, ":exempt": calc.exempt_minor, ":iva": calc.iva_minor,
            ":invoice_total": calc.invoice_total_minor, ":net": calc.net_payable_minor,
            ":skip_reason": skip_reason,
        },
    )?;
    let pid = tx.last_insert_rowid();
    if let Some(days) = credit_days {
        tx.execute(
            "UPDATE purchases SET on_credit = 1,
                due_date = date('now', 'localtime', '+' || ?2 || ' days') WHERE id = ?1",
            params![pid, days],
        )?;
    }

    let move_note = match &invoice_number {
        Some(inv) => format!("Compra C-{number:06} · factura {inv}"),
        None => format!("Compra C-{number:06}"),
    };

    let mut updated = 0i64;
    for (it, l) in input.items.iter().zip(&lines) {
        tx.execute(
            "INSERT INTO purchase_items
                (purchase_id, product_id, sku, description, quantity, unit_cost_minor, line_total_minor)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![pid, l.product_id, l.sku, l.name, l.qty, l.cost, l.total],
        )?;
        // Producto con lotes: la entrada crea el lote (o suma a uno igual) con el costo de esta compra.
        let lot_id = if lots::uses_lots(&tx, l.product_id)? {
            Some(lots::receive_lot(
                &tx,
                l.product_id,
                it.lot_code.clone(),
                it.lot_brand.clone(),
                it.lot_date.clone(),
                &format!("C-{number:06}"),
                l.cost,
                cur,
                Some(pid),
            )?)
        } else {
            None
        };
        tx.execute(
            "INSERT INTO stock_movements
                (product_id, quantity, reason, note, user_id, warehouse_id, purchase_id, lot_id)
             VALUES (?1, ?2, 'compra', ?3, ?4, ?5, ?6, ?7)",
            params![l.product_id, l.qty, move_note, me.id, input.warehouse_id, pid, lot_id],
        )?;
        if input.update_cost {
            let new_cost = convert(l.cost, cur, &l.pcur, rate).ok_or_else(|| {
                AppError::Validation(
                    "No hay tasa USD vigente para convertir los costos. Pide al administrador que la \
                     registre en Tasas de cambio, o desmarca «Actualizar costo»"
                        .into(),
                )
            })?;
            if new_cost != l.old_cost {
                tx.execute(
                    "UPDATE products SET cost_minor = ?1 WHERE id = ?2",
                    params![new_cost, l.product_id],
                )?;
                updated += 1;
            }
        }
    }
    if updated > 0 {
        tx.execute("UPDATE purchases SET costs_updated = ?1 WHERE id = ?2", params![updated, pid])?;
    }

    // Comprobantes de retención
    let ym = Local::now().format("%Y%m").to_string();
    let period = Local::now().format("%Y-%m").to_string();
    let mut vouchers: Vec<String> = Vec::new();

    if calc.iva_ret_minor > 0 && calc.iva_ret_ves_minor > 0 {
        let vn = next_voucher(&tx, "RET_IVA", &ym)?;
        tx.execute(
            "INSERT INTO withholdings (purchase_id, kind, voucher_number, period, supplier_id,
                base_ves_minor, tax_ves_minor, rate_bp, amount_ves_minor, amount_minor)
             VALUES (?1, 'IVA', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![pid, vn, period, input.supplier_id, calc.iva_base_ves_minor, calc.iva_ves_minor,
                    calc.iva_ret_bp, calc.iva_ret_ves_minor, calc.iva_ret_minor],
        )?;
        vouchers.push(format!("IVA {vn}"));
    }
    if let Some(i) = &calc.islr {
        if i.amount_ves_minor > 0 {
            let vn = next_voucher(&tx, "RET_ISLR", &ym)?;
            tx.execute(
                "INSERT INTO withholdings (purchase_id, kind, voucher_number, period, supplier_id,
                    concept_id, concept_name, base_ves_minor, rate_bp, sustraendo_ves_minor,
                    prior_base_ves_minor, prior_ret_ves_minor, amount_ves_minor, amount_minor)
                 VALUES (?1, 'ISLR', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![pid, vn, period, input.supplier_id, i.concept_id, i.concept_name,
                        i.base_ves_minor, i.rate_bp, i.sustraendo_ves_minor,
                        i.prior_base_ves_minor, i.prior_ret_ves_minor,
                        i.amount_ves_minor, i.amount_minor],
            )?;
            vouchers.push(format!("ISLR {vn}"));
        }
    }

    let detail = format!(
        "C-{number:06} · {sup_name} · {wh_name} · total {} {cur} · IVA {} · ret. IVA {} · ret. ISLR {} · \
         neto {} · {updated} costo(s) actualizado(s){}",
        fmt_minor(total),
        fmt_minor(calc.iva_minor),
        fmt_minor(calc.iva_ret_minor),
        fmt_minor(calc.islr.as_ref().map_or(0, |i| i.amount_minor)),
        fmt_minor(calc.net_payable_minor),
        skip_reason.as_deref().map(|r| format!(" · sin retener: {r}")).unwrap_or_default(),
    );
    audit::log(&tx, Some(me.id), "purchase_created", Some("purchase"), Some(pid), Some(&detail))?;
    tx.commit()?;
    Ok(PurchaseCreated { id: pid, number, vouchers })
}

// ---------- Consulta ----------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseFilter {
    search: Option<String>,
    supplier_id: Option<i64>,
    status: Option<String>,
    from: Option<String>,
    to: Option<String>,
    limit: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseRow {
    id: i64,
    number: i64,
    created_at: String,
    supplier_name: String,
    warehouse_name: String,
    invoice_number: Option<String>,
    currency_code: String,
    total_minor: i64,
    status: String,
    items_count: i64,
}

#[tauri::command]
pub async fn list_purchases(
    state: State<'_, AppState>,
    filter: PurchaseFilter,
) -> Result<Vec<PurchaseRow>, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let search = opt(filter.search);
    let status = opt(filter.status);
    if let Some(s) = &status {
        if s != "received" && s != "voided" {
            return Err(AppError::Validation("Estado inválido".into()));
        }
    }
    let from = opt_date(&filter.from)?;
    let to = opt_date(&filter.to)?;
    let limit = filter.limit.unwrap_or(200).clamp(1, 500);

    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT p.id, p.number, p.created_at, p.supplier_name, w.name, p.invoice_number,
                    p.currency_code, p.total_minor, p.status,
                    (SELECT COUNT(*) FROM purchase_items i WHERE i.purchase_id = p.id)
             FROM purchases p JOIN warehouses w ON w.id = p.warehouse_id
             WHERE (?1 IS NULL OR CAST(p.number AS TEXT) LIKE '%' || ?1 || '%'
                    OR p.invoice_number LIKE '%' || ?1 || '%'
                    OR p.supplier_name LIKE '%' || ?1 || '%')
               AND (?2 IS NULL OR p.supplier_id = ?2)
               AND (?3 IS NULL OR p.status = ?3)
               AND (?4 IS NULL OR date(p.created_at, 'localtime') >= ?4)
               AND (?5 IS NULL OR date(p.created_at, 'localtime') <= ?5)
             ORDER BY p.id DESC LIMIT ?6",
        )?
        .query_map(params![search, filter.supplier_id, status, from, to, limit], |r| {
            Ok(PurchaseRow {
                id: r.get(0)?,
                number: r.get(1)?,
                created_at: r.get(2)?,
                supplier_name: r.get(3)?,
                warehouse_name: r.get(4)?,
                invoice_number: r.get(5)?,
                currency_code: r.get(6)?,
                total_minor: r.get(7)?,
                status: r.get(8)?,
                items_count: r.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseLine {
    sku: String,
    description: String,
    quantity: i64,
    unit_cost_minor: i64,
    line_total_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhLine {
    id: i64,
    kind: String,
    voucher_number: String,
    rate_bp: i64,
    amount_ves_minor: i64,
    amount_minor: i64,
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseDetail {
    id: i64,
    number: i64,
    status: String,
    created_at: String,
    supplier_name: String,
    supplier_doc: String,
    warehouse_name: String,
    invoice_number: Option<String>,
    invoice_date: Option<String>,
    invoice_control: Option<String>,
    currency_code: String,
    exchange_rate_micro: Option<i64>,
    total_minor: i64,
    total_ves_minor: Option<i64>,
    costs_updated: i64,
    notes: Option<String>,
    username: Option<String>,
    voided_at: Option<String>,
    void_reason: Option<String>,
    iva_rate_bp: i64,
    exempt_minor: i64,
    iva_minor: i64,
    invoice_total_minor: i64,
    net_payable_minor: i64,
    ret_skip_reason: Option<String>,
    lines: Vec<PurchaseLine>,
    withholdings: Vec<WhLine>,
}

#[tauri::command]
pub async fn get_purchase(state: State<'_, AppState>, id: i64) -> Result<PurchaseDetail, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let db = state.conn()?;

    let mut p = db
        .query_row(
            "SELECT p.id, p.number, p.status, p.created_at, p.supplier_name, p.supplier_doc, w.name,
                    p.invoice_number, p.invoice_date, p.invoice_control, p.currency_code,
                    p.exchange_rate_micro, p.total_minor, p.total_ves_minor, p.costs_updated,
                    p.notes, u.username, p.voided_at, p.void_reason, p.iva_rate_bp, p.exempt_minor,
                    p.iva_minor, COALESCE(p.invoice_total_minor, p.total_minor),
                    COALESCE(p.net_payable_minor, p.total_minor), p.ret_skip_reason
             FROM purchases p
             JOIN warehouses w ON w.id = p.warehouse_id
             LEFT JOIN users u ON u.id = p.user_id
             WHERE p.id = ?1",
            [id],
            |r| {
                Ok(PurchaseDetail {
                    id: r.get(0)?,
                    number: r.get(1)?,
                    status: r.get(2)?,
                    created_at: r.get(3)?,
                    supplier_name: r.get(4)?,
                    supplier_doc: r.get(5)?,
                    warehouse_name: r.get(6)?,
                    invoice_number: r.get(7)?,
                    invoice_date: r.get(8)?,
                    invoice_control: r.get(9)?,
                    currency_code: r.get(10)?,
                    exchange_rate_micro: r.get(11)?,
                    total_minor: r.get(12)?,
                    total_ves_minor: r.get(13)?,
                    costs_updated: r.get(14)?,
                    notes: r.get(15)?,
                    username: r.get(16)?,
                    voided_at: r.get(17)?,
                    void_reason: r.get(18)?,
                    iva_rate_bp: r.get(19)?,
                    exempt_minor: r.get(20)?,
                    iva_minor: r.get(21)?,
                    invoice_total_minor: r.get(22)?,
                    net_payable_minor: r.get(23)?,
                    ret_skip_reason: r.get(24)?,
                    lines: vec![],
                    withholdings: vec![],
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("La compra no existe".into()))?;

    p.lines = db
        .prepare(
            "SELECT sku, description, quantity, unit_cost_minor, line_total_minor
             FROM purchase_items WHERE purchase_id = ?1 ORDER BY id",
        )?
        .query_map([id], |r| {
            Ok(PurchaseLine {
                sku: r.get(0)?,
                description: r.get(1)?,
                quantity: r.get(2)?,
                unit_cost_minor: r.get(3)?,
                line_total_minor: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    p.withholdings = db
        .prepare(
            "SELECT id, kind, voucher_number, rate_bp, amount_ves_minor, amount_minor, status
             FROM withholdings WHERE purchase_id = ?1 ORDER BY id",
        )?
        .query_map([id], |r| {
            Ok(WhLine {
                id: r.get(0)?,
                kind: r.get(1)?,
                voucher_number: r.get(2)?,
                rate_bp: r.get(3)?,
                amount_ves_minor: r.get(4)?,
                amount_minor: r.get(5)?,
                status: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(p)
}

#[tauri::command]
pub async fn void_purchase(
    state: State<'_, AppState>,
    id: i64,
    reason: String,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let reason = reason.trim().to_string();
    if reason.chars().count() < 5 {
        return Err(AppError::Validation("Indica el motivo de la anulación (mínimo 5 caracteres)".into()));
    }

    let mut db = state.conn()?;
    let tx = db.transaction()?;

    let (status, wh, number): (String, i64, i64) = tx
        .query_row(
            "SELECT status, warehouse_id, number FROM purchases WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("La compra no existe".into()))?;
    if status != "received" {
        return Err(AppError::Validation("Esta compra ya está anulada".into()));
    }
    let paid: i64 = tx.query_row(
        "SELECT COUNT(*) FROM ap_allocations a JOIN ap_payments v ON v.id = a.payment_id
         WHERE a.purchase_id = ?1 AND v.voided_at IS NULL",
        [id],
        |r| r.get(0),
    )?;
    if paid > 0 {
        return Err(AppError::Validation(
            "Esta compra tiene pagos registrados: anula primero esos pagos en Cuentas por pagar".into(),
        ));
    }

    // Se revierte lo que entró, lote por lote.
    let items = tx
        .prepare(
            "SELECT m.product_id, m.quantity, p.name, m.lot_id
             FROM stock_movements m JOIN products p ON p.id = m.product_id
             WHERE m.purchase_id = ?1 AND m.reason = 'compra'",
        )?
        .query_map([id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<i64>>(3)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // No se puede dejar stock negativo: las unidades deben seguir en ese almacén (y en ese lote).
    for (pid, qty, name, lot_id) in &items {
        let avail = match lot_id {
            Some(l) => lots::lot_stock(&tx, *l, wh)?,
            None => stock_in(&tx, *pid, wh)?,
        };
        if *qty > avail {
            return Err(AppError::Validation(format!(
                "No se puede anular: de «{name}» ya no quedan {qty} unidades en el almacén \
                 (disponible: {avail}). Probablemente ya se vendieron o se movieron"
            )));
        }
    }

    for (pid, qty, _, lot_id) in &items {
        tx.execute(
            "INSERT INTO stock_movements
                (product_id, quantity, reason, note, user_id, warehouse_id, purchase_id, lot_id)
             VALUES (?1, ?2, 'anulacion_compra', ?3, ?4, ?5, ?6, ?7)",
            params![pid, -qty, reason, me.id, wh, id, lot_id],
        )?;
    }
    tx.execute(
        "UPDATE purchases SET status = 'voided', voided_at = datetime('now'), void_reason = ?2
         WHERE id = ?1",
        params![id, reason],
    )?;
    // Los comprobantes de retención de esta compra también quedan anulados
    let voided_wh = tx.execute(
        "UPDATE withholdings SET status = 'voided', voided_at = datetime('now')
         WHERE purchase_id = ?1 AND status = 'active'",
        [id],
    )?;
    let detail = format!("C-{number:06}: {reason} · {voided_wh} comprobante(s) de retención anulado(s)");
    audit::log(&tx, Some(me.id), "purchase_voided", Some("purchase"), Some(id), Some(&detail))?;
    tx.commit()?;
    Ok(())
}