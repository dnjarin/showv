//! Importación y exportación masiva (productos).
//!
//! Etapas independientes, para poder mejorar cada una sin tocar las demás:
//!   1. `parse_csv` / `read_table`  -> texto a tabla (aquí se agregaría .xlsx)
//!   2. `parse_item`                -> celdas a un `Item` validado (reglas por entidad)
//!   3. `plan_products`             -> compara con la base: nuevo / actualiza / sin cambios / error
//!   4. `import_apply`              -> aplica en UNA transacción
//! La vista previa queda guardada (import_batches / import_rows) para revisarla,
//! y el lote queda como historial.

use crate::{audit, error::AppError, security, state::AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Manager, State};

const MAX_ROWS: usize = 5000;
const MAX_BYTES: usize = 5_000_000;
const HEADER: [&str; 11] = [
    "sku", "codigo_barras", "nombre", "categoria", "iva", "costo", "precio", "moneda",
    "stock_minimo", "stock_inicial", "controla_stock",
];

// ---------- Etapa 1: texto -> tabla ----------
pub(crate) fn detect_delimiter(text: &str) -> char {
    let first = text.lines().next().unwrap_or("");
    let mut best = (';', 0usize);
    for d in [';', ',', '\t'] {
        let n = first.matches(d).count();
        if n > best.1 {
            best = (d, n);
        }
    }
    best.0
}

pub(crate) fn parse_csv(text: &str, delim: char) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    cell.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                cell.push(c);
            }
        } else if c == '"' && cell.is_empty() {
            quoted = true;
        } else if c == delim {
            row.push(std::mem::take(&mut cell));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut cell));
            rows.push(std::mem::take(&mut row));
        } else {
            cell.push(c);
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }
    rows
}

pub(crate) fn norm(s: &str) -> String {
    s.chars()
        .flat_map(|c| c.to_lowercase())
        .filter_map(|c| match c {
            'á' | 'à' | 'ä' | 'â' => Some('a'),
            'é' | 'è' | 'ë' | 'ê' => Some('e'),
            'í' | 'ì' | 'ï' | 'î' => Some('i'),
            'ó' | 'ò' | 'ö' | 'ô' => Some('o'),
            'ú' | 'ù' | 'ü' | 'û' => Some('u'),
            'ñ' => Some('n'),
            c if c.is_ascii_alphanumeric() => Some(c),
            _ => None,
        })
        .collect()
}

/// Alias de encabezados -> campo interno. Para aceptar otro nombre, se agrega aquí.
fn field_of(header: &str) -> Option<&'static str> {
    Some(match norm(header).as_str() {
        "sku" | "codigo" | "codigointerno" | "cod" | "referencia" => "sku",
        "codigobarras" | "codigodebarras" | "barras" | "barcode" | "ean" | "upc" => "barcode",
        "nombre" | "producto" | "descripcion" | "articulo" => "name",
        "categoria" | "rubro" | "grupo" => "category",
        "iva" | "alicuota" | "alicuotaiva" | "impuesto" => "tax",
        "costo" | "costounitario" | "preciocosto" => "cost",
        "precio" | "preciodeventa" | "precioventa" | "pvp" => "price",
        "moneda" | "divisa" => "currency",
        "stockminimo" | "minimo" | "min" => "min_stock",
        "stockinicial" | "existenciainicial" | "existencia" | "cantidad" | "stock" => "initial_stock",
        "controlastock" | "controlarstock" | "inventariable" => "track",
        "stockactual" | "existenciaactual" => "ignore",
        _ => return None,
    })
}

// ---------- Etapa 2: celdas -> Item ----------
#[derive(Serialize, Deserialize, Default, Clone)]
struct Item {
    sku: String,
    barcode: Option<String>,
    name: Option<String>,
    category: Option<String>,
    tax_rate_id: Option<i64>,
    tax_code: Option<String>,
    cost_minor: Option<i64>,
    price_minor: Option<i64>,
    currency: Option<String>,
    min_stock: Option<i64>,
    initial_stock: Option<i64>,
    track_stock: Option<bool>,
}

