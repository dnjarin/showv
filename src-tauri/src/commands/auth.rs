use crate::{
    audit,
    error::AppError,
    security,
    state::{AppState, SessionUser},
};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use tauri::State;

const MAX_ATTEMPTS: i64 = 5;
const LOCK_MINUTES: i64 = 15;

/// Hash de relleno: cuando el usuario no existe también se hace una verificación Argon2, para que el tiempo de
/// respuesta no revele qué usuarios existen.
fn dummy_hash() -> &'static str {
    static H: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    H.get_or_init(|| security::hash_password("relleno-no-es-una-clave-1").unwrap_or_default())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupInput {
    pub rif: String,
    pub legal_name: String,
    pub fiscal_address: String,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub admin_username: String,
    pub admin_full_name: String,
    pub admin_password: String,
}

fn validate_credentials(username: &str, password: &str) -> Result<(), AppError> {
    if username.trim().len() < 3 {
        return Err(AppError::Validation("El usuario debe tener al menos 3 caracteres".into()));
    }
    security::validate_password(username, password)
}

#[tauri::command]
pub async fn needs_setup(state: State<'_, AppState>) -> Result<bool, AppError> {
    let db = state.conn()?;
    let n: i64 = db.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
    Ok(n == 0)
}

#[tauri::command]
pub async fn complete_setup(
    state: State<'_, AppState>,
    input: SetupInput,
) -> Result<SessionUser, AppError> {
    validate_credentials(&input.admin_username, &input.admin_password)?;
    if input.rif.trim().is_empty() || input.legal_name.trim().is_empty() {
        return Err(AppError::Validation("RIF y razón social son obligatorios".into()));
    }
    let hash = security::hash_password(&input.admin_password)?;

    let mut db = state.conn()?;
    let tx = db.transaction()?;

    // Solo se permite si todavía no existe ningún usuario.
    let n: i64 = tx.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
    if n > 0 {
        return Err(AppError::Forbidden);
    }

    tx.execute(
        "INSERT INTO company (id, rif, legal_name, fiscal_address, phone, email)
         VALUES (1, ?1, ?2, ?3, ?4, ?5)",
        params![
            input.rif.trim().to_uppercase(),
            input.legal_name.trim(),
            input.fiscal_address.trim(),
            input.phone,
            input.email
        ],
    )?;
    let role_id: i64 =
        tx.query_row("SELECT id FROM roles WHERE name = 'admin'", [], |r| r.get(0))?;
    tx.execute(
        "INSERT INTO users (username, password_hash, full_name, role_id) VALUES (?1, ?2, ?3, ?4)",
        params![input.admin_username.trim(), hash, input.admin_full_name.trim(), role_id],
    )?;
    let user_id = tx.last_insert_rowid();
    audit::log(&tx, Some(user_id), "setup_completed", Some("company"), Some(1), None)?;
    tx.commit()?;

    let user = SessionUser {
        id: user_id,
        username: input.admin_username.trim().to_string(),
        full_name: input.admin_full_name.trim().to_string(),
        role: "admin".into(),
        must_change_password: false,
    };
    state.set_session(Some(user.clone()));
    Ok(user)
}

