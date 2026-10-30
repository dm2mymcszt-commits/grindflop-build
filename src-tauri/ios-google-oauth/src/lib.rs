use std::{error::Error, fmt};

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{PluginHandle, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ios_google_oauth);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorizationError {
    InProgress,
    Cancelled,
    TimedOut,
    Failed,
}

impl fmt::Display for AuthorizationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InProgress => "an iOS Google authorization flow is already in progress",
            Self::Cancelled => "iOS Google authorization was cancelled",
            Self::TimedOut => "iOS Google authorization timed out",
            Self::Failed => "iOS Google authorization failed",
        })
    }
}

impl Error for AuthorizationError {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizeRequest<'a> {
    authorization_url: &'a str,
    callback_scheme: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WebViewAuthorizeRequest<'a> {
    authorization_url: &'a str,
    callback_prefix: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizeResponse {
    callback_url: String,
}

pub struct IosGoogleOAuth<R: Runtime>(PluginHandle<R>);

pub trait IosGoogleOAuthExt<R: Runtime> {
    fn ios_google_oauth(&self) -> &IosGoogleOAuth<R>;
}

impl<R: Runtime, T: Manager<R>> IosGoogleOAuthExt<R> for T {
    fn ios_google_oauth(&self) -> &IosGoogleOAuth<R> {
        self.state::<IosGoogleOAuth<R>>().inner()
    }
}

impl<R: Runtime> IosGoogleOAuth<R> {
    pub async fn authorize(
        &self,
        authorization_url: &str,
        callback_scheme: &str,
    ) -> Result<String, AuthorizationError> {
        let response = self
            .0
            .run_mobile_plugin_async::<AuthorizeResponse>(
                "authorize",
                AuthorizeRequest {
                    authorization_url,
                    callback_scheme,
                },
            )
            .await
            .map_err(map_invoke_error)?;
        Ok(response.callback_url)
    }

    /// Opens `authorization_url` in an in-app web view sheet and returns the
    /// first address starting with `callback_prefix` the page tries to load.
    /// For providers that return to a web address, like Sign in with Apple.
    pub async fn authorize_in_web_view(
        &self,
        authorization_url: &str,
        callback_prefix: &str,
    ) -> Result<String, AuthorizationError> {
        let response = self
            .0
            .run_mobile_plugin_async::<AuthorizeResponse>(
                "authorizeInWebView",
                WebViewAuthorizeRequest {
                    authorization_url,
                    callback_prefix,
                },
            )
            .await
            .map_err(map_invoke_error)?;
        Ok(response.callback_url)
    }

    pub async fn cancel(&self) -> Result<(), AuthorizationError> {
        self.0
            .run_mobile_plugin_async::<()>("cancel", ())
            .await
            .map_err(map_invoke_error)
    }
}

fn map_invoke_error(error: tauri::plugin::mobile::PluginInvokeError) -> AuthorizationError {
    if let tauri::plugin::mobile::PluginInvokeError::InvokeRejected(response) = error {
        return match response.code.as_deref() {
            Some("oauth_in_progress") => AuthorizationError::InProgress,
            Some("oauth_cancelled") => AuthorizationError::Cancelled,
            Some("oauth_timeout") => AuthorizationError::TimedOut,
            _ => AuthorizationError::Failed,
        };
    }
    AuthorizationError::Failed
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = tauri::plugin::Builder::new("ios-google-oauth");

    #[cfg(target_os = "ios")]
    let builder = builder.setup(|app, api| {
        let handle = api.register_ios_plugin(init_plugin_ios_google_oauth)?;
        app.manage(IosGoogleOAuth(handle));
        Ok(())
    });

    builder.build()
}
