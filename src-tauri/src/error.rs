use std::fmt;

use serde::Serialize;
use wreq;

/// What Grindr sent back when it refused a sign-in, or the renewal of a
/// session, with one of its ban codes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BanInfo {
    /// What the refusal is aimed at: "profile", "device", "network" or "underage".
    pub kind: &'static str,
    /// Grindr's error code.
    pub code: i32,
    pub message: String,
    pub reason: Option<String>,
    pub sub_reason: Option<String>,
    pub automated: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    Http(String),
    Auth(String),
    Api { code: i32, message: String },
    /// A sign-in or renewal that Grindr answered with a ban code. Not always
    /// a ban: see `ban_from_error_body`.
    Banned(BanInfo),
    NotInitialized,
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Http(msg) => write!(f, "HTTP error: {msg}"),
            AppError::Auth(msg) => write!(f, "Auth error: {msg}"),
            AppError::Api { code, message } => write!(f, "API error {code}: {message}"),
            AppError::Banned(info) => write!(
                f,
                "Refused by Grindr (code {}, {}): {}",
                info.code, info.kind, info.message
            ),
            AppError::NotInitialized => write!(f, "GrindrClient not initialized"),
        }
    }
}

impl std::error::Error for AppError {}

impl From<wreq::Error> for AppError {
    fn from(e: wreq::Error) -> Self {
        AppError::Http(e.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Http(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Http(e.to_string())
    }
}

impl From<AppError> for String {
    fn from(e: AppError) -> Self {
        e.to_string()
    }
}
