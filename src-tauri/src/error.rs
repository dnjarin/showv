use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Error de base de datos")]
    Db(#[from] rusqlite::Error),
    #[error("Error de migración de base de datos")]
    Migration(#[from] rusqlite_migration::Error),
    #[error("{0}")]
    Validation(String),
    #[error("Usuario o contraseña incorrectos")]
    InvalidCredentials,
    #[error("Debes iniciar sesión")]
    Unauthorized,
    #[error("No tienes permisos para esta acción")]
    Forbidden,
    #[error("Error interno: {0}")]
    Internal(String),
}

// Los errores llegan al frontend como texto simple.
// Los detalles internos de la BD no se exponen.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if let AppError::Db(e) = self {
            eprintln!("DB error: {e}");
        }
        s.serialize_str(&self.to_string())
    }
}