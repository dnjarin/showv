use crate::{audit, crypto, error::AppError, security, state::AppState};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use tauri::State;

const CONFIRMED: &str = "key_recovery_confirmed";

/// Comprueba la contraseña del administrador que tiene la sesión (antes de mostrar o tocar la llave).
fn reauth(state: &AppState, user_id: i64, password: &str) -> Result<(), AppError> {
    let hash: String = {
        let db = state.conn()?;
        db.query_row("SELECT password_hash FROM users WHERE id = ?1", [user_id], |r| r.get(0))?
    };
    if security::verify_password(password, &hash) {
        Ok(())
    } else {
        std::thread::sleep(std::time::Duration::from_millis(800));
        let db = state.conn()?;
        audit::log(&db, Some(user_id), "key_reauth_failed", Some("settings"), None, None)?;
        Err(AppError::InvalidCredentials)
    }
}

/// Estado de la protección de la llave de cifrado.
#[tauri::command]
pub async fn key_status(state: State<'_, AppState>) -> Result<Value, AppError> {
    security::require_role(&state, &["admin"])?;
    let confirmed: Option<String> = {
        let db = state.conn()?;
        db.query_row("SELECT value FROM settings WHERE key = ?1", [CONFIRMED], |r| r.get(0)).optional()?
    };
    let mut v = crypto::status();
    v["recoveryConfirmed"] = json!(confirmed.is_some());
    Ok(v)
}

/// Muestra la llave de recuperación (solo en el equipo principal y con la contraseña del administrador).
#[tauri::command]
pub async fn key_recovery_show(state: State<'_, AppState>, password: String) -> Result<String, AppError> {
    let me = security::require_role(&state, &["admin"])?;
    reauth(&state, me.id, &password)?;
    let code = crypto::recovery_code()?;
    let db = state.conn()?;
    audit::log(&db, Some(me.id), "key_recovery_shown", Some("settings"), None, None)?;
    Ok(code)
}

/// El administrador confirma que guardó la llave de recuperación: se anota y se elimina la copia en texto plano.
#[tauri::command]
pub async fn key_confirm_saved(state: State<'_, AppState>, password: String) -> Result<bool, AppError> {
    let me = security::require_role(&state, &["admin"])?;
    reauth(&state, me.id, &password)?;
    let removed = crypto::remove_plain_copy()?;
    let db = state.conn()?;
    db.execute(
        "INSERT INTO settings (key, value) VALUES (?1, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![CONFIRMED],
    )?;
    let detail = if removed { "copia en texto plano eliminada" } else { "sin copia que eliminar" };
    audit::log(&db, Some(me.id), "key_recovery_confirmed", Some("settings"), None, Some(detail))?;
    Ok(removed)
}
