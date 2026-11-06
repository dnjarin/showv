use crate::{
    audit,
    backup::{self, BackupItem},
    error::AppError,
    security,
    state::AppState,
};
use rusqlite::params;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

fn data_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path().app_data_dir().map_err(|e| AppError::Internal(e.to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    dir: String,
    extra_dir: Option<String>,
    items: Vec<BackupItem>,
}

#[derive(Serialize)]
pub struct BackupResult {
    name: String,
    warning: Option<String>,
}

#[tauri::command]
pub async fn backup_status(app: AppHandle, state: State<'_, AppState>) -> Result<BackupStatus, AppError> {
    security::require_role(&state, &["admin"])?;
    let dir = backup::dir(&data_dir(&app)?);
    let db = state.conn()?;
    Ok(BackupStatus {
        dir: dir.display().to_string(),
        extra_dir: backup::extra_dir(&db),
        items: backup::list(&dir),
    })
}

#[tauri::command]
pub async fn backup_create(app: AppHandle, state: State<'_, AppState>) -> Result<BackupResult, AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let dir = backup::dir(&data_dir(&app)?);
    let db = state.conn()?;
    let path = backup::run(&db, &dir, "manual")?;
    let warning = backup::copy_extra(&db, &path);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    audit::log(&db, Some(me.id), "backup_created", Some("database"), None, Some(&name))?;
    Ok(BackupResult { name, warning })
}

#[tauri::command]
pub async fn backup_set_extra_dir(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    let db = state.conn()?;

    match &path {
        None => {
            db.execute("DELETE FROM settings WHERE key = 'backup_extra_dir'", [])?;
        }
        Some(p) => {
            let dir = Path::new(p);
            if !dir.is_dir() {
                return Err(AppError::Validation("Esa carpeta no existe".into()));
            }
            // Prueba de escritura para avisar de inmediato si no se puede usar
            let probe = dir.join(".respaldo_prueba");
            std::fs::write(&probe, b"ok")
                .map_err(|_| AppError::Validation("No se puede escribir en esa carpeta".into()))?;
            let _ = std::fs::remove_file(&probe);
            db.execute(
                "INSERT INTO settings (key, value) VALUES ('backup_extra_dir', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![p],
            )?;
        }
    }
    audit::log(&db, Some(me.id), "backup_dir_set", Some("settings"), None, path.as_deref())?;
    Ok(())
}

#[tauri::command]
pub async fn backup_restore(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    confirm: String,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    if confirm != "RESTAURAR" {
        return Err(AppError::Validation("Escribe RESTAURAR para confirmar".into()));
    }
    if !backup::valid_name(&name) {
        return Err(AppError::Validation("Nombre de respaldo inválido".into()));
    }
    let dir = backup::dir(&data_dir(&app)?);
    let path = dir.join(&name);
    if !path.is_file() {
        return Err(AppError::Validation("El respaldo no existe".into()));
    }
    backup::check_restorable(&path)?;

    let mut db = state.conn()?;
    // Primero se guarda el estado actual: si algo sale mal, siempre hay vuelta atrás.
    backup::run(&db, &dir, "prerestauracion")?;
    backup::restore(&mut db, &path)?;
    let detail = format!("restaurado {name} por {}", me.username);
    audit::log(&db, None, "backup_restored", Some("database"), None, Some(&detail))?;
    drop(db);
    // El usuario actual puede no existir en la base restaurada.
    state.set_session(None);
    Ok(())
}