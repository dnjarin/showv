use crate::{audit, error::AppError, lan, security, state::AppState, tls};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

/// Estado del modo red con el que arrancó el programa. No requiere sesión: el frontend lo consulta
/// antes de iniciar sesión para saber cómo comunicarse con el sistema.
#[tauri::command]
pub async fn lan_info() -> Result<Value, AppError> {
    Ok(lan::info())
}

/// Configuración para la pantalla del administrador: lo activo ahora, lo guardado y la dirección
/// que deben escribir los demás puestos.
#[tauri::command]
pub async fn lan_settings_get(app: AppHandle, state: State<'_, AppState>) -> Result<Value, AppError> {
    security::require_role(&state, &["admin"])?;
    let dir = app.path().app_data_dir().map_err(|e| AppError::Internal(e.to_string()))?;
    let saved = lan::load_config(&dir);
    let active = lan::active();
    let ip = lan::lan_ip();
    let scheme = if saved.https { "https" } else { "http" };
    let url = ip.as_ref().map(|ip| format!("{scheme}://{ip}:{}", saved.port));
    let fingerprint = if saved.https { tls::current_fingerprint(&dir) } else { None };
    Ok(json!({
        "active": { "mode": active.mode, "port": active.port, "bind": active.bind, "https": active.https, "running": lan::running() },
        "saved": { "mode": saved.mode, "port": saved.port, "bind": saved.bind, "https": saved.https },
        "fingerprint": fingerprint,
        "lanIp": ip,
        "url": url,
        "needsRestart": saved != active,
    }))
}

/// Guarda el modo, el puerto y la dirección de escucha (vacía = todas). Se aplica al volver a abrir el programa.
/// Solo se acepta desde el equipo principal (lo hace cumplir el servidor).
#[tauri::command]
pub async fn lan_settings_save(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: String,
    port: u16,
    bind: String,
    https: bool,
) -> Result<(), AppError> {
    let me = security::require_role(&state, &["admin"])?;
    let dir = app.path().app_data_dir().map_err(|e| AppError::Internal(e.to_string()))?;
    let bind = bind.trim().to_string();
    lan::save_config(&dir, &lan::LanConfig { mode: mode.clone(), port, bind: bind.clone(), https })?;
    let db = state.conn()?;
    let detail = format!(
        "modo {mode}, puerto {port}, escucha en {}, {}",
        if bind.is_empty() { "todas las interfaces" } else { bind.as_str() },
        if https { "HTTPS" } else { "HTTP sin cifrar" }
    );
    audit::log(&db, Some(me.id), "lan_config_changed", Some("settings"), None, Some(&detail))?;
    Ok(())
}
