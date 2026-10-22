#[cfg(not(any(target_os = "windows", all(target_os = "macos", debug_assertions))))]
use keyring_core::Entry;
use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::path::PathBuf;
use std::time::{Duration, Instant};
use wreq::Method;

use crate::error::{AppError, BanInfo};
use crate::state::AppState;

use super::client::GrindrClient;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Session {
    pub email: String,
    pub expires_at: u64,
    pub profile_id: String,
    pub session_id: String,
    pub auth_token: String,
    pub device_id: String,
    pub advertising_id: String,
    /// Left over from a Google / Apple / Facebook sign-in that was built and
    /// then removed unused. Nothing sets it any more. Sessions are stored as
    /// msgpack arrays, so the slot has to stay, last and defaulted, for every
    /// session already saved to keep decoding.
    #[serde(default)]
    pub third_party_user_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    pub profile_id: String,
    pub session_id: String,
    pub auth_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
    pub token: Option<String>,
    pub geohash: Option<String>,
}

trait AuthRequest: Serialize {
    fn email(&self) -> &str;
}

impl AuthRequest for LoginRequest {
    fn email(&self) -> &str {
        &self.email
    }
}

impl AuthRequest for RefreshRequest {
    fn email(&self) -> &str {
        &self.email
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshRequest {
    pub email: String,
    pub auth_token: String,
    pub token: Option<String>,
    pub geohash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub profile_id: String,
    /// What the new session's token says is holding the account back, if anything.
    pub restriction: Option<Restriction>,
}

/// A limit Grindr has put on an account that it still lets sign in. It comes
/// inside the session token, not as a failed request.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restriction {
    /// "ageVerification", "timedBan", "trustVendorRejected" or "other".
    pub kind: &'static str,
    /// Grindr's own name for it, as the token has it.
    pub code: String,
    /// Where an age check applies: "uk", "br", "au", "us" or "other".
    pub region: Option<&'static str>,
    pub reason: Option<String>,
    /// When a timed ban ends, in Unix seconds, when Grindr says.
    pub expires_at: Option<i64>,
    pub sub_reason: Option<String>,
    pub automated: Option<bool>,
}

/// What Grindr last said about the standing of the account that is signed
/// in. The window gives it a screen of its own; nothing to report is `None`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AccountStatus {
    /// The renewal of the session was refused with one of the ban codes.
    Banned { info: BanInfo },
    Restriction { restriction: Restriction },
    /// A token sign-in whose token has run out, with nothing to renew it with.
    SessionExpired,
}

/// The window hears on this event whenever the account status changes.
pub const ACCOUNT_STATUS_EVENT: &str = "auth:account-status";

/// How long a renewal that Grindr refused with a ban code is left alone
/// before it is asked for again.
const REFUSED_REFRESH_PAUSE: Duration = Duration::from_secs(30);

