use crate::{audit, error::AppError, security, state::AppState};
use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Customer {
    id: i64,
    id_type: String,
    id_number: String,
    name: String,
    fiscal_address: Option<String>,
    phone: Option<String>,
    email: Option<String>,
    active: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerInput {
    id_type: String,
    id_number: String,
    name: String,
    fiscal_address: Option<String>,
    phone: Option<String>,
    email: Option<String>,
}

const SELECT: &str =
    "SELECT id, id_type, id_number, name, fiscal_address, phone, email, active FROM customers";

fn map_customer(r: &Row) -> rusqlite::Result<Customer> {
    Ok(Customer {
        id: r.get(0)?,
        id_type: r.get(1)?,
        id_number: r.get(2)?,
        name: r.get(3)?,
        fiscal_address: r.get(4)?,
        phone: r.get(5)?,
        email: r.get(6)?,
        active: r.get::<_, i64>(7)? != 0,
    })
}

fn opt(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn clean(input: &mut CustomerInput) -> Result<(), AppError> {
    input.id_type = input.id_type.trim().to_uppercase();
    input.name = input.name.trim().to_string();
    input.fiscal_address = opt(input.fiscal_address.take());
    input.phone = opt(input.phone.take());
    input.email = opt(input.email.take());

    if input.name.len() < 2 {
        return Err(AppError::Validation("El nombre o razón social es obligatorio".into()));
    }
    if let Some(e) = &input.email {
        if !e.contains('@') || e.contains(' ') {
            return Err(AppError::Validation("Correo electrónico inválido".into()));
        }
    }

    // Se guarda solo letras y números, sin guiones ni espacios.
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
            AppError::Validation("Ya existe un cliente con ese documento".into())
        }
        _ => AppError::Db(e),
    }
}

#[tauri::command]
pub async fn list_customers(
    state: State<'_, AppState>,
    search: Option<String>,
    include_inactive: bool,
) -> Result<Vec<Customer>, AppError> {
    security::require_role(&state, security::SALES_ROLES)?;
    let search = search.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let db = state.conn()?;
    let sql = format!(
        "{SELECT}
         WHERE (?1 IS NULL OR name LIKE '%' || ?1 || '%' OR id_number LIKE '%' || ?1 || '%')
           AND (?2 = 1 OR active = 1)
         ORDER BY name LIMIT 200"
    );
    let rows = db
        .prepare(&sql)?
        .query_map(params![search, include_inactive as i64], map_customer)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub async fn create_customer(
    state: State<'_, AppState>,
    mut input: CustomerInput,
) -> Result<Customer, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    clean(&mut input)?;
    let db = state.conn()?;
    db.execute(
        "INSERT INTO customers (id_type, id_number, name, fiscal_address, phone, email)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![input.id_type, input.id_number, input.name, input.fiscal_address, input.phone, input.email],
    )
    .map_err(map_unique)?;
    let id = db.last_insert_rowid();
    let detail = format!("{}-{}", input.id_type, input.id_number);
    audit::log(&db, Some(me.id), "customer_created", Some("customer"), Some(id), Some(&detail))?;
    Ok(db.query_row(&format!("{SELECT} WHERE id = ?1"), [id], map_customer)?)
}

#[tauri::command]
pub async fn update_customer(
    state: State<'_, AppState>,
    id: i64,
    mut input: CustomerInput,
) -> Result<Customer, AppError> {
    let me = security::require_role(&state, security::SALES_ROLES)?;
    clean(&mut input)?;
    let db = state.conn()?;
    let n = db
        .execute(
            "UPDATE customers SET id_type=?1, id_number=?2, name=?3, fiscal_address=?4,
                    phone=?5, email=?6 WHERE id=?7",
            params![input.id_type, input.id_number, input.name, input.fiscal_address,
                    input.phone, input.email, id],
        )
        .map_err(map_unique)?;
    if n == 0 {
        return Err(AppError::Validation("El cliente no existe".into()));
    }
    audit::log(&db, Some(me.id), "customer_updated", Some("customer"), Some(id), None)?;
    Ok(db.query_row(&format!("{SELECT} WHERE id = ?1"), [id], map_customer)?)
}

#[tauri::command]
pub async fn set_customer_active(
    state: State<'_, AppState>,
    id: i64,
    active: bool,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    let n = db.execute("UPDATE customers SET active = ?1 WHERE id = ?2", params![active as i64, id])?;
    if n == 0 {
        return Err(AppError::Validation("El cliente no existe".into()));
    }
    let action = if active { "customer_activated" } else { "customer_deactivated" };
    audit::log(&db, Some(me.id), action, Some("customer"), Some(id), None)?;
    Ok(())
}