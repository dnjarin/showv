use crate::error::AppError;
use rusqlite::{params, Connection};

pub fn log(
    conn: &Connection,
    user_id: Option<i64>,
    action: &str,
    entity: Option<&str>,
    entity_id: Option<i64>,
    detail: Option<&str>,
) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO audit_log (user_id, action, entity, entity_id, detail)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![user_id, action, entity, entity_id, detail],
    )?;
    Ok(())
}