/// "12,50" · "12.50" · "1.234,56" · "1,234.56" · "$ 12" -> centavos.
pub(crate) fn parse_money(raw: &str) -> Result<i64, String> {
    let t: String = raw.chars().filter(|c| !c.is_whitespace() && *c != '$').collect();
    if t.is_empty() {
        return Err("monto vacío".into());
    }
    let (int_part, dec_part): (String, String) = match (t.rfind('.'), t.rfind(',')) {
        (Some(a), Some(b)) => {
            let p = a.max(b);
            (t[..p].to_string(), t[p + 1..].to_string())
        }
        (Some(p), None) | (None, Some(p)) => {
            let sep = t.as_bytes()[p] as char;
            if t.matches(sep).count() > 1 {
                (t.clone(), String::new()) // varios separadores: son de miles
            } else {
                (t[..p].to_string(), t[p + 1..].to_string())
            }
        }
        (None, None) => (t.clone(), String::new()),
    };
    let int_digits: String = int_part.chars().filter(|c| *c != '.' && *c != ',').collect();
    if !int_digits.chars().all(|c| c.is_ascii_digit())
        || !dec_part.chars().all(|c| c.is_ascii_digit())
        || (int_digits.is_empty() && dec_part.is_empty())
    {
        return Err(format!("monto inválido «{raw}»"));
    }
    if dec_part.len() > 2 {
        return Err(format!("«{raw}» tiene más de 2 decimales (usa 12,50)"));
    }
    if int_digits.len() > 12 {
        return Err(format!("monto demasiado grande «{raw}»"));
    }
    let int: i64 = if int_digits.is_empty() { 0 } else { int_digits.parse().unwrap_or(0) };
    let dec: i64 = format!("{:0<2}", dec_part).parse().unwrap_or(0);
    Ok(int * 100 + dec)
}

fn parse_uint(raw: &str, what: &str) -> Result<i64, String> {
    let t = raw.trim();
    if t.is_empty() || t.len() > 9 || !t.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("{what} debe ser un entero sin decimales (recibí «{raw}»)"));
    }
    Ok(t.parse().unwrap_or(0))
}

fn parse_bool(raw: &str) -> Result<bool, String> {
    match norm(raw).as_str() {
        "si" | "s" | "1" | "true" | "yes" | "y" => Ok(true),
        "no" | "n" | "0" | "false" => Ok(false),
        _ => Err(format!("«{raw}» no es SI/NO")),
    }
}

struct Tax {
    id: i64,
    code: String,
    name: String,
    rate_bp: i64,
}

fn resolve_tax(raw: &str, taxes: &[Tax]) -> Result<(i64, String), String> {
    let n = norm(raw);
    let pct = raw.trim().trim_end_matches('%').trim().replace(',', ".");
    let by_pct = pct.parse::<f64>().ok().map(|p| (p * 100.0).round() as i64);
    for t in taxes {
        if norm(&t.code) == n || norm(&t.name) == n || Some(t.rate_bp) == by_pct {
            return Ok((t.id, t.code.clone()));
        }
    }
    let opts: Vec<String> = taxes.iter().map(|t| t.code.clone()).collect();
    Err(format!("IVA «{raw}» no reconocido (usa {} o el porcentaje)", opts.join(", ")))
}

