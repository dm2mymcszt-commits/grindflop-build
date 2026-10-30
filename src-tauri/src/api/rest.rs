use wreq::Method;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::str::FromStr;

use tauri::ipc::Response;

use crate::error::AppError;
use crate::state::AppState;

use super::auth::ban_from_error_body;
use super::client::GrindrClient;
use super::client::BASE_URL;
use super::headers::{build_headers, DeviceInfo};

/// Whether the Grindr session token may be attached to `url`.
///
/// Paths are normally relative and get BASE_URL prepended, but callers may
/// pass an absolute URL to reach a third party. Sending the Grindr bearer
/// token to such a host would leak the user's session to it, so auth is
/// attached only for Grindr's own hosts.
fn may_send_grindr_auth(url: &str) -> bool {
    if !url.starts_with("http") {
        // Relative path — BASE_URL is prepended, so it is always Grindr.
        return true;
    }

    let without_scheme = match url.split_once("://") {
        Some((_, rest)) => rest,
        None => return false,
    };
    let authority = without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    // Strip userinfo and port so "grindr.mobi@evil.com" cannot pass.
    let host = authority
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(authority);
    let host = host.split(':').next().unwrap_or_default().to_ascii_lowercase();

    host == "grindr.mobi"
        || host.ends_with(".grindr.mobi")
        || host == "grindr.com"
        || host.ends_with(".grindr.com")
}

/// Where a session is asked for and renewed.
const SESSIONS_PATH: &str = "/v8/sessions";

/// Sign-in and refresh routes. They must never trigger the proactive or
/// on-401 refresh themselves: a refresh goes through them, so doing that
/// would recurse while the refresh lock is held.
fn is_session_path(path: &str) -> bool {
    path == SESSIONS_PATH || path.starts_with("/public/")
}

#[derive(Serialize, Deserialize)]
pub struct RawResponse {
    pub status: u16,
    #[serde(with = "serde_bytes")]
    pub body: Vec<u8>,
}

impl GrindrClient {
    pub(super) async fn ensure_valid_session(&self) -> Result<(), AppError> {
        let needs_refresh = {
            let session = self.session.read().await;
            let expires_at = session.as_ref().map(|s| s.expires_at).unwrap_or(0);
            expires_at > 0 && expires_at < (chrono::Utc::now().timestamp() as u64 + 60)
        };

        if needs_refresh {
            let _lock = self.refresh_lock.lock().await;
            // Double-check after acquiring lock
            let still_needs_refresh = {
                let session = self.session.read().await;
                let expires_at = session.as_ref().map(|s| s.expires_at).unwrap_or(0);
                expires_at > 0 && expires_at < (chrono::Utc::now().timestamp() as u64 + 60)
            };

            if still_needs_refresh {
                let _ = Box::pin(self.refresh_token()).await?;
            }
        }
        Ok(())
    }

    fn apply_headers(
        mut req: wreq::RequestBuilder,
        items: &[(wreq::header::HeaderName, wreq::header::HeaderValue)],
    ) -> wreq::RequestBuilder {
        for (name, value) in items {
            req = req.header(name.clone(), value.clone());
        }
        req
    }

