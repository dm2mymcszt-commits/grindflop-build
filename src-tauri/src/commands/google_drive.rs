//! Native Google Drive `appDataFolder` transport and credential boundary.
//!
//! OAuth tokens and vault keys are deliberately stored in the OS credential
//! store and are never returned by ordinary status/Drive commands. The only
//! command that exposes a vault key is the explicitly-confirmed pairing export.
//! Windows completes installed-app OAuth with PKCE through a loopback listener.
//! iOS uses `ASWebAuthenticationSession` only to present the system browser and
//! return its callback URL; PKCE, state validation, token exchange, and secure
//! credential storage remain in Rust on both platforms.

use std::{
    collections::HashMap,
    fmt,
    sync::{LazyLock, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(any(target_os = "ios", test))]
use std::collections::HashSet;

#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::StreamExt;
use keyring_core::Entry;
use reqwest::{header, Client, RequestBuilder, Response, StatusCode};
use ring::{
    aead::{self, Aad, LessSafeKey, Nonce, UnboundKey},
    digest,
    rand::{SecureRandom, SystemRandom},
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use url::Url;
use zeroize::{Zeroize, Zeroizing};

const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.appdata";
#[cfg(any(target_os = "windows", target_os = "ios"))]
const AUTHORIZATION_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const DRIVE_FILES_ENDPOINT: &str = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_ENDPOINT: &str = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_CHANGES_ENDPOINT: &str = "https://www.googleapis.com/drive/v3/changes";
const DRIVE_START_TOKEN_ENDPOINT: &str =
    "https://www.googleapis.com/drive/v3/changes/startPageToken";
const DRIVE_ABOUT_ENDPOINT: &str = "https://www.googleapis.com/drive/v3/about";
const KEYRING_SERVICE: &str = "free-grind.google-drive.v1";
const TOKEN_RECORD_KIND: &str = "oauth";
const VAULT_KEY_RECORD_KIND: &str = "vault-key";
const INLINE_UPLOAD_LIMIT: usize = 5 * 1024 * 1024;
const INLINE_DOWNLOAD_LIMIT: usize = 8 * 1024 * 1024;
const INLINE_CRYPTO_LIMIT: usize = 8 * 1024 * 1024;
const MAX_AAD_BYTES: usize = 4096;
#[cfg(target_os = "windows")]
const OAUTH_TIMEOUT: Duration = Duration::from_secs(300);
const HTTP_TIMEOUT: Duration = Duration::from_secs(60);
const ACCESS_TOKEN_SKEW_SECONDS: u64 = 60;
const VAULT_KEY_SIZE: usize = 32;
const GCM_NONCE_SIZE: usize = 12;
const RECORD_SCHEMA_VERSION: u8 = 1;

#[cfg(target_os = "windows")]
static OAUTH_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static CREDENTIAL_EPOCHS: LazyLock<Mutex<HashMap<String, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Serialize)]
#[serde(tag = "code", content = "message", rename_all = "camelCase")]
pub enum GoogleDriveError {
    Configuration(String),
    InvalidInput(String),
    NotConnected(String),
    ReauthenticationRequired(String),
    SecureStorage(String),
    Transport(String),
    Remote(String),
    Integrity(String),
    Conflict(String),
    Unsupported(String),
}

impl fmt::Display for GoogleDriveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Configuration(message)
            | Self::InvalidInput(message)
            | Self::NotConnected(message)
            | Self::ReauthenticationRequired(message)
            | Self::SecureStorage(message)
            | Self::Transport(message)
            | Self::Remote(message)
            | Self::Integrity(message)
            | Self::Conflict(message)
            | Self::Unsupported(message) => message,
        };
        f.write_str(message)
    }
}