fn refusal_is_recent(refused_at: Instant, now: Instant) -> bool {
    now.saturating_duration_since(refused_at) < REFUSED_REFRESH_PAUSE
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PushTokenRequest {
    vendor_provided_identifier: String,
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JwtClaims {
    exp: u64,
    profile_id: String,
}

impl LoginRequest {
    pub fn new(email: String, password: String) -> Self {
        Self {
            email,
            password,
            token: None,
            geohash: None,
        }
    }
}

impl RefreshRequest {
    pub fn new(email: String, auth_token: String) -> Self {
        Self {
            email,
            auth_token,
            token: None,
            geohash: None,
        }
    }
}

fn decode_session_jwt(token: &str) -> Result<JwtClaims, AppError> {
    let data = jsonwebtoken::dangerous::insecure_decode::<JwtClaims>(token)
        .map_err(|e| AppError::Auth(format!("JWT decode failed: {e}")))?;

    Ok(data.claims)
}

/// A value from a response body or a token as text: a string as it is, a
/// number or a boolean written out, anything else left out.
fn scalar_text(value: Option<&serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::String(text) => {
            let text = text.trim();
            (!text.is_empty()).then(|| text.to_owned())
        }
        serde_json::Value::Number(number) => Some(number.to_string()),
        serde_json::Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// A whole number, however it was written down.
fn whole_number(value: &serde_json::Value) -> Option<i64> {
    match value {
        serde_json::Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|float| float as i64)),
        serde_json::Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

/// Reads one of Grindr's ban codes out of the body of a refused sign-in or
/// renewal: 27 for the profile, 28 for the device, 31 for the network, 35
/// and 36 for an account it holds to be under age.
///
/// 28 is often no ban at all. Grindr answers with it when it does not trust
/// the request itself, whatever the standing of the account, so the app must
/// not present it as one.
pub(super) fn ban_from_error_body(body: &serde_json::Value) -> Option<BanInfo> {
    let code = body.get("code")?.as_i64()?;
    let kind = match code {
        27 => "profile",
        28 => "device",
        31 => "network",
        35 | 36 => "underage",
        _ => return None,
    };

    Some(BanInfo {
        kind,
        code: code as i32,
        message: scalar_text(body.get("message")).unwrap_or_default(),
        reason: scalar_text(body.get("reason")),
        sub_reason: scalar_text(body.get("banSubReason")),
        automated: body.get("isBanAutomated").and_then(|flag| flag.as_bool()),
    })
}

/// What a session token says is holding the account back, if anything.
///
/// Read apart from the claims that signing in depends on, and leniently.
/// These fields only decide what the app tells the user, so one that comes
/// in a shape nobody expected is skipped and never stands in the way of a
/// session.
pub(super) fn restriction_from_token(token: &str) -> Option<Restriction> {
    let claims = jsonwebtoken::dangerous::insecure_decode::<serde_json::Value>(token)
        .ok()?
        .claims;
    restriction_from_claims(&claims)
}

fn restriction_from_claims(claims: &serde_json::Value) -> Option<Restriction> {
    let code = claims.get("restriction")?.as_str()?.trim();
    if code.is_empty() {
        return None;
    }

    let mut restriction = Restriction {
        kind: "other",
        code: code.to_owned(),
        region: None,
        reason: scalar_text(claims.get("restrictionReason")),
        expires_at: None,
        sub_reason: None,
        automated: None,
    };

    match code {
        "AGE_RESTRICTED" => {
            restriction.kind = "ageVerification";
            restriction.region = Some(match restriction.reason.as_deref() {
                Some("UK_VERIFICATION_REQUIRED") => "uk",
                Some("BR_VERIFICATION_REQUIRED") => "br",
                Some("AU_VERIFICATION_REQUIRED") => "au",
                Some("US_VERIFICATION_REQUIRED") => "us",
                _ => "other",
            });
        }
        "TIMED_BAN" => {
            restriction.kind = "timedBan";
            let details = claims.get("banDetails");
            let detail = |key: &str| details.and_then(|details| details.get(key));
            if let Some(reason) = scalar_text(detail("reason")) {
                restriction.reason = Some(reason);
            }
            restriction.expires_at = detail("expiryTime").and_then(whole_number);
            restriction.sub_reason = scalar_text(detail("subReason"));
            restriction.automated = detail("isAutomated").and_then(|flag| flag.as_bool());
        }
        "TRUST_VENDOR_REJECTED" => restriction.kind = "trustVendorRejected",
        _ => {}
    }

    Some(restriction)
}

pub struct AuthStorage;

impl AuthStorage {
    #[cfg(target_os = "windows")]
    fn windows_session_file_path() -> Result<PathBuf, AppError> {
        Ok(crate::windows_instance::WindowsInstance::current().session_file_path())
    }

    #[cfg(target_os = "windows")]
    pub fn get_session() -> Result<Option<Session>, AppError> {
        let path = Self::windows_session_file_path()?;

        let session_bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(AppError::Auth(format!(
                    "Failed to read Windows session from {}: {}",
                    path.display(),
                    error
                )))
            }
        };

        rmp_serde::decode::from_slice(&session_bytes)
            .map_err(|e| AppError::Auth(e.to_string()))
            .map(Some)
    }

    #[cfg(target_os = "windows")]
    pub fn set_session(session: &Session) -> Result<(), AppError> {
        let path = Self::windows_session_file_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppError::Auth(format!(
                    "Failed to create Windows session directory {}: {}",
                    parent.display(),
                    error
                ))
            })?;
        }

        let session_bytes = rmp_serde::encode::to_vec(session).unwrap();
        std::fs::write(&path, session_bytes).map_err(|error| {
            AppError::Auth(format!(
                "Failed to write Windows session {}: {}",
                path.display(),
                error
            ))
        })
    }

    #[cfg(target_os = "windows")]
    pub fn clear_session() -> Result<(), AppError> {
        let path = Self::windows_session_file_path()?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(AppError::Auth(format!(
                "Failed to clear Windows session {}: {}",
                path.display(),
                error
            ))),
        }
    }

    #[cfg(all(target_os = "macos", debug_assertions))]
    fn dev_session_file_path() -> Result<PathBuf, AppError> {
        let home = std::env::var("HOME").map_err(|_| {
            AppError::Auth("HOME is not set; cannot resolve session path".to_owned())
        })?;

        Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("free-grind")
            .join("dev-session.msgpack"))
    }

    #[cfg(all(target_os = "macos", debug_assertions))]
    pub fn get_session() -> Result<Option<Session>, AppError> {
        let path = Self::dev_session_file_path()?;

        let session_bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(AppError::Auth(format!(
                    "Failed to read dev session from {}: {}",
                    path.display(),
                    error
                )))
            }
        };

        rmp_serde::decode::from_slice(&session_bytes)
            .map_err(|e| AppError::Auth(e.to_string()))
            .map(Some)
    }

    #[cfg(all(target_os = "macos", debug_assertions))]
    pub fn set_session(session: &Session) -> Result<(), AppError> {
        let path = Self::dev_session_file_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppError::Auth(format!(
                    "Failed to create session directory {}: {}",
                    parent.display(),
                    error
                ))
            })?;
        }

        let session_bytes = rmp_serde::encode::to_vec(session).unwrap();
        std::fs::write(&path, session_bytes).map_err(|error| {
            AppError::Auth(format!(
                "Failed to write dev session {}: {}",
                path.display(),
                error
            ))
        })
    }

    #[cfg(all(target_os = "macos", debug_assertions))]
    pub fn clear_session() -> Result<(), AppError> {
        let path = Self::dev_session_file_path()?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(AppError::Auth(format!(
                "Failed to clear dev session {}: {}",
                path.display(),
                error
            ))),
        }
    }

    #[cfg(not(any(target_os = "windows", all(target_os = "macos", debug_assertions))))]
    fn get_session_entry() -> Result<Entry, AppError> {
        Entry::new("free-grind", "session").map_err(|e| AppError::Auth(e.to_string()))
    }

    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    fn macos_fallback_session_file_path() -> Result<PathBuf, AppError> {
        let home = std::env::var("HOME").map_err(|_| {
            AppError::Auth("HOME is not set; cannot resolve fallback session path".to_owned())
        })?;

        Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("free-grind")
            .join("session-fallback.msgpack"))
    }

    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    fn read_macos_fallback_session() -> Result<Option<Session>, AppError> {
        let path = Self::macos_fallback_session_file_path()?;
        let session_bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(AppError::Auth(format!(
                    "Failed to read macOS fallback session from {}: {}",
                    path.display(),
                    error
                )))
            }
        };

        rmp_serde::decode::from_slice(&session_bytes)
            .map_err(|e| AppError::Auth(e.to_string()))
            .map(Some)
    }

    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    fn write_macos_fallback_session(session: &Session) -> Result<(), AppError> {
        let path = Self::macos_fallback_session_file_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppError::Auth(format!(
                    "Failed to create fallback session directory {}: {}",
                    parent.display(),
                    error
                ))
            })?;
        }

        let session_bytes = rmp_serde::encode::to_vec(session).unwrap();
        std::fs::write(&path, session_bytes).map_err(|error| {
            AppError::Auth(format!(
                "Failed to write macOS fallback session {}: {}",
                path.display(),
                error
            ))
        })?;

        #[cfg(target_family = "unix")]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }

        Ok(())
    }

    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    fn clear_macos_fallback_session() -> Result<(), AppError> {
        let path = Self::macos_fallback_session_file_path()?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(AppError::Auth(format!(
                "Failed to clear macOS fallback session {}: {}",
                path.display(),
                error
            ))),
        }
    }

    #[cfg(not(any(target_os = "windows", all(target_os = "macos", debug_assertions))))]
    pub fn get_session() -> Result<Option<Session>, AppError> {
        let entry = match Self::get_session_entry() {
            Ok(entry) => entry,
            Err(_error) => {
                #[cfg(target_os = "macos")]
                {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[HTTP-AUTH] Keyring entry creation failed on macOS, trying fallback session file: {}",
                        _error
                    );
                    return Self::read_macos_fallback_session();
                }

                #[cfg(not(target_os = "macos"))]
                {
                    return Err(_error);
                }
            }
        };
        let session_bytes = match entry.get_secret() {
            Ok(bytes) => bytes,
            Err(keyring_core::Error::NoEntry) => {
                #[cfg(target_os = "macos")]
                {
                    return Self::read_macos_fallback_session();
                }

                #[cfg(not(target_os = "macos"))]
                {
                    return Ok(None);
                }
            }
            Err(_e) => {
                #[cfg(target_os = "macos")]
                {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[HTTP-AUTH] Keyring read failed on macOS, trying fallback session file: {}",
                        _e
                    );
                    return Self::read_macos_fallback_session();
                }

                #[cfg(not(target_os = "macos"))]
                {
                    return Err(AppError::Auth(_e.to_string()));
                }
            }
        };
        rmp_serde::decode::from_slice(&session_bytes)
            .map_err(|e| AppError::Auth(e.to_string()))
            .map(Some)
    }

    #[cfg(not(any(target_os = "windows", all(target_os = "macos", debug_assertions))))]
    pub fn set_session(session: &Session) -> Result<(), AppError> {
        let session_bytes = rmp_serde::encode::to_vec(session).unwrap();
        let entry = match Self::get_session_entry() {
            Ok(entry) => entry,
            Err(_error) => {
                #[cfg(target_os = "macos")]
                {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[HTTP-AUTH] Keyring entry creation failed on macOS, writing fallback session file: {}",
                        _error
                    );
                    return Self::write_macos_fallback_session(session);
                }

                #[cfg(not(target_os = "macos"))]
                {
                    return Err(_error);
                }
            }
        };
        match entry.set_secret(&session_bytes) {
            Ok(()) => {
                #[cfg(target_os = "macos")]
                {
                    let _ = Self::clear_macos_fallback_session();
                }
                Ok(())
            }
            Err(_error) => {
                #[cfg(target_os = "macos")]
                {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[HTTP-AUTH] Keyring write failed on macOS, writing fallback session file: {}",
                        _error
                    );
                    return Self::write_macos_fallback_session(session);
                }

                #[cfg(not(target_os = "macos"))]
                {
                    Err(AppError::Auth(_error.to_string()))
                }
            }
        }
    }

    #[cfg(not(any(target_os = "windows", all(target_os = "macos", debug_assertions))))]
    pub fn clear_session() -> Result<(), AppError> {
        let entry = match Self::get_session_entry() {
            Ok(entry) => Some(entry),
            Err(_error) => {
                #[cfg(not(target_os = "macos"))]
                {
                    return Err(_error);
                }

                #[cfg(target_os = "macos")]
                {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[HTTP-AUTH] Keyring entry creation failed on macOS during clear, continuing with fallback clear: {}",
                        _error
                    );
                    None
                }
            }
        };
        if let Some(entry) = entry {
            match entry.delete_credential() {
                Ok(()) | Err(keyring_core::Error::NoEntry) => {}
                Err(_error) => {
                    #[cfg(not(target_os = "macos"))]
                    {
                        return Err(AppError::Auth(_error.to_string()));
                    }

                    #[cfg(target_os = "macos")]
                    {
                        #[cfg(debug_assertions)]
                        eprintln!(
                            "[HTTP-AUTH] Keyring clear failed on macOS, continuing with fallback clear: {}",
                            _error
                        );
                    }
                }
            }
        }

        #[cfg(target_os = "macos")]
        {
            Self::clear_macos_fallback_session()?;
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Multi-account support — saved accounts you can switch between without
// re-entering a password. Built on a generic, slot-keyed version of the
// exact same storage primitive used above for the single active session
// (OS keyring where available, file-based fallback on Windows / macOS
// debug builds), so each account's full Session (including the live
// session_id/auth_token, not just a short-lived JWT) can be restored
// directly. Deliberately does not touch get_session/set_session/
// clear_session above — the existing single "active" slot keeps working
// exactly as before, completely unaffected by any of this.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAccountMeta {
    pub profile_id: String,
    pub email: String,
    pub last_used_at: u64,
}