    pub(super) async fn request_json<TReq, TResp>(
        &self,
        method: Method,
        path: &str,
        body: Option<&TReq>,
    ) -> Result<TResp, AppError>
    where
        TReq: Serialize + ?Sized,
        TResp: DeserializeOwned,
    {
        let is_auth_path = is_session_path(path);
        let url = if path.starts_with("http") {
            path.to_owned()
        } else {
            format!("{BASE_URL}{path}")
        };
        #[cfg(debug_assertions)]
        eprintln!("[HTTP] -> {} {}", method, url);

        // Proactive refresh
        if !is_auth_path {
            let _ = self.ensure_valid_session().await;
        }

        // A copy, so the lock is not held while Grindr answers. Held across the
        // request, it made a sign-in or an account switch that wanted to change
        // the device wait for every request in flight, and stalled the ones
        // behind it for good if one of them then had to renew the session.
        let device = self.device.read().await.clone();

        let make_request = |auth_token: Option<String>, device: &DeviceInfo| {
            let headers = build_headers(device, "Free", auth_token.as_deref());
            let mut req = Self::apply_headers(self.http.request(method.clone(), &url), &headers);
            if let Some(body) = body {
                req = req.json(body);
            }
            req
        };

        let auth_token = if may_send_grindr_auth(&url) {
            self.authorization_header().await
        } else {
            None
        };
        let mut response = make_request(auth_token.clone(), &device)
            .send()
            .await
            .map_err(|e| {
                #[cfg(debug_assertions)]
                eprintln!("[HTTP] network error on {} {}: {e}", method, url);
                AppError::Http(e.to_string())
            })?;

        // A 401 from a third-party host says nothing about our Grindr session,
        // and retrying would attach the token to that host.
        if response.status().as_u16() == 401 && !is_auth_path && may_send_grindr_auth(&url) {
            let _lock = self.refresh_lock.lock().await;

            // Check if the token has already been refreshed by someone else since our failed request
            let current_token = self.authorization_header().await;
            if current_token == auth_token {
                let _ = Box::pin(self.refresh_token()).await;
            }

            let new_auth_token = self.authorization_header().await;
            let device = self.device.read().await.clone();
            response = make_request(new_auth_token, &device)
                .send()
                .await
                .map_err(|e| {
                    #[cfg(debug_assertions)]
                    eprintln!("[HTTP] network error on {} {}: {e}", method, url);
                    AppError::Http(e.to_string())
                })?;
        }

        let status = response.status();
        let text = response.text().await.unwrap_or_default();

        #[cfg(debug_assertions)]
        eprintln!("[HTTP] <- {} {} | Status: {}", method, url, status);

        if !status.is_success() {
            #[cfg(debug_assertions)]
            eprintln!(
                "[HTTP] error {} {} -> status={} body={}",
                method, url, status, text
            );
            let json: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();

            // A banned account, and a request Grindr will not trust, get a
            // code of their own from the sign-in route. Kept apart from every
            // other failure so the app can say which one it was.
            if path == SESSIONS_PATH {
                if let Some(ban) = ban_from_error_body(&json) {
                    return Err(AppError::Banned(ban));
                }
            }

            let code = json.get("code").and_then(|c| c.as_i64()).unwrap_or(0) as i32;
            let message = json
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or_else(|| {
                    if text.is_empty() {
                        "Unknown error"
                    } else {
                        &text
                    }
                })
                .to_owned();

            return Err(AppError::Api { code, message });
        }

        let resp = serde_json::from_str::<TResp>(&text).map_err(|e| {
            #[cfg(debug_assertions)]
            eprintln!("[HTTP] JSON decode error on {} {}: {e}", method, url);
            AppError::from(e)
        })?;
        Ok(resp)
    }

