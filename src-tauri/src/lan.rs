//! Modo red: un servidor HTTP dentro del programa para que varios puestos usen el sistema a la vez.
//!
//! - El equipo principal guarda la base de datos y atiende a los demás puestos, que entran desde
//!   el navegador (la interfaz se sirve desde el propio programa).
//! - Cada puesto tiene su propia sesión (un token ligado a la dirección del equipo). Las operaciones se
//!   ejecutan de una en una, así que dos puestos nunca pisan el mismo dato (por ejemplo, el mismo stock).
//! - Si el modo es "single" (por defecto) no se abre ningún puerto y el programa funciona igual que siempre.
//! - Defensas (ver lan_guard.rs): solo red local, orígenes permitidos, límite de solicitudes por equipo,
//!   bloqueo por intentos fallidos de inicio de sesión, número fijo de hilos y tamaño máximo de solicitud.

use crate::{
    error::AppError,
    lan_dispatch, lan_guard,
    lan_guard::{Denied, Limiter},
    state::{ActiveSession, AppState, SESSION_TIMEOUT},
    tls,
};
use argon2::password_hash::rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Cursor, Empty, Read},
    net::{IpAddr, SocketAddr, UdpSocket},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard, OnceLock,
    },
    thread,
    time::Instant,
};
use tauri::{AppHandle, Manager};
use tiny_http::{Header, Method, Request, Response, Server, SslConfig};

pub const DEFAULT_PORT: u16 = 8787;
pub const MODE_SINGLE: &str = "single";
pub const MODE_SERVER: &str = "server";

/// Tamaño máximo de una solicitud (las importaciones de archivos grandes viajan como texto).
const MAX_BODY: u64 = 32 * 1024 * 1024;
/// Hilos que atienden solicitudes a la vez. Más conexiones esperan su turno (no se crean hilos sin límite).
const WORKERS: usize = 8;
const LOCAL_WORKERS: usize = 4;

/// Acciones que solo se aceptan desde el propio equipo principal.
const LOCAL_ONLY: &[&str] = &[
    "complete_setup",
    "recover_admin",
    "backup_restore",
    "backup_set_extra_dir",
    "key_recovery_show",
    "key_confirm_saved",
    "lan_settings_save",
];
/// Comandos que guardan un archivo en la carpeta Descargas del equipo principal.
/// Para un puesto remoto el archivo se devuelve para que lo descargue su navegador.
const DOWNLOAD_CMDS: &[&str] = &["write_export", "import_template", "export_products", "import_error_report"];
/// Comandos que abren una sesión nueva.
const NEW_SESSION_CMDS: &[&str] = &["login", "complete_setup"];

// ───────────────────────── Configuración ─────────────────────────

#[derive(Serialize, Deserialize, Clone, PartialEq)]
pub struct LanConfig {
    pub mode: String,
    pub port: u16,
    /// Dirección en la que escucha. Vacío = todas las interfaces de este equipo.
    #[serde(default)]
    pub bind: String,
    /// Conexión cifrada (HTTPS) con certificado propio. Recomendado.
    #[serde(default = "yes")]
    pub https: bool,
}

fn yes() -> bool {
    true
}

impl Default for LanConfig {
    fn default() -> Self {
        Self { mode: MODE_SINGLE.into(), port: DEFAULT_PORT, bind: String::new(), https: true }
    }
}

fn config_file(dir: &Path) -> PathBuf {
    dir.join("red.json")
}

fn bind_ok(bind: &str) -> bool {
    let b = bind.trim();
    b.is_empty() || b.parse::<IpAddr>().is_ok()
}

fn valid(cfg: &LanConfig) -> bool {
    (cfg.mode == MODE_SINGLE || cfg.mode == MODE_SERVER) && cfg.port >= 1024 && bind_ok(&cfg.bind)
}

/// Lee la configuración guardada; si no existe o es inválida, usa un solo puesto.
pub fn load_config(dir: &Path) -> LanConfig {
    let cfg: Option<LanConfig> = std::fs::read_to_string(config_file(dir))
        .ok()
        .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok());
    match cfg {
        Some(mut c) if valid(&c) => {
            c.bind = c.bind.trim().to_string();
            c
        }
        _ => LanConfig::default(),
    }
}