const ACCOUNT_INDEX_SLOT: &str = "account-index";

fn account_session_slot(profile_id: &str) -> String {
    format!("session-{profile_id}")
}

impl AuthStorage {
    #[cfg(target_os = "windows")]
    fn slot_file_path(slot: &str) -> PathBuf {
        crate::windows_instance::WindowsInstance::current()
            .data_root()
            .join(format!("{slot}.msgpack"))
    }

    #[cfg(target_os = "windows")]
    fn get_slot_bytes(slot: &str) -> Result<Option<Vec<u8>>, AppError> {
        let path = Self::slot_file_path(slot);
        match std::fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(AppError::Auth(format!(
                "Failed to read {} from {}: {}",
                slot,
                path.display(),
                error
            ))),
        }
    }

    #[cfg(target_os = "windows")]
    fn set_slot_bytes(slot: &str, bytes: &[u8]) -> Result<(), AppError> {
        let path = Self::slot_file_path(slot);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppError::Auth(format!(
                    "Failed to create directory {}: {}",
                    parent.display(),
                    error
                ))
            })?;
        }
        std::fs::write(&path, bytes).map_err(|error| {
            AppError::Auth(format!(
                "Failed to write {} to {}: {}",
                slot,
                path.display(),
                error
            ))
        })
    }

    #[cfg(target_os = "windows")]
    fn clear_slot(slot: &str) -> Result<(), AppError> {
        let path = Self::slot_file_path(slot);
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(AppError::Auth(format!(
                "Failed to clear {} at {}: {}",
                slot,
                path.display(),
                error
            ))),
        }
    }

    #[cfg(all(target_os = "macos", debug_assertions))]
    fn slot_file_path(slot: &str) -> Result<PathBuf, AppError> {
        let home = std::env::var("HOME").map_err(|_| {
            AppError::Auth("HOME is not set; cannot resolve slot path".to_owned())
        })?;

        Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("free-grind")
            .join(format!("{slot}.msgpack")))
    }

    #[cfg(all(target_os = "macos", debug_assertions))]
    fn get_slot_bytes(slot: &str) -> Result<Option<Vec<u8>>, AppError> {
        let path = Self::slot_file_path(slot)?;
        match std::fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(AppError::Auth(format!(
                "Failed to read {} from {}: {}",
                slot,
                path.display(),
                error
            ))),
        }
    }

    #[cfg(all(target_os = "macos", debug_assertions))]
    fn set_slot_bytes(slot: &str, bytes: &[u8]) -> Result<(), AppError> {
        let path = Self::slot_file_path(slot)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppError::Auth(format!(
                    "Failed to create directory {}: {}",
                    parent.display(),
                    error
                ))
            })?;
        }
        std::fs::write(&path, bytes).map_err(|error| {
            AppError::Auth(format!(
                "Failed to write {} to {}: {}",
                slot,
                path.display(),
                error
            ))
        })
    }

    #[cfg(all(target_os = "macos", debug_assertions))]
    fn clear_slot(slot: &str) -> Result<(), AppError> {
        let path = Self::slot_file_path(slot)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(AppError::Auth(format!(
                "Failed to clear {} at {}: {}",
                slot,
                path.display(),
                error
            ))),
        }
    }

    // Covers macOS release, Linux, and Android — all keyring-backed. Unlike
    // get_session/set_session above, this intentionally skips the
    // macOS-release fallback-to-file path for simplicity: if keyring access
    // fails here, saving/reading a saved account fails (logged, non-fatal —
    // the single active session above is completely unaffected), rather
    // than silently falling back to a less secure file.
    #[cfg(not(any(target_os = "windows", all(target_os = "macos", debug_assertions))))]
    fn get_slot_bytes(slot: &str) -> Result<Option<Vec<u8>>, AppError> {
        let entry = Entry::new("free-grind", slot).map_err(|e| AppError::Auth(e.to_string()))?;
        match entry.get_secret() {
            Ok(bytes) => Ok(Some(bytes)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::Auth(e.to_string())),
        }
    }

    #[cfg(not(any(target_os = "windows", all(target_os = "macos", debug_assertions))))]
    fn set_slot_bytes(slot: &str, bytes: &[u8]) -> Result<(), AppError> {
        let entry = Entry::new("free-grind", slot).map_err(|e| AppError::Auth(e.to_string()))?;
        entry
            .set_secret(bytes)
            .map_err(|e| AppError::Auth(e.to_string()))
    }

    #[cfg(not(any(target_os = "windows", all(target_os = "macos", debug_assertions))))]
    fn clear_slot(slot: &str) -> Result<(), AppError> {
        let entry = Entry::new("free-grind", slot).map_err(|e| AppError::Auth(e.to_string()))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Auth(e.to_string())),
        }
    }

    fn read_account_index() -> Result<Vec<SavedAccountMeta>, AppError> {
        match Self::get_slot_bytes(ACCOUNT_INDEX_SLOT)? {
            Some(bytes) => {
                rmp_serde::decode::from_slice(&bytes).map_err(|e| AppError::Auth(e.to_string()))
            }
            None => Ok(Vec::new()),
        }
    }

    fn write_account_index(index: &[SavedAccountMeta]) -> Result<(), AppError> {
        let bytes = rmp_serde::encode::to_vec(index).map_err(|e| AppError::Auth(e.to_string()))?;
        Self::set_slot_bytes(ACCOUNT_INDEX_SLOT, &bytes)
    }

    /// Upserts this session into the saved-accounts store, keyed by
    /// profile id — called on every successful login/refresh so accounts
    /// automatically show up in the switcher with no separate "save" step.
    pub fn save_account(session: &Session) -> Result<(), AppError> {
        let slot = account_session_slot(&session.profile_id);
        let bytes =
            rmp_serde::encode::to_vec(session).map_err(|e| AppError::Auth(e.to_string()))?;
        Self::set_slot_bytes(&slot, &bytes)?;

        let mut index = Self::read_account_index()?;
        let now = chrono::Utc::now().timestamp() as u64;
        if let Some(existing) = index
            .iter_mut()
            .find(|account| account.profile_id == session.profile_id)
        {
            existing.email = session.email.clone();
            existing.last_used_at = now;
        } else {
            index.push(SavedAccountMeta {
                profile_id: session.profile_id.clone(),
                email: session.email.clone(),
                last_used_at: now,
            });
        }
        Self::write_account_index(&index)
    }

    pub fn get_account_session(profile_id: &str) -> Result<Option<Session>, AppError> {
        let slot = account_session_slot(profile_id);
        match Self::get_slot_bytes(&slot)? {
            Some(bytes) => rmp_serde::decode::from_slice::<Session>(&bytes)
                .map(Some)
                .map_err(|e| AppError::Auth(e.to_string())),
            None => Ok(None),
        }
    }

    pub fn list_saved_accounts() -> Result<Vec<SavedAccountMeta>, AppError> {
        let mut accounts = Self::read_account_index()?;
        accounts.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
        Ok(accounts)
    }

    pub fn remove_saved_account(profile_id: &str) -> Result<(), AppError> {
        let slot = account_session_slot(profile_id);
        Self::clear_slot(&slot)?;
        let mut index = Self::read_account_index()?;
        index.retain(|account| account.profile_id != profile_id);
        Self::write_account_index(&index)
    }
}