impl std::error::Error for GoogleDriveError {}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleDriveConfigStatus {
    pub platform: &'static str,
    pub configured: bool,
    pub oauth_supported: bool,
    pub scope: &'static str,
    pub redirect_mode: &'static str,
    pub problem: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleDriveConnectionStatus {
    pub connected: bool,
    pub google_account_email: Option<String>,
    pub can_refresh: bool,
    pub credential_expires_at: Option<u64>,
    pub vault_key: VaultKeyInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultKeyInfo {
    pub present: bool,
    pub fingerprint: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingVaultKey {
    pub encoding: &'static str,
    pub key: String,
    pub fingerprint: String,
}

impl Drop for PairingVaultKey {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedEnvelope {
    pub version: u8,
    pub algorithm: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveFileMetadata {
    pub id: String,
    pub name: String,
    pub mime_type: Option<String>,
    pub size: Option<String>,
    pub modified_time: Option<String>,
    pub md5_checksum: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveFileList {
    pub next_page_token: Option<String>,
    #[serde(default)]
    pub files: Vec<DriveFileMetadata>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveStartPageToken {
    pub start_page_token: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveChange {
    pub file_id: String,
    #[serde(default)]
    pub removed: bool,
    pub file: Option<DriveFileMetadata>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveChangeList {
    pub next_page_token: Option<String>,
    pub new_start_page_token: Option<String>,
    #[serde(default)]
    pub changes: Vec<DriveChange>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveDownload {
    pub content_type: Option<String>,
    pub data_base64: String,
}

#[derive(Serialize, Deserialize)]
struct OAuthCredentialRecord {
    schema_version: u8,
    client_id: String,
    access_token: String,
    refresh_token: String,
    token_type: String,
    scope: String,
    expires_at: u64,
    #[serde(default)]
    google_account_email: Option<String>,
}

impl Drop for OAuthCredentialRecord {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}

#[derive(Serialize, Deserialize)]
struct VaultKeyRecord {
    schema_version: u8,
    #[serde(with = "serde_bytes")]
    key: Vec<u8>,
}

impl Drop for VaultKeyRecord {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

#[derive(Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
    #[serde(default = "default_token_type")]
    token_type: String,
    #[serde(default)]
    scope: String,
}

impl Drop for OAuthTokenResponse {
    fn drop(&mut self) {
        self.access_token.zeroize();
        if let Some(refresh_token) = &mut self.refresh_token {
            refresh_token.zeroize();
        }
    }
}

#[derive(Deserialize)]
struct OAuthRefreshResponse {
    access_token: String,
    expires_in: u64,
    #[serde(default = "default_token_type")]
    token_type: String,
    #[serde(default)]
    scope: String,
}

#[derive(Deserialize)]
struct DriveAbout {
    user: DriveAboutUser,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveAboutUser {
    email_address: String,
}

impl Drop for OAuthRefreshResponse {
    fn drop(&mut self) {
        self.access_token.zeroize();
    }
}

fn default_token_type() -> String {
    "Bearer".to_owned()
}

fn platform_name() -> &'static str {
    #[cfg(target_os = "windows")]
    return "windows";
    #[cfg(target_os = "ios")]
    return "ios";
    #[cfg(target_os = "android")]
    return "android";
    #[cfg(target_os = "macos")]
    return "macos";
    #[cfg(target_os = "linux")]
    return "linux";
    #[allow(unreachable_code)]
    "unknown"
}

fn oauth_supported() -> bool {
    cfg!(any(target_os = "windows", target_os = "ios"))
}

fn redirect_mode() -> &'static str {
    if cfg!(target_os = "windows") {
        "loopback-pkce"
    } else if cfg!(target_os = "ios") {
        "aswebauthentication-session-pkce"
    } else {
        "unsupported"
    }
}

fn validate_configured_client_id(client_id: &str) -> Result<(), GoogleDriveError> {
    const SUFFIX: &str = ".apps.googleusercontent.com";
    let client_name = client_id.strip_suffix(SUFFIX).unwrap_or_default();
    if client_id.len() > 512
        || client_name.is_empty()
        || !client_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(GoogleDriveError::Configuration(
            "The configured Google OAuth client ID is invalid".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(any(target_os = "windows", test))]
fn validate_configured_client_secret(client_secret: &str) -> Result<(), GoogleDriveError> {
    if client_secret.is_empty()
        || client_secret.len() > 512
        || !client_secret.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err(GoogleDriveError::Configuration(
            "The configured Google desktop OAuth client secret is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn configured_client_id() -> Result<String, GoogleDriveError> {
    #[cfg(target_os = "windows")]
    let value = option_env!("FREE_GRIND_GOOGLE_DESKTOP_CLIENT_ID")
        .map(str::to_owned)
        .or_else(|| std::env::var("FREE_GRIND_GOOGLE_DESKTOP_CLIENT_ID").ok());

    #[cfg(target_os = "ios")]
    let value = option_env!("FREE_GRIND_GOOGLE_IOS_CLIENT_ID")
        .map(str::to_owned)
        .or_else(|| std::env::var("FREE_GRIND_GOOGLE_IOS_CLIENT_ID").ok());

    #[cfg(not(any(target_os = "windows", target_os = "ios")))]
    let value: Option<String> = None;

    let client_id = value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            GoogleDriveError::Configuration(format!(
                "Google Drive OAuth is not configured for {}",
                platform_name()
            ))
        })?;

    validate_configured_client_id(&client_id)?;

    Ok(client_id)
}

#[cfg(target_os = "windows")]
fn configured_desktop_client_secret() -> Result<Zeroizing<String>, GoogleDriveError> {
    let value = option_env!("FREE_GRIND_GOOGLE_DESKTOP_CLIENT_SECRET")
        .map(|value| Zeroizing::new(value.to_owned()))
        .or_else(|| {
            std::env::var("FREE_GRIND_GOOGLE_DESKTOP_CLIENT_SECRET")
                .ok()
                .map(Zeroizing::new)
        })
        .ok_or_else(|| {
            GoogleDriveError::Configuration(
                "Google Drive OAuth is missing the Windows desktop client secret".to_owned(),
            )
        })?;
    validate_configured_client_secret(value.as_str())?;
    Ok(value)
}

fn validate_profile_id(profile_id: &str) -> Result<&str, GoogleDriveError> {
    let trimmed = profile_id.trim();
    if profile_id != trimmed
        || profile_id.is_empty()
        || profile_id.len() > 32
        || !profile_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(GoogleDriveError::InvalidInput(
            "A valid numeric GrindFlop profile ID is required".to_owned(),
        ));
    }
    Ok(profile_id)
}

fn ensure_active_profile(
    requested_profile_id: &str,
    authenticated_profile_id: Option<&str>,
) -> Result<(), GoogleDriveError> {
    validate_profile_id(requested_profile_id)?;
    if authenticated_profile_id != Some(requested_profile_id) {
        return Err(GoogleDriveError::NotConnected(
            "Google Drive actions require the currently signed-in GrindFlop profile".to_owned(),
        ));
    }
    Ok(())
}

async fn require_active_profile(
    state: &crate::state::AppState,
    profile_id: &str,
) -> Result<(), GoogleDriveError> {
    let client = state.client().map_err(|_| {
        GoogleDriveError::NotConnected(
            "Google Drive actions require the currently signed-in GrindFlop profile".to_owned(),
        )
    })?;
    let authenticated_profile_id = client.authenticated_profile_id().await;
    ensure_active_profile(profile_id, authenticated_profile_id.as_deref())
}

fn validate_file_id(file_id: &str) -> Result<&str, GoogleDriveError> {
    let file_id = file_id.trim();
    if file_id.is_empty()
        || file_id.len() > 256
        || !file_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(GoogleDriveError::InvalidInput(
            "The Google Drive file ID is invalid".to_owned(),
        ));
    }
    Ok(file_id)
}

fn validate_file_name(name: &str) -> Result<&str, GoogleDriveError> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 200
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(GoogleDriveError::InvalidInput(
            "Sync filenames may contain only letters, numbers, dots, underscores, and hyphens"
                .to_owned(),
        ));
    }
    Ok(name)
}

fn validate_page_token(token: &str) -> Result<&str, GoogleDriveError> {
    if token.is_empty() || token.len() > 4096 || token.chars().any(char::is_control) {
        return Err(GoogleDriveError::InvalidInput(
            "The Google Drive page token is invalid".to_owned(),
        ));
    }
    Ok(token)
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn random_bytes(length: usize) -> Result<Vec<u8>, GoogleDriveError> {
    let mut bytes = vec![0_u8; length];
    SystemRandom::new().fill(&mut bytes).map_err(|_| {
        GoogleDriveError::Integrity("The operating system random generator failed".to_owned())
    })?;
    Ok(bytes)
}

fn maximum_base64url_length(decoded_limit: usize) -> usize {
    decoded_limit.saturating_mul(4).saturating_add(2) / 3
}

fn validate_base64url_size(
    encoded: &str,
    decoded_limit: usize,
    message: &'static str,
) -> Result<(), GoogleDriveError> {
    if encoded.len() > maximum_base64url_length(decoded_limit) {
        return Err(GoogleDriveError::InvalidInput(message.to_owned()));
    }
    Ok(())
}

fn runtime_instance_namespace() -> String {
    #[cfg(target_os = "windows")]
    {
        return crate::windows_instance::WindowsInstance::current()
            .label()
            .to_owned();
    }

    #[cfg(target_os = "ios")]
    {
        return "ios-primary".to_owned();
    }

    #[cfg(target_os = "android")]
    {
        return "android-primary".to_owned();
    }

    #[cfg(target_os = "macos")]
    {
        return "macos-primary".to_owned();
    }

    #[cfg(target_os = "linux")]
    {
        return "linux-primary".to_owned();
    }

    #[allow(unreachable_code)]
    "unknown-primary".to_owned()
}

fn keyring_entry(profile_id: &str, kind: &str) -> Result<Entry, GoogleDriveError> {
    let profile_id = validate_profile_id(profile_id)?;
    let user = format!("{}:{profile_id}:{kind}", runtime_instance_namespace());
    Entry::new(KEYRING_SERVICE, &user).map_err(|_| {
        GoogleDriveError::SecureStorage(
            "The operating system credential store is unavailable".to_owned(),
        )
    })
}

fn read_secure_record<T: DeserializeOwned>(
    profile_id: &str,
    kind: &str,
) -> Result<Option<T>, GoogleDriveError> {
    let entry = keyring_entry(profile_id, kind)?;
    let mut bytes = match entry.get_secret() {
        Ok(bytes) => bytes,
        Err(keyring_core::Error::NoEntry) => return Ok(None),
        Err(_) => {
            return Err(GoogleDriveError::SecureStorage(
                "The operating system credential store could not be read".to_owned(),
            ))
        }
    };

    let result = rmp_serde::decode::from_slice(&bytes).map_err(|_| {
        GoogleDriveError::SecureStorage("A secure Google Drive record is corrupt".to_owned())
    });
    bytes.zeroize();
    result.map(Some)
}

fn write_secure_record<T: Serialize>(
    profile_id: &str,
    kind: &str,
    record: &T,
) -> Result<(), GoogleDriveError> {
    let entry = keyring_entry(profile_id, kind)?;
    let bytes = Zeroizing::new(rmp_serde::encode::to_vec(record).map_err(|_| {
        GoogleDriveError::SecureStorage(
            "A secure Google Drive record could not be encoded".to_owned(),
        )
    })?);
    entry.set_secret(bytes.as_slice()).map_err(|_| {
        GoogleDriveError::SecureStorage(
            "The operating system credential store could not save the Google Drive record"
                .to_owned(),
        )
    })
}

fn delete_secure_record(profile_id: &str, kind: &str) -> Result<(), GoogleDriveError> {
    let entry = keyring_entry(profile_id, kind)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(_) => Err(GoogleDriveError::SecureStorage(
            "The operating system credential store could not remove the Google Drive record"
                .to_owned(),
        )),
    }
}

fn credential_epoch(profile_id: &str) -> Result<u64, GoogleDriveError> {
    let profile_id = validate_profile_id(profile_id)?;
    let epochs = CREDENTIAL_EPOCHS.lock().map_err(|_| {
        GoogleDriveError::SecureStorage(
            "The Google Drive credential coordinator is unavailable".to_owned(),
        )
    })?;
    Ok(*epochs.get(profile_id).unwrap_or(&0))
}

fn write_credentials_at_epoch(
    profile_id: &str,
    expected_epoch: u64,
    credentials: &OAuthCredentialRecord,
) -> Result<(), GoogleDriveError> {
    let profile_id = validate_profile_id(profile_id)?;
    let epochs = CREDENTIAL_EPOCHS.lock().map_err(|_| {
        GoogleDriveError::SecureStorage(
            "The Google Drive credential coordinator is unavailable".to_owned(),
        )
    })?;
    if *epochs.get(profile_id).unwrap_or(&0) != expected_epoch {
        return Err(GoogleDriveError::NotConnected(
            "Google Drive was disconnected before the credential operation completed".to_owned(),
        ));
    }
    write_secure_record(profile_id, TOKEN_RECORD_KIND, credentials)
}

fn delete_credentials_and_advance_epoch(profile_id: &str) -> Result<(), GoogleDriveError> {
    let profile_id = validate_profile_id(profile_id)?;
    let mut epochs = CREDENTIAL_EPOCHS.lock().map_err(|_| {
        GoogleDriveError::SecureStorage(
            "The Google Drive credential coordinator is unavailable".to_owned(),
        )
    })?;
    delete_secure_record(profile_id, TOKEN_RECORD_KIND)?;
    let next_epoch = epochs.get(profile_id).copied().unwrap_or(0).wrapping_add(1);
    epochs.insert(profile_id.to_owned(), next_epoch);
    Ok(())
}

fn read_credentials(profile_id: &str) -> Result<Option<OAuthCredentialRecord>, GoogleDriveError> {
    let record: Option<OAuthCredentialRecord> = read_secure_record(profile_id, TOKEN_RECORD_KIND)?;
    if let Some(record) = &record {
        if record.schema_version != RECORD_SCHEMA_VERSION
            || record.access_token.is_empty()
            || record.token_type != "Bearer"
            || !scope_includes_app_data(&record.scope)
        {
            return Err(GoogleDriveError::SecureStorage(
                "The saved Google Drive credential has an unsupported format".to_owned(),
            ));
        }
    }
    Ok(record)
}

fn scope_includes_app_data(scope: &str) -> bool {
    scope
        .split_ascii_whitespace()
        .any(|value| value == DRIVE_SCOPE)
}

fn read_vault_key(profile_id: &str) -> Result<Option<VaultKeyRecord>, GoogleDriveError> {
    let record: Option<VaultKeyRecord> = read_secure_record(profile_id, VAULT_KEY_RECORD_KIND)?;
    if let Some(record) = &record {
        if record.schema_version != RECORD_SCHEMA_VERSION || record.key.len() != VAULT_KEY_SIZE {
            return Err(GoogleDriveError::SecureStorage(
                "The saved sync vault key has an unsupported format".to_owned(),
            ));
        }
    }
    Ok(record)
}

fn key_fingerprint(key: &[u8]) -> String {
    let hash = digest::digest(&digest::SHA256, key);
    URL_SAFE_NO_PAD.encode(&hash.as_ref()[..8])
}

fn vault_key_info(record: Option<&VaultKeyRecord>) -> VaultKeyInfo {
    VaultKeyInfo {
        present: record.is_some(),
        fingerprint: record.map(|record| key_fingerprint(&record.key)),
    }
}

fn crypto_aad(profile_id: &str, aad: &str) -> Result<Vec<u8>, GoogleDriveError> {
    let profile_id = validate_profile_id(profile_id)?;
    if aad.is_empty() || aad.len() > MAX_AAD_BYTES || aad.chars().any(char::is_control) {
        return Err(GoogleDriveError::InvalidInput(
            "Authenticated metadata must be non-empty and at most 4096 bytes".to_owned(),
        ));
    }
    Ok(format!("free-grind-drive:v1:{profile_id}:{aad}").into_bytes())
}

fn encrypt_with_key(
    key: &[u8],
    plaintext: &[u8],
    aad: &[u8],
    nonce_bytes: [u8; GCM_NONCE_SIZE],
) -> Result<Vec<u8>, GoogleDriveError> {
    let unbound = UnboundKey::new(&aead::AES_256_GCM, key)
        .map_err(|_| GoogleDriveError::Integrity("The sync vault key is invalid".to_owned()))?;
    let key = LessSafeKey::new(unbound);
    let mut encrypted = plaintext.to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce_bytes),
        Aad::from(aad),
        &mut encrypted,
    )
    .map_err(|_| GoogleDriveError::Integrity("Sync package encryption failed".to_owned()))?;
    Ok(encrypted)
}

fn decrypt_with_key(
    key: &[u8],
    ciphertext: &[u8],
    aad: &[u8],
    nonce_bytes: [u8; GCM_NONCE_SIZE],
) -> Result<Vec<u8>, GoogleDriveError> {
    let unbound = UnboundKey::new(&aead::AES_256_GCM, key)
        .map_err(|_| GoogleDriveError::Integrity("The sync vault key is invalid".to_owned()))?;
    let key = LessSafeKey::new(unbound);
    let mut decrypted = Zeroizing::new(ciphertext.to_vec());
    let plaintext = key
        .open_in_place(
            Nonce::assume_unique_for_key(nonce_bytes),
            Aad::from(aad),
            &mut decrypted,
        )
        .map_err(|_| {
            GoogleDriveError::Integrity(
                "Sync package authentication failed; it was not applied".to_owned(),
            )
        })?;
    let plaintext_len = plaintext.len();
    decrypted.truncate(plaintext_len);
    Ok(std::mem::take(&mut *decrypted))
}

fn http_client() -> Result<Client, GoogleDriveError> {
    Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(HTTP_TIMEOUT)
        .user_agent(concat!("GrindFlop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| {
            GoogleDriveError::Transport(
                "The secure HTTP client could not be initialized".to_owned(),
            )
        })
}

fn oauth_token_form_body(
    fields: &[(&str, &str)],
    client_secret: Option<&str>,
) -> Zeroizing<String> {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (name, value) in fields {
        serializer.append_pair(name, value);
    }
    if let Some(client_secret) = client_secret {
        serializer.append_pair("client_secret", client_secret);
    }
    Zeroizing::new(serializer.finish())
}

async fn parse_json_response<T: DeserializeOwned>(
    response: Response,
) -> Result<T, GoogleDriveError> {
    let status = response.status();
    if !status.is_success() {
        return Err(remote_error(status, response.headers()));
    }
    let mut body = response.text().await.map_err(|_| {
        GoogleDriveError::Transport("The Google Drive response could not be read".to_owned())
    })?;
    let parsed = serde_json::from_str(&body).map_err(|_| {
        GoogleDriveError::Remote("Google Drive returned an invalid response".to_owned())
    });
    body.zeroize();
    parsed
}

async fn parse_oauth_response<T: DeserializeOwned>(
    response: Response,
) -> Result<T, GoogleDriveError> {
    if response.status() == StatusCode::BAD_REQUEST || response.status() == StatusCode::UNAUTHORIZED
    {
        // OAuth error bodies can contain provider details that should not flow
        // into frontend logs. The actionable outcome is always to reconnect.
        return Err(GoogleDriveError::ReauthenticationRequired(
            "Google authorization is no longer valid; reconnect this device".to_owned(),
        ));
    }
    parse_json_response(response).await
}

fn remote_error(status: StatusCode, headers: &header::HeaderMap) -> GoogleDriveError {
    if status == StatusCode::UNAUTHORIZED {
        return GoogleDriveError::ReauthenticationRequired(
            "Google Drive authorization has expired or was revoked".to_owned(),
        );
    }
    if status == StatusCode::PRECONDITION_FAILED || status == StatusCode::CONFLICT {
        return GoogleDriveError::Conflict(
            "The Google Drive file changed concurrently; refresh and retry".to_owned(),
        );
    }
    if status == StatusCode::TOO_MANY_REQUESTS || status == StatusCode::SERVICE_UNAVAILABLE {
        let retry_after = headers
            .get(header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok());
        return GoogleDriveError::Remote(match retry_after {
            Some(seconds) => format!("Google Drive is busy; retry after {seconds} seconds"),
            None => "Google Drive is busy; retry with exponential backoff".to_owned(),
        });
    }
    if status == StatusCode::NOT_FOUND {
        return GoogleDriveError::Remote("The Google Drive app-data file was not found".to_owned());
    }
    GoogleDriveError::Remote(format!(
        "Google Drive rejected the request with HTTP status {}",
        status.as_u16()
    ))
}

async fn refresh_access_token(
    profile_id: &str,
    mut credentials: OAuthCredentialRecord,
    expected_epoch: u64,
) -> Result<Zeroizing<String>, GoogleDriveError> {
    let client_id = configured_client_id()?;
    if credentials.client_id != client_id {
        return Err(GoogleDriveError::ReauthenticationRequired(
            "The configured Google OAuth client changed; reconnect this device".to_owned(),
        ));
    }
    if credentials.refresh_token.is_empty() {
        return Err(GoogleDriveError::ReauthenticationRequired(
            "Google did not provide a renewable credential; reconnect this device".to_owned(),
        ));
    }

    #[cfg(target_os = "windows")]
    let client_secret = Some(configured_desktop_client_secret()?);
    #[cfg(not(target_os = "windows"))]
    let client_secret: Option<Zeroizing<String>> = None;
    let body = oauth_token_form_body(
        &[
            ("client_id", &client_id),
            ("refresh_token", &credentials.refresh_token),
            ("grant_type", "refresh_token"),
        ],
        client_secret.as_ref().map(|value| value.as_str()),
    );
    let response = http_client()?
        .post(TOKEN_ENDPOINT)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body.to_string())
        .send()
        .await
        .map_err(|_| {
            GoogleDriveError::Transport("Google authorization could not be reached".to_owned())
        })?;

    let mut token: OAuthRefreshResponse = parse_oauth_response(response).await?;
    if token.access_token.is_empty() || !token.token_type.eq_ignore_ascii_case("Bearer") {
        return Err(GoogleDriveError::Remote(
            "Google returned an unusable access credential".to_owned(),
        ));
    }
    if !token.scope.is_empty() && !scope_includes_app_data(&token.scope) {
        return Err(GoogleDriveError::ReauthenticationRequired(
            "Google no longer grants the application-data permission".to_owned(),
        ));
    }

    credentials.access_token = std::mem::take(&mut token.access_token);
    credentials.token_type = "Bearer".to_owned();
    credentials.expires_at = now_epoch_seconds().saturating_add(token.expires_in);
    if !token.scope.is_empty() {
        credentials.scope = std::mem::take(&mut token.scope);
    }
    write_credentials_at_epoch(profile_id, expected_epoch, &credentials)?;
    Ok(Zeroizing::new(credentials.access_token.clone()))
}

async fn access_token(
    profile_id: &str,
    force_refresh: bool,
) -> Result<Zeroizing<String>, GoogleDriveError> {
    let expected_epoch = credential_epoch(profile_id)?;
    let credentials = read_credentials(profile_id)?.ok_or_else(|| {
        GoogleDriveError::NotConnected("Google Drive is not connected for this profile".to_owned())
    })?;
    if credentials.client_id != configured_client_id()? {
        return Err(GoogleDriveError::ReauthenticationRequired(
            "The configured Google OAuth client changed; reconnect this device".to_owned(),
        ));
    }
    if !force_refresh
        && credentials.expires_at > now_epoch_seconds().saturating_add(ACCESS_TOKEN_SKEW_SECONDS)
    {
        return Ok(Zeroizing::new(credentials.access_token.clone()));
    }
    refresh_access_token(profile_id, credentials, expected_epoch).await
}

async fn authorized_send<F>(profile_id: &str, build: F) -> Result<Response, GoogleDriveError>
where
    F: Fn(&Client, &str) -> RequestBuilder,
{
    let client = http_client()?;
    let token = access_token(profile_id, false).await?;
    let response = build(&client, token.as_str()).send().await.map_err(|_| {
        GoogleDriveError::Transport("The Google Drive request could not be completed".to_owned())
    })?;
    if response.status() != StatusCode::UNAUTHORIZED {
        return Ok(response);
    }

    let refreshed = access_token(profile_id, true).await?;
    build(&client, refreshed.as_str())
        .send()
        .await
        .map_err(|_| {
            GoogleDriveError::Transport(
                "The retried Google Drive request could not be completed".to_owned(),
            )
        })
}

#[tauri::command]
pub fn google_drive_config_status() -> GoogleDriveConfigStatus {
    let config = configured_client_id();
    #[cfg(target_os = "windows")]
    let config = config.and_then(|client_id| {
        configured_desktop_client_secret()?;
        Ok(client_id)
    });
    #[cfg(target_os = "ios")]
    let config = config.and_then(|client_id| {
        ios_callback_scheme(&client_id)?;
        Ok(client_id)
    });
    let supported = oauth_supported();
    let problem = if !supported {
        Some(format!(
            "Google Drive OAuth is not implemented for {}",
            platform_name()
        ))
    } else {
        config.as_ref().err().map(ToString::to_string)
    };

    GoogleDriveConfigStatus {
        platform: platform_name(),
        configured: config.is_ok(),
        oauth_supported: supported,
        scope: DRIVE_SCOPE,
        redirect_mode: redirect_mode(),
        problem,
    }
}

#[tauri::command]
pub async fn google_drive_connection_status(
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: String,
) -> Result<GoogleDriveConnectionStatus, GoogleDriveError> {
    require_active_profile(state.inner(), &profile_id).await?;
    let credentials = read_credentials(&profile_id)?;
    let vault_key = read_vault_key(&profile_id)?;
    Ok(GoogleDriveConnectionStatus {
        connected: credentials.is_some(),
        google_account_email: credentials
            .as_ref()
            .and_then(|record| record.google_account_email.clone()),
        can_refresh: credentials
            .as_ref()
            .map(|record| !record.refresh_token.is_empty())
            .unwrap_or(false),
        credential_expires_at: credentials.as_ref().map(|record| record.expires_at),
        vault_key: vault_key_info(vault_key.as_ref()),
    })
}

#[cfg(target_os = "windows")]
struct OAuthProgressGuard;

#[cfg(target_os = "windows")]
impl OAuthProgressGuard {
    fn acquire() -> Result<Self, GoogleDriveError> {
        OAUTH_IN_PROGRESS
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                GoogleDriveError::Conflict(
                    "A Google authorization flow is already in progress".to_owned(),
                )
            })?;
        Ok(Self)
    }
}

#[cfg(target_os = "windows")]
impl Drop for OAuthProgressGuard {
    fn drop(&mut self) {
        OAUTH_IN_PROGRESS.store(false, Ordering::Release);
    }
}

#[cfg(any(target_os = "windows", target_os = "ios"))]
fn oauth_authorization_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> Result<Url, GoogleDriveError> {
    let mut url = Url::parse(AUTHORIZATION_ENDPOINT).map_err(|_| {
        GoogleDriveError::Configuration("The Google authorization endpoint is invalid".to_owned())
    })?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", DRIVE_SCOPE)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("include_granted_scopes", "false");
    Ok(url)
}

#[cfg(target_os = "windows")]
fn single_query_value(url: &Url, name: &str) -> Result<Option<String>, GoogleDriveError> {
    let values: Vec<String> = url
        .query_pairs()
        .filter(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
        .collect();
    if values.len() > 1 {
        return Err(GoogleDriveError::InvalidInput(
            "The OAuth callback contains duplicate parameters".to_owned(),
        ));
    }
    Ok(values.into_iter().next())
}

#[cfg(any(target_os = "windows", target_os = "ios", test))]
enum ParsedOAuthCallback {
    AuthorizationCode(String),
    ProviderError(String),
}

#[cfg(any(target_os = "ios", test))]
fn ios_callback_scheme(client_id: &str) -> Result<String, GoogleDriveError> {
    const SUFFIX: &str = ".apps.googleusercontent.com";
    let client_name = client_id.strip_suffix(SUFFIX).ok_or_else(|| {
        GoogleDriveError::Configuration(
            "The configured iOS Google OAuth client ID is invalid".to_owned(),
        )
    })?;
    if client_name.is_empty()
        || client_name.len() > 384
        || !client_name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(GoogleDriveError::Configuration(
            "The configured iOS Google OAuth client ID is invalid".to_owned(),
        ));
    }
    Ok(format!("com.googleusercontent.apps.{client_name}"))
}

#[cfg(any(target_os = "ios", test))]
fn ios_redirect_uri(client_id: &str) -> Result<String, GoogleDriveError> {
    Ok(format!(
        "{}:/oauth2redirect",
        ios_callback_scheme(client_id)?
    ))
}

#[cfg(any(target_os = "ios", test))]
fn parse_ios_oauth_callback_url(
    callback_url: &str,
    expected_scheme: &str,
    expected_state: &str,
) -> Result<ParsedOAuthCallback, GoogleDriveError> {
    if callback_url.is_empty() || callback_url.len() > 16 * 1024 {
        return Err(GoogleDriveError::InvalidInput(
            "The iOS OAuth callback URL was invalid".to_owned(),
        ));
    }
    let callback = Url::parse(callback_url).map_err(|_| {
        GoogleDriveError::InvalidInput("The iOS OAuth callback URL was invalid".to_owned())
    })?;
    if callback.scheme() != expected_scheme
        || callback.has_host()
        || callback.host_str().is_some()
        || !callback.username().is_empty()
        || callback.password().is_some()
        || callback.port().is_some()
        || callback.path() != "/oauth2redirect"
        || callback.fragment().is_some()
    {
        return Err(GoogleDriveError::InvalidInput(
            "The iOS OAuth callback target did not match".to_owned(),
        ));
    }

    let mut seen_names = HashSet::new();
    let mut returned_state = None;
    let mut code = None;
    let mut provider_error = None;
    for (name, value) in callback.query_pairs() {
        let name = name.into_owned();
        let value = value.into_owned();
        if name.is_empty()
            || name.len() > 256
            || value.len() > 4096
            || name.chars().any(char::is_control)
            || value.chars().any(char::is_control)
            || !seen_names.insert(name.clone())
        {
            return Err(GoogleDriveError::InvalidInput(
                "The iOS OAuth callback contained invalid or duplicate parameters".to_owned(),
            ));
        }
        match name.as_str() {
            "state" => returned_state = Some(value),
            "code" => code = Some(value),
            "error" => provider_error = Some(value),
            _ => {}
        }
    }

    if returned_state.as_deref() != Some(expected_state) {
        return Err(GoogleDriveError::InvalidInput(
            "The iOS OAuth callback state did not match".to_owned(),
        ));
    }
    match (code, provider_error) {
        (Some(_), Some(_)) => Err(GoogleDriveError::InvalidInput(
            "The iOS OAuth callback contained conflicting results".to_owned(),
        )),
        (Some(code), None) => {
            if code.is_empty() {
                return Err(GoogleDriveError::InvalidInput(
                    "The iOS OAuth authorization code was invalid".to_owned(),
                ));
            }
            Ok(ParsedOAuthCallback::AuthorizationCode(code))
        }
        (None, Some(error)) => {
            if error.is_empty() || error.len() > 256 {
                return Err(GoogleDriveError::InvalidInput(
                    "The iOS OAuth provider error was invalid".to_owned(),
                ));
            }
            Ok(ParsedOAuthCallback::ProviderError(error))
        }
        (None, None) => Err(GoogleDriveError::InvalidInput(
            "The iOS OAuth callback omitted its result".to_owned(),
        )),
    }
}

#[cfg(target_os = "windows")]
fn parse_oauth_callback_request(
    request: &[u8],
    expected_state: &str,
) -> Result<ParsedOAuthCallback, GoogleDriveError> {
    if request.len() > 16 * 1024
        || (!request.windows(4).any(|window| window == b"\r\n\r\n")
            && !request.windows(2).any(|window| window == b"\n\n"))
    {
        return Err(GoogleDriveError::InvalidInput(
            "The OAuth callback HTTP request was incomplete".to_owned(),
        ));
    }
    let request = std::str::from_utf8(request).map_err(|_| {
        GoogleDriveError::InvalidInput("The OAuth callback was not valid HTTP".to_owned())
    })?;
    let first_line = request
        .lines()
        .next()
        .ok_or_else(|| GoogleDriveError::InvalidInput("The OAuth callback was empty".to_owned()))?;
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    let version = parts.next().unwrap_or_default();
    if method != "GET"
        || !target.starts_with("/oauth2/callback?")
        || !matches!(version, "HTTP/1.0" | "HTTP/1.1" | "HTTP/2")
        || parts.next().is_some()
    {
        return Err(GoogleDriveError::InvalidInput(
            "The OAuth callback request line was invalid".to_owned(),
        ));
    }

    let callback = Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_| {
        GoogleDriveError::InvalidInput("The OAuth callback URL was invalid".to_owned())
    })?;
    let returned_state = single_query_value(&callback, "state")?.ok_or_else(|| {
        GoogleDriveError::InvalidInput("The OAuth callback omitted its state".to_owned())
    })?;
    if returned_state != expected_state {
        return Err(GoogleDriveError::InvalidInput(
            "The OAuth callback state did not match".to_owned(),
        ));
    }

    let error = single_query_value(&callback, "error")?;
    let code = single_query_value(&callback, "code")?;
    match (code, error) {
        (Some(_), Some(_)) => Err(GoogleDriveError::InvalidInput(
            "The OAuth callback contained conflicting results".to_owned(),
        )),
        (None, Some(error)) => {
            if error.is_empty() || error.len() > 256 || error.chars().any(char::is_control) {
                return Err(GoogleDriveError::InvalidInput(
                    "The OAuth provider error was invalid".to_owned(),
                ));
            }
            Ok(ParsedOAuthCallback::ProviderError(error))
        }
        (Some(code), None) => {
            if code.is_empty() || code.len() > 4096 || code.chars().any(char::is_control) {
                return Err(GoogleDriveError::InvalidInput(
                    "The OAuth authorization code was invalid".to_owned(),
                ));
            }
            Ok(ParsedOAuthCallback::AuthorizationCode(code))
        }
        (None, None) => Err(GoogleDriveError::InvalidInput(
            "The OAuth callback omitted its result".to_owned(),
        )),
    }
}

#[cfg(target_os = "windows")]
async fn read_oauth_http_request(
    stream: &mut tokio::net::TcpStream,
    deadline: tokio::time::Instant,
) -> Result<Vec<u8>, GoogleDriveError> {
    use tokio::io::AsyncReadExt;

    tokio::time::timeout_at(deadline, async {
        let mut request = Vec::with_capacity(2048);
        let mut chunk = [0_u8; 2048];
        loop {
            let length = stream.read(&mut chunk).await.map_err(|_| {
                GoogleDriveError::Transport("The OAuth callback was unreadable".to_owned())
            })?;
            if length == 0 {
                return Err(GoogleDriveError::InvalidInput(
                    "The OAuth callback ended before its headers".to_owned(),
                ));
            }
            request.extend_from_slice(&chunk[..length]);
            if request.len() > 16 * 1024 {
                return Err(GoogleDriveError::InvalidInput(
                    "The OAuth callback exceeded the HTTP header limit".to_owned(),
                ));
            }
            if request.windows(4).any(|window| window == b"\r\n\r\n")
                || request.windows(2).any(|window| window == b"\n\n")
            {
                return Ok(request);
            }
        }
    })
    .await
    .map_err(|_| GoogleDriveError::Transport("The OAuth callback timed out".to_owned()))?
}

#[cfg(target_os = "windows")]
async fn receive_oauth_callback(
    listener: tokio::net::TcpListener,
    expected_state: &str,
) -> Result<String, GoogleDriveError> {
    use tokio::io::AsyncWriteExt;

    const ACCEPTED: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n<!doctype html><title>GrindFlop</title><p>Google Drive authorization was received. You can return to GrindFlop.</p>";
    const DENIED: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n<!doctype html><title>GrindFlop</title><p>Google Drive was not connected. You can close this window.</p>";
    const INVALID: &[u8] = b"HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n<!doctype html><title>GrindFlop</title><p>This was not a valid GrindFlop authorization callback.</p>";

    let overall_deadline = tokio::time::Instant::now() + OAUTH_TIMEOUT;
    loop {
        let (mut stream, peer) = tokio::time::timeout_at(overall_deadline, listener.accept())
            .await
            .map_err(|_| GoogleDriveError::Transport("Google authorization timed out".to_owned()))?
            .map_err(|_| {
                GoogleDriveError::Transport(
                    "The local OAuth callback could not be received".to_owned(),
                )
            })?;
        if !peer.ip().is_loopback() {
            continue;
        }

        let connection_deadline = std::cmp::min(
            overall_deadline,
            tokio::time::Instant::now() + Duration::from_secs(5),
        );
        let parsed = match read_oauth_http_request(&mut stream, connection_deadline).await {
            Ok(request) => parse_oauth_callback_request(&request, expected_state),
            Err(error) => Err(error),
        };
        match parsed {
            Ok(ParsedOAuthCallback::AuthorizationCode(code)) => {
                let _ = stream.write_all(ACCEPTED).await;
                return Ok(code);
            }
            Ok(ParsedOAuthCallback::ProviderError(error)) => {
                let _ = stream.write_all(DENIED).await;
                return Err(GoogleDriveError::Remote(if error == "access_denied" {
                    "Google Drive authorization was cancelled".to_owned()
                } else {
                    "Google Drive authorization failed".to_owned()
                }));
            }
            Err(_) => {
                let _ = stream.write_all(INVALID).await;
                // Local browsers and security software can probe a newly-opened
                // loopback port. Ignore invalid requests and keep waiting for the
                // callback carrying the unguessable state value.
            }
        }
    }
}

#[cfg(any(target_os = "windows", target_os = "ios"))]
async fn exchange_authorization_code(
    profile_id: &str,
    client_id: &str,
    client_secret: Option<&str>,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
    expected_epoch: u64,
) -> Result<(), GoogleDriveError> {
    let body = oauth_token_form_body(
        &[
            ("client_id", client_id),
            ("code", code),
            ("code_verifier", verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri),
        ],
        client_secret,
    );
    let response = http_client()?
        .post(TOKEN_ENDPOINT)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body.to_string())
        .send()
        .await
        .map_err(|_| {
            GoogleDriveError::Transport("Google authorization could not be reached".to_owned())
        })?;
    let mut token: OAuthTokenResponse = parse_oauth_response(response).await?;
    let refresh_token = token.refresh_token.take().filter(|value| !value.is_empty()).ok_or_else(|| {
        GoogleDriveError::ReauthenticationRequired(
            "Google did not return an offline refresh credential; disconnect the app in your Google account and try again"
                .to_owned(),
        )
    })?;
    if token.access_token.is_empty() || !token.token_type.eq_ignore_ascii_case("Bearer") {
        return Err(GoogleDriveError::Remote(
            "Google returned an unusable access credential".to_owned(),
        ));
    }
    if !token.scope.is_empty() && !scope_includes_app_data(&token.scope) {
        return Err(GoogleDriveError::ReauthenticationRequired(
            "Google did not grant the application-data permission".to_owned(),
        ));
    }