fn parse_item(
    cols: &HashMap<&'static str, usize>,
    cells: &[String],
    taxes: &[Tax],
) -> (Item, Vec<String>) {
    let get = |f: &str| -> Option<String> {
        cols.get(f)
            .and_then(|i| cells.get(*i))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let mut it = Item::default();
    let mut errs: Vec<String> = Vec::new();

    it.sku = get("sku").unwrap_or_default().to_uppercase();
    if it.sku.is_empty() {
        errs.push("falta el SKU".into());
    } else if it.sku.chars().count() > 40 {
        errs.push("SKU demasiado largo (máx. 40)".into());
    }
    it.barcode = get("barcode");
    it.name = get("name").map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "));
    if it.name.as_ref().map(|n| n.chars().count() > 120).unwrap_or(false) {
        errs.push("nombre demasiado largo (máx. 120)".into());
    }
    it.category = get("category").map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "));
    if let Some(c) = &it.category {
        if !(2..=40).contains(&c.chars().count()) {
            errs.push("la categoría debe tener entre 2 y 40 caracteres".into());
        }
    }
    if let Some(v) = get("tax") {
        match resolve_tax(&v, taxes) {
            Ok((id, code)) => {
                it.tax_rate_id = Some(id);
                it.tax_code = Some(code);
            }
            Err(e) => errs.push(e),
        }
    }
    if let Some(v) = get("cost") {
        match parse_money(&v) {
            Ok(m) => it.cost_minor = Some(m),
            Err(e) => errs.push(format!("costo: {e}")),
        }
    }
    if let Some(v) = get("price") {
        match parse_money(&v) {
            Ok(m) => it.price_minor = Some(m),
            Err(e) => errs.push(format!("precio: {e}")),
        }
    }
    if let Some(v) = get("currency") {
        match norm(&v).as_str() {
            "usd" | "dolar" | "dolares" => it.currency = Some("USD".into()),
            "ves" | "bs" | "bolivar" | "bolivares" => it.currency = Some("VES".into()),
            _ => errs.push(format!("moneda «{v}» no válida (USD o VES)")),
        }
    }
    if let Some(v) = get("min_stock") {
        match parse_uint(&v, "stock mínimo") {
            Ok(n) => it.min_stock = Some(n),
            Err(e) => errs.push(e),
        }
    }
    if let Some(v) = get("initial_stock") {
        match parse_uint(&v, "stock inicial") {
            Ok(n) => it.initial_stock = Some(n),
            Err(e) => errs.push(e),
        }
    }
    if let Some(v) = get("track") {
        match parse_bool(&v) {
            Ok(b) => it.track_stock = Some(b),
            Err(e) => errs.push(format!("controla stock: {e}")),
        }
    }
    (it, errs)
}

// ---------- Etapa 3: plan (comparación con la base) ----------
struct Existing {
    id: i64,
    name: String,
    barcode: Option<String>,
    category: Option<String>,
    tax_rate_id: i64,
    cost: i64,
    price: i64,
    currency: String,
    min_stock: i64,
    track: bool,
}

fn find_existing(conn: &Connection, sku: &str) -> Result<Option<Existing>, AppError> {
    Ok(conn
        .query_row(
            "SELECT p.id, p.name, p.barcode, c.name, p.tax_rate_id, p.cost_minor, p.price_minor,
                    p.price_currency, p.min_stock, p.track_stock
             FROM products p LEFT JOIN categories c ON c.id = p.category_id
             WHERE p.sku = ?1",
            [sku],
            |r| {
                Ok(Existing {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    barcode: r.get(2)?,
                    category: r.get(3)?,
                    tax_rate_id: r.get(4)?,
                    cost: r.get(5)?,
                    price: r.get(6)?,
                    currency: r.get(7)?,
                    min_stock: r.get(8)?,
                    track: r.get::<_, i64>(9)? != 0,
                })
            },
        )
        .optional()?)
}

struct Planned {
    line_no: i64,
    action: &'static str,
    sku: String,
    message: String,
    item: Item,
}

fn load_taxes(conn: &Connection) -> Result<Vec<Tax>, AppError> {
    let v = conn
        .prepare("SELECT id, code, name, rate_bp FROM tax_rates WHERE active = 1 ORDER BY rate_bp DESC")?
        .query_map([], |r| {
            Ok(Tax { id: r.get(0)?, code: r.get(1)?, name: r.get(2)?, rate_bp: r.get(3)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(v)
}

fn plan_products(
    conn: &Connection,
    cols: &HashMap<&'static str, usize>,
    data: &[Vec<String>],
    mode: &str,
) -> Result<Vec<Planned>, AppError> {
    let taxes = load_taxes(conn)?;
    let default_tax = taxes.iter().find(|t| t.code == "GENERAL").map(|t| (t.id, t.code.clone()));
    let mut seen_sku: HashSet<String> = HashSet::new();
    let mut seen_barcode: HashMap<String, String> = HashMap::new();
    let mut out: Vec<Planned> = Vec::new();

    for (i, cells) in data.iter().enumerate() {
        let line_no = (i + 2) as i64; // la línea 1 es el encabezado
        let (mut item, mut errs) = parse_item(cols, cells, &taxes);
        let mut notes: Vec<String> = Vec::new();
        let sku = item.sku.clone();

        if !sku.is_empty() && !seen_sku.insert(sku.clone()) {
            errs.push("SKU repetido en el archivo".into());
        }
        if let Some(b) = &item.barcode {
            let clash = seen_barcode.get(b).filter(|o| **o != sku).cloned();
            if let Some(other) = clash {
                errs.push(format!("el código de barras ya se usa en la línea del SKU {other}"));
            } else {
                seen_barcode.insert(b.clone(), sku.clone());
            }
            let owner: Option<String> = conn
                .query_row("SELECT sku FROM products WHERE barcode = ?1", [b], |r| r.get(0))
                .optional()?;
            if let Some(o) = owner {
                if o != sku {
                    errs.push(format!("el código de barras ya pertenece al SKU {o}"));
                }
            }
        }

        let existing = if sku.is_empty() { None } else { find_existing(conn, &sku)? };
        let mut action: &'static str = "error";

        if errs.is_empty() {
            match existing {
                None => {
                    if mode == "update" {
                        action = "skipped";
                        notes.push("No existe y el modo es «solo actualizar»".into());
                    } else {
                        if item.name.is_none() {
                            errs.push("producto nuevo: falta el nombre".into());
                        }
                        if item.price_minor.is_none() {
                            errs.push("producto nuevo: falta el precio".into());
                        }
                        if item.tax_rate_id.is_none() {
                            match &default_tax {
                                Some((id, code)) => {
                                    item.tax_rate_id = Some(*id);
                                    item.tax_code = Some(code.clone());
                                }
                                None => errs.push("producto nuevo: falta el IVA".into()),
                            }
                        }
                        if errs.is_empty() {
                            action = "new";
                            notes.push("Producto nuevo".into());
                            if item.initial_stock.unwrap_or(0) > 0 && item.track_stock == Some(false) {
                                notes.push("stock inicial ignorado (no controla stock)".into());
                            }
                        }
                    }
                }
                Some(ex) => {
                    if mode == "create" {
                        action = "skipped";
                        notes.push("Ya existe y el modo es «solo crear»".into());
                    } else {
                        let mut changes: Vec<&str> = Vec::new();
                        if item.name.as_ref().map_or(false, |v| *v != ex.name) {
                            changes.push("nombre");
                        }
                        if item.barcode.as_ref().map_or(false, |v| Some(v) != ex.barcode.as_ref()) {
                            changes.push("código de barras");
                        }
                        if item.category.as_ref().map_or(false, |v| {
                            ex.category.as_ref().map_or(true, |c| c.to_lowercase() != v.to_lowercase())
                        }) {
                            changes.push("categoría");
                        }
                        if item.tax_rate_id.map_or(false, |v| v != ex.tax_rate_id) {
                            changes.push("IVA");
                        }
                        if item.cost_minor.map_or(false, |v| v != ex.cost) {
                            changes.push("costo");
                        }
                        if item.price_minor.map_or(false, |v| v != ex.price) {
                            changes.push("precio");
                        }
                        if item.currency.as_ref().map_or(false, |v| *v != ex.currency) {
                            changes.push("moneda");
                        }
                        if item.min_stock.map_or(false, |v| v != ex.min_stock) {
                            changes.push("stock mínimo");
                        }
                        if item.track_stock.map_or(false, |v| v != ex.track) {
                            changes.push("controla stock");
                        }
                        if changes.is_empty() {
                            action = "unchanged";
                            notes.push("Sin cambios".into());
                        } else {
                            action = "update";
                            notes.push(format!("Cambia: {}", changes.join(", ")));
                        }
                        if item.initial_stock.unwrap_or(0) > 0 {
                            notes.push("stock inicial ignorado (el producto ya existe; usa un ajuste de inventario)".into());
                        }
                        let _ = ex.id;
                    }
                }
            }
        }

        let message = if action == "error" { errs.join("; ") } else { notes.join(" · ") };
        out.push(Planned { line_no, action, sku, message, item });
    }
    Ok(out)
}

// ---------- Lotes: lectura ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRow {
    id: i64,
    filename: String,
    mode: String,
    status: String,
    total_rows: i64,
    new_rows: i64,
    update_rows: i64,
    unchanged_rows: i64,
    skipped_rows: i64,
    error_rows: i64,
    applied_rows: i64,
    created_by_name: Option<String>,
    created_at: String,
    applied_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRowOut {
    line_no: i64,
    action: String,
    sku: String,
    message: String,
    name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchDetail {
    batch: BatchRow,
    rows: Vec<ImportRowOut>,
    ignored_columns: Vec<String>,
}

const BATCH_SELECT: &str = "
  SELECT b.id, b.filename, b.mode, b.status, b.total_rows, b.new_rows, b.update_rows,
         b.unchanged_rows, b.skipped_rows, b.error_rows, b.applied_rows,
         u.full_name, b.created_at, b.applied_at
  FROM import_batches b LEFT JOIN users u ON u.id = b.created_by";

fn map_batch(r: &rusqlite::Row) -> rusqlite::Result<BatchRow> {
    Ok(BatchRow {
        id: r.get(0)?,
        filename: r.get(1)?,
        mode: r.get(2)?,
        status: r.get(3)?,
        total_rows: r.get(4)?,
        new_rows: r.get(5)?,
        update_rows: r.get(6)?,
        unchanged_rows: r.get(7)?,
        skipped_rows: r.get(8)?,
        error_rows: r.get(9)?,
        applied_rows: r.get(10)?,
        created_by_name: r.get(11)?,
        created_at: r.get(12)?,
        applied_at: r.get(13)?,
    })
}

fn fetch_batch(conn: &Connection, id: i64, ignored: Vec<String>) -> Result<BatchDetail, AppError> {
    let sql = format!("{BATCH_SELECT} WHERE b.id = ?1");
    let batch = conn
        .query_row(&sql, [id], map_batch)
        .optional()?
        .ok_or_else(|| AppError::Validation("El lote no existe".into()))?;
    let rows = conn
        .prepare(
            "SELECT line_no, action, sku, message, data_json FROM import_rows
             WHERE batch_id = ?1 ORDER BY line_no",
        )?
        .query_map([id], |r| {
            let json: String = r.get(4)?;
            let name = serde_json::from_str::<Item>(&json).ok().and_then(|i| i.name);
            Ok(ImportRowOut {
                line_no: r.get(0)?,
                action: r.get(1)?,
                sku: r.get(2)?,
                message: r.get(3)?,
                name,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(BatchDetail { batch, rows, ignored_columns: ignored })
}

#[tauri::command]
pub async fn import_list_batches(state: State<'_, AppState>) -> Result<Vec<BatchRow>, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let db = state.conn()?;
    let sql = format!("{BATCH_SELECT} ORDER BY b.id DESC LIMIT 50");
    let rows = db
        .prepare(&sql)?
        .query_map([], map_batch)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub async fn import_get_batch(state: State<'_, AppState>, id: i64) -> Result<BatchDetail, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let db = state.conn()?;
    fetch_batch(&db, id, Vec::new())
}

// ---------- Vista previa ----------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    filename: String,
    content: String,
    mode: String,
    warehouse_id: Option<i64>,
}

#[tauri::command]
pub async fn import_products_preview(
    state: State<'_, AppState>,
    input: ImportRequest,
) -> Result<BatchDetail, AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    if !["both", "create", "update"].contains(&input.mode.as_str()) {
        return Err(AppError::Validation("Modo de importación inválido".into()));
    }
    if input.content.len() > MAX_BYTES {
        return Err(AppError::Validation("El archivo es demasiado grande (máx. 5 MB)".into()));
    }
    let text = input.content.trim_start_matches('\u{feff}');
    let table = parse_csv(text, detect_delimiter(text));
    let mut it = table.into_iter();
    let header = it
        .next()
        .ok_or_else(|| AppError::Validation("El archivo está vacío".into()))?;
    let data: Vec<Vec<String>> = it.filter(|r| r.iter().any(|c| !c.trim().is_empty())).collect();
    if data.is_empty() {
        return Err(AppError::Validation("El archivo no tiene filas de datos".into()));
    }
    if data.len() > MAX_ROWS {
        return Err(AppError::Validation(format!(
            "El archivo tiene {} filas; el máximo por importación es {MAX_ROWS}",
            data.len()
        )));
    }

    let mut cols: HashMap<&'static str, usize> = HashMap::new();
    let mut ignored: Vec<String> = Vec::new();
    for (i, h) in header.iter().enumerate() {
        if h.trim().is_empty() {
            continue;
        }
        match field_of(h) {
            Some("ignore") => {}
            Some(f) => {
                cols.entry(f).or_insert(i);
            }
            None => ignored.push(h.trim().to_string()),
        }
    }
    if !cols.contains_key("sku") {
        return Err(AppError::Validation(
            "No encuentro la columna SKU. Descarga la plantilla para ver el formato".into(),
        ));
    }
    if input.mode != "update" && (!cols.contains_key("name") || !cols.contains_key("price")) {
        return Err(AppError::Validation(
            "Para crear productos el archivo necesita las columnas «nombre» y «precio»".into(),
        ));
    }

    let mut db = state.conn()?;
    let tx = db.transaction()?;
    let wh = match input.warehouse_id {
        Some(w) => {
            let ok: i64 = tx.query_row(
                "SELECT COUNT(*) FROM warehouses WHERE id = ?1 AND active = 1",
                [w],
                |r| r.get(0),
            )?;
            if ok == 0 {
                return Err(AppError::Validation("El almacén no existe o está inactivo".into()));
            }
            w
        }
        None => crate::commands::warehouses::sales_warehouse_id(&tx)?,
    };

    let plan = plan_products(&tx, &cols, &data, &input.mode)?;
    let count = |a: &str| plan.iter().filter(|p| p.action == a).count() as i64;
    let filename: String = input.filename.chars().take(120).collect();
    tx.execute(
        "INSERT INTO import_batches (filename, mode, warehouse_id, total_rows, new_rows, update_rows,
                                     unchanged_rows, skipped_rows, error_rows, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            filename, input.mode, wh, plan.len() as i64, count("new"), count("update"),
            count("unchanged"), count("skipped"), count("error"), me.id
        ],
    )?;
    let batch_id = tx.last_insert_rowid();
    {
        let mut ins = tx.prepare(
            "INSERT INTO import_rows (batch_id, line_no, action, sku, message, data_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for p in &plan {
            let json = serde_json::to_string(&p.item).map_err(|e| AppError::Internal(e.to_string()))?;
            ins.execute(params![batch_id, p.line_no, p.action, p.sku, p.message, json])?;
        }
    }
    tx.commit()?;
    fetch_batch(&db, batch_id, ignored)
}

#[tauri::command]
pub async fn import_cancel(state: State<'_, AppState>, id: i64) -> Result<(), AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let db = state.conn()?;
    db.execute(
        "UPDATE import_batches SET status = 'cancelled' WHERE id = ?1 AND status = 'preview'",
        [id],
    )?;
    Ok(())
}

// ---------- Etapa 4: aplicar ----------
#[tauri::command]
pub async fn import_apply(
    state: State<'_, AppState>,
    id: i64,
    skip_errors: bool,
) -> Result<BatchDetail, AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    let mut db = state.conn()?;

    let (status, errors, warehouse_id): (String, i64, Option<i64>) = db
        .query_row(
            "SELECT status, error_rows, warehouse_id FROM import_batches WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("El lote no existe".into()))?;
    if status != "preview" {
        return Err(AppError::Validation("Este lote ya fue procesado o cancelado".into()));
    }
    if errors > 0 && !skip_errors {
        return Err(AppError::Validation(
            "Hay filas con errores. Corrige el archivo o elige importar solo las filas válidas".into(),
        ));
    }
    let wh = warehouse_id.ok_or_else(|| AppError::Validation("El lote no tiene almacén".into()))?;

    let tx = db.transaction()?;
    let todo: Vec<(i64, String, String, String)> = tx
        .prepare(
            "SELECT line_no, action, sku, data_json FROM import_rows
             WHERE batch_id = ?1 AND action IN ('new','update') ORDER BY line_no",
        )?
        .query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut categories: HashMap<String, i64> = HashMap::new();
    let mut applied = 0i64;
    for (line, action, sku, json) in todo {
        let item: Item = serde_json::from_str(&json).map_err(|e| AppError::Internal(e.to_string()))?;
        let stale = || {
            AppError::Validation(format!(
                "Línea {line}: el catálogo cambió desde la vista previa. Valida el archivo otra vez"
            ))
        };
        let exists: Option<i64> = tx
            .query_row("SELECT id FROM products WHERE sku = ?1", [&sku], |r| r.get(0))
            .optional()?;

        // categoría: se busca (sin distinguir mayúsculas) y se crea si falta
        let category_id: Option<i64> = match &item.category {
            None => None,
            Some(name) => {
                let key = name.to_lowercase();
                if let Some(cid) = categories.get(&key) {
                    Some(*cid)
                } else {
                    let found: Option<i64> = tx
                        .query_row(
                            "SELECT id FROM categories WHERE lower(name) = lower(?1)",
                            [name],
                            |r| r.get(0),
                        )
                        .optional()?;
                    let cid = match found {
                        Some(c) => c,
                        None => {
                            tx.execute("INSERT INTO categories (name) VALUES (?1)", [name])?;
                            tx.last_insert_rowid()
                        }
                    };
                    categories.insert(key, cid);
                    Some(cid)
                }
            }
        };
        let line_err = |e: rusqlite::Error| match &e {
            rusqlite::Error::SqliteFailure(f, _)
                if f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
            {
                AppError::Validation(format!("Línea {line}: SKU o código de barras ya existe"))
            }
            _ => AppError::Db(e),
        };

        if action == "new" {
            if exists.is_some() {
                return Err(stale());
            }
            let track = item.track_stock.unwrap_or(true);
            tx.execute(
                "INSERT INTO products (sku, barcode, name, category_id, tax_rate_id, cost_minor,
                                       price_minor, price_currency, track_stock, min_stock)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    sku,
                    item.barcode,
                    item.name,
                    category_id,
                    item.tax_rate_id,
                    item.cost_minor.unwrap_or(0),
                    item.price_minor,
                    item.currency.clone().unwrap_or_else(|| "USD".into()),
                    track as i64,
                    item.min_stock.unwrap_or(0)
                ],
            )
            .map_err(line_err)?;
            let pid = tx.last_insert_rowid();
            let qty = item.initial_stock.unwrap_or(0);
            if track && qty > 0 {
                let note = format!("Importación #{id}");
                tx.execute(
                    "INSERT INTO stock_movements (product_id, quantity, reason, note, user_id, warehouse_id)
                     VALUES (?1, ?2, 'stock_inicial', ?3, ?4, ?5)",
                    params![pid, qty, note, me.id, wh],
                )?;
            }
        } else {
            let pid = exists.ok_or_else(stale)?;
            tx.execute(
                "UPDATE products SET
                   name = COALESCE(?1, name),
                   barcode = COALESCE(?2, barcode),
                   category_id = COALESCE(?3, category_id),
                   tax_rate_id = COALESCE(?4, tax_rate_id),
                   cost_minor = COALESCE(?5, cost_minor),
                   price_minor = COALESCE(?6, price_minor),
                   price_currency = COALESCE(?7, price_currency),
                   min_stock = COALESCE(?8, min_stock),
                   track_stock = COALESCE(?9, track_stock)
                 WHERE id = ?10",
                params![
                    item.name,
                    item.barcode,
                    category_id,
                    item.tax_rate_id,
                    item.cost_minor,
                    item.price_minor,
                    item.currency,
                    item.min_stock,
                    item.track_stock.map(|b| b as i64),
                    pid
                ],
            )
            .map_err(line_err)?;
        }
        applied += 1;
    }

    tx.execute(
        "UPDATE import_batches SET status = 'applied', applied_rows = ?1,
                applied_by = ?2, applied_at = datetime('now') WHERE id = ?3",
        params![applied, me.id, id],
    )?;
    let detail = format!("lote #{id}: {applied} filas aplicadas");
    audit::log(&tx, Some(me.id), "products_imported", Some("import_batch"), Some(id), Some(&detail))?;
    tx.commit()?;
    fetch_batch(&db, id, Vec::new())
}

// ---------- Exportación y plantilla ----------
/// Evita que Excel ejecute como fórmula una celda de texto que empieza por = + - @ (los números no se tocan).
pub(crate) fn neutralize(v: &str) -> String {
    let first = v.chars().next();
    let numeric = v.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | '-' | '+')) && v.chars().any(|c| c.is_ascii_digit());
    match first {
        Some('=') | Some('@') | Some('\t') | Some('\r') => format!("'{v}"),
        Some('+') | Some('-') if !numeric => format!("'{v}"),
        _ => v.to_string(),
    }
}

fn esc(v: &str) -> String {
    let neutral = neutralize(v);
    let v = neutral.as_str();
    if v.contains(|c: char| matches!(c, ';' | '"' | '\r' | '\n')) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

pub(crate) fn csv_line(cells: &[String]) -> String {
    cells.iter().map(|c| esc(c)).collect::<Vec<_>>().join(";")
}

fn money(m: i64) -> String {
    format!("{},{:02}", m / 100, m % 100)
}

pub(crate) fn write_download(app: &AppHandle, filename: &str, lines: Vec<String>) -> Result<String, AppError> {
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let path = dir.join(filename);
    let content = format!("\u{feff}{}", lines.join("\r\n"));
    std::fs::write(&path, content).map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(path.display().to_string())
}

fn stamp() -> String {
    chrono::Local::now().format("%Y%m%d_%H%M").to_string()
}

#[tauri::command]
pub async fn import_template(app: AppHandle, state: State<'_, AppState>) -> Result<String, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let head: Vec<String> = HEADER.iter().map(|s| s.to_string()).collect();
    let ej = |v: [&str; 11]| csv_line(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    let lines = vec![
        csv_line(&head),
        ej(["CAM-001", "7591234567890", "Camisa manga larga", "Ropa", "GENERAL", "8,50", "15,00", "USD", "5", "20", "SI"]),
        ej(["ARR-5KG", "", "Arroz 1 kg", "Alimentos", "EXENTO", "1,10", "1,60", "USD", "10", "50", "SI"]),
    ];
    write_download(&app, "plantilla_productos.csv", lines)
}

#[tauri::command]
pub async fn export_products(
    app: AppHandle,
    state: State<'_, AppState>,
    include_inactive: bool,
) -> Result<String, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let db = state.conn()?;
    let mut lines: Vec<String> = Vec::new();
    let mut head: Vec<String> = HEADER[..9].iter().map(|s| s.to_string()).collect();
    head.push("controla_stock".into());
    head.push("stock_actual".into());
    head.push("activo".into());
    lines.push(csv_line(&head));
    let mut stmt = db.prepare(
        "SELECT p.sku, p.barcode, p.name, c.name, t.code, p.cost_minor, p.price_minor,
                p.price_currency, p.min_stock, p.track_stock, p.active,
                COALESCE((SELECT SUM(m.quantity) FROM stock_movements m WHERE m.product_id = p.id), 0)
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         JOIN tax_rates t ON t.id = p.tax_rate_id
         WHERE (?1 = 1 OR p.active = 1)
         ORDER BY p.name",
    )?;
    let rows = stmt.query_map([include_inactive as i64], |r| {
        let sku: String = r.get(0)?;
        let barcode: Option<String> = r.get(1)?;
        let name: String = r.get(2)?;
        let cat: Option<String> = r.get(3)?;
        let tax: String = r.get(4)?;
        let cost: i64 = r.get(5)?;
        let price: i64 = r.get(6)?;
        let cur: String = r.get(7)?;
        let min: i64 = r.get(8)?;
        let track: i64 = r.get(9)?;
        let active: i64 = r.get(10)?;
        let stock: i64 = r.get(11)?;
        Ok(vec![
            sku,
            barcode.unwrap_or_default(),
            name,
            cat.unwrap_or_default(),
            tax,
            money(cost),
            money(price),
            cur,
            min.to_string(),
            if track != 0 { "SI".into() } else { "NO".into() },
            stock.to_string(),
            if active != 0 { "SI".into() } else { "NO".into() },
        ])
    })?;
    for r in rows {
        lines.push(csv_line(&r?));
    }
    write_download(&app, &format!("productos_{}.csv", stamp()), lines)
}

#[tauri::command]
pub async fn import_error_report(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<String, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let db = state.conn()?;
    let mut lines = vec![csv_line(&["linea".into(), "sku".into(), "problema".into()])];
    let mut stmt = db.prepare(
        "SELECT line_no, sku, message FROM import_rows
         WHERE batch_id = ?1 AND action = 'error' ORDER BY line_no",
    )?;
    let rows = stmt.query_map([id], |r| {
        Ok(vec![r.get::<_, i64>(0)?.to_string(), r.get::<_, String>(1)?, r.get::<_, String>(2)?])
    })?;
    for r in rows {
        lines.push(csv_line(&r?));
    }
    if lines.len() == 1 {
        return Err(AppError::Validation("Este lote no tiene errores".into()));
    }
    write_download(&app, &format!("errores_importacion_{id}.csv"), lines)
}
