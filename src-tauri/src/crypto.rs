//! Cifrado de la base de datos (SQLCipher).
//!
//! La llave es una cadena aleatoria de 64 caracteres hexadecimales. Se guarda en el almacén de llaves del sistema
//! (Windows: Administrador de credenciales / DPAPI; macOS: Llavero). Si el sistema no ofrece uno, se usa el archivo
//! `inventario.key` junto a la base. La decisión de qué llave usar está en `keyplan.rs`.
//! Hay que imprimir la llave de recuperación (Configuración): sin ella los datos no se pueden recuperar.
use crate::error::AppError;
use argon2::password_hash::rand_core::{OsRng, RngCore};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::keyplan::{self, Plan};

static KEY: OnceLock<String> = OnceLock::new();
static MODE: OnceLock<KeyMode> = OnceLock::new();
static DIR: OnceLock<PathBuf> = OnceLock::new();

/// Copia de la llave en texto plano que se aparta al migrar; se elimina cuando el administrador confirma.
const MIGRATED: &str = "inventario.key.migrado";

#[derive(Clone, Copy, PartialEq, Eq)]
enum KeyMode {
    /// La llave está protegida por el sistema operativo.
    Keystore,
    /// No hay almacén disponible: la llave está en `inventario.key` (como antes).
    File,
}

/// Almacén de llaves del sistema: Administrador de credenciales (DPAPI) en Windows, Llavero en macOS.
#[cfg(any(windows, target_os = "macos"))]
mod store {
    fn entry(id: &str) -> Option<keyring::Entry> {
        keyring::Entry::new("Tekkadon", id).ok()
    }
    pub fn get(id: &str) -> Option<String> {
        entry(id)?.get_password().ok()
    }
    pub fn set(id: &str, value: &str) -> bool {
        match entry(id) {
            Some(e) => e.set_password(value).is_ok() && e.get_password().ok().as_deref() == Some(value),
            None => false,
        }
    }
}

/// En otros sistemas no hay almacén: se sigue usando el archivo.
#[cfg(not(any(windows, target_os = "macos")))]
mod store {
    pub fn get(_id: &str) -> Option<String> {
        None
    }
    pub fn set(_id: &str, _value: &str) -> bool {
        false
    }
}

/// Identificador de esta instalación en el almacén (así dos carpetas de datos no se pisan).
fn store_id(dir: &Path) -> String {
    use sha2::{Digest, Sha256};
    let h = Sha256::digest(dir.to_string_lossy().to_lowercase().as_bytes());
    format!("db-{}", h.iter().take(8).map(|b| format!("{b:02x}")).collect::<String>())
}

/// Guarda la llave en el almacén y comprueba que se pueda leer de vuelta.
fn move_to_store(id: &str, key: &str) -> bool {
    store::set(id, key)
}

fn key_opens(db: &Path, key: &str) -> bool {
    match Connection::open(db) {
        Ok(c) => {
            c.execute_batch(&format!("PRAGMA key = '{key}';")).is_ok()
                && c.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0)).is_ok()
        }
        Err(_) => false,
    }
}

/// Estado de la protección de la llave, para la pantalla de Configuración.
pub fn status() -> serde_json::Value {
    let protected = MODE.get() == Some(&KeyMode::Keystore);
    let pending = DIR.get().map_or(false, |d| d.join(MIGRATED).is_file());
    serde_json::json!({ "protected": protected, "plainCopy": pending || !protected })
}

/// Llave de recuperación en grupos de 8 caracteres, para imprimirla.
pub fn recovery_code() -> Result<String, AppError> {
    Ok(keyplan::format_recovery(key()?))
}

/// Elimina del disco la copia en texto plano (si la hay y la llave está protegida). Devuelve si borró algo.
pub fn remove_plain_copy() -> Result<bool, AppError> {
    let Some(dir) = DIR.get() else { return Ok(false) };
    let p = dir.join(MIGRATED);
    if !p.is_file() {
        return Ok(false);
    }
    // Se sobrescribe antes de borrar para que no quede legible en el archivo.
    let len = std::fs::metadata(&p).map(|m| m.len() as usize).unwrap_or(64);
    let _ = std::fs::write(&p, vec![b'0'; len.max(64)]);
    std::fs::remove_file(&p).map_err(io)?;
    Ok(true)
}

fn io(e: std::io::Error) -> AppError {
    AppError::Internal(e.to_string())
}

/// Comillas simples escapadas para usar una ruta dentro de una sentencia SQL.
fn sql_str(s: &str) -> String {
    s.replace('\'', "''")
}

fn key() -> Result<&'static str, AppError> {
    KEY.get()
        .map(|s| s.as_str())
        .ok_or_else(|| AppError::Internal("La llave de cifrado no está cargada".into()))
}

/// Debe ser lo primero que se hace con una conexión nueva.
pub fn apply(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(&format!("PRAGMA key = '{}';", key()?))?;
    // Comprueba que la llave abre la base (si no, SQLite dice «file is not a database»).
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))
        .map_err(|_| {
            AppError::Internal(
                "No se pudo abrir la base cifrada: la llave (inventario.key) no corresponde o el archivo está dañado".into(),
            )
        })?;
    Ok(())
}