    let record = OAuthCredentialRecord {
        schema_version: RECORD_SCHEMA_VERSION,
        client_id: client_id.to_owned(),
        access_token: std::mem::take(&mut token.access_token),
        refresh_token,
        token_type: "Bearer".to_owned(),
        scope: if token.scope.is_empty() {
            DRIVE_SCOPE.to_owned()
        } else {
            std::mem::take(&mut token.scope)
        },
        expires_at: now_epoch_seconds().saturating_add(token.expires_in),
        google_account_email: None,
    };
    write_credentials_at_epoch(profile_id, expected_epoch, &record)
}

async fn refresh_google_account_email(profile_id: &str) -> Result<(), GoogleDriveError> {
    let expected_epoch = credential_epoch(profile_id)?;
    let mut url = Url::parse(DRIVE_ABOUT_ENDPOINT).map_err(|_| {
        GoogleDriveError::Configuration("The Google Drive account endpoint is invalid".to_owned())
    })?;
    url.query_pairs_mut()
        .append_pair("fields", "user(emailAddress)");
    let url = url.to_string();
    let response = authorized_send(profile_id, |client, token| {
        client.get(&url).bearer_auth(token)
    })
    .await?;
    let about: DriveAbout = parse_json_response(response).await?;
    let email = about.user.email_address.trim();
    if email.is_empty() || email.len() > 320 || email.chars().any(char::is_control) {
        return Err(GoogleDriveError::Remote(
            "Google Drive returned an invalid account identity".to_owned(),
        ));
    }
    let mut credentials = read_credentials(profile_id)?.ok_or_else(|| {
        GoogleDriveError::NotConnected("Google Drive is not connected for this profile".to_owned())
    })?;
    credentials.google_account_email = Some(email.to_owned());
    write_credentials_at_epoch(profile_id, expected_epoch, &credentials)
}