pub fn save_config(dir: &Path, cfg: &LanConfig) -> Result<(), AppError> {
    if !valid(cfg) {
        return Err(AppError::Validation(
            "Modo, puerto o dirección inválidos (el puerto debe ser 1024 o mayor; la dirección, una IP como 192.168.1.20 o vacía)".into(),
        ));
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| AppError::Internal(e.to_string()))?;
    std::fs::write(config_file(dir), text).map_err(|e| AppError::Internal(e.to_string()))
}

// ───────────────────────── Estado del servidor ─────────────────────────

static ACTIVE: OnceLock<LanConfig> = OnceLock::new();
static RUNNING: AtomicBool = AtomicBool::new(false);
static LOCAL_RUNNING: AtomicBool = AtomicBool::new(false);
/// Turno único: solo una operación a la vez toca la base y la sesión.
static BRIDGE: Mutex<()> = Mutex::new(());

/// Una sesión abierta desde un puesto. Solo vale para solicitudes que llegan desde el mismo equipo.
struct TokenEntry {
    session: ActiveSession,
    ip: IpAddr,
}

fn tokens() -> &'static Mutex<HashMap<String, TokenEntry>> {
    static T: OnceLock<Mutex<HashMap<String, TokenEntry>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

fn limiter() -> &'static Mutex<Limiter> {
    static L: OnceLock<Mutex<Limiter>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(Limiter::new()))
}

/// Cierra todas las sesiones abiertas de un usuario (al desactivarlo, cambiarle la clave o el rol).
pub fn revoke_user(user_id: i64) {
    lock(tokens()).retain(|_, e| e.session.user.id != user_id);
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Configuración con la que arrancó el programa (puede diferir de la guardada hasta reiniciar).
pub fn active() -> LanConfig {
    ACTIVE.get().cloned().unwrap_or_default()
}

pub fn running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

pub fn local_running() -> bool {
    LOCAL_RUNNING.load(Ordering::SeqCst)
}

/// Puerto de la entrada local: solo acepta conexiones del propio equipo, sin cifrar (nunca sale por la red).
/// La ventana del programa usa esta entrada para no depender de ningún certificado.
pub fn local_port(port: u16) -> u16 {
    if port < u16::MAX {
        port + 1
    } else {
        port - 1
    }
}

pub fn info() -> Value {
    let c = active();
    json!({
        "mode": c.mode, "port": c.port, "bind": c.bind, "https": c.https,
        "running": running(), "localPort": local_port(c.port), "localRunning": local_running(),
    })
}

/// Dirección del equipo en la red local (sin enviar nada: solo se elige la interfaz de salida).
pub fn lan_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        None
    } else {
        Some(ip.to_string())
    }
}

fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ───────────────────────── Arranque ─────────────────────────

