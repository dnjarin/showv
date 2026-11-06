use crate::{error::AppError, security, state::AppState};
use chrono::NaiveDate;
use rusqlite::params;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditRow {
    id: i64,
    created_at: String,
    username: Option<String>,
    action: String,
    entity: Option<String>,
    entity_id: Option<i64>,
    detail: Option<String>,
}

#[tauri::command]
pub async fn list_audit(
    state: State<'_, AppState>,
    from: String,
    to: String,
    search: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<AuditRow>, AppError> {
    security::require_role(&state, &["admin"])?;

    let parse = |s: &str| {
        NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
            .map_err(|_| AppError::Validation("Fecha inválida".into()))
    };
    let (f, t) = (parse(&from)?, parse(&to)?);
    if t < f {
        return Err(AppError::Validation("La fecha final es anterior a la inicial".into()));
    }
    if (t - f).num_days() > 366 {
        return Err(AppError::Validation("El rango máximo es de un año".into()));
    }
    let (f, t) = (f.format("%Y-%m-%d").to_string(), t.format("%Y-%m-%d").to_string());
    let search = search.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let limit = limit.unwrap_or(300).clamp(1, 1000);

    let db = state.conn()?;
    let rows = db
        .prepare(
            "SELECT a.id, a.created_at, u.username, a.action, a.entity, a.entity_id, a.detail
             FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
             WHERE date(a.created_at, 'localtime') BETWEEN ?1 AND ?2
               AND (?3 IS NULL OR a.action LIKE '%' || ?3 || '%'
                    OR a.detail LIKE '%' || ?3 || '%' OR u.username LIKE '%' || ?3 || '%')
             ORDER BY a.id DESC LIMIT ?4",
        )?
        .query_map(params![f, t, search, limit], |r| {
            Ok(AuditRow {
                id: r.get(0)?,
                created_at: r.get(1)?,
                username: r.get(2)?,
                action: r.get(3)?,
                entity: r.get(4)?,
                entity_id: r.get(5)?,
                detail: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}