#[tauri::command]
pub async fn login(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<SessionUser, AppError> {
    let username = username.trim().to_string();
    if password.len() > 128 {
        return Err(AppError::InvalidCredentials);
    }

    // La BD se libera antes de verificar Argon2 (es lento a propósito).
    let row = {
        let db = state.conn()?;
        db.query_row(
            "SELECT u.id, u.password_hash, u.full_name, r.name,
                    CASE WHEN u.locked_until IS NOT NULL AND u.locked_until > datetime('now')
                         THEN CAST((julianday(u.locked_until) - julianday('now')) * 1440 AS INTEGER) + 1
                         ELSE NULL END,
                    u.must_change_password
             FROM users u JOIN roles r ON r.id = u.role_id
             WHERE u.username = ?1 AND u.active = 1",
            [&username],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            },
        )
        .optional()?
    };

    // Cuenta bloqueada: ni siquiera se verifica la contraseña.
    if let Some((id, _, _, _, Some(minutes), _)) = &row {
        let db = state.conn()?;
        audit::log(&db, Some(*id), "login_blocked", Some("user"), Some(*id), None)?;
        return Err(AppError::Validation(format!(
            "Cuenta bloqueada por intentos fallidos. Intenta de nuevo en {minutes} min."
        )));
    }

    match row {
        Some((id, hash, full_name, role, None, must_change))
            if security::verify_password(&password, &hash) =>
        {
            let db = state.conn()?;
            db.execute("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?1", [id])?;
            audit::log(&db, Some(id), "login", Some("user"), Some(id), None)?;
            let user = SessionUser {
                id,
                username,
                full_name,
                role,
                must_change_password: must_change != 0,
            };
            state.set_session(Some(user.clone()));
            Ok(user)
        }
        other => {
            if other.is_none() {
                let _ = security::verify_password(&password, dummy_hash());
            }
            let db = state.conn()?;
            if let Some((id, ..)) = other {
                db.execute(
                    "UPDATE users SET
                        locked_until = CASE WHEN failed_attempts + 1 >= ?2
                                            THEN datetime('now', ?3) ELSE locked_until END,
                        failed_attempts = CASE WHEN failed_attempts + 1 >= ?2
                                               THEN 0 ELSE failed_attempts + 1 END
                     WHERE id = ?1",
                    params![id, MAX_ATTEMPTS, format!("+{LOCK_MINUTES} minutes")],
                )?;
                audit::log(&db, Some(id), "login_failed", Some("user"), Some(id), None)?;
                let locked: i64 = db.query_row(
                    "SELECT locked_until IS NOT NULL AND locked_until > datetime('now')
                     FROM users WHERE id = ?1",
                    [id],
                    |r| r.get(0),
                )?;
                if locked != 0 {
                    audit::log(&db, Some(id), "account_locked", Some("user"), Some(id), None)?;
                    return Err(AppError::Validation(format!(
                        "Demasiados intentos fallidos. Cuenta bloqueada por {LOCK_MINUTES} minutos."
                    )));
                }
            } else {
                // No se guarda lo tecleado: podría ser una contraseña puesta por error en el campo de usuario.
                audit::log(&db, None, "login_failed", Some("user"), None, Some("usuario inexistente"))?;
            }
            Err(AppError::InvalidCredentials)
        }
    }
}

#[tauri::command]
pub async fn logout(state: State<'_, AppState>) -> Result<(), AppError> {
    if let Some(u) = state.session() {
        let db = state.conn()?;
        audit::log(&db, Some(u.id), "logout", Some("user"), Some(u.id), None)?;
    }
    state.set_session(None);
    Ok(())
}

#[tauri::command]
pub async fn current_user(state: State<'_, AppState>) -> Result<Option<SessionUser>, AppError> {
    Ok(state.peek())
}

#[tauri::command]
pub async fn keep_alive(state: State<'_, AppState>) -> Result<(), AppError> {
    state.session().map(|_| ()).ok_or(AppError::Unauthorized)
}

/// Crea un usuario con clave temporal: deberá cambiarla en su primer ingreso.
#[tauri::command]
pub async fn create_user(
    state: State<'_, AppState>,
    username: String,
    full_name: String,
    password: String,
    role: String,
) -> Result<i64, AppError> {
    let me = security::require_role(&state, &["admin"])?;
    validate_credentials(&username, &password)?;
    let hash = security::hash_password(&password)?;

    let db = state.conn()?;
    let role_id: i64 = db
        .query_row("SELECT id FROM roles WHERE name = ?1", [&role], |r| r.get(0))
        .optional()?
        .ok_or_else(|| AppError::Validation("Rol inválido".into()))?;
    let exists: i64 = db.query_row(
        "SELECT COUNT(*) FROM users WHERE username = ?1", [username.trim()], |r| r.get(0))?;
    if exists > 0 {
        return Err(AppError::Validation("Ese usuario ya existe".into()));
    }
    db.execute(
        "INSERT INTO users (username, password_hash, full_name, role_id, must_change_password)
         VALUES (?1, ?2, ?3, ?4, 1)",
        params![username.trim(), hash, full_name.trim(), role_id],
    )?;
    let id = db.last_insert_rowid();
    audit::log(&db, Some(me.id), "user_created", Some("user"), Some(id), Some(&role))?;
    Ok(id)
}