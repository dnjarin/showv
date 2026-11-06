use crate::{error::AppError, state::{AppState, SessionUser}};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};

pub fn hash_password(password: &str) -> Result<String, AppError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::Internal(e.to_string()))
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
        .unwrap_or(false)
}

/// Devuelve la sesión activa sin exigir rol. Se usa solo donde debe poder entrar
/// alguien con un cambio de contraseña pendiente (por ejemplo, cambiar su clave).
pub fn require_session(state: &AppState) -> Result<SessionUser, AppError> {
    state.session().ok_or(AppError::Unauthorized)
}

/// Guardia de permisos. Bloquea todo mientras haya un cambio de contraseña pendiente.
pub fn require_role(state: &AppState, roles: &[&str]) -> Result<SessionUser, AppError> {
    let user = require_session(state)?;
    if user.must_change_password {
        return Err(AppError::Validation(
            "Debes cambiar tu contraseña antes de continuar".into(),
        ));
    }
    if roles.contains(&user.role.as_str()) {
        Ok(user)
    } else {
        Err(AppError::Forbidden)
    }
}

pub const ALL_ROLES: &[&str] = &["admin", "cajero", "almacen"];
pub const STOCK_MANAGERS: &[&str] = &["admin", "almacen"];
pub const SALES_ROLES: &[&str] = &["admin", "cajero"];
/// Palabras muy usadas que, con unos dígitos al final, cumplen «letras y números» y aun así se adivinan primero.
const COMMON_WORDS: &[&str] = &[
    "password", "passw0rd", "qwerty", "qwertyui", "abc", "abcd", "abcde", "admin", "administrador", "contrasena",
    "contraseña", "clave", "tekkadon", "venezuela", "caracas", "iloveyou", "welcome", "letmein", "sistema",
    "inventario", "usuario", "master", "secret", "dragon", "monkey", "football", "baseball",
];
/// Contraseñas comunes que no siguen el patrón «palabra + dígitos».
const COMMON_EXACT: &[&str] = &["1q2w3e4r", "a1234567", "12345678a", "1234567a", "q1w2e3r4", "zaq12wsx", "1qaz2wsx"];

/// ¿Es una contraseña de las que cualquiera prueba primero?
pub fn is_common(password: &str) -> bool {
    let low = password.to_lowercase();
    if COMMON_EXACT.contains(&low.as_str()) {
        return true;
    }
    if password.chars().all(|c| Some(c) == password.chars().next()) {
        return true;
    }
    let base = low.trim_end_matches(|c: char| c.is_ascii_digit());
    let digits = low.len() - base.len();
    digits <= 6 && COMMON_WORDS.contains(&base)
}

/// Política de contraseñas: 8+ caracteres, letras y números, no común, distinta del usuario.
pub fn validate_password(username: &str, password: &str) -> Result<(), AppError> {
    let n = password.chars().count();
    if n < 8 {
        return Err(AppError::Validation("La contraseña debe tener al menos 8 caracteres".into()));
    }
    if n > 128 {
        return Err(AppError::Validation("La contraseña es demasiado larga (máximo 128)".into()));
    }
    if !password.chars().any(|c| c.is_alphabetic()) || !password.chars().any(|c| c.is_ascii_digit()) {
        return Err(AppError::Validation("La contraseña debe incluir letras y números".into()));
    }
    if is_common(password) {
        return Err(AppError::Validation("Esa contraseña es muy común. Elige una menos fácil de adivinar".into()));
    }
    if password.to_lowercase() == username.trim().to_lowercase() {
        return Err(AppError::Validation("La contraseña no puede ser igual al usuario".into()));
    }
    Ok(())
}
