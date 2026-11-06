use crate::{audit, error::AppError, security, state::AppState};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

// ---------- Configuración compartida ----------
pub struct WhCfg {
    pub agent_iva: bool,
    pub agent_islr: bool,
    pub iva_default_bp: i64,
    pub tax_unit_minor: Option<i64>,
}

fn setting(conn: &Connection, key: &str) -> Result<Option<String>, AppError> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()?)
}

fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn read_cfg(conn: &Connection) -> Result<WhCfg, AppError> {
    let flag = |k: &str| -> Result<bool, AppError> { Ok(setting(conn, k)?.as_deref() == Some("1")) };
    Ok(WhCfg {
        agent_iva: flag("wh_agent_iva")?,
        agent_islr: flag("wh_agent_islr")?,
        iva_default_bp: setting(conn, "wh_iva_default_bp")?
            .and_then(|s| s.trim().parse().ok())
            .filter(|v| *v == 7500 || *v == 10000)
            .unwrap_or(7500),
        tax_unit_minor: setting(conn, "tax_unit_minor")?
            .and_then(|s| s.trim().parse::<i64>().ok())
            .filter(|v| *v > 0),
    })
}

fn opt(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn opt_date(v: &Option<String>) -> Result<Option<String>, AppError> {
    match v.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .map(|d| Some(d.format("%Y-%m-%d").to_string()))
            .map_err(|_| AppError::Validation("Fecha inválida".into())),
    }
}

fn convert_ves(minor: i64, cur: &str, rate: Option<i64>) -> i64 {
    if cur == "VES" {
        return minor;
    }
    match rate {
        Some(r) => ((minor as i128 * r as i128 + 500_000) / 1_000_000) as i64,
        None => 0,
    }
}

// ---------- Conceptos de ISLR ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Concept {
    id: i64,
    code: String,
    name: String,
    rate_pnr_bp: Option<i64>,
    rate_pjd_bp: Option<i64>,
    base_pct_bp: i64,
    min_base_ut_milli: i64,
    sustraendo_pnr: bool,
    active: bool,
}

const CONCEPT_SELECT: &str = "SELECT id, code, name, rate_pnr_bp, rate_pjd_bp, base_pct_bp,
    min_base_ut_milli, sustraendo_pnr, active FROM islr_concepts";

fn map_concept(r: &Row) -> rusqlite::Result<Concept> {
    Ok(Concept {
        id: r.get(0)?,
        code: r.get(1)?,
        name: r.get(2)?,
        rate_pnr_bp: r.get(3)?,
        rate_pjd_bp: r.get(4)?,
        base_pct_bp: r.get(5)?,
        min_base_ut_milli: r.get(6)?,
        sustraendo_pnr: r.get::<_, i64>(7)? != 0,
        active: r.get::<_, i64>(8)? != 0,
    })
}