impl GrindrClient {
    /// Makes `session` the active one and reports what its token says about
    /// the account. Getting here means Grindr issued or renewed the session,
    /// or the user moved to another saved account, so a refusal from before
    /// no longer describes what is signed in.
    async fn activate_session(&self, session: Session) -> LoginResult {
        let restriction = restriction_from_token(&session.session_id);
        let profile_id = session.profile_id.clone();

        *self.session.write().await = Some(session);
        self.forget_refused_refresh();
        self.set_account_status(
            restriction
                .clone()
                .map(|restriction| AccountStatus::Restriction { restriction }),
        );

        LoginResult {
            profile_id,
            restriction,
        }
    }

    /// The ban Grindr answered the last renewal with, while it is recent
    /// enough that asking again would only repeat it.
    fn recently_refused_refresh(&self) -> Option<BanInfo> {
        let refused = self
            .refused_refresh
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match refused.as_ref() {
            Some((refused_at, info)) if refusal_is_recent(*refused_at, Instant::now()) => {
                Some(info.clone())
            }
            _ => None,
        }
    }

    fn note_refused_refresh(&self, info: BanInfo) {
        *self
            .refused_refresh
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((Instant::now(), info));
    }

    fn forget_refused_refresh(&self) {
        *self
            .refused_refresh
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    /// Signing out: what Grindr said about the account that was signed in
    /// is not about whoever signs in next.
    fn forget_account_standing(&self) {
        self.forget_refused_refresh();
        self.set_account_status(None);
    }

    async fn create_session(
        &self,
        body: &impl AuthRequest,
        device_id: String,
        advertising_id: String,
    ) -> Result<Session, AppError> {
        #[cfg(debug_assertions)]
        eprintln!("[HTTP-AUTH] POST /v8/sessions for email={}", body.email());
        let session_resp: SessionResponse = self
            .request_json(Method::POST, "/v8/sessions", Some(body))
            .await
            .map_err(|e| {
                #[cfg(debug_assertions)]
                eprintln!("[HTTP-AUTH] /v8/sessions request failed: {e}");
                e
            })?;
        #[cfg(debug_assertions)]
        eprintln!(
            "[HTTP-AUTH] /v8/sessions success; profile_id={}",
            session_resp.profile_id
        );
        let claims = decode_session_jwt(&session_resp.session_id).map_err(|e| {
            #[cfg(debug_assertions)]
            eprintln!("[HTTP-AUTH] JWT decode for session_id failed: {e}");
            e
        })?;

        let session = Session {
            email: body.email().to_owned(),
            profile_id: session_resp.profile_id.clone(),
            session_id: session_resp.session_id,
            auth_token: session_resp.auth_token,
            expires_at: claims.exp,
            device_id,
            advertising_id,
            third_party_user_id: None,
        };

        #[cfg(debug_assertions)]
        eprintln!(
            "[HTTP-AUTH] Saving session to storage; profile_id={}, expires_at={}",
            session.profile_id, session.expires_at
        );
        if let Err(_error) = AuthStorage::set_session(&session) {
            #[cfg(debug_assertions)]
            eprintln!(
                "[HTTP-AUTH] Failed to persist session (continuing in-memory only): {}",
                _error
            );
        }
        if let Err(_error) = AuthStorage::save_account(&session) {
            #[cfg(debug_assertions)]
            eprintln!(
                "[HTTP-AUTH] Failed to register account in switcher (login still succeeded): {}",
                _error
            );
        }

        Ok(session)
    }

    pub async fn login(&self, email: &str, password: &str) -> Result<LoginResult, AppError> {
        #[cfg(debug_assertions)]
        eprintln!(
            "[HTTP-AUTH] login attempt for email={}***",
            email.chars().next().unwrap_or('?')
        );

        // Generate NEW device IDs for a new login
        let new_device_id = format!("{:016x}", rand::random::<u64>());
        let new_advertising_id = uuid::Uuid::new_v4().to_string();

        let previous_device = {
            let mut device = self.device.write().await;
            let previous = (device.device_id.clone(), device.advertising_id.clone());
            device.device_id = new_device_id.clone();
            device.advertising_id = new_advertising_id.clone();
            previous
        };

        let body = LoginRequest::new(email.to_owned(), password.to_owned());
        let session =
            match Box::pin(self.create_session(&body, new_device_id, new_advertising_id)).await {
                Ok(session) => session,
                Err(e) => {
                    #[cfg(debug_assertions)]
                    eprintln!("[HTTP-AUTH] login failed: {e}");
                    // An account is added while another one is signed in, and
                    // that one has to go on talking to Grindr as the device it
                    // signed in with. A sign-in that failed, a mistyped
                    // password for one, used to leave it with the identity
                    // made for the attempt until the app was restarted.
                    let mut device = self.device.write().await;
                    device.device_id = previous_device.0;
                    device.advertising_id = previous_device.1;
                    return Err(e);
                }
            };
        #[cfg(debug_assertions)]
        eprintln!(
            "[HTTP-AUTH] login succeeded; profile_id={}",
            session.profile_id
        );

        Ok(self.activate_session(session).await)
    }

    pub async fn login_with_jwt(&self, token: &str) -> Result<LoginResult, AppError> {
        #[cfg(debug_assertions)]
        eprintln!(
            "[HTTP-AUTH] login_with_jwt attempt; token_len={}",
            token.len()
        );
        let claims = decode_session_jwt(token).map_err(|e| {
            #[cfg(debug_assertions)]
            eprintln!("[HTTP-AUTH] JWT decode failed: {e}");
            e
        })?;

        let new_device_id = format!("{:016x}", rand::random::<u64>());
        let new_advertising_id = uuid::Uuid::new_v4().to_string();

        {
            let mut device = self.device.write().await;
            device.device_id = new_device_id.clone();
            device.advertising_id = new_advertising_id.clone();
        }

        // Set the JWT as the current session so the Authorization header is available
        // when we immediately attempt to exchange it for a full session with an authToken.
        *self.session.write().await = Some(Session {
            email: String::new(),
            profile_id: claims.profile_id.clone(),
            session_id: token.to_owned(),
            auth_token: String::new(),
            expires_at: claims.exp,
            device_id: new_device_id.clone(),
            advertising_id: new_advertising_id.clone(),
            third_party_user_id: None,
        });

        // Try to exchange the JWT for a full session (sessionId + authToken) so that
        // subsequent refreshes work the same way as email/password login.
        // We send the JWT as the authToken field; Grindr validates the request via the
        // Authorization header (Grindr3 <JWT>) and the body authToken together.
        let body = RefreshRequest::new(String::new(), token.to_owned());
        match Box::pin(self.create_session(
            &body,
            new_device_id.clone(),
            new_advertising_id.clone(),
        ))
        .await
        {
            Ok(session) => {
                #[cfg(debug_assertions)]
                eprintln!(
                    "[HTTP-AUTH] login_with_jwt exchange succeeded; profile_id={}, has_auth_token={}",
                    session.profile_id,
                    !session.auth_token.is_empty()
                );
                if let Err(_error) = AuthStorage::set_session(&session) {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[HTTP-AUTH] Failed to persist exchanged session (continuing in-memory only): {}",
                        _error
                    );
                }
                if let Err(_error) = AuthStorage::save_account(&session) {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[HTTP-AUTH] Failed to register account in switcher (login still succeeded): {}",
                        _error
                    );
                }
                Ok(self.activate_session(session).await)
            }
            Err(_exchange_error) => {
                // Exchange failed — fall back to storing the JWT directly.
                // The session will work until the JWT expires (~15-30 min).
                // Deliberately not registered via save_account: it has no
                // email to identify it by and would expire almost
                // immediately, making it a dead/confusing entry in the
                // switcher rather than a useful saved account.
                #[cfg(debug_assertions)]
                eprintln!(
                    "[HTTP-AUTH] login_with_jwt exchange failed (falling back to JWT-only session): {_exchange_error}"
                );
                let session = Session {
                    email: String::new(),
                    profile_id: claims.profile_id.clone(),
                    session_id: token.to_owned(),
                    auth_token: String::new(),
                    expires_at: claims.exp,
                    device_id: new_device_id,
                    advertising_id: new_advertising_id,
                    third_party_user_id: None,
                };
                if let Err(_error) = AuthStorage::set_session(&session) {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[HTTP-AUTH] Failed to persist JWT session (continuing in-memory only): {}",
                        _error
                    );
                }
                #[cfg(debug_assertions)]
                eprintln!(
                    "[HTTP-AUTH] login_with_jwt (JWT-only) succeeded; profile_id={}",
                    claims.profile_id
                );
                Ok(self.activate_session(session).await)
            }
        }
    }

    pub async fn refresh_token(&self) -> Result<LoginResult, AppError> {
        let current = self.session.read().await;
        let session = current
            .as_ref()
            .ok_or_else(|| AppError::Auth("Not logged in".to_owned()))?;

        // A token sign-in that Grindr would not turn into a full session has
        // only its own token to renew itself with. Once that has run out
        // there is nothing left to ask with, so say so instead of asking.
        if session.auth_token.is_empty()
            && session.expires_at <= chrono::Utc::now().timestamp() as u64
        {
            drop(current);
            self.set_account_status(Some(AccountStatus::SessionExpired));
            return Err(AppError::Auth("Session token expired".to_owned()));
        }

        // Grindr refused the last renewal with one of its ban codes. Every
        // request asks for a renewal while the session is out of date, and
        // asking over and over gets the same answer while it hammers the
        // sign-in route, so that answer stands for a moment.
        if let Some(info) = self.recently_refused_refresh() {
            return Err(AppError::Banned(info));
        }

        // For JWT-only sessions (no authToken), use the current session_id as the authToken.
        // Grindr validates via the Authorization header; this mirrors how the initial
        // JWT exchange is attempted in login_with_jwt.
        let auth_token = if session.auth_token.is_empty() {
            session.session_id.clone()
        } else {
            session.auth_token.clone()
        };

        let body = RefreshRequest::new(session.email.clone(), auth_token);
        let device_id = session.device_id.clone();
        let advertising_id = session.advertising_id.clone();
        let profile_id = session.profile_id.clone();

        drop(current);

        let session = match Box::pin(self.create_session(&body, device_id, advertising_id)).await
        {
            Ok(session) => session,
            Err(error) => {
                if let AppError::Banned(info) = &error {
                    // Only while the account it was asked for is still the
                    // one signed in: the user may have signed out, or moved
                    // to another account, while Grindr was answering.
                    let still_active = self.authenticated_profile_id().await.as_deref()
                        == Some(profile_id.as_str());
                    if still_active {
                        self.note_refused_refresh(info.clone());
                        self.set_account_status(Some(AccountStatus::Banned {
                            info: info.clone(),
                        }));
                    }
                }
                return Err(error);
            }
        };

        Ok(self.activate_session(session).await)
    }

    /// Makes a previously saved account the active session, without
    /// re-entering a password — restores its stored Session (live
    /// session_id/auth_token, not a re-derived JWT) directly into both the
    /// single "active" slot (so normal boot/restore picks it up next
    /// launch too) and this client's in-memory state.
    pub async fn switch_account(&self, profile_id: &str) -> Result<LoginResult, AppError> {
        let session = AuthStorage::get_account_session(profile_id)?.ok_or_else(|| {
            AppError::Auth("No saved session for this account".to_owned())
        })?;

        {
            let mut device = self.device.write().await;
            device.device_id = session.device_id.clone();
            device.advertising_id = session.advertising_id.clone();
        }

        if let Err(_error) = AuthStorage::set_session(&session) {
            #[cfg(debug_assertions)]
            eprintln!(
                "[HTTP-AUTH] Failed to persist switched-to session (continuing in-memory only): {}",
                _error
            );
        }

        Ok(self.activate_session(session).await)
    }

    pub async fn authorization_header(&self) -> Option<String> {
        let session = self.session.read().await;
        session
            .as_ref()
            .map(|s| format!("Grindr3 {}", s.session_id))
    }

    pub async fn sync_push_token(&self, token: &str) -> Result<(), AppError> {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            #[cfg(debug_assertions)]
            eprintln!("[HTTP-PUSH] sync_push_token called with empty token");
            return Err(AppError::Api {
                code: 400,
                message: "Push token is empty".to_owned(),
            });
        }

        let identifier = trimmed.split(':').next().unwrap_or(trimmed).to_owned();
        #[cfg(debug_assertions)]
        eprintln!(
            "[HTTP-PUSH] Syncing push token: token_len={}, identifier={}",
            trimmed.len(),
            identifier
        );
        let payload = PushTokenRequest {
            vendor_provided_identifier: identifier,
            token: trimmed.to_owned(),
        };
        let body = serde_json::to_vec(&payload)
            .map_err(|e| AppError::Http(format!("Failed to serialize push token payload: {e}")))?;

        let response = self
            .request_raw(
                Method::POST,
                "/v3/gcm-push-tokens",
                Some(body),
                Some("application/json"),
            )
            .await?;

        if (200..300).contains(&response.status) {
            #[cfg(debug_assertions)]
            eprintln!(
                "[HTTP-PUSH] /v3/gcm-push-tokens sync success: status={}",
                response.status
            );
            Ok(())
        } else {
            let message = String::from_utf8(response.body)
                .unwrap_or_else(|_| "Failed to sync push token".to_owned());
            #[cfg(debug_assertions)]
            eprintln!(
                "[HTTP-PUSH] /v3/gcm-push-tokens sync failed: status={}, body={}",
                response.status, message
            );
            Err(AppError::Api {
                code: response.status as i32,
                message,
            })
        }
    }
}

