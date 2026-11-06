use crate::lan;
use crate::{audit, error::AppError, security, state::AppState};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRow {
    id: i64,
    username: String,
    full_name: String,
    role: String,
    active: bool,
    locked: bool,
    created_at: String,
}

#[tauri::command]
pub async fn list_users(state: State<'_, AppState>) -> Result<Vec<UserRow>, AppError> {
    security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT u.id, u.username, u.full_name, r.name, u.active,
                    (u.locked_until IS NOT NULL AND u.locked_until > datetime('now')),
                    u.created_at
             FROM users u JOIN roles r ON r.id = u.role_id
             ORDER BY u.username",
        )?
        .query_map([], |r| {
            Ok(UserRow {
                id: r.get(0)?,
                username: r.get(1)?,
                full_name: r.get(2)?,
                role: r.get(3)?,
                active: r.get::<_, i64>(4)? != 0,
                locked: r.get::<_, i64>(5)? != 0,
                created_at: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub async fn update_user(
    state: State<'_, AppState>,
    id: i64,
    full_name: String,
    role: String,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let full_name = full_name.trim().to_string();
    if full_name.len() < 2 {
        return Err(AppError::Validation("El nombre es obligatorio".into()));
    }
    let db = state.conn()?;
    let old_role: String = db
        .query_row(
            "SELECT r.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("El usuario no existe".into()))?;
    let role_id: i64 = db
        .query_row("SELECT id FROM roles WHERE name = ?1", [&role], |r| r.get(0))
        .optional()?
        .ok_or_else(|| AppError::Validation("Rol inválido".into()))?;

    // El admin no puede quitarse a sí mismo el rol: garantiza que siempre quede un administrador.
    if id == me.id && role != "admin" {
        return Err(AppError::Validation("No puedes quitarte tu propio rol de administrador".into()));
    }

    db.execute(
        "UPDATE users SET full_name = ?1, role_id = ?2 WHERE id = ?3",
        params![full_name, role_id, id],
    )?;
    if old_role != role {
        lan::revoke_user(id); // su sesión abierta conservaría el rol anterior
    }
    let detail = format!("rol {old_role} -> {role}");
    audit::log(&db, Some(me.id), "user_updated", Some("user"), Some(id), Some(&detail))?;
    Ok(())
}

#[tauri::command]
pub async fn set_user_active(
    state: State<'_, AppState>,
    id: i64,
    active: bool,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    if id == me.id && !active {
        return Err(AppError::Validation("No puedes desactivar tu propia cuenta".into()));
    }
    let db = state.conn()?;
    let n = db.execute("UPDATE users SET active = ?1 WHERE id = ?2", params![active as i64, id])?;
    if n == 0 {
        return Err(AppError::Validation("El usuario no existe".into()));
    }
    if !active {
        lan::revoke_user(id);
    }
    let action = if active { "user_activated" } else { "user_deactivated" };
    audit::log(&db, Some(me.id), action, Some("user"), Some(id), None)?;
    Ok(())
}
#[tauri::command]
pub async fn reset_user_password(
    state: State<'_, AppState>,
    id: i64,
    new_password: String,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let username: String = {
        let db = state.conn()?;
        db.query_row("SELECT username FROM users WHERE id = ?1", [id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| AppError::Validation("El usuario no existe".into()))?
    };
    security::validate_password(&username, &new_password)?;
    let hash = security::hash_password(&new_password)?;

    let db = state.conn()?;
    db.execute(
        "UPDATE users SET password_hash = ?1, failed_attempts = 0, locked_until = NULL,
                must_change_password = 1
         WHERE id = ?2",
        params![hash, id],
    )?;
    lan::revoke_user(id);
    audit::log(&db, Some(me.id), "password_reset", Some("user"), Some(id), None)?;
    Ok(())
}


#[tauri::command]
pub async fn unlock_user(state: State<'_, AppState>, id: i64) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let db = state.conn()?;
    let n = db.execute(
        "UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?1",
        [id],
    )?;
    if n == 0 {
        return Err(AppError::Validation("El usuario no existe".into()));
    }
    audit::log(&db, Some(me.id), "user_unlocked", Some("user"), Some(id), None)?;
    Ok(())
}

#[tauri::command]
pub async fn change_own_password(
    state: State<'_, AppState>,
    current_password: String,
    new_password: String,
) -> Result<(), AppError> {
    // Debe poder usarse aunque haya un cambio de contraseña pendiente.
    let me = security::require_session(&state)?;
    let hash: String = {
        let db = state.conn()?;
        db.query_row("SELECT password_hash FROM users WHERE id = ?1", [me.id], |r| r.get(0))?
    };
    if !security::verify_password(&current_password, &hash) {
        return Err(AppError::Validation("La contraseña actual no es correcta".into()));
    }
    security::validate_password(&me.username, &new_password)?;
    if new_password == current_password {
        return Err(AppError::Validation("La nueva contraseña debe ser distinta de la actual".into()));
    }
    let new_hash = security::hash_password(&new_password)?;

    let db = state.conn()?;
    db.execute(
        "UPDATE users SET password_hash = ?1, must_change_password = 0 WHERE id = ?2",
        params![new_hash, me.id],
    )?;
    audit::log(&db, Some(me.id), "password_changed", Some("user"), Some(me.id), None)?;
    drop(db);
    state.clear_must_change();
    Ok(())
}