use crate::error::AppError;
use rusqlite::Connection;
use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Tiempo máximo sin actividad antes de cerrar la sesión.
pub const SESSION_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUser {
    pub id: i64,
    pub username: String,
    pub full_name: String,
    pub role: String,
    pub must_change_password: bool,
}

#[derive(Clone)]
pub struct ActiveSession {
    pub user: SessionUser,
    pub last_active: Instant,
}

pub struct AppState {
    db: Mutex<Connection>,
    session: Mutex<Option<ActiveSession>>,
}

impl AppState {
    pub fn new(conn: Connection) -> Self {
        Self { db: Mutex::new(conn), session: Mutex::new(None) }
    }

    pub fn conn(&self) -> Result<MutexGuard<'_, Connection>, AppError> {
        // Si un hilo falló con el bloqueo tomado, se recupera: SQLite ya revirtió la transacción incompleta.
        Ok(self.db.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn active(&self, touch: bool) -> Option<SessionUser> {
        let mut guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        let expired = guard.as_ref()?.last_active.elapsed() > SESSION_TIMEOUT;
        if expired {
            *guard = None;
            return None;
        }
        let s = guard.as_mut()?;
        if touch {
            s.last_active = Instant::now();
        }
        Some(s.user.clone())
    }

    /// Devuelve el usuario y renueva el tiempo de actividad (comandos protegidos).
    pub fn session(&self) -> Option<SessionUser> {
        self.active(true)
    }

    /// Consulta la sesión SIN renovarla (sondeo del frontend).
    pub fn peek(&self) -> Option<SessionUser> {
        self.active(false)
    }

    pub fn set_session(&self, user: Option<SessionUser>) {
        let mut s = self.session.lock().unwrap_or_else(|e| e.into_inner());
        *s = user.map(|user| ActiveSession { user, last_active: Instant::now() });
    }

    /// Modo red: retira la sesión actual del estado (lo deja sin sesión).
    pub fn take_session(&self) -> Option<ActiveSession> {
        self.session.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    /// Modo red: coloca la sesión del puesto que está siendo atendido.
    pub fn put_session(&self, s: Option<ActiveSession>) {
        *self.session.lock().unwrap_or_else(|e| e.into_inner()) = s;
    }

    /// Se llama cuando el usuario ya cambió su contraseña temporal.
    pub fn clear_must_change(&self) {
        let mut g = self.session.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = g.as_mut() {
            s.user.must_change_password = false;
        }
    }
}