#[tauri::command]
pub async fn google_drive_connect(
    app: tauri::AppHandle,
    app_state: tauri::State<'_, crate::state::AppState>,
    profile_id: String,
) -> Result<GoogleDriveConnectionStatus, GoogleDriveError> {
    require_active_profile(app_state.inner(), &profile_id).await?;

    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_opener::OpenerExt;

        if crate::windows_instance::WindowsInstance::current().is_manager() {
            return Err(GoogleDriveError::Unsupported(
                "Google Drive must be connected from a GrindFlop account window, not the instance manager"
                    .to_owned(),
            ));
        }
        let _guard = OAuthProgressGuard::acquire()?;
        let expected_epoch = credential_epoch(&profile_id)?;
        let client_id = configured_client_id()?;
        let client_secret = configured_desktop_client_secret()?;
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| {
                GoogleDriveError::Transport(
                    "GrindFlop could not open a local OAuth callback port".to_owned(),
                )
            })?;
        let port = listener
            .local_addr()
            .map_err(|_| {
                GoogleDriveError::Transport(
                    "GrindFlop could not determine its OAuth callback port".to_owned(),
                )
            })?
            .port();
        let redirect_uri = format!("http://127.0.0.1:{port}/oauth2/callback");

        let verifier_bytes = Zeroizing::new(random_bytes(64)?);
        let verifier = Zeroizing::new(URL_SAFE_NO_PAD.encode(verifier_bytes.as_slice()));
        let challenge_hash = digest::digest(&digest::SHA256, verifier.as_bytes());
        let challenge = URL_SAFE_NO_PAD.encode(challenge_hash.as_ref());
        let state = URL_SAFE_NO_PAD.encode(random_bytes(32)?);
        let authorization_url =
            oauth_authorization_url(&client_id, &redirect_uri, &state, &challenge)?;

        app.opener()
            .open_url(authorization_url.as_str(), None::<&str>)
            .map_err(|_| {
                GoogleDriveError::Transport(
                    "The system browser could not be opened for Google authorization".to_owned(),
                )
            })?;

        let code = Zeroizing::new(receive_oauth_callback(listener, &state).await?);
        exchange_authorization_code(
            &profile_id,
            &client_id,
            Some(client_secret.as_str()),
            &redirect_uri,
            code.as_str(),
            verifier.as_str(),
            expected_epoch,
        )
        .await?;
        // The Drive About endpoint works with the appData scope and lets the UI
        // identify the connected account without exposing any credential. It is
        // supplementary metadata, so a transient failure must not undo a valid
        // connection.
        let _ = refresh_google_account_email(&profile_id).await;
        google_drive_connection_status(app_state, profile_id).await
    }

    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_ios_google_oauth::{AuthorizationError, IosGoogleOAuthExt};

        let expected_epoch = credential_epoch(&profile_id)?;
        let client_id = configured_client_id()?;
        let callback_scheme = ios_callback_scheme(&client_id)?;
        let redirect_uri = ios_redirect_uri(&client_id)?;

        let verifier_bytes = Zeroizing::new(random_bytes(64)?);
        let verifier = Zeroizing::new(URL_SAFE_NO_PAD.encode(verifier_bytes.as_slice()));
        let challenge_hash = digest::digest(&digest::SHA256, verifier.as_bytes());
        let challenge = URL_SAFE_NO_PAD.encode(challenge_hash.as_ref());
        let state = URL_SAFE_NO_PAD.encode(random_bytes(32)?);
        let authorization_url =
            oauth_authorization_url(&client_id, &redirect_uri, &state, &challenge)?;

        let callback_url = Zeroizing::new(
            app.ios_google_oauth()
                .authorize(authorization_url.as_str(), &callback_scheme)
                .await
                .map_err(|error| match error {
                    AuthorizationError::InProgress => GoogleDriveError::Conflict(
                        "A Google authorization flow is already in progress".to_owned(),
                    ),
                    AuthorizationError::Cancelled => GoogleDriveError::Remote(
                        "Google Drive authorization was cancelled".to_owned(),
                    ),
                    AuthorizationError::TimedOut => {
                        GoogleDriveError::Transport("Google authorization timed out".to_owned())
                    }
                    AuthorizationError::Failed => GoogleDriveError::Transport(
                        "The iOS system authorization session failed".to_owned(),
                    ),
                })?,
        );
        let code =
            match parse_ios_oauth_callback_url(callback_url.as_str(), &callback_scheme, &state)? {
                ParsedOAuthCallback::AuthorizationCode(code) => Zeroizing::new(code),
                ParsedOAuthCallback::ProviderError(error) => {
                    return Err(GoogleDriveError::Remote(if error == "access_denied" {
                        "Google Drive authorization was cancelled".to_owned()
                    } else {
                        "Google Drive authorization failed".to_owned()
                    }));
                }
            };

        exchange_authorization_code(
            &profile_id,
            &client_id,
            None,
            &redirect_uri,
            code.as_str(),
            verifier.as_str(),
            expected_epoch,
        )
        .await?;
        let _ = refresh_google_account_email(&profile_id).await;
        google_drive_connection_status(app_state, profile_id).await
    }

    #[cfg(not(any(target_os = "windows", target_os = "ios")))]
    {
        let _ = app;
        Err(GoogleDriveError::Unsupported(format!(
            "Google Drive OAuth is not implemented for {}",
            platform_name()
        )))
    }
}

