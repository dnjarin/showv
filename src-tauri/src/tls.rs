//! Certificado propio para el modo red (HTTPS). Se genera solo la primera vez y se guarda en la carpeta
//! de datos del programa (`tls/`). Es un certificado **autofirmado**: el cifrado funciona, pero el navegador
//! de cada puesto avisa que no conoce a quien lo emitió hasta que se acepta (una vez por navegador).
//! Para evitar ese aviso, usa la versión con autoridad propia (carpeta s9).

use std::{
    fs,
    net::IpAddr,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use rcgen::{CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, KeyPair, KeyUsagePurpose};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::error::AppError;

/// Vigencia del certificado. 800 días queda por debajo del límite de 825 que aplican iPhone y iPad.
const VALID_DAYS: i64 = 800;
/// Si faltan menos días que esto, se genera uno nuevo.
const RENEW_BEFORE_DAYS: i64 = 30;

pub struct Material {
    pub cert_pem: Vec<u8>,
    pub key_pem: Vec<u8>,
    /// Huella SHA-256 del certificado, para compararla con la que muestra el navegador.
    pub fingerprint: String,
}

fn err<E: std::fmt::Display>(e: E) -> AppError {
    AppError::Internal(format!("certificado: {e}"))
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn tls_dir(dir: &Path) -> PathBuf {
    dir.join("tls")
}

pub fn fingerprint_of(der: &[u8]) -> String {
    let hash = Sha256::digest(der);
    hash.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

/// Texto con las direcciones que cubre el certificado, ordenadas, para saber si hay que rehacerlo.
fn ips_key(ips: &[IpAddr]) -> String {
    let mut v: Vec<String> = ips.iter().map(|i| i.to_string()).collect();
    v.sort();
    v.dedup();
    v.join(",")
}

fn write_private(path: &Path, data: &[u8]) -> Result<(), AppError> {
    fs::write(path, data).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Devuelve el certificado vigente; lo crea si no existe, si vence pronto o si cambió la dirección del equipo.
pub fn ensure(dir: &Path, ips: &[IpAddr]) -> Result<Material, AppError> {
    let d = tls_dir(dir);
    fs::create_dir_all(&d).map_err(err)?;
    let (cert_f, key_f, meta_f) = (d.join("servidor.crt"), d.join("servidor.key"), d.join("servidor.meta"));
    let want = ips_key(ips);

    if let (Ok(cert), Ok(key), Ok(meta)) = (fs::read(&cert_f), fs::read(&key_f), fs::read_to_string(&meta_f)) {
        let mut lines = meta.lines();
        let expires: i64 = lines.next().and_then(|l| l.trim().parse().ok()).unwrap_or(0);
        let have = lines.next().unwrap_or("").trim().to_string();
        let fp = lines.next().unwrap_or("").trim().to_string();
        if have == want && expires - now_secs() > RENEW_BEFORE_DAYS * 86_400 && !fp.is_empty() {
            return Ok(Material { cert_pem: cert, key_pem: key, fingerprint: fp });
        }
    }

    let key = KeyPair::generate().map_err(err)?;
    let mut sans: Vec<String> = vec!["localhost".into()];
    sans.extend(ips.iter().map(|i| i.to_string()));
    let mut params = CertificateParams::new(sans).map_err(err)?;
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "Tekkadon (equipo principal)");
    dn.push(DnType::OrganizationName, "Tekkadon");
    params.distinguished_name = dn;
    let now = OffsetDateTime::now_utc();
    params.not_before = now - time::Duration::days(1);
    params.not_after = now + time::Duration::days(VALID_DAYS);
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature, KeyUsagePurpose::KeyEncipherment];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let cert = params.self_signed(&key).map_err(err)?;

    let cert_pem = cert.pem().into_bytes();
    let key_pem = key.serialize_pem().into_bytes();
    let fp = fingerprint_of(cert.der().as_ref());
    let expires = now_secs() + VALID_DAYS * 86_400;

    fs::write(&cert_f, &cert_pem).map_err(err)?;
    write_private(&key_f, &key_pem)?;
    fs::write(&meta_f, format!("{expires}\n{want}\n{fp}\n")).map_err(err)?;
    Ok(Material { cert_pem, key_pem, fingerprint: fp })
}

/// Huella del certificado en uso, si ya existe (para mostrarla en pantalla).
pub fn current_fingerprint(dir: &Path) -> Option<String> {
    let meta = fs::read_to_string(tls_dir(dir).join("servidor.meta")).ok()?;
    meta.lines().nth(2).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}
