//! Reglas de seguridad del modo red. No depende de Tauri ni de otras librerías, por eso se puede
//! probar sola (`cargo test lan_guard`).
//!
//! - Solo se atienden equipos de la red local (privada, enlace local o el propio equipo).
//! - Un navegador solo puede usar la API desde la propia página de Tekkadon (mismo origen, http o https) o desde la
//!   ventana del programa; una página web cualquiera abierta en un navegador de la red queda fuera.
//! - Límite de solicitudes por minuto y bloqueo temporal por intentos fallidos de inicio de sesión,
//!   por equipo de origen (el bloqueo por cuenta, que ya existía, se mantiene).

use std::{
    collections::HashMap,
    net::IpAddr,
    time::{Duration, Instant},
};

/// Solicitudes por minuto que se aceptan de un mismo equipo.
pub const MAX_REQ_PER_MIN: u32 = 300;
/// Intentos fallidos de inicio de sesión desde un mismo equipo antes de bloquearlo.
/// Es menor que el límite por cuenta (5) para que el equipo se bloquee antes de poder bloquear la cuenta.
pub const MAX_LOGIN_FAILS: u32 = 4;
/// Ventana en la que se cuentan los intentos fallidos.
pub const FAIL_WINDOW: Duration = Duration::from_secs(15 * 60);
/// Tiempo que se bloquean los inicios de sesión de un equipo.
pub const BLOCK_TIME: Duration = Duration::from_secs(15 * 60);
const MAX_TRACKED: usize = 2000;

/// ¿La dirección pertenece a la red local (o al propio equipo)?
pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

/// Orígenes (páginas) desde los que un navegador puede llamar a la API.
const FIXED_ORIGINS: [&str; 5] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
];