#[tauri::command]
pub async fn google_drive_disconnect(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: String,
) -> Result<(), GoogleDriveError> {
    require_active_profile(state.inner(), &profile_id).await?;
    // This is intentionally a local-device disconnect. It does not revoke the
    // Google project grant and does not delete the vault key or remote files.
    // Advancing the epoch before cancelling the native session prevents a late
    // callback/token exchange from restoring credentials after disconnect.
    delete_credentials_and_advance_epoch(&profile_id)?;

    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_ios_google_oauth::IosGoogleOAuthExt;
        let _ = app.ios_google_oauth().cancel().await;
    }
    #[cfg(not(target_os = "ios"))]
    let _ = app;

    Ok(())
}

#[tauri::command]
pub async fn google_drive_vault_key_status(
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: String,
) -> Result<VaultKeyInfo, GoogleDriveError> {
    require_active_profile(state.inner(), &profile_id).await?;
    let key = read_vault_key(&profile_id)?;
    Ok(vault_key_info(key.as_ref()))
}

#[tauri::command]
pub async fn google_drive_vault_key_create(
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: String,
) -> Result<VaultKeyInfo, GoogleDriveError> {
    require_active_profile(state.inner(), &profile_id).await?;
    if let Some(existing) = read_vault_key(&profile_id)? {
        return Ok(vault_key_info(Some(&existing)));
    }
    let record = VaultKeyRecord {
        schema_version: RECORD_SCHEMA_VERSION,
        key: random_bytes(VAULT_KEY_SIZE)?,
    };
    write_secure_record(&profile_id, VAULT_KEY_RECORD_KIND, &record)?;
    Ok(vault_key_info(Some(&record)))
}