/// ¿El archivo es una base SQLite sin cifrar?
fn is_plain(path: &Path) -> bool {
    match Connection::open(path) {
        Ok(c) => c.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0)).is_ok(),
        Err(_) => false,
    }
}

fn remove_sidecars(path: &Path) {
    for ext in ["-wal", "-shm", "-journal"] {
        let mut s = path.as_os_str().to_os_string();
        s.push(ext);
        let _ = std::fs::remove_file(PathBuf::from(s));
    }
}

/// Convierte una base sin cifrar en una cifrada. Devuelve la ruta temporal con el resultado.
fn export_encrypted(plain: &Path, key: &str) -> Result<PathBuf, AppError> {
    let tmp = plain.with_extension("cifrando.tmp");
    let _ = std::fs::remove_file(&tmp);
    {
        let c = Connection::open(plain)?;
        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        let ver: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
        c.execute_batch(&format!(
            "ATTACH DATABASE '{}' AS enc KEY '{}';",
            sql_str(&tmp.to_string_lossy()),
            key
        ))?;
        c.execute_batch("SELECT sqlcipher_export('enc');")?;
        c.execute_batch(&format!("PRAGMA enc.user_version = {ver};"))?;
        c.execute_batch("DETACH DATABASE enc;")?;
    }
    Ok(tmp)
}

/// Prepara la llave y, si la base (o algún respaldo) está sin cifrar, la convierte.
/// La base original se conserva como `inventario.sin-cifrar.db` hasta que el usuario la borre.
pub fn prepare(db_path: &Path) -> Result<(), AppError> {
    let dir = db_path.parent().ok_or_else(|| AppError::Internal("Ruta de base inválida".into()))?;
    let key_path = dir.join("inventario.key");
    let _ = DIR.set(dir.to_path_buf());
    let id = store_id(dir);

    let file_text = std::fs::read_to_string(&key_path).ok();
    let stored = store::get(&id);
    let db_exists = db_path.is_file();
    let db_plain = db_exists && is_plain(db_path);
    let opens = |k: &str| key_opens(db_path, k);

    let (key, mode) = match keyplan::plan(stored.as_deref(), file_text.as_deref(), db_exists, db_plain, &opens) {
        Plan::UseStored(k) => {
            // Queda un archivo con la misma llave (migración incompleta): se aparta.
            if file_text.as_deref().and_then(keyplan::normalize).is_some() {
                let _ = std::fs::rename(&key_path, dir.join(MIGRATED));
            }
            (k, KeyMode::Keystore)
        }
        Plan::UseFileAndMigrate(k) | Plan::UseFileReplaceStored(k) => match move_to_store(&id, &k) {
            true => {
                // El archivo en texto plano se aparta (no se borra) hasta que el administrador confirme
                // que guardó su llave de recuperación.
                let _ = std::fs::rename(&key_path, dir.join(MIGRATED));
                (k, KeyMode::Keystore)
            }
            false => (k, KeyMode::File),
        },
        Plan::CreateNew => {
            let mut bytes = [0u8; 32];
            OsRng.fill_bytes(&mut bytes);
            let k: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            if move_to_store(&id, &k) {
                (k, KeyMode::Keystore)
            } else {
                std::fs::write(&key_path, &k).map_err(io)?;
                (k, KeyMode::File)
            }
        }
        Plan::NeedRecovery => {
            return Err(AppError::Internal(
                "No se encuentra la llave de cifrado en este equipo. Crea un archivo de texto llamado inventario.key \
                 junto a la base y pega dentro tu llave de recuperación (la que imprimiste en Configuración). \
                 Al abrir el programa la guardará de forma protegida."
                    .into(),
            ))
        }
    };
    let _ = MODE.set(mode);
    let _ = KEY.set(key.clone());

    // Base principal sin cifrar: se convierte y se conserva la original aparte.
    if db_path.is_file() && is_plain(db_path) {
        let tmp = export_encrypted(db_path, &key)?;
        let keep = dir.join("inventario.sin-cifrar.db");
        let _ = std::fs::remove_file(&keep);
        std::fs::rename(db_path, &keep).map_err(io)?;
        remove_sidecars(db_path);
        std::fs::rename(&tmp, db_path).map_err(io)?;
    }

    // Respaldos anteriores sin cifrar: se reemplazan por su versión cifrada.
    let bdir = crate::backup::dir(dir);
    if let Ok(rd) = std::fs::read_dir(&bdir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("db") && is_plain(&p) {
                match export_encrypted(&p, &key) {
                    Ok(tmp) => {
                        remove_sidecars(&p);
                        if std::fs::rename(&tmp, &p).is_err() {
                            let _ = std::fs::remove_file(&tmp);
                        }
                    }
                    Err(err) => eprintln!("No se pudo cifrar el respaldo {}: {err}", p.display()),
                }
            }
        }
    }
    Ok(())
}
