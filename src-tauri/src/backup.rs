use crate::error::AppError;
use chrono::{DateTime, Local};
use rusqlite::{backup::Backup, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const KINDS: &[&str] = &["auto", "manual", "premigracion", "prerestauracion"];

fn io(e: std::io::Error) -> AppError {
    AppError::Internal(e.to_string())
}

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("backups")
}

fn keep_for(kind: &str) -> usize {
    match kind {
        "auto" => 14,
        "manual" => 30,
        _ => 5,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupItem {
    pub name: String,
    pub kind: String,
    pub size_bytes: u64,
    pub created_at: String,
}

/// Comprueba que el archivo es una base SQLite íntegra.
fn verify(path: &Path) -> Result<(), AppError> {
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    crate::crypto::apply(&c)?;
    let r: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if r != "ok" {
        return Err(AppError::Internal(format!("Respaldo corrupto: {r}")));
    }
    Ok(())
}

/// Crea un respaldo consistente (no depende de archivos -wal), lo verifica y rota los antiguos.
pub fn run(conn: &Connection, dir: &Path, kind: &str) -> Result<PathBuf, AppError> {
    std::fs::create_dir_all(dir).map_err(io)?;
    let name = format!("{kind}_{}.db", Local::now().format("%Y%m%d_%H%M%S"));
    let path = dir.join(&name);
    {
        let mut dst = Connection::open(&path)?;
        crate::crypto::apply(&dst)?;
        let b = Backup::new(conn, &mut dst)?;
        b.run_to_completion(256, Duration::from_millis(0), None)?;
    }
    if let Err(e) = verify(&path) {
        let _ = std::fs::remove_file(&path);
        return Err(e);
    }
    prune(dir, kind)?;
    Ok(path)
}

fn prune(dir: &Path, kind: &str) -> Result<(), AppError> {
    let prefix = format!("{kind}_");
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map_err(io)?
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.starts_with(&prefix) && n.ends_with(".db"))
        .collect();
    names.sort(); // la fecha va en el nombre: los más viejos quedan primero
    let keep = keep_for(kind);
    if names.len() > keep {
        for n in &names[..names.len() - keep] {
            let _ = std::fs::remove_file(dir.join(n));
        }
    }
    Ok(())
}

pub fn list(dir: &Path) -> Vec<BackupItem> {
    let mut v: Vec<(SystemTime, BackupItem)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let Ok(name) = e.file_name().into_string() else { continue };
            if !name.ends_with(".db") {
                continue;
            }
            let kind = name.split('_').next().unwrap_or("").to_string();
            if !KINDS.contains(&kind.as_str()) {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let created_at = DateTime::<Local>::from(modified).format("%Y-%m-%d %H:%M").to_string();
            v.push((modified, BackupItem { name, kind, size_bytes: meta.len(), created_at }));
        }
    }
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v.into_iter().map(|(_, i)| i).collect()
}

fn latest_modified(dir: &Path, kind: &str) -> Option<SystemTime> {
    let prefix = format!("{kind}_");
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .map_or(false, |n| n.starts_with(&prefix) && n.ends_with(".db"))
        })
        .filter_map(|e| e.metadata().ok()?.modified().ok())
        .max()
}

/// Carpeta externa opcional (USB, OneDrive, disco de red...), configurada por el admin.
pub fn extra_dir(conn: &Connection) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = 'backup_extra_dir'", [], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

/// Copia el respaldo a la carpeta externa. Devuelve un aviso si falla (no es un error fatal).
pub fn copy_extra(conn: &Connection, path: &Path) -> Option<String> {
    let extra = extra_dir(conn)?;
    let dest = Path::new(&extra).join(path.file_name()?);
    match std::fs::copy(path, &dest) {
        Ok(_) => None,
        Err(e) => Some(format!("No se pudo copiar a la carpeta externa ({extra}): {e}")),
    }
}

/// Respaldo automático si el último tiene más de 24 horas.
pub fn auto_if_due(conn: &Connection, dir: &Path) -> Result<(), AppError> {
    let due = match latest_modified(dir, "auto") {
        Some(t) => t.elapsed().map(|d| d > Duration::from_secs(24 * 3600)).unwrap_or(true),
        None => true,
    };
    if due {
        let p = run(conn, dir, "auto")?;
        if let Some(w) = copy_extra(conn, &p) {
            eprintln!("{w}");
        }
    }
    Ok(())
}

/// Solo nombres que el propio sistema genera: sin rutas ni caracteres raros.
pub fn valid_name(name: &str) -> bool {
    name.len() <= 64
        && name.ends_with(".db")
        && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
        && KINDS.iter().any(|k| name.starts_with(&format!("{k}_")))
}

/// Valida que el archivo sea una base íntegra y de este sistema, y no de una versión más nueva.
pub fn check_restorable(path: &Path) -> Result<(), AppError> {
    verify(path)?;
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    crate::crypto::apply(&c)?;
    let tables: i64 = c.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'
         AND name IN ('users','documents','products','settings','audit_log')",
        [],
        |r| r.get(0),
    )?;
    if tables < 5 {
        return Err(AppError::Validation("El archivo no es un respaldo válido de este sistema".into()));
    }
    let version: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version as usize > crate::db::MIGRATIONS.len() {
        return Err(AppError::Validation("Ese respaldo es de una versión más nueva del sistema".into()));
    }
    Ok(())
}

/// Sobrescribe la base en uso con el respaldo, sin reiniciar la aplicación.
pub fn restore(conn: &mut Connection, src_path: &Path) -> Result<(), AppError> {
    let src = Connection::open_with_flags(src_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    crate::crypto::apply(&src)?;
    {
        let b = Backup::new(&src, conn)?;
        b.run_to_completion(256, Duration::from_millis(0), None)?;
    }
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "foreign_keys", "ON");
    crate::db::migrate(conn)?; // si el respaldo es de un esquema anterior, se actualiza
    Ok(())
}