#[tauri::command]
pub async fn google_drive_vault_key_import(
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: String,
    key_base64: String,
) -> Result<VaultKeyInfo, GoogleDriveError> {
    require_active_profile(state.inner(), &profile_id).await?;
    let mut encoded = Zeroizing::new(key_base64);
    validate_base64url_size(
        &encoded,
        VAULT_KEY_SIZE,
        "The pairing vault key must contain exactly 32 bytes",
    )?;
    let decoded = URL_SAFE_NO_PAD.decode(encoded.as_bytes()).map_err(|_| {
        GoogleDriveError::InvalidInput("The pairing vault key is not valid base64url".to_owned())
    });
    encoded.zeroize();
    let key = Zeroizing::new(decoded?);
    if key.len() != VAULT_KEY_SIZE {
        return Err(GoogleDriveError::InvalidInput(
            "The pairing vault key must contain exactly 32 bytes".to_owned(),
        ));
    }
    let existing = read_vault_key(&profile_id)?;
    if let Some(existing) = existing {
        if existing.key != key.as_slice() {
            return Err(GoogleDriveError::Conflict(
                "This profile already has a different vault key; replace it only through the explicit recovery flow"
                    .to_owned(),
            ));
        }
        return Ok(vault_key_info(Some(&existing)));
    }

    let record = VaultKeyRecord {
        schema_version: RECORD_SCHEMA_VERSION,
        key: key.to_vec(),
    };
    write_secure_record(&profile_id, VAULT_KEY_RECORD_KIND, &record)?;
    Ok(vault_key_info(Some(&record)))
}

#[tauri::command]
pub async fn google_drive_vault_key_export_for_pairing(
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: String,
    acknowledge_secret_exposure: bool,
) -> Result<PairingVaultKey, GoogleDriveError> {
    require_active_profile(state.inner(), &profile_id).await?;
    if !acknowledge_secret_exposure {
        return Err(GoogleDriveError::InvalidInput(
            "Pairing export requires explicit confirmation".to_owned(),
        ));
    }
    let record = read_vault_key(&profile_id)?.ok_or_else(|| {
        GoogleDriveError::NotConnected("No sync vault key exists for this profile".to_owned())
    })?;
    Ok(PairingVaultKey {
        encoding: "base64url-no-padding",
        key: URL_SAFE_NO_PAD.encode(&record.key),
        fingerprint: key_fingerprint(&record.key),
    })
}

#[tauri::command]
pub async fn google_drive_vault_key_delete(
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: String,
    confirm_local_key_removal: bool,
) -> Result<(), GoogleDriveError> {
    require_active_profile(state.inner(), &profile_id).await?;
    if !confirm_local_key_removal {
        return Err(GoogleDriveError::InvalidInput(
            "Removing this device's vault key requires explicit confirmation".to_owned(),
        ));
    }
    // Local-only: remote encrypted packages and the Google OAuth grant remain.
    // The key can be restored by pairing again from an enrolled device.
    delete_secure_record(&profile_id, VAULT_KEY_RECORD_KIND)
}

#[tauri::command]
pub async fn google_drive_encrypt(
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: String,
    plaintext_base64: String,
    aad: String,
) -> Result<EncryptedEnvelope, GoogleDriveError> {
    require_active_profile(state.inner(), &profile_id).await?;
    let aad = crypto_aad(&profile_id, &aad)?;
    let mut encoded = Zeroizing::new(plaintext_base64);
    validate_base64url_size(
        &encoded,
        INLINE_CRYPTO_LIMIT,
        "Inline encryption is limited to 8 MiB; use staged native files for media",
    )?;
    let decoded = URL_SAFE_NO_PAD.decode(encoded.as_bytes()).map_err(|_| {
        GoogleDriveError::InvalidInput("The plaintext is not valid base64url".to_owned())
    });
    encoded.zeroize();
    let mut plaintext = Zeroizing::new(decoded?);
    if plaintext.len() > INLINE_CRYPTO_LIMIT {
        return Err(GoogleDriveError::InvalidInput(
            "Inline encryption is limited to 8 MiB; use staged native files for media".to_owned(),
        ));
    }
    let key = read_vault_key(&profile_id)?.ok_or_else(|| {
        GoogleDriveError::NotConnected("No sync vault key exists for this profile".to_owned())
    })?;
    let mut nonce = [0_u8; GCM_NONCE_SIZE];
    SystemRandom::new().fill(&mut nonce).map_err(|_| {
        GoogleDriveError::Integrity("The operating system random generator failed".to_owned())
    })?;
    let encrypted = encrypt_with_key(&key.key, &plaintext, &aad, nonce)?;
    plaintext.zeroize();
    Ok(EncryptedEnvelope {
        version: 1,
        algorithm: "A256GCM".to_owned(),
        nonce: URL_SAFE_NO_PAD.encode(nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(encrypted),
    })
}

#[tauri::command]
pub async fn google_drive_decrypt(
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: String,
    envelope: EncryptedEnvelope,
    aad: String,
) -> Result<String, GoogleDriveError> {
    require_active_profile(state.inner(), &profile_id).await?;
    let aad = crypto_aad(&profile_id, &aad)?;
    if envelope.version != 1 || envelope.algorithm != "A256GCM" {
        return Err(GoogleDriveError::Integrity(
            "The encrypted sync package uses an unsupported format".to_owned(),
        ));
    }
    validate_base64url_size(
        &envelope.nonce,
        GCM_NONCE_SIZE,
        "The encrypted sync package nonce has the wrong size",
    )?;
    let nonce = URL_SAFE_NO_PAD
        .decode(envelope.nonce.as_bytes())
        .map_err(|_| {
            GoogleDriveError::Integrity("The encrypted sync package nonce is invalid".to_owned())
        })?;
    let nonce: [u8; GCM_NONCE_SIZE] = nonce.try_into().map_err(|_| {
        GoogleDriveError::Integrity(
            "The encrypted sync package nonce has the wrong size".to_owned(),
        )
    })?;
    validate_base64url_size(
        &envelope.ciphertext,
        INLINE_CRYPTO_LIMIT + aead::AES_256_GCM.tag_len(),
        "Inline decryption is limited to 8 MiB; use staged native files for media",
    )?;
    let mut ciphertext = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(envelope.ciphertext.as_bytes())
            .map_err(|_| {
                GoogleDriveError::Integrity("The encrypted sync package body is invalid".to_owned())
            })?,
    );
    if ciphertext.len() > INLINE_CRYPTO_LIMIT + aead::AES_256_GCM.tag_len() {
        return Err(GoogleDriveError::InvalidInput(
            "Inline decryption is limited to 8 MiB; use staged native files for media".to_owned(),
        ));
    }
    let key = read_vault_key(&profile_id)?.ok_or_else(|| {
        GoogleDriveError::NotConnected("No sync vault key exists for this profile".to_owned())
    })?;
    let plaintext = Zeroizing::new(decrypt_with_key(&key.key, &ciphertext, &aad, nonce)?);
    ciphertext.zeroize();
    Ok(URL_SAFE_NO_PAD.encode(plaintext.as_slice()))
}

