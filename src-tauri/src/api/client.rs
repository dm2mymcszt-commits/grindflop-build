use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::Instant;

use tauri::Emitter;
use wreq::Client;

use tokio::sync::{Mutex, RwLock};

use crate::error::{AppError, BanInfo};

use super::auth::{
    restriction_from_token, AccountStatus, AuthStorage, Session, ACCOUNT_STATUS_EVENT,
};
use super::headers::{build_grindr_client, build_headers, DeviceInfo};

pub const BASE_URL: &str = "https://grindr.mobi";

pub struct GrindrClient {
    pub(super) http: Client,
    pub(super) session: RwLock<Option<Session>>,
    pub(super) user_agent: String,
    pub(super) device: RwLock<DeviceInfo>,
    pub(super) refresh_lock: Mutex<()>,
    /// What Grindr last said about the standing of the account signed in.
    account_status: StdMutex<Option<AccountStatus>>,
    /// The window to tell when that changes. Set once the app is up.
    events: OnceLock<tauri::AppHandle>,
    /// The last renewal Grindr refused with a ban code, and when.
    pub(super) refused_refresh: StdMutex<Option<(Instant, BanInfo)>>,
}

impl GrindrClient {
    /// Gives the client the window that account status changes are announced to.
    pub fn attach_events(&self, app: tauri::AppHandle) {
        let _ = self.events.set(app);
    }

    pub fn account_status(&self) -> Option<AccountStatus> {
        self.account_status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Records what Grindr said about the account signed in, and tells the
    /// window when that is news.
    pub(super) fn set_account_status(&self, status: Option<AccountStatus>) {
        {
            let mut current = self
                .account_status
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if *current == status {
                return;
            }
            *current = status.clone();
        }

        if let Some(app) = self.events.get() {
            let _ = app.emit(ACCOUNT_STATUS_EVENT, &status);
        }
    }

    pub(crate) async fn authenticated_profile_id(&self) -> Option<String> {
        self.session
            .read()
            .await
            .as_ref()
            .map(|session| session.profile_id.clone())
    }

    pub fn user_agent(&self) -> &str {
        &self.user_agent
    }

    pub fn cookie_header_for_base_url(&self) -> Option<String> {
        // wreq doesn't track cookies as it's a fingerprinting client
        // WebSocket connections use token in URL + Authorization header instead
        None
    }
}

impl GrindrClient {
    pub fn new() -> Result<Self, AppError> {
        let mut device = DeviceInfo::default();

        let session = match AuthStorage::get_session() {
            Ok(Some(session)) => {
                #[cfg(debug_assertions)]
                eprintln!(
                    "[HTTP-CLIENT] Restored session for profile_id={}",
                    session.profile_id
                );
                // Restore device IDs from the session
                device.device_id = session.device_id.clone();
                device.advertising_id = session.advertising_id.clone();
                Some(session)
            }
            Ok(None) => {
                #[cfg(debug_assertions)]
                eprintln!("[HTTP-CLIENT] No stored session found; starting unauthenticated.");
                None
            }
            Err(_error) => {
                #[cfg(debug_assertions)]
                eprintln!(
                    "[HTTP-CLIENT] Failed to restore persisted session (continuing unauthenticated): {}",
                    _error
                );
                None
            }
        };

        let headers = build_headers(&device, "Free", None);
        let user_agent = headers
            .iter()
            .find(|(name, _)| name.as_str() == "user-agent")
            .and_then(|(_, value)| value.to_str().ok())
            .unwrap_or("")
            .to_owned();

        let http = build_grindr_client()
            .map_err(|e| AppError::Http(format!("Failed to build wreq client: {}", e)))?;

        #[cfg(debug_assertions)]
        eprintln!(
            "[HTTP-CLIENT] Initializing GrindrClient on os={}",
            std::env::consts::OS
        );

        // The token of the session that was restored may already say the
        // account is held back; the window asks for this when it starts.
        let account_status = session
            .as_ref()
            .and_then(|session| restriction_from_token(&session.session_id))
            .map(|restriction| AccountStatus::Restriction { restriction });

        Ok(Self {
            http,
            session: RwLock::new(session),
            user_agent,
            device: RwLock::new(device),
            refresh_lock: Mutex::new(()),
            account_status: StdMutex::new(account_status),
            events: OnceLock::new(),
            refused_refresh: StdMutex::new(None),
        })
    }
}