#[tauri::command]
pub async fn login(
    state: tauri::State<'_, AppState>,
    email: String,
    password: String,
) -> Result<LoginResult, AppError> {
    state.client()?.login(&email, &password).await
}

#[tauri::command]
pub async fn login_with_jwt(
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<LoginResult, AppError> {
    state.client()?.login_with_jwt(&token).await
}

#[tauri::command]
pub async fn refresh_token(state: tauri::State<'_, AppState>) -> Result<LoginResult, AppError> {
    state.client()?.refresh_token().await
}

#[tauri::command]
pub async fn logout(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    AuthStorage::clear_session()?;

    let client = state.client()?;
    let previous = client.session.write().await.take();
    client.forget_account_standing();

    previous
        .ok_or_else(|| AppError::Auth("Not logged in".to_owned()))
        .map(|_| ())
}

/// What Grindr last said about the standing of the account that is signed
/// in. The window asks once when it starts and hears about every change
/// after that on `ACCOUNT_STATUS_EVENT`.
#[tauri::command]
pub async fn account_status(
    state: tauri::State<'_, AppState>,
) -> Result<Option<AccountStatus>, AppError> {
    Ok(state.client()?.account_status())
}

#[tauri::command]
pub async fn auth_state(state: tauri::State<'_, AppState>) -> Result<Option<u64>, AppError> {
    let session = state.client()?.session.read().await;
    Ok(session
        .as_ref()
        .and_then(|s| s.profile_id.parse::<u64>().ok()))
}

#[tauri::command]
pub async fn list_saved_accounts() -> Result<Vec<SavedAccountMeta>, AppError> {
    AuthStorage::list_saved_accounts()
}

#[tauri::command]
pub async fn switch_account(
    state: tauri::State<'_, AppState>,
    profile_id: String,
) -> Result<LoginResult, AppError> {
    state.client()?.switch_account(&profile_id).await
}

#[tauri::command]
pub async fn remove_saved_account(profile_id: String) -> Result<(), AppError> {
    AuthStorage::remove_saved_account(&profile_id)
}

#[tauri::command]
pub async fn websocket_token(
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, AppError> {
    let client = state.client()?;

    // Check if refresh is needed
    let needs_refresh = {
        let session = client.session.read().await;
        let expires_at = session.as_ref().map(|s| s.expires_at).unwrap_or(0);
        expires_at > 0 && expires_at < (chrono::Utc::now().timestamp() as u64 + 60)
    };

    if needs_refresh {
        let _ = client.refresh_token().await;
    }

    let session = client.session.read().await;
    Ok(session.as_ref().map(|s| s.session_id.clone()))
}

#[tauri::command]
pub async fn sync_push_token(
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<(), AppError> {
    #[cfg(debug_assertions)]
    eprintln!("[HTTP-PUSH] Tauri command sync_push_token invoked");
    state.client()?.sync_push_token(&token).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape sessions had before `third_party_user_id`, in the same order.
    #[derive(Serialize)]
    struct SessionBeforeThirdParty {
        email: String,
        expires_at: u64,
        profile_id: String,
        session_id: String,
        auth_token: String,
        device_id: String,
        advertising_id: String,
    }

    #[test]
    fn sessions_saved_before_third_party_sign_in_still_load() {
        let old = SessionBeforeThirdParty {
            email: "me@example.com".to_owned(),
            expires_at: 1_800_000_000,
            profile_id: "900000002".to_owned(),
            session_id: "jwt".to_owned(),
            auth_token: "token".to_owned(),
            device_id: "0123456789abcdef".to_owned(),
            advertising_id: "ad".to_owned(),
        };
        let bytes = rmp_serde::encode::to_vec(&old).unwrap();
        let session: Session = rmp_serde::decode::from_slice(&bytes).unwrap();
        assert_eq!(session.profile_id, "900000002");
        assert_eq!(session.auth_token, "token");
        assert_eq!(session.third_party_user_id, None);
    }

    #[test]
    fn third_party_sessions_keep_their_provider_id() {
        let session = Session {
            email: "me@example.com".to_owned(),
            expires_at: 1_800_000_000,
            profile_id: "1".to_owned(),
            session_id: "jwt".to_owned(),
            auth_token: "token".to_owned(),
            device_id: "0123456789abcdef".to_owned(),
            advertising_id: "ad".to_owned(),
            third_party_user_id: Some("google111659523269679641630".to_owned()),
        };
        let bytes = rmp_serde::encode::to_vec(&session).unwrap();
        let decoded: Session = rmp_serde::decode::from_slice(&bytes).unwrap();
        assert_eq!(
            decoded.third_party_user_id.as_deref(),
            Some("google111659523269679641630")
        );
    }

    /// A session token with these claims. Nothing here checks a signature,
    /// so any third part will do.
    fn token_with(claims: serde_json::Value) -> String {
        use base64::Engine;
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!(
            "{}.{}.sig",
            engine.encode(br#"{"alg":"HS256","typ":"JWT"}"#),
            engine.encode(claims.to_string())
        )
    }

    #[test]
    fn the_documented_refusal_reads_as_a_device_ban() {
        let body = serde_json::json!({
            "code": 28,
            "message": "ACCOUNT_BANNED",
            "profileId": null,
            "type": 1,
            "reason": null,
            "isBanAutomated": true,
            "thirdPartyUserIdToShow": null,
            "banSubReason": null,
        });
        let ban = ban_from_error_body(&body).unwrap();
        assert_eq!(ban.kind, "device");
        assert_eq!(ban.code, 28);
        assert_eq!(ban.message, "ACCOUNT_BANNED");
        assert_eq!(ban.reason, None);
        assert_eq!(ban.sub_reason, None);
        assert_eq!(ban.automated, Some(true));
    }

    #[test]
    fn each_ban_code_has_its_kind() {
        let kind = |code: i64| {
            ban_from_error_body(&serde_json::json!({ "code": code })).map(|ban| ban.kind)
        };
        assert_eq!(kind(27), Some("profile"));
        assert_eq!(kind(28), Some("device"));
        assert_eq!(kind(31), Some("network"));
        assert_eq!(kind(35), Some("underage"));
        assert_eq!(kind(36), Some("underage"));
    }

    #[test]
    fn other_failures_are_not_bans() {
        // 4 is a wrong password, 30 an account that has to confirm a phone number.
        for code in [0, 4, 8, 26, 29, 30, 32, 34, 37, 401, 403] {
            assert_eq!(
                ban_from_error_body(&serde_json::json!({ "code": code, "message": "x" })),
                None,
                "code {code}"
            );
        }
        assert_eq!(ban_from_error_body(&serde_json::json!({})), None);
        assert_eq!(ban_from_error_body(&serde_json::json!({ "code": "28" })), None);
        assert_eq!(ban_from_error_body(&serde_json::Value::Null), None);
        assert_eq!(ban_from_error_body(&serde_json::json!("ACCOUNT_BANNED")), None);
    }

    #[test]
    fn a_ban_keeps_its_reasons() {
        let ban = ban_from_error_body(&serde_json::json!({
            "code": 27,
            "message": "PROFILE_BANNED",
            "reason": " SPAM ",
            "banSubReason": 12,
            "isBanAutomated": false,
        }))
        .unwrap();
        assert_eq!(ban.reason.as_deref(), Some("SPAM"));
        assert_eq!(ban.sub_reason.as_deref(), Some("12"));
        assert_eq!(ban.automated, Some(false));
    }

    #[test]
    fn a_ban_reaches_the_window_under_its_own_kind() {
        let error = AppError::Banned(
            ban_from_error_body(&serde_json::json!({ "code": 28, "message": "ACCOUNT_BANNED" }))
                .unwrap(),
        );
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["kind"], "Banned");
        assert_eq!(json["message"]["kind"], "device");
        assert_eq!(json["message"]["code"], 28);
        assert_eq!(json["message"]["message"], "ACCOUNT_BANNED");
        assert!(json["message"]["subReason"].is_null());
    }

    #[test]
    fn an_ordinary_token_carries_no_restriction() {
        let token = token_with(serde_json::json!({
            "exp": 9_999_999_999u64,
            "profileId": "42",
            "roles": [],
            "restrictionReason": null,
        }));
        assert_eq!(decode_session_jwt(&token).unwrap().profile_id, "42");
        assert_eq!(restriction_from_token(&token), None);

        for restriction in [
            serde_json::Value::Null,
            serde_json::json!(""),
            serde_json::json!("  "),
            serde_json::json!(false),
            serde_json::json!(0),
            serde_json::json!({}),
        ] {
            let token = token_with(serde_json::json!({
                "exp": 9_999_999_999u64,
                "profileId": "42",
                "restriction": restriction,
            }));
            assert_eq!(restriction_from_token(&token), None);
        }
    }

    #[test]
    fn an_age_check_names_its_region() {
        // {"alg":"HS256","typ":"JWT"} . {"exp":9999999999,"profileId":"42","restriction":"AGE_RESTRICTED","restrictionReason":"UK_VERIFICATION_REQUIRED"} . sig
        let token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjk5OTk5OTk5OTksInByb2ZpbGVJZCI6IjQyIiwicmVzdHJpY3Rpb24iOiJBR0VfUkVTVFJJQ1RFRCIsInJlc3RyaWN0aW9uUmVhc29uIjoiVUtfVkVSSUZJQ0FUSU9OX1JFUVVJUkVEIn0.sig";
        assert_eq!(decode_session_jwt(token).unwrap().profile_id, "42");
        let restriction = restriction_from_token(token).unwrap();
        assert_eq!(restriction.kind, "ageVerification");
        assert_eq!(restriction.code, "AGE_RESTRICTED");
        assert_eq!(restriction.region, Some("uk"));
        assert_eq!(restriction.reason.as_deref(), Some("UK_VERIFICATION_REQUIRED"));

        let elsewhere = token_with(serde_json::json!({
            "exp": 9_999_999_999u64,
            "profileId": "42",
            "restriction": "AGE_RESTRICTED",
            "restrictionReason": "VERIFICATION_REQUESTED",
        }));
        assert_eq!(restriction_from_token(&elsewhere).unwrap().region, Some("other"));
    }

    #[test]
    fn a_vendor_rejection_keeps_its_reason() {
        // ... {"exp":9999999999,"profileId":"42","restriction":"TRUST_VENDOR_REJECTED","restrictionReason":"Device risk too high"} ...
        let token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjk5OTk5OTk5OTksInByb2ZpbGVJZCI6IjQyIiwicmVzdHJpY3Rpb24iOiJUUlVTVF9WRU5ET1JfUkVKRUNURUQiLCJyZXN0cmljdGlvblJlYXNvbiI6IkRldmljZSByaXNrIHRvbyBoaWdoIn0.sig";
        let restriction = restriction_from_token(token).unwrap();
        assert_eq!(restriction.kind, "trustVendorRejected");
        assert_eq!(restriction.reason.as_deref(), Some("Device risk too high"));
        assert_eq!(restriction.region, None);
    }

    #[test]
    fn a_timed_ban_keeps_its_reason_and_its_end() {
        let token = token_with(serde_json::json!({
            "exp": 9_999_999_999u64,
            "profileId": "42",
            "restriction": "TIMED_BAN",
            "banDetails": {
                "expiryTime": 1_800_000_000,
                "reason": "SPAM",
                "subReason": "MASS_MESSAGING",
                "isAutomated": true,
            },
        }));
        let restriction = restriction_from_token(&token).unwrap();
        assert_eq!(restriction.kind, "timedBan");
        assert_eq!(restriction.reason.as_deref(), Some("SPAM"));
        assert_eq!(restriction.expires_at, Some(1_800_000_000));
        assert_eq!(restriction.sub_reason.as_deref(), Some("MASS_MESSAGING"));
        assert_eq!(restriction.automated, Some(true));

        let json = serde_json::to_value(&restriction).unwrap();
        assert_eq!(json["kind"], "timedBan");
        assert_eq!(json["expiresAt"], 1_800_000_000);
        assert_eq!(json["subReason"], "MASS_MESSAGING");
    }

    #[test]
    fn an_unknown_restriction_is_reported_as_it_came() {
        let token = token_with(serde_json::json!({
            "exp": 9_999_999_999u64,
            "profileId": "42",
            "restriction": "SOMETHING_NEW",
        }));
        let restriction = restriction_from_token(&token).unwrap();
        assert_eq!(restriction.kind, "other");
        assert_eq!(restriction.code, "SOMETHING_NEW");
        assert_eq!(restriction.reason, None);
    }

    /// Whatever shape these fields come in, the claims signing in depends on
    /// still decode and the rest is read as far as it makes sense.
    #[test]
    fn odd_restriction_fields_never_get_in_the_way() {
        let token = token_with(serde_json::json!({
            "exp": 9_999_999_999u64,
            "profileId": "42",
            "restriction": "TIMED_BAN",
            "restrictionReason": { "unexpected": true },
            "banDetails": "not an object",
        }));
        assert_eq!(decode_session_jwt(&token).unwrap().profile_id, "42");
        let restriction = restriction_from_token(&token).unwrap();
        assert_eq!(restriction.kind, "timedBan");
        assert_eq!(restriction.reason, None);
        assert_eq!(restriction.expires_at, None);
        assert_eq!(restriction.automated, None);

        let token = token_with(serde_json::json!({
            "exp": 9_999_999_999u64,
            "profileId": "42",
            "restriction": "TIMED_BAN",
            "banDetails": { "expiryTime": "1800000000", "reason": 7, "isAutomated": "yes" },
        }));
        let restriction = restriction_from_token(&token).unwrap();
        assert_eq!(restriction.expires_at, Some(1_800_000_000));
        assert_eq!(restriction.reason.as_deref(), Some("7"));
        assert_eq!(restriction.automated, None);

        assert_eq!(restriction_from_token("not a token"), None);
        assert_eq!(restriction_from_token(""), None);
    }

    #[test]
    fn the_account_status_has_the_shape_the_window_reads() {
        let banned = AccountStatus::Banned {
            info: ban_from_error_body(&serde_json::json!({ "code": 27, "message": "PROFILE_BANNED" }))
                .unwrap(),
        };
        let json = serde_json::to_value(&banned).unwrap();
        assert_eq!(json["kind"], "banned");
        assert_eq!(json["info"]["kind"], "profile");
        assert_eq!(json["info"]["code"], 27);

        let restricted = AccountStatus::Restriction {
            restriction: restriction_from_claims(&serde_json::json!({
                "restriction": "AGE_RESTRICTED",
                "restrictionReason": "BR_VERIFICATION_REQUIRED",
            }))
            .unwrap(),
        };
        let json = serde_json::to_value(&restricted).unwrap();
        assert_eq!(json["kind"], "restriction");
        assert_eq!(json["restriction"]["kind"], "ageVerification");
        assert_eq!(json["restriction"]["region"], "br");

        assert_eq!(
            serde_json::to_value(AccountStatus::SessionExpired).unwrap(),
            serde_json::json!({ "kind": "sessionExpired" })
        );
        assert_eq!(
            serde_json::to_value(None::<AccountStatus>).unwrap(),
            serde_json::Value::Null
        );
    }

    #[test]
    fn a_sign_in_result_always_says_whether_there_is_a_restriction() {
        let json = serde_json::to_value(LoginResult {
            profile_id: "42".to_owned(),
            restriction: None,
        })
        .unwrap();
        assert_eq!(json["profileId"], "42");
        assert!(json.as_object().unwrap().contains_key("restriction"));
        assert!(json["restriction"].is_null());
    }

    #[test]
    fn a_refused_renewal_is_left_alone_for_a_moment_only() {
        let refused_at = Instant::now();
        assert!(refusal_is_recent(refused_at, refused_at));
        assert!(refusal_is_recent(
            refused_at,
            refused_at + REFUSED_REFRESH_PAUSE - Duration::from_millis(1)
        ));
        assert!(!refusal_is_recent(refused_at, refused_at + REFUSED_REFRESH_PAUSE));
        assert!(!refusal_is_recent(
            refused_at,
            refused_at + Duration::from_secs(3600)
        ));
        // A clock that reads earlier than the refusal counts as no time passed.
        assert!(refusal_is_recent(refused_at + Duration::from_secs(5), refused_at));
    }
}
