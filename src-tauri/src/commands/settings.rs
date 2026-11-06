use crate::{audit, error::AppError, security, state::AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompanyData {
    rif: String,
    legal_name: String,
    trade_name: Option<String>,
    fiscal_address: String,
    phone: Option<String>,
    email: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxRateRow {
    id: i64,
    code: String,
    name: String,
    rate_bp: i64,
    editable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsData {
    company: CompanyData,
    igtf_bp: i64,
    cashier_max_discount_bp: i64,
    receipt_legend: String,
    tax_rates: Vec<TaxRateRow>,
    has_recovery_code: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxRateInput {
    id: i64,
    rate_bp: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInput {
    company: CompanyData,
    igtf_bp: i64,
    cashier_max_discount_bp: i64,
    receipt_legend: String,
    tax_rates: Vec<TaxRateInput>,
}

const DEFAULT_LEGEND: &str = "DOCUMENTO SIN VALIDEZ FISCAL";

fn clean(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn read_company(conn: &Connection) -> Result<CompanyData, AppError> {
    Ok(conn.query_row(
        "SELECT rif, legal_name, trade_name, fiscal_address, phone, email FROM company WHERE id = 1",
        [],
        |r| {
            Ok(CompanyData {
                rif: r.get(0)?,
                legal_name: r.get(1)?,
                trade_name: r.get(2)?,
                fiscal_address: r.get(3)?,
                phone: r.get(4)?,
                email: r.get(5)?,
            })
        },
    )?)
}

fn read_igtf(conn: &Connection) -> Result<i64, AppError> {
    let v: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'igtf_bp'", [], |r| r.get(0))
        .optional()?;
    Ok(v.and_then(|s| s.trim().parse().ok()).unwrap_or(300))
}

fn read_max_discount(conn: &Connection) -> Result<i64, AppError> {
    let v: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'cashier_max_discount_bp'", [], |r| r.get(0))
        .optional()?;
    Ok(v.and_then(|s| s.trim().parse().ok()).unwrap_or(1000))
}

fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<SettingsData, AppError> {
    security::require_role(&state, &["admin"])?;
    let db = state.conn()?;

    let company = read_company(&db)?;
    let igtf_bp = read_igtf(&db)?;
    let cashier_max_discount_bp = read_max_discount(&db)?;
    let receipt_legend: String = db
        .query_row("SELECT value FROM settings WHERE key = 'receipt_legend'", [], |r| r.get(0))
        .optional()?
        .unwrap_or_else(|| DEFAULT_LEGEND.to_string());
    let tax_rates = db
        .prepare("SELECT id, code, name, rate_bp FROM tax_rates WHERE active = 1 ORDER BY rate_bp DESC")?
        .query_map([], |r| {
            let code: String = r.get(1)?;
            Ok(TaxRateRow {
                id: r.get(0)?,
                editable: code != "EXENTO",
                code,
                name: r.get(2)?,
                rate_bp: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let has: i64 = db.query_row(
        "SELECT COUNT(*) FROM settings WHERE key = 'admin_recovery_hash'",
        [],
        |r| r.get(0),
    )?;

    Ok(SettingsData { company, igtf_bp, cashier_max_discount_bp, receipt_legend, tax_rates, has_recovery_code: has > 0 })
}

#[tauri::command]
pub async fn save_settings(state: State<'_, AppState>, input: SettingsInput) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;

    let mut c = input.company;
    c.rif = c.rif.trim().to_uppercase();
    c.legal_name = c.legal_name.trim().to_string();
    c.fiscal_address = c.fiscal_address.trim().to_string();
    c.trade_name = clean(c.trade_name);
    c.phone = clean(c.phone);
    c.email = clean(c.email);

    if c.rif.len() < 5 || c.rif.len() > 20 {
        return Err(AppError::Validation("RIF inválido".into()));
    }
    if c.legal_name.chars().count() < 2 {
        return Err(AppError::Validation("La razón social es obligatoria".into()));
    }
    if c.fiscal_address.chars().count() < 5 {
        return Err(AppError::Validation("El domicilio fiscal es obligatorio".into()));
    }
    if let Some(e) = &c.email {
        if !e.contains('@') || e.contains(' ') {
            return Err(AppError::Validation("Correo electrónico inválido".into()));
        }
    }
    if !(0..=1000).contains(&input.igtf_bp) {
        return Err(AppError::Validation("El IGTF debe estar entre 0 % y 10 %".into()));
    }
    if !(0..=10_000).contains(&input.cashier_max_discount_bp) {
        return Err(AppError::Validation("El descuento máximo del cajero debe estar entre 0 % y 100 %".into()));
    }
    // La leyenda es obligatoria: evita que un comprobante interno pase por factura.
    let legend = input.receipt_legend.trim().to_string();
    let legend_len = legend.chars().count();
    if !(5..=80).contains(&legend_len) {
        return Err(AppError::Validation("La leyenda del ticket debe tener entre 5 y 80 caracteres".into()));
    }

    let mut db = state.conn()?;
    let tx = db.transaction()?;
    let mut changes: Vec<String> = Vec::new();

    if read_company(&tx)? != c {
        changes.push("datos de la empresa".into());
    }
    tx.execute(
        "UPDATE company SET rif = ?1, legal_name = ?2, trade_name = ?3, fiscal_address = ?4,
                phone = ?5, email = ?6 WHERE id = 1",
        params![c.rif, c.legal_name, c.trade_name, c.fiscal_address, c.phone, c.email],
    )?;

    let old_igtf = read_igtf(&tx)?;
    if old_igtf != input.igtf_bp {
        changes.push(format!("IGTF {old_igtf} -> {} (puntos base)", input.igtf_bp));
    }
    set_setting(&tx, "igtf_bp", &input.igtf_bp.to_string())?;

    let old_disc = read_max_discount(&tx)?;
    if old_disc != input.cashier_max_discount_bp {
        changes.push(format!("descuento máximo del cajero {old_disc} -> {} (puntos base)", input.cashier_max_discount_bp));
    }
    set_setting(&tx, "cashier_max_discount_bp", &input.cashier_max_discount_bp.to_string())?;

    let old_legend: Option<String> = tx
        .query_row("SELECT value FROM settings WHERE key = 'receipt_legend'", [], |r| r.get(0))
        .optional()?;
    if old_legend.as_deref() != Some(legend.as_str()) {
        changes.push("leyenda del ticket".into());
    }
    set_setting(&tx, "receipt_legend", &legend)?;

    for t in &input.tax_rates {
        if !(0..=3000).contains(&t.rate_bp) {
            return Err(AppError::Validation("Cada impuesto debe estar entre 0 % y 30 %".into()));
        }
        let (code, old): (String, i64) = tx
            .query_row("SELECT code, rate_bp FROM tax_rates WHERE id = ?1", [t.id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?
            .ok_or_else(|| AppError::Validation("Impuesto inexistente".into()))?;
        if code == "EXENTO" && t.rate_bp != 0 {
            return Err(AppError::Validation("El impuesto exento siempre es 0 %".into()));
        }
        if old != t.rate_bp {
            changes.push(format!("{code} {old} -> {} (puntos base)", t.rate_bp));
            tx.execute("UPDATE tax_rates SET rate_bp = ?1 WHERE id = ?2", params![t.rate_bp, t.id])?;
        }
    }

    if !changes.is_empty() {
        audit::log(&tx, Some(me.id), "settings_updated", Some("settings"), None, Some(&changes.join("; ")))?;
    }
    tx.commit()?;
    Ok(())
}