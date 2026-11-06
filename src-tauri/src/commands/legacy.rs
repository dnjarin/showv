//! Migración desde el sistema anterior (QSL Sistemas).
//!
//! Se trae lo imprescindible para empezar a operar con Tekkadon:
//!   1. Clientes            (con su límite y días de crédito)
//!   2. Proveedores
//!   3. Saldos por cobrar   (lo que los clientes deben al momento de migrar)
//!   4. Saldos por pagar    (lo que la empresa debe a sus proveedores)
//! Los productos y su existencia se cargan con «Importar / exportar productos».
//!
//! Cada paso funciona igual: se lee un CSV, se arma un plan fila por fila (nuevo / actualiza /
//! sin cambios / omitido / error) y NO se escribe nada hasta que el administrador lo aplica.
//! Al aplicar, el plan se recalcula dentro de una sola transacción: o entra todo o no entra nada.
//!
//! Los saldos iniciales no son ventas ni compras reales:
//!   - por cobrar: documento `SALDO_INICIAL` (a crédito, sin líneas, sin impuestos);
//!   - por pagar: compra con `opening = 1` (sin líneas; no mueve inventario ni entra al libro de compras).
//! Ambos se cobran y se pagan con los mismos abonos y pagos de siempre.

use crate::commands::imports::{detect_delimiter, norm, parse_csv, parse_money};
use crate::{audit, error::AppError, security, state::AppState};
use chrono::{Duration, Local, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::State;

const MAX_ROWS: usize = 5000;
const MAX_BYTES: usize = 5_000_000;
const ADMIN: &[&str] = &["admin"];
const DEFAULT_TERM_DAYS: i64 = 15;

// ---------- Tipos de migración ----------
#[derive(Clone, Copy, PartialEq)]
enum Entity {
    Customers,
    Suppliers,
    ArBalances,
    ApBalances,
}

impl Entity {
    fn parse(s: &str) -> Result<Entity, AppError> {
        match s {
            "customers" => Ok(Entity::Customers),
            "suppliers" => Ok(Entity::Suppliers),
            "ar_balances" => Ok(Entity::ArBalances),
            "ap_balances" => Ok(Entity::ApBalances),
            _ => Err(AppError::Validation("Tipo de migración inválido".into())),
        }
    }
    fn key(self) -> &'static str {
        match self {
            Entity::Customers => "customers",
            Entity::Suppliers => "suppliers",
            Entity::ArBalances => "ar_balances",
            Entity::ApBalances => "ap_balances",
        }
    }
    fn is_balance(self) -> bool {
        matches!(self, Entity::ArBalances | Entity::ApBalances)
    }
}

// ---------- Etapa 1: texto -> tabla ----------
/// Alias de encabezados -> campo interno. Para aceptar otro nombre de columna, se agrega aquí.
fn field_of(header: &str) -> Option<&'static str> {
    Some(match norm(header).as_str() {
        "tipo" | "tipodocumento" | "tipoid" | "tipodoc" | "tipodeid" => "id_type",
        "rif" | "cedula" | "rifcedula" | "cedularif" | "ci" | "identificacion" | "documento" | "rifci"
        | "nrodocumento" | "cedulaorif" => "doc",
        "nombre" | "razonsocial" | "cliente" | "proveedor" | "nombrecliente" | "nombreproveedor"
        | "nombreorazonsocial" => "name",
        "direccion" | "domicilio" | "direccionfiscal" => "address",
        "telefono" | "tlf" | "celular" | "movil" | "telefonos" => "phone",
        "correo" | "email" | "correoelectronico" | "mail" => "email",
        "limitecredito" | "limitecreditousd" | "limite" | "credito" => "credit_limit",
        "diascredito" | "diasdecredito" | "plazo" | "dias" => "credit_days",
        "factura" | "nrofactura" | "numerofactura" | "numero" | "referencia" | "nrodoc" | "documentoorigen" => {
            "reference"
        }
        "fecha" | "fechaemision" | "emision" | "fechafactura" => "date",
        "vencimiento" | "fechavencimiento" | "vence" | "fechadevencimiento" => "due",
        "moneda" | "divisa" => "currency",
        "saldo" | "monto" | "importe" | "saldopendiente" | "deuda" | "total" => "amount",
        _ => return None,
    })
}

