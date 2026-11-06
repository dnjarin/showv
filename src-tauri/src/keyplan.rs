//! Decisión de qué llave de cifrado usar. No depende de Tauri ni de SQLite, por eso se puede probar sola
//! (`cargo test keyplan`).
//!
//! La llave de los datos (64 caracteres hexadecimales) se guarda protegida por el sistema operativo
//! (Windows: Administrador de credenciales, que usa DPAPI). El archivo `inventario.key` en texto plano solo
//! existe en dos casos: instalaciones anteriores (se migra) o cuando el usuario escribe ahí su llave de
//! recuperación para abrir los datos en otro equipo.

#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    /// La llave ya está en el almacén del sistema.
    UseStored(String),
    /// Solo hay archivo: se usa y se mueve al almacén del sistema.
    UseFileAndMigrate(String),
    /// Hay archivo y almacén con llaves distintas, y la del archivo es la que abre la base.
    UseFileReplaceStored(String),
    /// No hay datos ni llave: instalación nueva.
    CreateNew,
    /// Hay una base cifrada pero ninguna llave.
    NeedRecovery,
}

/// Acepta la llave tal cual o con guiones/espacios (como se imprime la llave de recuperación).
pub fn normalize(s: &str) -> Option<String> {
    let k: String = s.chars().filter(|c| !c.is_whitespace() && *c != '-').collect::<String>().to_lowercase();
    if k.len() == 64 && k.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(k)
    } else {
        None
    }
}

/// 8 grupos de 8 caracteres: `a1b2c3d4-...`
pub fn format_recovery(key: &str) -> String {
    key.as_bytes()
        .chunks(8)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("-")
}

pub fn plan(
    stored: Option<&str>,
    file: Option<&str>,
    db_exists: bool,
    db_plain: bool,
    opens: &dyn Fn(&str) -> bool,
) -> Plan {
    let stored = stored.and_then(normalize);
    let file = file.and_then(normalize);
    match (stored, file) {
        (Some(s), Some(f)) => {
            if s == f {
                Plan::UseStored(s)
            } else if !db_exists || db_plain {
                Plan::UseFileReplaceStored(f)
            } else if opens(&f) && !opens(&s) {
                Plan::UseFileReplaceStored(f)
            } else {
                Plan::UseStored(s)
            }
        }
        (Some(s), None) => Plan::UseStored(s),
        (None, Some(f)) => Plan::UseFileAndMigrate(f),
        (None, None) => {
            if db_exists && !db_plain {
                Plan::NeedRecovery
            } else {
                Plan::CreateNew
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const B: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    #[test]
    fn normaliza_la_llave_de_recuperacion() {
        assert_eq!(normalize(A).as_deref(), Some(A));
        assert_eq!(normalize(&format!("  {}\n", A.to_uppercase())).as_deref(), Some(A));
        assert_eq!(normalize(&format_recovery(A)).as_deref(), Some(A));
        assert_eq!(normalize("abc"), None);
        assert_eq!(normalize(&A.replace('0', "z")), None);
        assert_eq!(format_recovery(A).matches('-').count(), 7);
    }

    #[test]
    fn instalacion_anterior_se_migra() {
        assert_eq!(plan(None, Some(A), true, false, &|_| true), Plan::UseFileAndMigrate(A.into()));
    }

    #[test]
    fn con_almacen_se_usa_el_almacen() {
        assert_eq!(plan(Some(A), None, true, false, &|_| true), Plan::UseStored(A.into()));
        assert_eq!(plan(Some(A), Some(A), true, false, &|_| true), Plan::UseStored(A.into()));
    }

    #[test]
    fn llave_de_recuperacion_en_equipo_nuevo() {
        // El almacén tiene una llave vieja que no abre la base; la del archivo sí.
        let opens = |k: &str| k == B;
        assert_eq!(plan(Some(A), Some(B), true, false, &opens), Plan::UseFileReplaceStored(B.into()));
        // Si el almacén abre la base, manda el almacén.
        let opens = |k: &str| k == A;
        assert_eq!(plan(Some(A), Some(B), true, false, &opens), Plan::UseStored(A.into()));
    }

    #[test]
    fn sin_llave() {
        assert_eq!(plan(None, None, false, false, &|_| false), Plan::CreateNew);
        assert_eq!(plan(None, None, true, true, &|_| false), Plan::CreateNew); // base sin cifrar: se cifra con llave nueva
        assert_eq!(plan(None, None, true, false, &|_| false), Plan::NeedRecovery);
    }

    #[test]
    fn archivo_basura_se_ignora() {
        assert_eq!(plan(None, Some("hola"), false, false, &|_| true), Plan::CreateNew);
    }
}