#[tauri::command]
pub async fn google_drive_list_app_data(
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: String,
    page_token: Option<String>,
) -> Result<DriveFileList, GoogleDriveError> {
    require_active_profile(state.inner(), &profile_id).await?;
    if let Some(token) = &page_token {
        validate_page_token(token)?;
    }
    let mut url = Url::parse(DRIVE_FILES_ENDPOINT).map_err(|_| {
        GoogleDriveError::Configuration("The Google Drive files endpoint is invalid".to_owned())
    })?;
    url.query_pairs_mut()
        .append_pair("spaces", "appDataFolder")
        .append_pair("q", "'appDataFolder' in parents and trashed = false")
        .append_pair("pageSize", "1000")
        .append_pair(
            "fields",
            "nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)",
        );
    if let Some(token) = page_token {
        url.query_pairs_mut().append_pair("pageToken", &token);
    }
    let url = url.to_string();
    let response = authorized_send(&profile_id, |client, token| {
        client.get(&url).bearer_auth(token)
    })
    .await?;
    parse_json_response(response).await
}

#[tauri::command]
pub async fn google_drive_get_start_page_token(
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: String,
) -> Result<DriveStartPageToken, GoogleDriveError> {
    require_active_profile(state.inner(), &profile_id).await?;
    let mut url = Url::parse(DRIVE_START_TOKEN_ENDPOINT).map_err(|_| {
        GoogleDriveError::Configuration("The Google Drive changes endpoint is invalid".to_owned())
    })?;
    url.query_pairs_mut()
        .append_pair("spaces", "appDataFolder")
        .append_pair("fields", "startPageToken");
    let url = url.to_string();
    let response = authorized_send(&profile_id, |client, token| {
        client.get(&url).bearer_auth(token)
    })
    .await?;
    parse_json_response(response).await
}

#[tauri::command]
pub async fn google_drive_list_changes(
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: String,
    page_token: String,
) -> Result<DriveChangeList, GoogleDriveError> {
    require_active_profile(state.inner(), &profile_id).await?;
    validate_page_token(&page_token)?;
    let mut url = Url::parse(DRIVE_CHANGES_ENDPOINT).map_err(|_| {
        GoogleDriveError::Configuration("The Google Drive changes endpoint is invalid".to_owned())
    })?;
    url.query_pairs_mut()
        .append_pair("pageToken", &page_token)
        .append_pair("spaces", "appDataFolder")
        .append_pair("includeRemoved", "true")
        .append_pair("pageSize", "1000")
        .append_pair(
            "fields",
            "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,size,modifiedTime,md5Checksum))",
        );
    let url = url.to_string();
    let response = authorized_send(&profile_id, |client, token| {
        client.get(&url).bearer_auth(token)
    })
    .await?;
    parse_json_response(response).await
}

#[tauri::command]
pub async fn google_drive_download_app_data(
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: String,
    file_id: String,
) -> Result<DriveDownload, GoogleDriveError> {
    require_active_profile(state.inner(), &profile_id).await?;
    let file_id = validate_file_id(&file_id)?.to_owned();
    let mut url = Url::parse(&format!("{DRIVE_FILES_ENDPOINT}/{file_id}")).map_err(|_| {
        GoogleDriveError::Configuration("The Google Drive download endpoint is invalid".to_owned())
    })?;
    url.query_pairs_mut().append_pair("alt", "media");
    let url = url.to_string();
    let response = authorized_send(&profile_id, |client, token| {
        client.get(&url).bearer_auth(token)
    })
    .await?;
    if !response.status().is_success() {
        return Err(remote_error(response.status(), response.headers()));
    }
    if response.content_length().unwrap_or(0) > INLINE_DOWNLOAD_LIMIT as u64 {
        return Err(GoogleDriveError::InvalidInput(
            "Inline downloads are limited to 8 MiB; use staged native files for media".to_owned(),
        ));
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let mut data = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            GoogleDriveError::Transport("The Google Drive file download was interrupted".to_owned())
        })?;
        if data.len().saturating_add(chunk.len()) > INLINE_DOWNLOAD_LIMIT {
            data.zeroize();
            return Err(GoogleDriveError::InvalidInput(
                "Inline downloads are limited to 8 MiB; use staged native files for media"
                    .to_owned(),
            ));
        }
        data.extend_from_slice(&chunk);
    }
    let data_base64 = URL_SAFE_NO_PAD.encode(&data);
    data.zeroize();
    Ok(DriveDownload {
        content_type,
        data_base64,
    })
}

fn multipart_upload_body(name: &str, data: &[u8]) -> Result<(String, Vec<u8>), GoogleDriveError> {
    let boundary = format!("freegrind-{}", URL_SAFE_NO_PAD.encode(random_bytes(18)?));
    let metadata = serde_json::to_vec(&serde_json::json!({
        "name": name,
        "parents": ["appDataFolder"]
    }))
    .map_err(|_| {
        GoogleDriveError::InvalidInput("The Drive upload metadata could not be encoded".to_owned())
    })?;
    let mut body = Vec::with_capacity(metadata.len() + data.len() + 256);
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n").as_bytes(),
    );
    body.extend_from_slice(&metadata);
    body.extend_from_slice(
        format!("\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes(),
    );
    body.extend_from_slice(data);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    Ok((format!("multipart/related; boundary={boundary}"), body))
}

#[tauri::command]
pub async fn google_drive_create_app_data(
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: String,
    name: String,
    data_base64: String,
) -> Result<DriveFileMetadata, GoogleDriveError> {
    require_active_profile(state.inner(), &profile_id).await?;
    let name = validate_file_name(&name)?.to_owned();
    let mut encoded = Zeroizing::new(data_base64);
    validate_base64url_size(
        &encoded,
        INLINE_UPLOAD_LIMIT,
        "Inline uploads are limited to 5 MiB; use a resumable staged-file upload for media",
    )?;
    let data = URL_SAFE_NO_PAD.decode(encoded.as_bytes()).map_err(|_| {
        GoogleDriveError::InvalidInput("The upload body is not valid base64url".to_owned())
    });
    encoded.zeroize();
    let mut data = Zeroizing::new(data?);
    if data.len() > INLINE_UPLOAD_LIMIT {
        return Err(GoogleDriveError::InvalidInput(
            "Inline uploads are limited to 5 MiB; use a resumable staged-file upload for media"
                .to_owned(),
        ));
    }
    let (content_type, mut body) = multipart_upload_body(&name, &data)?;
    data.zeroize();
    let mut url = Url::parse(DRIVE_UPLOAD_ENDPOINT).map_err(|_| {
        GoogleDriveError::Configuration("The Google Drive upload endpoint is invalid".to_owned())
    })?;
    url.query_pairs_mut()
        .append_pair("uploadType", "multipart")
        .append_pair("fields", "id,name,mimeType,size,modifiedTime,md5Checksum");
    let url = url.to_string();
    let response = authorized_send(&profile_id, |client, token| {
        client
            .post(&url)
            .bearer_auth(token)
            .header(header::CONTENT_TYPE, &content_type)
            .body(body.clone())
    })
    .await;
    body.zeroize();
    parse_json_response(response?).await
}

#[tauri::command]
pub async fn google_drive_update_app_data(
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: String,
    file_id: String,
    data_base64: String,
    expected_etag: Option<String>,
) -> Result<DriveFileMetadata, GoogleDriveError> {
    require_active_profile(state.inner(), &profile_id).await?;
    let file_id = validate_file_id(&file_id)?.to_owned();
    if let Some(etag) = &expected_etag {
        if etag.is_empty() || etag.len() > 512 || etag.chars().any(char::is_control) {
            return Err(GoogleDriveError::InvalidInput(
                "The expected Google Drive ETag is invalid".to_owned(),
            ));
        }
    }
    let mut encoded = Zeroizing::new(data_base64);
    validate_base64url_size(
        &encoded,
        INLINE_UPLOAD_LIMIT,
        "Inline uploads are limited to 5 MiB; use a resumable staged-file upload for media",
    )?;
    let data = URL_SAFE_NO_PAD.decode(encoded.as_bytes()).map_err(|_| {
        GoogleDriveError::InvalidInput("The upload body is not valid base64url".to_owned())
    });
    encoded.zeroize();
    let mut data = Zeroizing::new(data?);
    if data.len() > INLINE_UPLOAD_LIMIT {
        return Err(GoogleDriveError::InvalidInput(
            "Inline uploads are limited to 5 MiB; use a resumable staged-file upload for media"
                .to_owned(),
        ));
    }
    let mut url = Url::parse(&format!("{DRIVE_UPLOAD_ENDPOINT}/{file_id}")).map_err(|_| {
        GoogleDriveError::Configuration("The Google Drive upload endpoint is invalid".to_owned())
    })?;
    url.query_pairs_mut()
        .append_pair("uploadType", "media")
        .append_pair("fields", "id,name,mimeType,size,modifiedTime,md5Checksum");
    let url = url.to_string();
    let response = authorized_send(&profile_id, |client, token| {
        let mut request = client
            .patch(&url)
            .bearer_auth(token)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .body(data.to_vec());
        if let Some(etag) = &expected_etag {
            request = request.header(header::IF_MATCH, etag);
        }
        request
    })
    .await;
    data.zeroize();
    parse_json_response(response?).await
}