struct Table {
    cols: HashMap<&'static str, usize>,
    /// (número de línea en el archivo, celdas)
    data: Vec<(i64, Vec<String>)>,
    ignored: Vec<String>,
}

fn read_table(content: &str) -> Result<Table, AppError> {
    if content.len() > MAX_BYTES {
        return Err(AppError::Validation("El archivo es demasiado grande (máx. 5 MB)".into()));
    }
    let text = content.trim_start_matches('\u{feff}');
    let table = parse_csv(text, detect_delimiter(text));
    let mut it = table.into_iter().enumerate();
    let (_, header) = it
        .next()
        .ok_or_else(|| AppError::Validation("El archivo está vacío".into()))?;
    let data: Vec<(i64, Vec<String>)> = it
        .filter(|(_, r)| r.iter().any(|c| !c.trim().is_empty()))
        .map(|(i, r)| ((i + 1) as i64, r))
        .collect();
    if data.is_empty() {
        return Err(AppError::Validation("El archivo no tiene filas de datos".into()));
    }
    if data.len() > MAX_ROWS {
        return Err(AppError::Validation(format!(
            "El archivo tiene {} filas; el máximo por migración es {MAX_ROWS}",
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
            Some(f) => {
                cols.entry(f).or_insert(i);
            }
            None => ignored.push(h.trim().to_string()),
        }
    }
    Ok(Table { cols, data, ignored })
}

/// Celda recortada; `None` si la columna no existe o la celda está vacía.
fn cell<'a>(cols: &HashMap<&'static str, usize>, row: &'a [String], f: &str) -> Option<&'a str> {
    cols.get(f)
        .and_then(|&i| row.get(i))
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
}

// ---------- Etapa 2: validaciones de celdas ----------
/// Devuelve (tipo, número) ya normalizados. Acepta «J-30123456-7», «V12.345.678», o el tipo en otra columna.
fn parse_doc(raw: &str, type_col: Option<&str>) -> Result<(String, String), String> {
    let t: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_uppercase();
    if t.is_empty() {
        return Err("falta el RIF o la cédula".into());
    }
    let from_col = type_col.map(|s| s.trim().to_uppercase()).filter(|s| !s.is_empty());
    let (ty, num) = match from_col {
        Some(ty) => {
            let rest = t.strip_prefix(ty.as_str()).filter(|r| !r.is_empty() && ty != "P");
            let num = rest.map(|r| r.to_string()).unwrap_or_else(|| t.clone());
            (ty, num)
        }
        None => {
            let first = t.chars().next().unwrap_or(' ');
            if "VEJGPC".contains(first) && t.len() > 1 {
                (first.to_string(), t[1..].to_string())
            } else {
                return Err(format!("«{raw}» no indica el tipo (V, E, J, G, P o C)"));
            }
        }
    };
    let all_digits = num.chars().all(|c| c.is_ascii_digit());
    match ty.as_str() {
        "V" | "E" => {
            if !(all_digits && (5..=9).contains(&num.len())) {
                return Err(format!("cédula inválida «{raw}» (5 a 9 dígitos)"));
            }
        }
        "J" | "G" | "C" => {
            if !(all_digits && num.len() == 9) {
                return Err(format!("RIF inválido «{raw}» (9 dígitos: 8 + verificador)"));
            }
        }
        "P" => {
            if !(5..=15).contains(&num.len()) {
                return Err(format!("pasaporte inválido «{raw}» (5 a 15 caracteres)"));
            }
        }
        _ => return Err(format!("tipo de documento inválido «{ty}»")),
    }
    Ok((ty, num))
}

/// «2026-03-15» · «15/03/2026» · «15-03-2026» -> «2026-03-15».
fn parse_date(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    let parts: Vec<&str> = t.split(|c| c == '-' || c == '/' || c == '.').collect();
    let bad = || format!("fecha inválida «{raw}» (usa AAAA-MM-DD o DD/MM/AAAA)");
    if parts.len() != 3 {
        return Err(bad());
    }
    let mut n = [0i64; 3];
    for (i, p) in parts.iter().enumerate() {
        n[i] = p.trim().parse::<i64>().map_err(|_| bad())?;
    }
    let (y, m, d) = if parts[0].trim().len() == 4 {
        (n[0], n[1], n[2])
    } else if parts[2].trim().len() == 4 {
        (n[2], n[1], n[0])
    } else {
        return Err(bad());
    };
    if !(1990..=2100).contains(&y) || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return Err(bad());
    }
    NaiveDate::from_ymd_opt(y as i32, m as u32, d as u32)
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .ok_or_else(bad)
}

fn parse_currency(raw: Option<&str>) -> Result<&'static str, String> {
    let Some(r) = raw else {
        return Err("falta la moneda (USD o VES)".into());
    };
    if r.trim() == "$" {
        return Ok("USD");
    }
    match norm(r).as_str() {
        "usd" | "us" | "dolar" | "dolares" | "ds" => Ok("USD"),
        "ves" | "bs" | "bsf" | "bss" | "bsd" | "bolivar" | "bolivares" => Ok("VES"),
        _ => Err(format!("moneda desconocida «{r}» (usa USD o VES)")),
    }
}

