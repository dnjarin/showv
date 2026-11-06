//! Cotizaciones (presupuestos): no mueven stock, caja ni contabilidad.
//! Los montos los calcula el mismo motor de las ventas (`sales::compute`), sin validar existencias.

use crate::commands::pricing::resolve_list;
use crate::commands::sales::{compute, max_discount_bp, usd_rate, CartItem, Quote};
use crate::{audit, error::AppError, security, state::AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteInput {
    customer_id: Option<i64>,
    customer_name: Option<String>,
    currency_code: String,
    items: Vec<CartItem>,
    valid_days: i64,
    notes: Option<String>,
    price_list_id: Option<i64>,
    #[serde(default)]
    pay_condition: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteRow {
    id: i64,
    number: String,
    customer_name: String,
    currency_code: String,
    total_minor: i64,
    status: String,
    valid_until: String,
    expired: bool,
    created_at: String,
    created_by_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteItemOut {
    sku: String,
    description: String,
    quantity: i64,
    unit_price_minor: i64,
    discount_bp: i64,
    discount_minor: i64,
    tax_code: String,
    tax_rate_bp: i64,
    base_minor: i64,
    line_total_minor: i64,
}

/// Formato visual de la cotización (logo, garantías y pie), editable por el administrador.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteStyle {
    logo: Option<String>,
    warranty_title: String,
    warranty: String,
    footer: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteDetail {
    id: i64,
    number: String,
    customer_name: String,
    customer_doc: Option<String>,
    customer_phone: Option<String>,
    currency_code: String,
    usd_rate_micro: Option<i64>,
    valid_until: String,
    expired: bool,
    notes: Option<String>,
    status: String,
    document_id: Option<i64>,
    discount_minor: i64,
    subtotal_minor: i64,
    exempt_minor: i64,
    tax_minor: i64,
    total_minor: i64,
    total_ves_minor: i64,
    created_at: String,
    created_by_name: Option<String>,
    issuer_name: String,
    issuer_rif: String,
    issuer_address: String,
    issuer_phone: Option<String>,
    customer_address: Option<String>,
    pay_condition: String,
    style: QuoteStyle,
    items: Vec<QuoteItemOut>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CartItemOut {
    product_id: i64,
    quantity: i64,
    discount_bp: i64,
    sku: String,
    name: String,
    uses_lots: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteCart {
    id: i64,
    number: String,
    currency_code: String,
    customer_name: String,
    price_list_id: Option<i64>,
    items: Vec<CartItemOut>,
}

/// Cálculo en vivo para la pantalla (sin guardar y sin exigir existencias).
#[tauri::command]
pub async fn quote_preview(
    state: State<'_, AppState>,
    currency_code: String,
    items: Vec<CartItem>,
    price_list_id: Option<i64>,
) -> Result<Quote, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;
    let rate = usd_rate(&db)?;
    let max_bp = max_discount_bp(&db, &me)?;
    let list = resolve_list(&db, &me, price_list_id)?;
    compute(false, &db, &currency_code, &items, rate, true, max_bp, list)
}

#[tauri::command]
pub async fn quote_create(state: State<'_, AppState>, input: QuoteInput) -> Result<i64, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    if !(1..=365).contains(&input.valid_days) {
        return Err(AppError::Validation("La vigencia debe estar entre 1 y 365 días".into()));
    }
    let mut db = state.conn()?;
    let tx = db.transaction()?;
    let rate = usd_rate(&tx)?;
    let max_bp = max_discount_bp(&tx, &me)?;
    let list = resolve_list(&tx, &me, input.price_list_id)?;
    let q = compute(false, &tx, &input.currency_code, &input.items, rate, true, max_bp, list)?;

    let mut customer_name = input
        .customer_name
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if let Some(cid) = input.customer_id {
        customer_name = tx
            .query_row("SELECT name FROM customers WHERE id = ?1", [cid], |r| r.get(0))
            .optional()?
            .ok_or_else(|| AppError::Validation("El cliente no existe".into()))?;
    }
    if customer_name.chars().count() > 80 {
        return Err(AppError::Validation("El nombre del cliente es demasiado largo".into()));
    }
    let pay_condition = match input.pay_condition.as_deref().map(str::trim) {
        None | Some("") | Some("CONTADO") => "CONTADO",
        Some("CREDITO") => "CREDITO",
        Some(_) => return Err(AppError::Validation("Condición de pago inválida".into())),
    };
    let notes = input.notes.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    if notes.as_ref().map_or(false, |n| n.chars().count() > 500) {
        return Err(AppError::Validation("Las notas son demasiado largas (máx. 500)".into()));
    }

    tx.execute(
        "INSERT INTO quotes (number, customer_id, customer_name, currency_code, usd_rate_micro,
                valid_until, notes, discount_minor, subtotal_minor, exempt_minor, tax_minor,
                total_minor, total_ves_minor, created_by, price_list_id, pay_condition)
         VALUES ('COT-' || printf('%06d', (SELECT COALESCE(MAX(id), 0) + 1 FROM quotes)),
                 ?1, ?2, ?3, ?4, date('now','localtime', '+' || ?5 || ' days'), ?6,
                 ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            input.customer_id,
            customer_name,
            q.currency_code,
            q.usd_rate_micro,
            input.valid_days,
            notes,
            q.discount_minor,
            q.subtotal_minor,
            q.exempt_minor,
            q.tax_minor,
            q.total_minor,
            q.total_ves_minor,
            me.id,
            list,
            pay_condition
        ],
    )?;
    let id = tx.last_insert_rowid();
    for l in &q.lines {
        tx.execute(
            "INSERT INTO quote_items (quote_id, product_id, sku, description, quantity,
                    unit_price_minor, discount_bp, discount_minor, tax_code, tax_rate_bp,
                    base_minor, tax_minor, line_total_minor)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                id,
                l.product_id,
                l.sku,
                l.description,
                l.quantity,
                l.unit_price_minor,
                l.discount_bp,
                l.discount_minor,
                l.tax_code,
                l.tax_rate_bp,
                l.base_minor,
                l.tax_minor,
                l.line_total_minor
            ],
        )?;
    }
    let number: String = tx.query_row("SELECT number FROM quotes WHERE id = ?1", [id], |r| r.get(0))?;
    audit::log(&tx, Some(me.id), "quote_created", Some("quote"), Some(id), Some(&number))?;
    tx.commit()?;
    Ok(id)
}