/// ¿El encabezado Host es una IP o «localhost»? Un nombre cualquiera (p. ej. `evil.com` apuntando a esta red
/// por «DNS rebinding») se rechaza. Sin Host (HTTP/1.0) se acepta.
pub fn host_ok(host: Option<&str>) -> bool {
    let h = match host.map(str::trim) {
        None => return true,
        Some(h) if h.is_empty() => return false,
        Some(h) => h,
    };
    let name = if let Some(rest) = h.strip_prefix('[') {
        match rest.find(']') {
            Some(i) => &rest[..i],
            None => return false,
        }
    } else {
        match h.rsplit_once(':') {
            Some((n, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => n,
            Some(_) => return false,
            None => h,
        }
    };
    name.eq_ignore_ascii_case("localhost") || name.parse::<IpAddr>().is_ok()
}

/// `origin`: encabezado Origin del navegador. `host`: encabezado Host de la solicitud.
/// Se acepta la ventana del programa, el servidor de desarrollo y la propia página servida por este equipo.
pub fn origin_allowed(origin: &str, host: Option<&str>) -> bool {
    let o = origin.trim().trim_end_matches('/');
    if FIXED_ORIGINS.iter().any(|f| f.eq_ignore_ascii_case(o)) {
        return true;
    }
    match host.map(str::trim) {
        Some(h) if !h.is_empty() && host_ok(Some(h)) => {
            o.eq_ignore_ascii_case(&format!("http://{h}")) || o.eq_ignore_ascii_case(&format!("https://{h}"))
        }
        _ => false,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Denied {
    /// Inicios de sesión bloqueados; minutos que faltan.
    Blocked(u64),
    /// Demasiadas solicitudes en el último minuto.
    TooMany,
}

#[derive(Default)]
struct Entry {
    win_start: Option<Instant>,
    count: u32,
    fails: u32,
    fail_start: Option<Instant>,
    blocked_until: Option<Instant>,
    last_seen: Option<Instant>,
}

#[derive(Default)]
pub struct Limiter {
    map: HashMap<IpAddr, Entry>,
}

impl Limiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registra una solicitud de `ip`. El propio equipo (127.0.0.1) nunca se limita.
    pub fn check(&mut self, ip: IpAddr, now: Instant, is_login: bool) -> Result<(), Denied> {
        if ip.is_loopback() {
            return Ok(());
        }
        if self.map.len() > MAX_TRACKED {
            self.prune(now);
        }
        let e = self.map.entry(ip).or_default();
        e.last_seen = Some(now);

        if let Some(until) = e.blocked_until {
            if now < until {
                if is_login {
                    return Err(Denied::Blocked((until - now).as_secs() / 60 + 1));
                }
            } else {
                e.blocked_until = None;
            }
        }

        match e.win_start {
            Some(start) if now.duration_since(start) < Duration::from_secs(60) => e.count += 1,
            _ => {
                e.win_start = Some(now);
                e.count = 1;
            }
        }
        if e.count > MAX_REQ_PER_MIN {
            return Err(Denied::TooMany);
        }
        Ok(())
    }

    /// Registra el resultado de un inicio de sesión desde `ip`.
    pub fn login_result(&mut self, ip: IpAddr, ok: bool, now: Instant) {
        if ip.is_loopback() {
            return;
        }
        let e = self.map.entry(ip).or_default();
        e.last_seen = Some(now);
        if ok {
            e.fails = 0;
            e.fail_start = None;
            return;
        }
        match e.fail_start {
            Some(start) if now.duration_since(start) < FAIL_WINDOW => e.fails += 1,
            _ => {
                e.fail_start = Some(now);
                e.fails = 1;
            }
        }
        if e.fails >= MAX_LOGIN_FAILS {
            e.blocked_until = Some(now + BLOCK_TIME);
            e.fails = 0;
            e.fail_start = None;
        }
    }

    fn prune(&mut self, now: Instant) {
        self.map.retain(|_, e| {
            e.blocked_until.map_or(false, |u| u > now)
                || e.last_seen.map_or(false, |s| now.duration_since(s) < Duration::from_secs(3600))
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn solo_red_local() {
        for ok in ["127.0.0.1", "10.0.0.5", "172.16.3.4", "172.31.255.1", "192.168.1.20", "169.254.1.1", "::1", "fd12:3456::1", "fe80::1", "::ffff:192.168.1.5"] {
            assert!(is_private(ip(ok)), "{ok} debería aceptarse");
        }
        for no in ["8.8.8.8", "172.32.0.1", "172.15.0.1", "200.44.1.1", "2800:370::1", "::ffff:8.8.8.8"] {
            assert!(!is_private(ip(no)), "{no} debería rechazarse");
        }
    }

    #[test]
    fn origenes() {
        assert!(origin_allowed("tauri://localhost", Some("127.0.0.1:8787")));
        assert!(origin_allowed("http://tauri.localhost", None));
        assert!(origin_allowed("http://127.0.0.1:1420", None));
        assert!(origin_allowed("http://192.168.1.20:8787", Some("192.168.1.20:8787")));
        assert!(origin_allowed("http://192.168.1.20:8787/", Some("192.168.1.20:8787")));
        assert!(!origin_allowed("http://malo.example", Some("192.168.1.20:8787")));
        assert!(!origin_allowed("http://192.168.1.99:8787", Some("192.168.1.20:8787")));
        assert!(origin_allowed("https://192.168.1.20:8787", Some("192.168.1.20:8787")));
        assert!(!origin_allowed("https://192.168.1.99:8787", Some("192.168.1.20:8787")));
        assert!(!origin_allowed("http://192.168.1.20:8787", None));
        assert!(!origin_allowed("null", Some("192.168.1.20:8787")));
    }

    #[test]
    fn host_solo_ip_o_localhost() {
        for ok in ["192.168.1.20:8787", "127.0.0.1:8788", "localhost:8787", "LOCALHOST", "[::1]:8787", "10.0.0.5"] {
            assert!(host_ok(Some(ok)), "{ok}");
        }
        for no in ["evil.com", "evil.com:8787", "192.168.1.20.evil.com:8787", "tekkadon.local:8787", "", "[::1", "1.2.3.4:abc"] {
            assert!(!host_ok(Some(no)), "{no}");
        }
        assert!(host_ok(None));
        // Con rebinding el Origin coincide con el Host, pero el Host no es una IP.
        assert!(!origin_allowed("http://evil.com:8787", Some("evil.com:8787")));
    }

    #[test]
    fn bloqueo_por_intentos_fallidos() {
        let mut l = Limiter::new();
        let a = ip("192.168.1.50");
        let t0 = Instant::now();
        for i in 0..(MAX_LOGIN_FAILS - 1) {
            assert!(l.check(a, t0, true).is_ok());
            l.login_result(a, false, t0 + Duration::from_secs(i as u64));
        }
        // Aún no está bloqueado.
        assert!(l.check(a, t0, true).is_ok());
        l.login_result(a, false, t0 + Duration::from_secs(5));
        // Ahora sí: el inicio de sesión se rechaza, el resto de solicitudes pasa.
        assert!(matches!(l.check(a, t0 + Duration::from_secs(6), true), Err(Denied::Blocked(m)) if m >= 14));
        assert!(l.check(a, t0 + Duration::from_secs(6), false).is_ok());
        // Otro equipo no se ve afectado.
        assert!(l.check(ip("192.168.1.51"), t0, true).is_ok());
        // Pasado el tiempo, vuelve a permitirse.
        assert!(l.check(a, t0 + BLOCK_TIME + Duration::from_secs(10), true).is_ok());
    }

    #[test]
    fn un_acierto_reinicia_la_cuenta() {
        let mut l = Limiter::new();
        let a = ip("10.1.1.1");
        let t0 = Instant::now();
        for _ in 0..(MAX_LOGIN_FAILS - 1) {
            l.login_result(a, false, t0);
        }
        l.login_result(a, true, t0);
        for _ in 0..(MAX_LOGIN_FAILS - 1) {
            l.login_result(a, false, t0);
        }
        assert!(l.check(a, t0, true).is_ok());
    }

    #[test]
    fn los_fallos_viejos_no_cuentan() {
        let mut l = Limiter::new();
        let a = ip("10.1.1.2");
        let t0 = Instant::now();
        for _ in 0..(MAX_LOGIN_FAILS - 1) {
            l.login_result(a, false, t0);
        }
        l.login_result(a, false, t0 + FAIL_WINDOW + Duration::from_secs(1));
        assert!(l.check(a, t0 + FAIL_WINDOW + Duration::from_secs(2), true).is_ok());
    }

    #[test]
    fn limite_por_minuto() {
        let mut l = Limiter::new();
        let a = ip("192.168.0.9");
        let t0 = Instant::now();
        for _ in 0..MAX_REQ_PER_MIN {
            assert!(l.check(a, t0, false).is_ok());
        }
        assert_eq!(l.check(a, t0, false), Err(Denied::TooMany));
        // Un minuto después se reinicia.
        assert!(l.check(a, t0 + Duration::from_secs(61), false).is_ok());
    }

    #[test]
    fn el_propio_equipo_no_se_limita() {
        let mut l = Limiter::new();
        let a = ip("127.0.0.1");
        let t0 = Instant::now();
        for _ in 0..(MAX_REQ_PER_MIN * 3) {
            assert!(l.check(a, t0, true).is_ok());
            l.login_result(a, false, t0);
        }
        assert!(l.check(a, t0, true).is_ok());
    }
}