fn money(m: i64) -> String {
    let whole = m / 100;
    let mut digits = whole.to_string();
    let mut out = String::new();
    while digits.len() > 3 {
        let cut = digits.len() - 3;
        out = format!(".{}{}", &digits[cut..], out);
        digits.truncate(cut);
    }
    format!("{digits}{out},{:02}", m % 100)
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

// ---------- Plan ----------
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LegacyRow {
    line_no: i64,
    action: String,
    key: String,
    name: String,
    detail: String,
    message: String,
}

#[derive(Clone)]
struct Party {
    id_type: String,
    id_number: String,
    name: String,
    address: Option<String>,
    phone: Option<String>,
    email: Option<String>,
    credit_limit_minor: Option<i64>,
    credit_days: Option<i64>,
}

#[derive(Clone)]
struct Bal {
    party_id: i64,
    party_name: String,
    party_type: String,
    party_number: String,
    party_address: Option<String>,
    reference: String,
    date: String,
    due: String,
    currency: &'static str,
    amount_minor: i64,
}

enum Op {
    None,
    NewParty(Party),
    UpdateParty(i64, Party),
    Balance(Bal),
}

struct Planned {
    row: LegacyRow,
    op: Op,
}

impl Planned {
    fn new(line: i64, action: &str, key: &str, name: &str, detail: String, message: String, op: Op) -> Planned {
        Planned {
            row: LegacyRow {
                line_no: line,
                action: action.to_string(),
                key: key.to_string(),
                name: name.to_string(),
                detail,
                message,
            },
            op,
        }
    }
    fn error(line: i64, key: &str, name: &str, message: String) -> Planned {
        Planned::new(line, "error", key, name, String::new(), message, Op::None)
    }
}

fn short(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

type PartyRow = (i64, String, Option<String>, Option<String>, Option<String>, i64, i64);

fn plan_parties(conn: &Connection, ent: Entity, t: &Table) -> Result<Vec<Planned>, AppError> {
    let customers = ent == Entity::Customers;
    let mut seen: HashMap<String, i64> = HashMap::new();
    let mut out: Vec<Planned> = Vec::new();

    for (line, row) in &t.data {
        let line = *line;
        let name_raw = cell(&t.cols, row, "name");
        let doc_raw = cell(&t.cols, row, "doc");
        let key_hint = doc_raw.unwrap_or("").to_string();
        let name_hint = name_raw.unwrap_or("").to_string();
        let fail = |msg: String| Planned::error(line, &key_hint, &name_hint, msg);

        let Some(name_raw) = name_raw else {
            out.push(fail("falta el nombre".into()));
            continue;
        };
        let Some(doc_raw) = doc_raw else {
            out.push(fail("falta el RIF o la cédula".into()));
            continue;
        };
        let (ty, num) = match parse_doc(doc_raw, cell(&t.cols, row, "id_type")) {
            Ok(v) => v,
            Err(m) => {
                out.push(fail(m));
                continue;
            }
        };
        let key = format!("{ty}-{num}");
        let name = short(name_raw, 150);
        if name.chars().count() < 2 {
            out.push(fail("el nombre es muy corto".into()));
            continue;
        }
        if let Some(first) = seen.get(&key) {
            out.push(Planned::new(
                line, "skipped", &key, &name, String::new(),
                format!("Repetido: ya aparece en la línea {first}"), Op::None,
            ));
            continue;
        }
        seen.insert(key.clone(), line);

        let mut warn: Vec<String> = Vec::new();
        let address = cell(&t.cols, row, "address").map(|s| short(s, 200));
        let phone = cell(&t.cols, row, "phone").map(|s| short(s, 40));
        let mut email = if customers { cell(&t.cols, row, "email").map(|s| short(s, 120)) } else { None };
        let bad_email = email.as_ref().filter(|e| !e.contains('@') || e.contains(' ')).cloned();
        if let Some(e) = bad_email {
            warn.push(format!("correo inválido «{e}» (se omitió)"));
            email = None;
        }
        let mut credit_limit_minor = None;
        let mut credit_days = None;
        if customers {
            match cell(&t.cols, row, "credit_limit").map(parse_money).transpose() {
                Ok(v) => credit_limit_minor = v,
                Err(m) => {
                    out.push(fail(format!("límite de crédito: {m}")));
                    continue;
                }
            }
            match cell(&t.cols, row, "credit_days").map(|s| s.parse::<i64>()).transpose() {
                Ok(Some(d)) if (0..=365).contains(&d) => credit_days = Some(d),
                Ok(None) => {}
                _ => {
                    out.push(fail("días de crédito debe ser un entero entre 0 y 365".into()));
                    continue;
                }
            }
        }

        let party = Party {
            id_type: ty.clone(),
            id_number: num.clone(),
            name: name.clone(),
            address,
            phone,
            email,
            credit_limit_minor,
            credit_days,
        };

        let sql = if customers {
            "SELECT id, name, fiscal_address, phone, email, credit_limit_usd_minor, credit_days
             FROM customers WHERE id_type = ?1 AND id_number = ?2"
        } else {
            "SELECT id, name, address, phone, NULL, 0, 0 FROM suppliers WHERE id_type = ?1 AND id_number = ?2"
        };
        let existing: Option<PartyRow> = conn
            .query_row(sql, params![ty, num], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
            })
            .optional()?;

        let msg = warn.join("; ");
        match existing {
            None => out.push(Planned::new(line, "new", &key, &name, String::new(), msg, Op::NewParty(party))),
            Some((id, ename, eaddr, ephone, eemail, elimit, edays)) => {
                let mut changes: Vec<&str> = Vec::new();
                if ename != party.name {
                    changes.push("nombre");
                }
                if party.address.is_some() && party.address != eaddr {
                    changes.push("dirección");
                }
                if party.phone.is_some() && party.phone != ephone {
                    changes.push("teléfono");
                }
                if party.email.is_some() && party.email != eemail {
                    changes.push("correo");
                }
                if party.credit_limit_minor.is_some_and(|l| l != elimit) {
                    changes.push("límite de crédito");
                }
                if party.credit_days.is_some_and(|d| d != edays) {
                    changes.push("días de crédito");
                }
                if changes.is_empty() {
                    out.push(Planned::new(line, "unchanged", &key, &name, String::new(), msg, Op::None));
                } else {
                    out.push(Planned::new(
                        line, "update", &key, &name, format!("cambia: {}", changes.join(", ")), msg,
                        Op::UpdateParty(id, party),
                    ));
                }
            }
        }
    }
    Ok(out)
}

fn plan_balances(
    conn: &Connection,
    ent: Entity,
    t: &Table,
    rate: Option<i64>,
) -> Result<Vec<Planned>, AppError> {
    let ar = ent == Entity::ArBalances;
    let today = Local::now().date_naive().format("%Y-%m-%d").to_string();
    let mut seen: HashSet<(i64, String)> = HashSet::new();
    let mut out: Vec<Planned> = Vec::new();

    for (line, row) in &t.data {
        let line = *line;
        let doc_raw = cell(&t.cols, row, "doc");
        let ref_raw = cell(&t.cols, row, "reference");
        let key_hint = format!("{} · {}", doc_raw.unwrap_or(""), ref_raw.unwrap_or(""));
        let fail = |msg: String| Planned::error(line, &key_hint, "", msg);

        let Some(doc_raw) = doc_raw else {
            out.push(fail("falta el RIF o la cédula".into()));
            continue;
        };
        let (ty, num) = match parse_doc(doc_raw, cell(&t.cols, row, "id_type")) {
            Ok(v) => v,
            Err(m) => {
                out.push(fail(m));
                continue;
            }
        };
        let Some(reference) = ref_raw else {
            out.push(fail("falta el número de factura o documento".into()));
            continue;
        };
        if reference.chars().count() > 40 {
            out.push(fail("el número de factura es demasiado largo (máx. 40)".into()));
            continue;
        }
        let reference = reference.to_string();
        let key = format!("{ty}-{num} · {reference}");

        let date = match cell(&t.cols, row, "date").ok_or_else(|| "falta la fecha".to_string()).and_then(parse_date) {
            Ok(d) => d,
            Err(m) => {
                out.push(Planned::error(line, &key, "", m));
                continue;
            }
        };
        if date > today {
            out.push(Planned::error(line, &key, "", format!("la fecha {date} es futura")));
            continue;
        }
        let currency = match parse_currency(cell(&t.cols, row, "currency")) {
            Ok(c) => c,
            Err(m) => {
                out.push(Planned::error(line, &key, "", m));
                continue;
            }
        };
        let amount_minor = match cell(&t.cols, row, "amount")
            .ok_or_else(|| "falta el saldo".to_string())
            .and_then(parse_money)
        {
            Ok(a) if a > 0 => a,
            Ok(_) => {
                out.push(Planned::error(line, &key, "", "el saldo debe ser mayor que cero".into()));
                continue;
            }
            Err(m) => {
                out.push(Planned::error(line, &key, "", m));
                continue;
            }
        };
        if currency == "USD" && rate.is_none() {
            out.push(Planned::error(
                line, &key, "",
                "no hay tasa USD registrada; regístrala en «Tasas de cambio» antes de migrar saldos en dólares".into(),
            ));
            continue;
        }

        // El cliente o proveedor debe existir (se migra primero).
        let sql = if ar {
            "SELECT id, name, fiscal_address, credit_days, active FROM customers WHERE id_type = ?1 AND id_number = ?2"
        } else {
            "SELECT id, name, address, 15, active FROM suppliers WHERE id_type = ?1 AND id_number = ?2"
        };
        let party: Option<(i64, String, Option<String>, i64, i64)> = conn
            .query_row(sql, params![ty, num], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .optional()?;
        let Some((party_id, party_name, party_address, term_days, active)) = party else {
            let what = if ar { "cliente" } else { "proveedor" };
            let step = if ar { "Clientes" } else { "Proveedores" };
            out.push(Planned::error(
                line, &key, "",
                format!("el {what} {ty}-{num} no existe; migra primero el paso «{step}»"),
            ));
            continue;
        };
        if active == 0 {
            out.push(Planned::error(line, &key, &party_name, "el registro está inactivo; actívalo primero".into()));
            continue;
        }

        let due = match cell(&t.cols, row, "due") {
            Some(raw) => match parse_date(raw) {
                Ok(d) => d,
                Err(m) => {
                    out.push(Planned::error(line, &key, &party_name, m));
                    continue;
                }
            },
            None => {
                let days = if term_days > 0 { term_days } else { DEFAULT_TERM_DAYS };
                let base = NaiveDate::parse_from_str(&date, "%Y-%m-%d")
                    .map_err(|e| AppError::Internal(e.to_string()))?;
                (base + Duration::days(days)).format("%Y-%m-%d").to_string()
            }
        };
        if due < date {
            out.push(Planned::error(line, &key, &party_name, "el vencimiento es anterior a la fecha".into()));
            continue;
        }

        if !seen.insert((party_id, reference.clone())) {
            out.push(Planned::new(
                line, "skipped", &key, &party_name, String::new(),
                "Repetido dentro del archivo".into(), Op::None,
            ));
            continue;
        }
        let already: i64 = if ar {
            conn.query_row(
                "SELECT COUNT(*) FROM documents WHERE doc_type = 'SALDO_INICIAL' AND customer_id = ?1 AND notes = ?2",
                params![party_id, ar_note(&reference)],
                |r| r.get(0),
            )?
        } else {
            conn.query_row(
                "SELECT COUNT(*) FROM purchases WHERE supplier_id = ?1 AND invoice_number = ?2 AND status = 'received'",
                params![party_id, reference],
                |r| r.get(0),
            )?
        };
        if already > 0 {
            out.push(Planned::new(
                line, "skipped", &key, &party_name, String::new(),
                "Ya registrado antes (misma factura para este tercero)".into(), Op::None,
            ));
            continue;
        }

        let detail = format!("{currency} {} · {date} · vence {due}", money(amount_minor));
        out.push(Planned::new(
            line, "new", &key, &party_name, detail, String::new(),
            Op::Balance(Bal {
                party_id,
                party_name: party_name.clone(),
                party_type: ty,
                party_number: num,
                party_address,
                reference,
                date,
                due,
                currency,
                amount_minor,
            }),
        ));
    }
    Ok(out)
}

fn ar_note(reference: &str) -> String {
    format!("Saldo inicial QSL · Ref. {reference}")
}

/// Devuelve (plan, columnas ignoradas, tasa USD usada).
fn plan(conn: &Connection, ent: Entity, content: &str) -> Result<(Vec<Planned>, Vec<String>, Option<i64>), AppError> {
    let t = read_table(content)?;
    if !t.cols.contains_key("doc") {
        return Err(AppError::Validation(
            "No encuentro la columna del RIF o la cédula (rif_cedula). Descarga la plantilla para ver el formato".into(),
        ));
    }
    match ent {
        Entity::Customers | Entity::Suppliers => {
            if !t.cols.contains_key("name") {
                return Err(AppError::Validation("No encuentro la columna «nombre»".into()));
            }
            let rows = plan_parties(conn, ent, &t)?;
            Ok((rows, t.ignored, None))
        }
        Entity::ArBalances | Entity::ApBalances => {
            for (f, label) in [("reference", "factura"), ("date", "fecha"), ("currency", "moneda"), ("amount", "saldo")] {
                if !t.cols.contains_key(f) {
                    return Err(AppError::Validation(format!("No encuentro la columna «{label}»")));
                }
            }
            let rate = usd_rate(conn)?;
            let rows = plan_balances(conn, ent, &t, rate)?;
            Ok((rows, t.ignored, rate))
        }
    }
}

// ---------- Comandos ----------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyRequest {
    entity: String,
    filename: String,
    content: String,
    skip_errors: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPreview {
    entity: String,
    rows: Vec<LegacyRow>,
    new_rows: i64,
    update_rows: i64,
    unchanged_rows: i64,
    skipped_rows: i64,
    error_rows: i64,
    ignored_columns: Vec<String>,
    usd_rate_micro: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyResult {
    created: i64,
    updated: i64,
    skipped: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyHistoryRow {
    id: i64,
    entity: String,
    filename: String,
    created_rows: i64,
    updated_rows: i64,
    skipped_rows: i64,
    user_name: Option<String>,
    created_at: String,
}

#[tauri::command]
pub async fn legacy_preview(state: State<'_, AppState>, input: LegacyRequest) -> Result<LegacyPreview, AppError> {
    security::require_role(&state, ADMIN)?;
    let ent = Entity::parse(&input.entity)?;
    let db = state.conn()?;
    let (planned, ignored, rate) = plan(&db, ent, &input.content)?;
    let count = |a: &str| planned.iter().filter(|p| p.row.action == a).count() as i64;
    let out = LegacyPreview {
        entity: ent.key().to_string(),
        new_rows: count("new"),
        update_rows: count("update"),
        unchanged_rows: count("unchanged"),
        skipped_rows: count("skipped"),
        error_rows: count("error"),
        rows: planned.iter().map(|p| p.row.clone()).collect(),
        ignored_columns: ignored,
        usd_rate_micro: if ent.is_balance() { rate } else { None },
    };
    Ok(out)
}

fn insert_party(conn: &Connection, ent: Entity, x: &Party) -> Result<(), AppError> {
    if ent == Entity::Customers {
        conn.execute(
            "INSERT INTO customers (id_type, id_number, name, fiscal_address, phone, email,
                                    credit_limit_usd_minor, credit_days)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                x.id_type, x.id_number, x.name, x.address, x.phone, x.email,
                x.credit_limit_minor.unwrap_or(0), x.credit_days.unwrap_or(DEFAULT_TERM_DAYS)
            ],
        )?;
    } else {
        conn.execute(
            "INSERT INTO suppliers (id_type, id_number, name, phone, address) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![x.id_type, x.id_number, x.name, x.phone, x.address],
        )?;
    }
    Ok(())
}

fn update_party(conn: &Connection, ent: Entity, id: i64, x: &Party) -> Result<(), AppError> {
    if ent == Entity::Customers {
        conn.execute(
            "UPDATE customers SET name = ?1,
                fiscal_address = COALESCE(?2, fiscal_address), phone = COALESCE(?3, phone),
                email = COALESCE(?4, email),
                credit_limit_usd_minor = COALESCE(?5, credit_limit_usd_minor),
                credit_days = COALESCE(?6, credit_days)
             WHERE id = ?7",
            params![x.name, x.address, x.phone, x.email, x.credit_limit_minor, x.credit_days, id],
        )?;
    } else {
        conn.execute(
            "UPDATE suppliers SET name = ?1, phone = COALESCE(?2, phone), address = COALESCE(?3, address)
             WHERE id = ?4",
            params![x.name, x.phone, x.address, id],
        )?;
    }
    Ok(())
}

fn ves_of(amount_minor: i64, currency: &str, rate: i64) -> i64 {
    if currency == "VES" {
        amount_minor
    } else {
        ((amount_minor as i128 * rate as i128 + 500_000) / 1_000_000) as i64
    }
}

#[tauri::command]
pub async fn legacy_apply(state: State<'_, AppState>, input: LegacyRequest) -> Result<LegacyResult, AppError> {
    let me = security::require_role(&state, ADMIN)?;
    let ent = Entity::parse(&input.entity)?;
    let mut db = state.conn()?;
    let tx = db.transaction()?;

    let (planned, _ignored, rate) = plan(&tx, ent, &input.content)?;
    let errors = planned.iter().filter(|p| p.row.action == "error").count();
    if errors > 0 && !input.skip_errors.unwrap_or(false) {
        return Err(AppError::Validation(format!(
            "Hay {errors} fila(s) con errores. Corrígelas en el archivo o marca «Omitir las filas con error»"
        )));
    }

    let company: Option<(String, String, String)> = if ent == Entity::ArBalances {
        Some(tx.query_row(
            "SELECT rif, legal_name, fiscal_address FROM company WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?)
    } else {
        None
    };
    let warehouse_id = if ent == Entity::ApBalances {
        Some(crate::commands::warehouses::sales_warehouse_id(&tx)?)
    } else {
        None
    };

    let (mut created, mut updated, mut skipped) = (0i64, 0i64, 0i64);
    for p in planned {
        match p.op {
            Op::None => skipped += 1,
            Op::NewParty(x) => {
                insert_party(&tx, ent, &x)?;
                created += 1;
            }
            Op::UpdateParty(id, x) => {
                update_party(&tx, ent, id, &x)?;
                updated += 1;
            }
            Op::Balance(b) => {
                // Como en ventas y compras normales: se guarda la tasa USD vigente (si existe).
                let rate_micro = rate.unwrap_or(1_000_000);
                let total_ves = ves_of(b.amount_minor, b.currency, rate_micro);
                let issued_at = format!("{} 12:00:00", b.date);
                if let Some((rif, iname, iaddr)) = &company {
                    let number: i64 = tx.query_row(
                        "SELECT next_number FROM document_series WHERE doc_type = 'SALDO_INICIAL' AND series = 'S'",
                        [],
                        |r| r.get(0),
                    )?;
                    tx.execute(
                        "UPDATE document_series SET next_number = next_number + 1
                         WHERE doc_type = 'SALDO_INICIAL' AND series = 'S'",
                        [],
                    )?;
                    tx.execute(
                        "INSERT INTO documents (doc_type, series, number, status, fiscal_status,
                            issuer_rif, issuer_name, issuer_address,
                            customer_id, customer_id_type, customer_id_number, customer_name, customer_address,
                            currency_code, exchange_rate_micro, subtotal_minor, exempt_minor, tax_minor,
                            igtf_minor, total_minor, total_ves_minor, cashier_id, notes, issued_at,
                            credit_sale, due_date, paid_initial_minor)
                         VALUES ('SALDO_INICIAL', 'S', ?1, 'issued', 'NONE',
                            ?2, ?3, ?4,
                            ?5, ?6, ?7, ?8, ?9,
                            ?10, ?11, ?12, 0, 0,
                            0, ?12, ?13, ?14, ?15, ?16,
                            1, ?17, 0)",
                        params![
                            number, rif, iname, iaddr,
                            b.party_id, b.party_type, b.party_number, b.party_name, b.party_address,
                            b.currency, rate_micro, b.amount_minor,
                            total_ves, me.id, ar_note(&b.reference), issued_at,
                            b.due
                        ],
                    )?;
                } else {
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
                            invoice_number, invoice_date, currency_code, exchange_rate_micro,
                            total_minor, total_ves_minor, notes, user_id, on_credit, due_date, opening, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5,
                            ?6, ?7, ?8, ?9,
                            ?10, ?11, ?12, ?13, 1, ?14, 1, ?15)",
                        params![
                            number, b.party_id, b.party_name,
                            format!("{}-{}", b.party_type, b.party_number),
                            warehouse_id.unwrap_or(1),
                            b.reference, b.date, b.currency, rate,
                            b.amount_minor, total_ves,
                            format!("Saldo inicial del sistema anterior · Factura {}", b.reference),
                            me.id, b.due, issued_at
                        ],
                    )?;
                }
                created += 1;
            }
        }
    }

    let filename = short(&input.filename, 120);
    tx.execute(
        "INSERT INTO legacy_imports (entity, filename, created_rows, updated_rows, skipped_rows, user_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![ent.key(), filename, created, updated, skipped, me.id],
    )?;
    audit::log(
        &tx,
        Some(me.id),
        "migracion_qsl",
        Some(ent.key()),
        None,
        Some(&format!("{filename}: {created} nuevos, {updated} actualizados, {skipped} sin aplicar")),
    )?;
    tx.commit()?;
    Ok(LegacyResult { created, updated, skipped })
}

#[tauri::command]
pub async fn legacy_history(state: State<'_, AppState>) -> Result<Vec<LegacyHistoryRow>, AppError> {
    security::require_role(&state, ADMIN)?;
    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT l.id, l.entity, l.filename, l.created_rows, l.updated_rows, l.skipped_rows,
                    u.full_name, l.created_at
             FROM legacy_imports l LEFT JOIN users u ON u.id = l.user_id
             ORDER BY l.id DESC LIMIT 30",
        )?
        .query_map([], |r| {
            Ok(LegacyHistoryRow {
                id: r.get(0)?,
                entity: r.get(1)?,
                filename: r.get(2)?,
                created_rows: r.get(3)?,
                updated_rows: r.get(4)?,
                skipped_rows: r.get(5)?,
                user_name: r.get(6)?,
                created_at: r.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