#[tauri::command]
pub async fn quote_list(
    state: State<'_, AppState>,
    status: Option<String>,
    search: Option<String>,
) -> Result<Vec<QuoteRow>, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let status = status.filter(|s| ["open", "converted", "cancelled"].contains(&s.as_str()));
    let search = search.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT q.id, q.number, q.customer_name, q.currency_code, q.total_minor, q.status,
                    q.valid_until, q.status = 'open' AND q.valid_until < date('now','localtime'),
                    q.created_at, u.full_name
             FROM quotes q LEFT JOIN users u ON u.id = q.created_by
             WHERE (?1 IS NULL OR q.status = ?1)
               AND (?2 IS NULL OR q.number LIKE '%' || ?2 || '%' OR q.customer_name LIKE '%' || ?2 || '%')
             ORDER BY q.id DESC LIMIT 300",
        )?
        .query_map(params![status, search], |r| {
            Ok(QuoteRow {
                id: r.get(0)?,
                number: r.get(1)?,
                customer_name: r.get(2)?,
                currency_code: r.get(3)?,
                total_minor: r.get(4)?,
                status: r.get(5)?,
                valid_until: r.get(6)?,
                expired: r.get::<_, i64>(7)? != 0,
                created_at: r.get(8)?,
                created_by_name: r.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn load_detail(conn: &Connection, id: i64) -> Result<QuoteDetail, AppError> {
    let mut d = conn
        .query_row(
            "SELECT q.id, q.number, q.customer_name, c.id_type || '-' || c.id_number, c.phone,
                    q.currency_code, q.usd_rate_micro, q.valid_until,
                    q.status = 'open' AND q.valid_until < date('now','localtime'),
                    q.notes, q.status, q.document_id, q.discount_minor, q.subtotal_minor,
                    q.exempt_minor, q.tax_minor, q.total_minor, q.total_ves_minor,
                    q.created_at, u.full_name, q.pay_condition, c.fiscal_address
             FROM quotes q
             LEFT JOIN customers c ON c.id = q.customer_id
             LEFT JOIN users u ON u.id = q.created_by
             WHERE q.id = ?1",
            [id],
            |r| {
                Ok(QuoteDetail {
                    id: r.get(0)?,
                    number: r.get(1)?,
                    customer_name: r.get(2)?,
                    customer_doc: r.get(3)?,
                    customer_phone: r.get(4)?,
                    currency_code: r.get(5)?,
                    usd_rate_micro: r.get(6)?,
                    valid_until: r.get(7)?,
                    expired: r.get::<_, i64>(8)? != 0,
                    notes: r.get(9)?,
                    status: r.get(10)?,
                    document_id: r.get(11)?,
                    discount_minor: r.get(12)?,
                    subtotal_minor: r.get(13)?,
                    exempt_minor: r.get(14)?,
                    tax_minor: r.get(15)?,
                    total_minor: r.get(16)?,
                    total_ves_minor: r.get(17)?,
                    created_at: r.get(18)?,
                    created_by_name: r.get(19)?,
                    issuer_name: String::new(),
                    issuer_rif: String::new(),
                    issuer_address: String::new(),
                    issuer_phone: None,
                    customer_address: r.get(21)?,
                    pay_condition: r.get(20)?,
                    style: default_style(),
                    items: Vec::new(),
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("La cotización no existe".into()))?;

    let (rif, name, trade, addr, phone): (String, String, Option<String>, String, Option<String>) = conn.query_row(
        "SELECT rif, legal_name, trade_name, fiscal_address, phone FROM company WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    d.issuer_rif = rif;
    d.issuer_name = trade.filter(|t| !t.trim().is_empty()).unwrap_or(name);
    d.issuer_address = addr;
    d.issuer_phone = phone;
    d.style = read_style(conn)?;
    d.items = conn
        .prepare(
            "SELECT sku, description, quantity, unit_price_minor, discount_bp, discount_minor,
                    tax_code, tax_rate_bp, base_minor, line_total_minor
             FROM quote_items WHERE quote_id = ?1 ORDER BY id",
        )?
        .query_map([id], |r| {
            Ok(QuoteItemOut {
                sku: r.get(0)?,
                description: r.get(1)?,
                quantity: r.get(2)?,
                unit_price_minor: r.get(3)?,
                discount_bp: r.get(4)?,
                discount_minor: r.get(5)?,
                tax_code: r.get(6)?,
                tax_rate_bp: r.get(7)?,
                base_minor: r.get(8)?,
                line_total_minor: r.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(d)
}

const DEFAULT_WARRANTY_TITLE: &str = "Garantía de Equipos Refurbished";
const DEFAULT_WARRANTY: &str = "1 Año CPU\n6 Meses Fuente de poder\n3 Meses Monitor\n30 Días accesorios\n7 Días SO (Windows 10 Pro y Office 2016)\n1 Mes (Disco SSD)";
const DEFAULT_FOOTER: &str = "COTIZACIÓN SUJETA A CAMBIOS";
const MAX_LOGO_CHARS: usize = 900_000;

fn default_style() -> QuoteStyle {
    QuoteStyle {
        logo: None,
        warranty_title: DEFAULT_WARRANTY_TITLE.into(),
        warranty: DEFAULT_WARRANTY.into(),
        footer: DEFAULT_FOOTER.into(),
    }
}

fn setting(conn: &Connection, key: &str) -> Result<Option<String>, AppError> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get::<_, String>(0))
        .optional()?)
}

fn read_style(conn: &Connection) -> Result<QuoteStyle, AppError> {
    let d = default_style();
    Ok(QuoteStyle {
        logo: setting(conn, "quote_logo")?.filter(|l| !l.is_empty()),
        warranty_title: setting(conn, "quote_warranty_title")?.unwrap_or(d.warranty_title),
        warranty: setting(conn, "quote_warranty")?.unwrap_or(d.warranty),
        footer: setting(conn, "quote_footer")?.unwrap_or(d.footer),
    })
}

fn put_setting(conn: &Connection, key: &str, value: &str) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Formato de la cotización (logo, garantías, pie). Solo el administrador lo edita.
#[tauri::command]
pub async fn quote_style_get(state: State<'_, AppState>) -> Result<QuoteStyle, AppError> {
    security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    read_style(&db)
}

#[tauri::command]
pub async fn quote_style_save(state: State<'_, AppState>, input: QuoteStyle) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let title = input.warranty_title.trim().to_string();
    let warranty = input.warranty.replace("\r\n", "\n").trim().to_string();
    let footer = input.footer.trim().to_string();
    if title.chars().count() > 80 {
        return Err(AppError::Validation("El título de la garantía es demasiado largo (máx. 80)".into()));
    }
    if warranty.chars().count() > 800 || warranty.lines().count() > 12 {
        return Err(AppError::Validation("Las garantías admiten hasta 12 líneas y 800 caracteres".into()));
    }
    if footer.chars().count() > 120 {
        return Err(AppError::Validation("El pie de la cotización es demasiado largo (máx. 120)".into()));
    }
    let logo = input.logo.map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
    if let Some(l) = &logo {
        let ok_head = l.starts_with("data:image/png;base64,") || l.starts_with("data:image/jpeg;base64,");
        let body = l.split_once(',').map(|x| x.1).unwrap_or("");
        let ok_body = body.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='));
        if !ok_head || !ok_body || l.len() > MAX_LOGO_CHARS {
            return Err(AppError::Validation("El logo debe ser una imagen PNG o JPG de hasta 650 KB".into()));
        }
    }
    let mut db = state.conn()?;
    let tx = db.transaction()?;
    match &logo {
        Some(l) => put_setting(&tx, "quote_logo", l)?,
        None => {
            tx.execute("DELETE FROM settings WHERE key = 'quote_logo'", [])?;
        }
    }
    put_setting(&tx, "quote_warranty_title", &title)?;
    put_setting(&tx, "quote_warranty", &warranty)?;
    put_setting(&tx, "quote_footer", &footer)?;
    audit::log(&tx, Some(me.id), "quote_style_saved", Some("settings"), None, None)?;
    tx.commit()?;
    Ok(())
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' => continue,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Guarda en la carpeta Descargas el PDF o JPG de una cotización (el contenido llega en base64).
#[tauri::command]
pub async fn save_quote_file(
    app: AppHandle,
    state: State<'_, AppState>,
    filename: String,
    data: String,
) -> Result<String, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let lower = filename.to_lowercase();
    let ok_name = filename.len() <= 80
        && (lower.ends_with(".pdf") || lower.ends_with(".jpg"))
        && filename.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        && !filename.contains("..");
    if !ok_name {
        return Err(AppError::Validation("Nombre de archivo inválido".into()));
    }
    if data.len() > 14_000_000 {
        return Err(AppError::Validation("El archivo es demasiado grande".into()));
    }
    let bytes = b64_decode(&data).ok_or_else(|| AppError::Validation("Contenido inválido".into()))?;
    let magic_ok = if lower.ends_with(".pdf") { bytes.starts_with(b"%PDF-") } else { bytes.starts_with(&[0xFF, 0xD8, 0xFF]) };
    if !magic_ok {
        return Err(AppError::Validation("El contenido no corresponde al tipo de archivo".into()));
    }
    let dir = app.path().download_dir().map_err(|e| AppError::Internal(e.to_string()))?;
    let mut path = dir.join(&filename);
    if path.exists() {
        // No pisa un archivo abierto o anterior: agrega -2, -3…
        let (stem, ext) = filename.rsplit_once('.').unwrap_or((filename.as_str(), ""));
        let mut n = 2;
        while path.exists() && n < 1000 {
            path = dir.join(format!("{stem}-{n}.{ext}"));
            n += 1;
        }
    }
    std::fs::write(&path, bytes).map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub async fn quote_get(state: State<'_, AppState>, id: i64) -> Result<QuoteDetail, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;
    load_detail(&db, id)
}

#[tauri::command]
pub async fn quote_cancel(state: State<'_, AppState>, id: i64) -> Result<(), AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;
    let n = db.execute(
        "UPDATE quotes SET status = 'cancelled', closed_at = datetime('now')
         WHERE id = ?1 AND status = 'open'",
        [id],
    )?;
    if n == 0 {
        return Err(AppError::Validation("Solo se pueden anular cotizaciones abiertas".into()));
    }
    audit::log(&db, Some(me.id), "quote_cancelled", Some("quote"), Some(id), None)?;
    Ok(())
}

/// Devuelve las líneas para cargarlas en «Nueva venta». Con precios vencidos no se convierte.
#[tauri::command]
pub async fn quote_to_cart(state: State<'_, AppState>, id: i64) -> Result<QuoteCart, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;
    let (number, status, currency, customer, expired): (String, String, String, String, i64) = db
        .query_row(
            "SELECT number, status, currency_code, customer_name,
                    valid_until < date('now','localtime') FROM quotes WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("La cotización no existe".into()))?;
    if status != "open" {
        return Err(AppError::Validation("La cotización ya no está abierta".into()));
    }
    if expired != 0 {
        return Err(AppError::Validation(
            "La cotización está vencida: los precios pudieron cambiar. Crea una nueva".into(),
        ));
    }
    let items = db
        .prepare("SELECT qi.product_id, qi.quantity, qi.discount_bp, qi.sku, qi.description,
                    COALESCE((SELECT p.uses_lots FROM products p WHERE p.id = qi.product_id), 0)
             FROM quote_items qi WHERE qi.quote_id = ?1 ORDER BY qi.id")?
        .query_map([id], |r| {
            Ok(CartItemOut {
                product_id: r.get(0)?,
                quantity: r.get(1)?,
                discount_bp: r.get(2)?,
                sku: r.get(3)?,
                name: r.get(4)?,
                uses_lots: r.get::<_, i64>(5)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let price_list_id: Option<i64> =
        db.query_row("SELECT price_list_id FROM quotes WHERE id = ?1", [id], |r| r.get(0))?;
    Ok(QuoteCart { id, number, currency_code: currency, customer_name: customer, price_list_id, items })
}

/// Se llama después de emitir la venta creada desde la cotización.
#[tauri::command]
pub async fn quote_mark_converted(
    state: State<'_, AppState>,
    id: i64,
    document_id: i64,
) -> Result<(), AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;
    let ok: i64 = db.query_row("SELECT COUNT(*) FROM documents WHERE id = ?1", [document_id], |r| r.get(0))?;
    if ok == 0 {
        return Err(AppError::Validation("El documento no existe".into()));
    }
    let n = db.execute(
        "UPDATE quotes SET status = 'converted', document_id = ?2, closed_at = datetime('now')
         WHERE id = ?1 AND status = 'open'",
        params![id, document_id],
    )?;
    if n > 0 {
        let detail = format!("documento {document_id}");
        audit::log(&db, Some(me.id), "quote_converted", Some("quote"), Some(id), Some(&detail))?;
    }
    Ok(())
}

// ───────────────────────── Cotizaciones emitidas (modo liviano) ─────────────────────────
// La pantalla calcula todo en el cliente con los precios que escribe el vendedor.
// La base de datos solo recibe UNA fila por documento emitido (auditoría) y nada más.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteContext {
    rate_micro: Option<i64>,
    issuer_name: String,
    issuer_rif: String,
    issuer_address: String,
    issuer_phone: Option<String>,
    style: QuoteStyle,
}

/// Datos de apoyo para armar la cotización: tasa vigente, datos de la empresa y formato.
#[tauri::command]
pub async fn quote_context(state: State<'_, AppState>) -> Result<QuoteContext, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;
    let rate_micro = usd_rate(&db)?;
    let (rif, name, trade, addr, phone): (String, String, Option<String>, String, Option<String>) = db.query_row(
        "SELECT rif, legal_name, trade_name, fiscal_address, phone FROM company WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    Ok(QuoteContext {
        rate_micro,
        issuer_name: trade.filter(|t| !t.trim().is_empty()).unwrap_or(name),
        issuer_rif: rif,
        issuer_address: addr,
        issuer_phone: phone,
        style: read_style(&db)?,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueInput {
    currency_code: String,
    rate_micro: Option<i64>,
    customer_name: Option<String>,
    total_minor: i64,
    payload: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueOut {
    id: i64,
    number: String,
    created_at: String,
    created_by_name: Option<String>,
}

fn doc_number(id: i64) -> String {
    format!("COT-{:06}", id)
}

/// Registra la cotización emitida: un INSERT y una línea de auditoría.
#[tauri::command]
pub async fn quote_issue(state: State<'_, AppState>, input: IssueInput) -> Result<IssueOut, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    if !["USD", "VES"].contains(&input.currency_code.as_str()) {
        return Err(AppError::Validation("Moneda inválida".into()));
    }
    if input.total_minor < 0 {
        return Err(AppError::Validation("Total inválido".into()));
    }
    if input.payload.len() > 200_000 || !input.payload.trim_start().starts_with('{') {
        return Err(AppError::Validation("Detalle de la cotización inválido".into()));
    }
    let customer = input.customer_name.unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ");
    if customer.chars().count() > 80 {
        return Err(AppError::Validation("El nombre del cliente es demasiado largo".into()));
    }
    let db = state.conn()?;
    // La tasa mostrada en pantalla debe seguir siendo la vigente (una lectura).
    if input.currency_code == "VES" {
        let now = usd_rate(&db)?;
        if now.is_none() || now != input.rate_micro {
            return Err(AppError::Validation(
                "La tasa BCV cambió mientras armabas la cotización. Vuelve a abrirla para usar la tasa vigente.".into(),
            ));
        }
    }
    db.execute(
        "INSERT INTO quote_docs (created_at, created_by, customer_name, currency_code, rate_micro, total_minor, payload)
         VALUES (datetime('now'), ?1, ?2, ?3, ?4, ?5, ?6)",
        params![me.id, customer, input.currency_code, input.rate_micro, input.total_minor, input.payload],
    )?;
    let id = db.last_insert_rowid();
    let (created_at, by): (String, Option<String>) = db.query_row(
        "SELECT d.created_at, u.full_name FROM quote_docs d LEFT JOIN users u ON u.id = d.created_by WHERE d.id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let number = doc_number(id);
    audit::log(
        &db,
        Some(me.id),
        "quote_issued",
        Some("quote_doc"),
        Some(id),
        Some(&format!("{} {} {}", number, input.currency_code, input.total_minor)),
    )?;
    Ok(IssueOut { id, number, created_at, created_by_name: by })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocRow {
    id: i64,
    number: String,
    created_at: String,
    customer_name: String,
    currency_code: String,
    total_minor: i64,
    created_by_name: Option<String>,
}

/// Historial (solo lectura) de cotizaciones emitidas, sin el detalle.
#[tauri::command]
pub async fn quote_docs_list(state: State<'_, AppState>, search: Option<String>) -> Result<Vec<DocRow>, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let search = search.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT d.id, d.created_at, d.customer_name, d.currency_code, d.total_minor, u.full_name
             FROM quote_docs d LEFT JOIN users u ON u.id = d.created_by
             WHERE ?1 IS NULL OR d.customer_name LIKE '%' || ?1 || '%'
                OR printf('COT-%06d', d.id) LIKE '%' || ?1 || '%'
             ORDER BY d.id DESC LIMIT 200",
        )?
        .query_map(params![search], |r| {
            let id: i64 = r.get(0)?;
            Ok(DocRow {
                id,
                number: doc_number(id),
                created_at: r.get(1)?,
                customer_name: r.get(2)?,
                currency_code: r.get(3)?,
                total_minor: r.get(4)?,
                created_by_name: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocOut {
    id: i64,
    number: String,
    created_at: String,
    created_by_name: Option<String>,
    payload: String,
}

/// Un documento emitido, para reimprimirlo.
#[tauri::command]
pub async fn quote_doc_get(state: State<'_, AppState>, id: i64) -> Result<DocOut, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let db = state.conn()?;
    let doc = db
        .query_row(
            "SELECT d.created_at, u.full_name, d.payload FROM quote_docs d
             LEFT JOIN users u ON u.id = d.created_by WHERE d.id = ?1",
            [id],
            |r| Ok(DocOut { id, number: doc_number(id), created_at: r.get(0)?, created_by_name: r.get(1)?, payload: r.get(2)? }),
        )
        .optional()?;
    doc.ok_or_else(|| AppError::Validation("La cotización no existe".into()))
}