    pub(super) async fn request_raw(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
        content_type: Option<&str>,
    ) -> Result<RawResponse, AppError> {
        let is_auth_path = is_session_path(path);
        let url = if path.starts_with("http") {
            path.to_owned()
        } else {
            format!("{BASE_URL}{path}")
        };
        #[cfg(debug_assertions)]
        eprintln!("[HTTP] -> {} {}", method, url);

        // Proactive refresh
        if !is_auth_path {
            let _ = self.ensure_valid_session().await;
        }

        let is_external = path.starts_with("http");
        let auth_token = if !may_send_grindr_auth(&url) {
            // Third-party host: never attach the Grindr session token.
            None
        } else if is_auth_path || is_external {
            self.authorization_header().await
        } else {
            Some(
                self.authorization_header()
                    .await
                    .ok_or_else(|| AppError::Auth("Not logged in".to_owned()))?,
            )
        };

        // A copy, for the reason given in request_json.
        let device = self.device.read().await.clone();

        let make_request = |auth_token: Option<String>, device: &DeviceInfo| {
            let headers = build_headers(device, "Free", auth_token.as_deref());
            let mut req = Self::apply_headers(self.http.request(method.clone(), &url), &headers);

            if let Some(ref body_bytes) = body {
                req = req.body(body_bytes.clone());

                if let Some(content_type) = content_type {
                    req = req.header("Content-Type", content_type);
                } else {
                    req = req.header("Content-Type", "application/json");
                }
            }

            req
        };

        let mut response = make_request(auth_token.clone(), &device).send().await
            .map_err(|e| AppError::Http(e.to_string()))?;
        #[cfg(debug_assertions)]
        eprintln!(
            "[HTTP] <- {} {} | Status: {}",
            method,
            url,
            response.status()
        );

        // A 401 from a third-party host says nothing about our Grindr session,
        // and retrying would attach the token to that host.
        if response.status().as_u16() == 401 && !is_auth_path && may_send_grindr_auth(&url) {
            let _lock = self.refresh_lock.lock().await;

            let current_token = self.authorization_header().await;
            if current_token == auth_token {
                let _ = Box::pin(self.refresh_token()).await;
            }

            let new_auth_token = self.authorization_header().await;
            let device = self.device.read().await.clone();
            response = make_request(new_auth_token, &device).send().await
                .map_err(|e| AppError::Http(e.to_string()))?;
        }

        let status = response.status().as_u16();
        let response_body = response.bytes().await
            .map_err(|e| AppError::Http(e.to_string()))?
            .to_vec();

        Ok(RawResponse {
            status,
            body: response_body,
        })
    }
}

#[tauri::command]
pub async fn request(
    state: tauri::State<'_, AppState>,
    method: String,
    path: String,
    body: Option<Vec<u8>>,
    content_type: Option<String>,
) -> Result<Response, AppError> {
    let method_str = method.clone();
    let method = Method::from_str(&method).map_err(|_| AppError::Api {
        code: 400,
        message: format!("Invalid method: {method_str}"),
    })?;

    let raw = state
        .client()?
        .request_raw(method, &path, body, content_type.as_deref())
        .await;

    let raw = raw?;

    Ok(Response::new(
        rmp_serde::encode::to_vec_named(&raw).map_err(|e| AppError::Http(e.to_string()))?,
    ))
}

#[cfg(test)]
mod tests {
    use super::may_send_grindr_auth;

    #[test]
    fn relative_paths_keep_auth() {
        assert!(may_send_grindr_auth("/v7/profiles/123"));
        assert!(may_send_grindr_auth("/v8/sessions"));
    }

    #[test]
    fn grindr_hosts_keep_auth() {
        assert!(may_send_grindr_auth("https://grindr.mobi/v7/profiles/1"));
        assert!(may_send_grindr_auth("https://cdns.grindr.com/images/x"));
    }

    #[test]
    fn third_party_hosts_lose_auth() {
        assert!(!may_send_grindr_auth("https://api.spotify.com/v1/search?q=a"));
        assert!(!may_send_grindr_auth("https://accounts.spotify.com/api/token"));
    }

    #[test]
    fn lookalike_hosts_lose_auth() {
        // userinfo trick, suffix trick, and embedded-substring trick
        assert!(!may_send_grindr_auth("https://grindr.mobi@evil.com/x"));
        assert!(!may_send_grindr_auth("https://notgrindr.mobi/x"));
        assert!(!may_send_grindr_auth("https://grindr.mobi.evil.com/x"));
        assert!(!may_send_grindr_auth("https://evil.com/?a=grindr.mobi"));
    }

    #[test]
    fn port_and_case_are_handled() {
        assert!(may_send_grindr_auth("https://GRINDR.MOBI:443/v7/profiles/1"));
        assert!(!may_send_grindr_auth("https://evil.com:8443/grindr.mobi"));
    }
}