#[tauri::command]
pub async fn google_drive_delete_app_data(
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: String,
    file_id: String,
    confirm_permanent_delete: bool,
) -> Result<(), GoogleDriveError> {
    require_active_profile(state.inner(), &profile_id).await?;
    let file_id = validate_file_id(&file_id)?.to_owned();
    if !confirm_permanent_delete {
        return Err(GoogleDriveError::InvalidInput(
            "Deleting appDataFolder files is permanent and requires explicit confirmation"
                .to_owned(),
        ));
    }
    let url = format!("{DRIVE_FILES_ENDPOINT}/{file_id}");
    let response = authorized_send(&profile_id, |client, token| {
        client.delete(&url).bearer_auth(token)
    })
    .await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(remote_error(response.status(), response.headers()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_ids_are_strictly_numeric() {
        assert_eq!(validate_profile_id("12345").unwrap(), "12345");
        assert!(validate_profile_id("").is_err());
        assert!(validate_profile_id("account-a").is_err());
        assert!(validate_profile_id("12/34").is_err());
        assert!(validate_profile_id(" 12345 ").is_err());
    }

    #[test]
    fn profile_guard_requires_the_authenticated_profile() {
        assert!(ensure_active_profile("12345", Some("12345")).is_ok());
        assert!(matches!(
            ensure_active_profile("12345", None),
            Err(GoogleDriveError::NotConnected(_))
        ));
        assert!(matches!(
            ensure_active_profile("12345", Some("67890")),
            Err(GoogleDriveError::NotConnected(_))
        ));
        assert!(matches!(
            ensure_active_profile("invalid", Some("invalid")),
            Err(GoogleDriveError::InvalidInput(_))
        ));
    }

    #[test]
    fn configured_oauth_client_ids_use_google_generated_syntax() {
        assert!(
            validate_configured_client_id("1234567890-AbCdEf-987.apps.googleusercontent.com")
                .is_ok()
        );
        for invalid in [
            ".apps.googleusercontent.com".to_owned(),
            "client_name.apps.googleusercontent.com".to_owned(),
            "client.name.apps.googleusercontent.com".to_owned(),
            "client/name.apps.googleusercontent.com".to_owned(),
            "client.apps.googleusercontent.example".to_owned(),
            format!("{}.apps.googleusercontent.com", "a".repeat(513)),
        ] {
            assert!(
                validate_configured_client_id(&invalid).is_err(),
                "accepted invalid client ID: {invalid}"
            );
        }
    }

    #[test]
    fn configured_desktop_client_secrets_are_bounded_graphic_ascii() {
        assert!(validate_configured_client_secret("GOCSPX-fake_desktop-secret").is_ok());
        for invalid in [
            "".to_owned(),
            "contains space".to_owned(),
            "contains\nnewline".to_owned(),
            "contains\ttab".to_owned(),
            "non-ascii-é".to_owned(),
            "a".repeat(513),
        ] {
            assert!(
                validate_configured_client_secret(&invalid).is_err(),
                "accepted an invalid desktop client secret"
            );
        }
    }

    #[test]
    fn oauth_token_forms_include_the_desktop_secret_only_when_supplied() {
        let code_body = oauth_token_form_body(
            &[
                ("client_id", "example.apps.googleusercontent.com"),
                ("code", "fake-code"),
                ("code_verifier", "fake-verifier"),
                ("grant_type", "authorization_code"),
                ("redirect_uri", "http://127.0.0.1:4567/oauth2/callback"),
            ],
            Some("fake-desktop-secret"),
        );
        let code_fields: std::collections::HashMap<_, _> =
            url::form_urlencoded::parse(code_body.as_bytes())
                .into_owned()
                .collect();
        assert_eq!(
            code_fields.get("client_secret").map(String::as_str),
            Some("fake-desktop-secret")
        );

        let refresh_body = oauth_token_form_body(
            &[
                ("client_id", "example.apps.googleusercontent.com"),
                ("refresh_token", "fake-refresh-token"),
                ("grant_type", "refresh_token"),
            ],
            Some("fake-desktop-secret"),
        );
        let refresh_fields: std::collections::HashMap<_, _> =
            url::form_urlencoded::parse(refresh_body.as_bytes())
                .into_owned()
                .collect();
        assert_eq!(
            refresh_fields.get("client_secret").map(String::as_str),
            Some("fake-desktop-secret")
        );

        let ios_body =
            oauth_token_form_body(&[("client_id", "example.apps.googleusercontent.com")], None);
        let ios_fields: std::collections::HashMap<_, _> =
            url::form_urlencoded::parse(ios_body.as_bytes())
                .into_owned()
                .collect();
        assert!(!ios_fields.contains_key("client_secret"));
    }

    #[test]
    fn app_data_scope_must_be_an_exact_grant() {
        assert!(scope_includes_app_data(DRIVE_SCOPE));
        assert!(scope_includes_app_data(&format!("openid {DRIVE_SCOPE}")));
        assert!(!scope_includes_app_data(
            "https://www.googleapis.com/auth/drive.appdata.extra"
        ));
    }

    #[test]
    fn drive_identifiers_and_names_reject_injection() {
        assert!(validate_file_id("abc_DEF-123").is_ok());
        assert!(validate_file_id("abc?alt=media").is_err());
        assert!(validate_file_name("fg-sync-v1-device-1.bin").is_ok());
        assert!(validate_file_name("../secret").is_err());
        assert!(validate_file_name("pack/name").is_err());
    }

    #[test]
    fn encoded_size_limits_are_checked_before_decode() {
        assert_eq!(maximum_base64url_length(1), 2);
        assert_eq!(maximum_base64url_length(2), 3);
        assert_eq!(maximum_base64url_length(3), 4);
        assert!(validate_base64url_size("AAAA", 3, "too large").is_ok());
        assert!(validate_base64url_size("AAAAA", 3, "too large").is_err());
    }

    #[test]
    fn aes_gcm_round_trip_and_aad_authentication() {
        let key = [7_u8; VAULT_KEY_SIZE];
        let nonce = [9_u8; GCM_NONCE_SIZE];
        let plaintext = b"immutable sync package";
        let encrypted = encrypt_with_key(&key, plaintext, b"account:1:pack:2", nonce).unwrap();
        assert_ne!(encrypted, plaintext);
        assert_eq!(
            decrypt_with_key(&key, &encrypted, b"account:1:pack:2", nonce).unwrap(),
            plaintext
        );
        assert!(decrypt_with_key(&key, &encrypted, b"account:2:pack:2", nonce).is_err());
    }

    #[test]
    fn multipart_upload_has_metadata_and_exact_payload() {
        let payload = [0_u8, 1, 2, 0xff];
        let (content_type, body) = multipart_upload_body("fg-sync-v1-pack.bin", &payload).unwrap();
        assert!(content_type.starts_with("multipart/related; boundary=freegrind-"));
        assert!(body
            .windows(b"\"parents\":[\"appDataFolder\"]".len())
            .any(|window| window == b"\"parents\":[\"appDataFolder\"]"));
        assert!(body.windows(payload.len()).any(|window| window == payload));
    }

    #[test]
    fn ios_client_id_maps_to_the_reversed_callback_scheme() {
        assert_eq!(
            ios_callback_scheme("123-abc.apps.googleusercontent.com").unwrap(),
            "com.googleusercontent.apps.123-abc"
        );
        assert_eq!(
            ios_redirect_uri("123-abc.apps.googleusercontent.com").unwrap(),
            "com.googleusercontent.apps.123-abc:/oauth2redirect"
        );
        assert!(ios_callback_scheme(".apps.googleusercontent.com").is_err());
        assert!(ios_callback_scheme("ABC-123.apps.googleusercontent.com").is_err());
        assert!(ios_callback_scheme("123_bad.apps.googleusercontent.com").is_err());
        assert!(ios_callback_scheme("123-abc.example.com").is_err());
    }

    #[test]
    fn ios_oauth_callback_requires_the_exact_target_state_and_single_result() {
        let scheme = "com.googleusercontent.apps.123-abc";
        let callback = format!("{scheme}:/oauth2redirect?code=secret-code&state=expected");
        match parse_ios_oauth_callback_url(&callback, scheme, "expected").unwrap() {
            ParsedOAuthCallback::AuthorizationCode(code) => assert_eq!(code, "secret-code"),
            ParsedOAuthCallback::ProviderError(_) => panic!("expected an authorization code"),
        }
        let denied = format!("{scheme}:/oauth2redirect?error=access_denied&state=expected");
        match parse_ios_oauth_callback_url(&denied, scheme, "expected").unwrap() {
            ParsedOAuthCallback::ProviderError(error) => assert_eq!(error, "access_denied"),
            ParsedOAuthCallback::AuthorizationCode(_) => panic!("expected a provider error"),
        }

        for invalid in [
            "com.googleusercontent.apps.wrong:/oauth2redirect?code=secret-code&state=expected"
                .to_owned(),
            format!("{scheme}://oauth2redirect?code=secret-code&state=expected"),
            format!("{scheme}:/wrong?code=secret-code&state=expected"),
            format!("{scheme}:/oauth2redirect?code=secret-code&state=expected#fragment"),
            format!("{scheme}:/oauth2redirect?code=secret-code&state=different"),
            format!("{scheme}:/oauth2redirect?code=secret-code&state=expected&state=expected"),
            format!("{scheme}:/oauth2redirect?code=first&code=second&state=expected"),
            format!("{scheme}:/oauth2redirect?code=secret-code&error=access_denied&state=expected"),
            format!("{scheme}:/oauth2redirect?state=expected"),
        ] {
            assert!(
                parse_ios_oauth_callback_url(&invalid, scheme, "expected").is_err(),
                "accepted invalid callback: {invalid}"
            );
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn oauth_url_uses_pkce_and_minimal_scope() {
        let url = oauth_authorization_url(
            "example.apps.googleusercontent.com",
            "http://127.0.0.1:4567/oauth2/callback",
            "state",
            "challenge",
        )
        .unwrap();
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query.get("scope").map(String::as_str), Some(DRIVE_SCOPE));
        assert_eq!(
            query.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert_eq!(
            query.get("access_type").map(String::as_str),
            Some("offline")
        );
        assert!(!query.contains_key("client_secret"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn oauth_callback_requires_complete_http_and_exact_state() {
        let request = b"GET /oauth2/callback?code=secret-code&state=expected HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        match parse_oauth_callback_request(request, "expected").unwrap() {
            ParsedOAuthCallback::AuthorizationCode(code) => assert_eq!(code, "secret-code"),
            ParsedOAuthCallback::ProviderError(_) => panic!("expected an authorization code"),
        }

        assert!(parse_oauth_callback_request(request, "different").is_err());
        assert!(parse_oauth_callback_request(
            b"GET /oauth2/callback?code=secret-code&state=expected HTTP/1.1\r\n",
            "expected"
        )
        .is_err());
        assert!(parse_oauth_callback_request(
            b"GET /oauth2/callback?code=secret-code&state=expected&state=expected HTTP/1.1\r\n\r\n",
            "expected"
        )
        .is_err());
    }
}