fn list_concepts(conn: &Connection, only_active: bool) -> Result<Vec<Concept>, AppError> {
    let sql = format!(
        "{CONCEPT_SELECT} WHERE (?1 = 0 OR active = 1) ORDER BY active DESC, name"
    );
    Ok(conn
        .prepare(&sql)?
        .query_map([only_active as i64], map_concept)?
        .collect::<Result<Vec<_>, _>>()?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionOptions {
    agent_iva: bool,
    agent_islr: bool,
    iva_default_bp: i64,
    concepts: Vec<Concept>,
}

/// Lo que necesita la pantalla de compras (admin y almacén).
#[tauri::command]
pub async fn retention_options(state: State<'_, AppState>) -> Result<RetentionOptions, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let db = state.conn()?;
    let cfg = read_cfg(&db)?;
    Ok(RetentionOptions {
        agent_iva: cfg.agent_iva,
        agent_islr: cfg.agent_islr,
        iva_default_bp: cfg.iva_default_bp,
        concepts: list_concepts(&db, true)?,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhConfigOut {
    agent_iva: bool,
    agent_islr: bool,
    iva_default_bp: i64,
    tax_unit_minor: Option<i64>,
    concepts: Vec<Concept>,
}

#[tauri::command]
pub async fn get_withholding_config(state: State<'_, AppState>) -> Result<WhConfigOut, AppError> {
    security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    let cfg = read_cfg(&db)?;
    Ok(WhConfigOut {
        agent_iva: cfg.agent_iva,
        agent_islr: cfg.agent_islr,
        iva_default_bp: cfg.iva_default_bp,
        tax_unit_minor: cfg.tax_unit_minor,
        concepts: list_concepts(&db, false)?,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigInput {
    agent_iva: bool,
    agent_islr: bool,
    iva_default_bp: i64,
    tax_unit_minor: Option<i64>,
}

#[tauri::command]
pub async fn save_withholding_config(
    state: State<'_, AppState>,
    input: ConfigInput,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    if input.iva_default_bp != 7500 && input.iva_default_bp != 10000 {
        return Err(AppError::Validation("El porcentaje de retención de IVA debe ser 75 % o 100 %".into()));
    }
    if let Some(u) = input.tax_unit_minor {
        if !(1..=1_000_000_000).contains(&u) {
            return Err(AppError::Validation("Valor de la unidad tributaria fuera de rango".into()));
        }
    }
    let db = state.conn()?;
    let old = read_cfg(&db)?;
    set_setting(&db, "wh_agent_iva", if input.agent_iva { "1" } else { "0" })?;
    set_setting(&db, "wh_agent_islr", if input.agent_islr { "1" } else { "0" })?;
    set_setting(&db, "wh_iva_default_bp", &input.iva_default_bp.to_string())?;
    match input.tax_unit_minor {
        Some(u) => set_setting(&db, "tax_unit_minor", &u.to_string())?,
        None => {
            db.execute("DELETE FROM settings WHERE key = 'tax_unit_minor'", [])?;
        }
    }
    let detail = format!(
        "agente IVA {}->{}, agente ISLR {}->{}, IVA {}->{} pb, UT {:?}->{:?} (centavos)",
        old.agent_iva, input.agent_iva, old.agent_islr, input.agent_islr,
        old.iva_default_bp, input.iva_default_bp, old.tax_unit_minor, input.tax_unit_minor
    );
    audit::log(&db, Some(me.id), "retention_config_saved", Some("settings"), None, Some(&detail))?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConceptInput {
    id: Option<i64>,
    code: String,
    name: String,
    rate_pnr_bp: Option<i64>,
    rate_pjd_bp: Option<i64>,
    base_pct_bp: i64,
    min_base_ut_milli: i64,
    sustraendo_pnr: bool,
}

#[tauri::command]
pub async fn save_islr_concept(
    state: State<'_, AppState>,
    input: ConceptInput,
) -> Result<i64, AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let code = input.code.trim().to_uppercase();
    let name = input.name.split_whitespace().collect::<Vec<_>>().join(" ");
    if !(2..=14).contains(&code.chars().count())
        || !code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(AppError::Validation("El código debe tener de 2 a 14 letras, números o guion bajo".into()));
    }
    if !(3..=80).contains(&name.chars().count()) {
        return Err(AppError::Validation("El nombre debe tener entre 3 y 80 caracteres".into()));
    }
    if input.rate_pnr_bp.is_none() && input.rate_pjd_bp.is_none() {
        return Err(AppError::Validation("Indica al menos una tarifa (persona natural o jurídica)".into()));
    }
    for r in [input.rate_pnr_bp, input.rate_pjd_bp].into_iter().flatten() {
        if !(1..=10_000).contains(&r) {
            return Err(AppError::Validation("Las tarifas deben estar entre 0,01 % y 100 %".into()));
        }
    }
    if !(1..=10_000).contains(&input.base_pct_bp) {
        return Err(AppError::Validation("El porcentaje de la base debe estar entre 0,01 % y 100 %".into()));
    }
    if !(0..=1_000_000_000).contains(&input.min_base_ut_milli) {
        return Err(AppError::Validation("Mínimo en unidades tributarias inválido".into()));
    }
    if input.sustraendo_pnr && input.rate_pnr_bp.is_none() {
        return Err(AppError::Validation("El sustraendo solo aplica si hay tarifa para persona natural".into()));
    }

    let db = state.conn()?;
    let map_unique = |e: rusqlite::Error| match &e {
        rusqlite::Error::SqliteFailure(f, _)
            if f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
        {
            AppError::Validation("Ya existe un concepto con ese código o nombre".into())
        }
        _ => AppError::Db(e),
    };
    let id = match input.id {
        Some(id) => {
            let n = db
                .execute(
                    "UPDATE islr_concepts SET code=?1, name=?2, rate_pnr_bp=?3, rate_pjd_bp=?4,
                        base_pct_bp=?5, min_base_ut_milli=?6, sustraendo_pnr=?7 WHERE id=?8",
                    params![code, name, input.rate_pnr_bp, input.rate_pjd_bp, input.base_pct_bp,
                            input.min_base_ut_milli, input.sustraendo_pnr as i64, id],
                )
                .map_err(map_unique)?;
            if n == 0 {
                return Err(AppError::Validation("El concepto no existe".into()));
            }
            id
        }
        None => {
            db.execute(
                "INSERT INTO islr_concepts (code, name, rate_pnr_bp, rate_pjd_bp, base_pct_bp,
                    min_base_ut_milli, sustraendo_pnr, active)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
                params![code, name, input.rate_pnr_bp, input.rate_pjd_bp, input.base_pct_bp,
                        input.min_base_ut_milli, input.sustraendo_pnr as i64],
            )
            .map_err(map_unique)?;
            db.last_insert_rowid()
        }
    };
    let detail = format!(
        "{code} · PNR {:?} · PJD {:?} · base {} pb · mín {} milésimas de UT",
        input.rate_pnr_bp, input.rate_pjd_bp, input.base_pct_bp, input.min_base_ut_milli
    );
    audit::log(&db, Some(me.id), "islr_concept_saved", Some("islr_concept"), Some(id), Some(&detail))?;
    Ok(id)
}

#[tauri::command]
pub async fn set_islr_concept_active(
    state: State<'_, AppState>,
    id: i64,
    active: bool,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    let n = db.execute("UPDATE islr_concepts SET active = ?1 WHERE id = ?2", params![active as i64, id])?;
    if n == 0 {
        return Err(AppError::Validation("El concepto no existe".into()));
    }
    let action = if active { "islr_concept_activated" } else { "islr_concept_deactivated" };
    audit::log(&db, Some(me.id), action, Some("islr_concept"), Some(id), None)?;
    Ok(())
}

/// Porcentaje de retención de IVA propio del proveedor: None = predeterminado.
#[tauri::command]
pub async fn set_supplier_retention(
    state: State<'_, AppState>,
    id: i64,
    iva_retention_bp: Option<i64>,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    if let Some(v) = iva_retention_bp {
        if v != 0 && v != 7500 && v != 10000 {
            return Err(AppError::Validation("Porcentaje inválido (0, 75 % o 100 %)".into()));
        }
    }
    let db = state.conn()?;
    let n = db.execute("UPDATE suppliers SET iva_retention_bp = ?1 WHERE id = ?2", params![iva_retention_bp, id])?;
    if n == 0 {
        return Err(AppError::Validation("El proveedor no existe".into()));
    }
    let detail = format!("{:?}", iva_retention_bp);
    audit::log(&db, Some(me.id), "supplier_retention_set", Some("supplier"), Some(id), Some(&detail))?;
    Ok(())
}

// ---------- Listado de retenciones ----------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhFilter {
    from: Option<String>,
    to: Option<String>,
    kind: Option<String>,
    status: Option<String>,
    search: Option<String>,
    limit: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhRow {
    id: i64,
    kind: String,
    voucher_number: String,
    period: String,
    created_at: String,
    supplier_name: String,
    supplier_doc: String,
    purchase_number: i64,
    invoice_number: Option<String>,
    concept_name: Option<String>,
    base_ves_minor: i64,
    tax_ves_minor: i64,
    rate_bp: i64,
    amount_ves_minor: i64,
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhTotal {
    kind: String,
    count: i64,
    amount_ves_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhList {
    rows: Vec<WhRow>,
    totals: Vec<WhTotal>,
}

#[tauri::command]
pub async fn list_withholdings(
    state: State<'_, AppState>,
    filter: WhFilter,
) -> Result<WhList, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let from = opt_date(&filter.from)?;
    let to = opt_date(&filter.to)?;
    let kind = opt(filter.kind);
    if let Some(k) = &kind {
        if k != "IVA" && k != "ISLR" {
            return Err(AppError::Validation("Tipo inválido".into()));
        }
    }
    let status = opt(filter.status);
    if let Some(s) = &status {
        if s != "active" && s != "voided" {
            return Err(AppError::Validation("Estado inválido".into()));
        }
    }
    let search = opt(filter.search);
    let limit = filter.limit.unwrap_or(300).clamp(1, 1000);

    const WHERE: &str = "WHERE (?1 IS NULL OR date(w.created_at,'localtime') >= ?1)
        AND (?2 IS NULL OR date(w.created_at,'localtime') <= ?2)
        AND (?3 IS NULL OR w.kind = ?3)
        AND (?5 IS NULL OR w.voucher_number LIKE '%' || ?5 || '%'
             OR p.supplier_name LIKE '%' || ?5 || '%' OR p.invoice_number LIKE '%' || ?5 || '%')";

    let db = state.conn()?;
    let sql = format!(
        "SELECT w.id, w.kind, w.voucher_number, w.period, w.created_at, p.supplier_name,
                p.supplier_doc, p.number, p.invoice_number, w.concept_name, w.base_ves_minor,
                w.tax_ves_minor, w.rate_bp, w.amount_ves_minor, w.status
         FROM withholdings w JOIN purchases p ON p.id = w.purchase_id
         {WHERE} AND (?4 IS NULL OR w.status = ?4)
         ORDER BY w.id DESC LIMIT ?6"
    );
    let rows = db
        .prepare(&sql)?
        .query_map(params![from, to, kind, status, search, limit], |r| {
            Ok(WhRow {
                id: r.get(0)?,
                kind: r.get(1)?,
                voucher_number: r.get(2)?,
                period: r.get(3)?,
                created_at: r.get(4)?,
                supplier_name: r.get(5)?,
                supplier_doc: r.get(6)?,
                purchase_number: r.get(7)?,
                invoice_number: r.get(8)?,
                concept_name: r.get(9)?,
                base_ves_minor: r.get(10)?,
                tax_ves_minor: r.get(11)?,
                rate_bp: r.get(12)?,
                amount_ves_minor: r.get(13)?,
                status: r.get(14)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let tsql = format!(
        "SELECT w.kind, COUNT(*), COALESCE(SUM(w.amount_ves_minor), 0)
         FROM withholdings w JOIN purchases p ON p.id = w.purchase_id
         {WHERE} AND w.status = 'active' AND (?4 IS NULL OR 1 = 1) AND ?6 > 0
         GROUP BY w.kind ORDER BY w.kind"
    );
    let totals = db
        .prepare(&tsql)?
        .query_map(params![from, to, kind, status, search, limit], |r| {
            Ok(WhTotal { kind: r.get(0)?, count: r.get(1)?, amount_ves_minor: r.get(2)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(WhList { rows, totals })
}

// ---------- Comprobante ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Voucher {
    id: i64,
    kind: String,
    voucher_number: String,
    period: String,
    created_at: String,
    status: String,
    voided_at: Option<String>,
    agent_name: String,
    agent_rif: String,
    agent_address: String,
    supplier_name: String,
    supplier_doc: String,
    supplier_address: Option<String>,
    purchase_number: i64,
    invoice_number: Option<String>,
    invoice_control: Option<String>,
    invoice_date: Option<String>,
    currency_code: String,
    invoice_total_ves_minor: i64,
    exempt_ves_minor: i64,
    iva_rate_bp: i64,
    concept_name: Option<String>,
    base_ves_minor: i64,
    tax_ves_minor: i64,
    rate_bp: i64,
    sustraendo_ves_minor: i64,
    prior_base_ves_minor: i64,
    prior_ret_ves_minor: i64,
    amount_ves_minor: i64,
}

#[tauri::command]
pub async fn get_withholding_voucher(state: State<'_, AppState>, id: i64) -> Result<Voucher, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let db = state.conn()?;
    let mut v = db
        .query_row(
            "SELECT w.id, w.kind, w.voucher_number, w.period, w.created_at, w.status, w.voided_at,
                    p.supplier_name, p.supplier_doc, s.address, p.number, p.invoice_number,
                    p.invoice_control, p.invoice_date, p.currency_code, p.exchange_rate_micro,
                    COALESCE(p.invoice_total_minor, p.total_minor), p.exempt_minor, p.iva_rate_bp,
                    w.concept_name, w.base_ves_minor, w.tax_ves_minor, w.rate_bp,
                    w.sustraendo_ves_minor, w.prior_base_ves_minor, w.prior_ret_ves_minor,
                    w.amount_ves_minor
             FROM withholdings w
             JOIN purchases p ON p.id = w.purchase_id
             JOIN suppliers s ON s.id = w.supplier_id
             WHERE w.id = ?1",
            [id],
            |r| {
                let cur: String = r.get(14)?;
                let rate: Option<i64> = r.get(15)?;
                let total: i64 = r.get(16)?;
                let exempt: i64 = r.get(17)?;
                Ok(Voucher {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    voucher_number: r.get(2)?,
                    period: r.get(3)?,
                    created_at: r.get(4)?,
                    status: r.get(5)?,
                    voided_at: r.get(6)?,
                    agent_name: String::new(),
                    agent_rif: String::new(),
                    agent_address: String::new(),
                    supplier_name: r.get(7)?,
                    supplier_doc: r.get(8)?,
                    supplier_address: r.get(9)?,
                    purchase_number: r.get(10)?,
                    invoice_number: r.get(11)?,
                    invoice_control: r.get(12)?,
                    invoice_date: r.get(13)?,
                    invoice_total_ves_minor: convert_ves(total, &cur, rate),
                    exempt_ves_minor: convert_ves(exempt, &cur, rate),
                    currency_code: cur,
                    iva_rate_bp: r.get(18)?,
                    concept_name: r.get(19)?,
                    base_ves_minor: r.get(20)?,
                    tax_ves_minor: r.get(21)?,
                    rate_bp: r.get(22)?,
                    sustraendo_ves_minor: r.get(23)?,
                    prior_base_ves_minor: r.get(24)?,
                    prior_ret_ves_minor: r.get(25)?,
                    amount_ves_minor: r.get(26)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("El comprobante no existe".into()))?;

    let (name, rif, addr): (String, String, String) = db.query_row(
        "SELECT legal_name, rif, fiscal_address FROM company WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    v.agent_name = name;
    v.agent_rif = rif;
    v.agent_address = addr;
    Ok(v)
}