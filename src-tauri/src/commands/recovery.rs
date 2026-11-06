use crate::{audit, error::AppError, security, state::AppState};
use argon2::password_hash::rand_core::{OsRng, RngCore};
use rusqlite::{params, OptionalExtension};
use tauri::State;

// 32 símbolos, sin O/0/I/1 para que no se confundan al copiarlos a mano.
const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_ATTEMPTS: i64 = 5;
const LOCK_MINUTES: i64 = 15;

/// 20 caracteres (100 bits) en 4 grupos: XXXXX-XXXXX-XXXXX-XXXXX
fn new_code() -> String {
    let mut bytes = [0u8; 20];
    OsRng.fill_bytes(&mut bytes);
    let chars: Vec<char> = bytes.iter().map(|b| ALPHABET[(*b % 32) as usize] as char).collect();
    chars
        .chunks(5)
        .map(|c| c.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("-")
}

fn normalize(code: &str) -> String {
    code.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_uppercase()
}

/// El administrador genera un código de un solo uso. Se muestra una única vez.
#[tauri::command]
pub async fn generate_recovery_code(state: State<'_, AppState>) -> Result<String, AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let code = new_code();
    let hash = security::hash_password(&normalize(&code))?;

    let db = state.conn()?;
    db.execute(
        "INSERT INTO settings (key, value) VALUES ('admin_recovery_hash', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![hash],
    )?;
    audit::log(&db, Some(me.id), "recovery_code_generated", Some("settings"), None, None)?;
    Ok(code)
}

/// Restablece la contraseña de un administrador con el código de recuperación (sin sesión).
#[tauri::command]
pub async fn recover_admin(
    state: State<'_, AppState>,
    username: String,
    code: String,
    new_password: String,
) -> Result<(), AppError> {
    let username = username.trim().to_string();
    let code = normalize(&code);
    let generic = || AppError::Validation("Datos de recuperación incorrectos".into());

    let (id, locked_minutes, hash) = {
        let db = state.conn()?;
        let user = db
            .query_row(
                "SELECT u.id,
                        CASE WHEN u.locked_until IS NOT NULL AND u.locked_until > datetime('now')
                             THEN CAST((julianday(u.locked_until) - julianday('now')) * 1440 AS INTEGER) + 1
                             ELSE NULL END
                 FROM users u JOIN roles r ON r.id = u.role_id
                 WHERE u.username = ?1 AND u.active = 1 AND r.name = 'admin'",
                [&username],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?)),
            )
            .optional()?;
        let hash: Option<String> = db
            .query_row("SELECT value FROM settings WHERE key = 'admin_recovery_hash'", [], |r| r.get(0))
            .optional()?;
        match (user, hash) {
            (Some((id, lm)), Some(h)) => (id, lm, h),
            _ => return Err(generic()),
        }
    };

    if let Some(m) = locked_minutes {
        return Err(AppError::Validation(format!(
            "Demasiados intentos. Intenta de nuevo en {m} min."
        )));
    }

    // Se verifica fuera del candado de la BD (Argon2 es lento a propósito).
    if !security::verify_password(&code, &hash) {
        let db = state.conn()?;
        db.execute(
            "UPDATE users SET
                locked_until = CASE WHEN failed_attempts + 1 >= ?2
                                    THEN datetime('now', ?3) ELSE locked_until END,
                failed_attempts = CASE WHEN failed_attempts + 1 >= ?2
                                       THEN 0 ELSE failed_attempts + 1 END
             WHERE id = ?1",
            params![id, MAX_ATTEMPTS, format!("+{LOCK_MINUTES} minutes")],
        )?;
        audit::log(&db, Some(id), "recovery_failed", Some("user"), Some(id), None)?;
        return Err(generic());
    }

    security::validate_password(&username, &new_password)?;
    let new_hash = security::hash_password(&new_password)?;

    let db = state.conn()?;
    db.execute(
        "UPDATE users SET password_hash = ?1, failed_attempts = 0, locked_until = NULL,
                must_change_password = 0
         WHERE id = ?2",
        params![new_hash, id],
    )?;
    // El código es de un solo uso.
    db.execute("DELETE FROM settings WHERE key = 'admin_recovery_hash'", [])?;
    audit::log(&db, Some(id), "admin_recovered", Some("user"), Some(id), None)?;
    Ok(())
}