pub fn start(app: &AppHandle, cfg: &LanConfig) {
    let _ = ACTIVE.set(cfg.clone());
    if cfg.mode != MODE_SERVER {
        return;
    }
    let dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Modo red: no se pudo ubicar la carpeta de datos: {e}");
            return;
        }
    };

    // Entrada local (HTTP, solo 127.0.0.1): la usa la ventana del propio programa.
    let lport = local_port(cfg.port);
    match Server::http(SocketAddr::from(([127, 0, 0, 1], lport))) {
        Ok(s) => {
            LOCAL_RUNNING.store(true, Ordering::SeqCst);
            spawn_workers(Arc::new(s), LOCAL_WORKERS, app);
        }
        Err(e) => eprintln!("Modo red: no se pudo abrir la entrada local en el puerto {lport}: {e}"),
    }

    // Entrada para los demás puestos.
    let ip: IpAddr = if cfg.bind.trim().is_empty() {
        IpAddr::from([0, 0, 0, 0])
    } else {
        match cfg.bind.trim().parse() {
            Ok(ip) => ip,
            Err(_) => {
                eprintln!("Modo red: la dirección «{}» no es válida", cfg.bind);
                return;
            }
        }
    };
    let addr = SocketAddr::new(ip, cfg.port);
    let opened = if cfg.https {
        // Direcciones que debe cubrir el certificado: este equipo, su dirección en la red y la de escucha.
        let mut ips: Vec<IpAddr> = vec![IpAddr::from([127, 0, 0, 1])];
        if let Some(lan) = lan_ip().and_then(|s| s.parse::<IpAddr>().ok()) {
            ips.push(lan);
        }
        if !ip.is_unspecified() && !ips.contains(&ip) {
            ips.push(ip);
        }
        match tls::ensure(&dir, &ips) {
            Ok(m) => Server::https(addr, SslConfig { certificate: m.cert_pem, private_key: m.key_pem }),
            Err(e) => {
                eprintln!("Modo red: no se pudo preparar el certificado: {e}");
                return;
            }
        }
    } else {
        Server::http(addr)
    };
    let server = match opened {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("No se pudo abrir el modo red en {addr}: {e}");
            return;
        }
    };
    RUNNING.store(true, Ordering::SeqCst);
    spawn_workers(server, WORKERS, app);
}

/// Número fijo de hilos: una avalancha de conexiones espera su turno en vez de agotar el equipo.
fn spawn_workers(server: Arc<Server>, n: usize, app: &AppHandle) {
    for _ in 0..n {
        let server = Arc::clone(&server);
        let app = app.clone();
        thread::spawn(move || loop {
            match server.recv() {
                Ok(req) => handle(app.clone(), req),
                Err(_) => break,
            }
        });
    }
}

// ───────────────────────── Respuestas HTTP ─────────────────────────

fn header(name: &str, value: &str) -> Option<Header> {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).ok()
}

/// Encabezados de seguridad en todas las respuestas y, si el origen está permitido, los de CORS.
fn decorate<R: Read>(resp: &mut Response<R>, origin: Option<&str>) {
    let mut put = |k: &str, v: &str| {
        if let Some(h) = header(k, v) {
            resp.add_header(h);
        }
    };
    put("X-Content-Type-Options", "nosniff");
    put("X-Frame-Options", "DENY");
    put("Referrer-Policy", "no-referrer");
    if let Some(o) = origin {
        put("Access-Control-Allow-Origin", o);
        put("Vary", "Origin");
        put("Access-Control-Allow-Headers", "content-type, authorization");
        put("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
        put("Access-Control-Allow-Private-Network", "true");
    }
}

fn json_response(body: &Value, origin: Option<&str>) -> Response<Cursor<Vec<u8>>> {
    let mut r = Response::from_string(body.to_string()).with_status_code(200);
    if let Some(h) = header("Content-Type", "application/json; charset=utf-8") {
        r.add_header(h);
    }
    if let Some(h) = header("Cache-Control", "no-store") {
        r.add_header(h);
    }
    decorate(&mut r, origin);
    r
}

fn preflight(origin: Option<&str>) -> Response<Empty> {
    let mut r = Response::empty(204);
    if let Some(h) = header("Access-Control-Max-Age", "600") {
        r.add_header(h);
    }
    decorate(&mut r, origin);
    r
}

fn text_response(status: u16, text: &str) -> Response<Cursor<Vec<u8>>> {
    let mut r = Response::from_string(text.to_string()).with_status_code(status);
    if let Some(h) = header("Content-Type", "text/plain; charset=utf-8") {
        r.add_header(h);
    }
    decorate(&mut r, None);
    r
}

fn fail(msg: &str) -> Value {
    json!({ "ok": false, "error": msg })
}

fn header_value(req: &Request, name: &'static str) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str().to_string())
}

fn bearer(req: &Request) -> Option<String> {
    header_value(req, "Authorization")
        .and_then(|v| v.strip_prefix("Bearer ").map(|s| s.trim().to_string()))
}

fn read_body(req: &mut Request) -> Result<Vec<u8>, ()> {
    let mut buf = Vec::new();
    req.as_reader().take(MAX_BODY + 1).read_to_end(&mut buf).map_err(|_| ())?;
    if buf.len() as u64 > MAX_BODY {
        return Err(());
    }
    Ok(buf)
}

// ───────────────────────── Atención de solicitudes ─────────────────────────

fn handle(app: AppHandle, mut req: Request) {
    // 1) Solo equipos de la red local.
    let peer = match req.remote_addr().map(|a| a.ip()) {
        Some(ip) if lan_guard::is_private(ip) => ip,
        _ => {
            let _ = req.respond(text_response(403, "Acceso permitido solo desde la red local"));
            return;
        }
    };
    let local = peer.is_loopback();
    let path = req.url().split('?').next().unwrap_or("/").to_string();
    let is_options = matches!(req.method(), Method::Options);
    let is_post = matches!(req.method(), Method::Post);
    let is_get = matches!(req.method(), Method::Get | Method::Head);

    // 2) Orígenes: una página ajena abierta en un navegador no puede usar la API.
    let host = header_value(&req, "Host");
    if !lan_guard::host_ok(host.as_deref()) {
        let _ = req.respond(text_response(403, "Host no permitido"));
        return;
    }
    let origin = header_value(&req, "Origin");
    let allow_origin: Option<String> = origin
        .as_deref()
        .filter(|o| lan_guard::origin_allowed(o, host.as_deref()))
        .map(|o| o.to_string());
    let origin_rejected = origin.is_some() && allow_origin.is_none();

    if is_options {
        if origin_rejected {
            let _ = req.respond(text_response(403, "Origen no permitido"));
        } else {
            let _ = req.respond(preflight(allow_origin.as_deref()));
        }
        return;
    }

    if is_post && path.starts_with("/api/") {
        if origin_rejected {
            let _ = req.respond(text_response(403, "Origen no permitido"));
            return;
        }
        let cmd = path["/api/".len()..].to_string();
        let too_big = req.body_length().map_or(false, |l| l as u64 > MAX_BODY);
        let out = if too_big {
            fail("La solicitud es demasiado grande")
        } else {
            match read_body(&mut req) {
                Err(_) => fail("La solicitud es demasiado grande"),
                Ok(body) => {
                    let args: Result<Value, _> = if body.is_empty() {
                        Ok(json!({}))
                    } else {
                        serde_json::from_slice::<Value>(&body)
                    };
                    match args {
                        Ok(Value::Object(map)) => run(&app, &cmd, Value::Object(map), bearer(&req), peer, local),
                        Ok(Value::Null) => run(&app, &cmd, json!({}), bearer(&req), peer, local),
                        _ => fail("Solicitud inválida"),
                    }
                }
            }
        };
        let _ = req.respond(json_response(&out, allow_origin.as_deref()));
        return;
    }

    if is_get {
        serve_asset(&app, req, &path);
        return;
    }
    let _ = req.respond(text_response(405, "Método no permitido"));
}

/// Ejecuta un comando con la sesión del token recibido y devuelve el sobre JSON de respuesta.
fn run(app: &AppHandle, cmd: &str, args: Value, token: Option<String>, peer: IpAddr, local: bool) -> Value {
    // Límite de solicitudes y bloqueo de inicios de sesión por equipo de origen.
    let verdict = lock(limiter()).check(peer, Instant::now(), cmd == "login");
    match verdict {
        Err(Denied::Blocked(min)) => {
            return fail(&format!(
                "Demasiados intentos fallidos desde este equipo. Intenta de nuevo en {min} min."
            ));
        }
        Err(Denied::TooMany) => return fail("Demasiadas solicitudes seguidas. Espera un momento e intenta de nuevo."),
        Ok(()) => {}
    }

    if LOCAL_ONLY.contains(&cmd) && !local {
        return fail("Esta acción solo se puede hacer en el equipo principal");
    }
    let state = app.state::<AppState>();
    let _turn = lock(&BRIDGE);

    // Se carga la sesión de este puesto (vacía si no hay token válido o si llega desde otro equipo).
    let (current, mismatch) = {
        let mut map = lock(tokens());
        map.retain(|_, e| e.session.last_active.elapsed() <= SESSION_TIMEOUT);
        let found = match token.as_ref().and_then(|t| map.get(t)) {
            Some(e) if e.ip == peer => (Some(e.session.clone()), false),
            Some(_) => (None, true),
            None => (None, false),
        };
        found
    };
    state.put_session(current);
    let result = tauri::async_runtime::block_on(lan_dispatch::dispatch(app, cmd, &args));
    // Se retira del estado compartido: nada de esta sesión queda para el siguiente puesto.
    let after = state.take_session();

    if cmd == "login" {
        lock(limiter()).login_result(peer, result.is_ok(), Instant::now());
    }

    let mut new_token: Option<String> = None;
    {
        let mut map = lock(tokens());
        if result.is_ok() && NEW_SESSION_CMDS.contains(&cmd) && after.is_some() {
            if let Some(old) = &token {
                if !mismatch {
                    map.remove(old);
                }
            }
            let t = generate_token();
            if let Some(s) = after {
                map.insert(t.clone(), TokenEntry { session: s, ip: peer });
            }
            new_token = Some(t);
        } else if let Some(t) = &token {
            // Si el token pertenece a otro equipo, no se toca (no se puede cerrar la sesión ajena).
            if !mismatch {
                match after {
                    Some(s) => {
                        map.insert(t.clone(), TokenEntry { session: s, ip: peer });
                    }
                    None => {
                        map.remove(t);
                    }
                }
            }
        }
        // Al restaurar un respaldo, todas las sesiones quedan cerradas.
        if cmd == "backup_restore" && result.is_ok() {
            map.clear();
        }
    }

    match result {
        Ok(data) => {
            let mut env = json!({ "ok": true, "data": data });
            if let Some(t) = new_token {
                env["token"] = json!(t);
            }
            if DOWNLOAD_CMDS.contains(&cmd) && !local {
                if let Some(dl) = take_download(&env["data"]) {
                    env["download"] = dl;
                }
            }
            env
        }
        Err(e) => fail(&e.to_string()),
    }
}

/// El comando dejó un archivo en Descargas del equipo principal: se entrega al navegador remoto
/// y se borra de ahí.
fn take_download(data: &Value) -> Option<Value> {
    let path = data.as_str()?;
    let bytes = std::fs::read(path).ok()?;
    let name = Path::new(path).file_name()?.to_string_lossy().to_string();
    let _ = std::fs::remove_file(path);
    Some(json!({ "filename": name, "content": String::from_utf8_lossy(&bytes).to_string() }))
}

/// Entrega la interfaz (los archivos incluidos en el programa) a los navegadores de otros puestos.
fn serve_asset(app: &AppHandle, req: Request, path: &str) {
    let p = path.trim_start_matches('/');
    let resolver = app.asset_resolver();
    let mut candidates: Vec<String> = Vec::new();
    if p.is_empty() {
        candidates.push("index.html".to_string());
    } else {
        candidates.push(p.to_string());
        candidates.push(format!("{}/index.html", p.trim_end_matches('/')));
    }
    let mut found = None;
    for c in candidates {
        if let Some(a) = resolver.get(c) {
            found = Some(a);
            break;
        }
    }
    // Ruta sin extensión: la interfaz es de una sola página.
    if found.is_none() && !p.contains('.') {
        found = resolver.get("index.html".to_string());
    }
    match found {
        Some(a) => {
            let mut resp = Response::from_data(a.bytes);
            if let Some(h) = header("Content-Type", &a.mime_type) {
                resp.add_header(h);
            }
            if let Some(h) = header("Cache-Control", "no-cache") {
                resp.add_header(h);
            }
            decorate(&mut resp, None);
            let _ = req.respond(resp);
        }
        None => {
            let _ = req.respond(text_response(
                404,
                "Tekkadon: no se encontró la interfaz. En el programa instalado esta dirección abre el sistema; \
                 en modo de desarrollo (tauri dev) no se incluye.",
            ));
        }
    }
}
