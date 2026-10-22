mod api;
mod commands;
mod error;
mod instance_lock;
mod state;
mod storage;
#[cfg(target_os = "windows")]
mod toast_identity;
mod windows_instance;

use std::sync::Arc;

use crate::state::AppState;
use api::client::GrindrClient;
use api::websocket::WsState;

/// Lets the Grindr client tell the window when the standing of the account
/// that is signed in changes.
fn attach_client_events(app: &tauri::App) {
    use tauri::Manager;

    if let Some(client) = app.state::<AppState>().client.as_ref() {
        client.attach_events(app.handle().clone());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install the ring crypto provider for rustls (required for
    // tokio-tungstenite when using rustls TLS backend).
    let _ = rustls::crypto::ring::default_provider().install_default();

    #[cfg(target_os = "windows")]
    {
        windows_instance::WindowsInstance::init();

        // Set explicit AppUserModelID so that Windows notifications don't show as coming from PowerShell
        unsafe {
            let _ = windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(
                &windows::core::HSTRING::from(toast_identity::APP_USER_MODEL_ID),
            );
        }
        // The ID only gets a notification shown if Windows can look it up,
        // so the app registers it for this user itself.
        toast_identity::register(&windows_instance::windows_app_data_root_dir());
    }

    // Keyring initialization should not block app startup.
    // Some environments (including certain Intel macOS setups) can fail keychain init.
    if let Err(e) = storage::init_keyring() {
        eprintln!(
            "Warning: keyring initialization failed (continuing without persisted sessions): {:?}",
            e
        );
    }

    let client = GrindrClient::new().ok();

    // Platform-specific setup for plugins
    #[cfg(not(mobile))]
    {
        #[cfg(target_os = "windows")]
        let instance_lock_guard = match instance_lock::acquire_for_current_child_instance() {
            Ok(guard) => guard,
            Err(error) => {
                eprintln!("GrindFlop failed to acquire child instance lock: {}", error);
                return;
            }
        };

        let context = tauri::generate_context!();
        let builder = tauri::Builder::default();

        let app = builder
            .plugin(tauri_plugin_notification::init())
            .plugin(tauri_plugin_os::init())
            .plugin(tauri_plugin_geolocation::init())
            .plugin(tauri_plugin_fs::init())
            .plugin(tauri_plugin_http::init())
            .plugin(tauri_plugin_sql::Builder::default().build())
            .plugin(tauri_plugin_opener::init())
            .manage(AppState { client })
            .manage(Arc::new(WsState::new()))
            .setup(|app| {
                #[cfg(target_os = "linux")]
                {
                    use tauri::Manager;
                    use webkit2gtk::{PermissionRequestExt, WebViewExt};
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.with_webview(|webview| {
                            webview.inner().connect_permission_request(|_view, request| {
                                request.allow();
                                true
                            });
                        });
                    }
                }

                // WebView2 (Chromium) has its own geolocation/microphone backends wired
                // to the Windows Location service and audio devices, but only
                // prompts/grants them if the host app handles PermissionRequested —
                // without this it silently denies navigator.geolocation and
                // navigator.mediaDevices.getUserMedia calls instead of showing the
                // OS prompt.
                #[cfg(target_os = "windows")]
                {
                    use tauri::webview::Color;
                    use tauri::Manager;
                    use windows::Win32::Foundation::HWND;
                    use windows::Win32::Graphics::Dwm::{
                        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE,
                        DWMWCP_DONOTROUND,
                    };
                    use webview2_com::Microsoft::Web::WebView2::Win32::{
                        COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                    };
                    use webview2_com::PermissionRequestedEventHandler;

                    if let Some(win) = app.get_webview_window("main") {
                        // Set webview background to fully transparent so the rounded
                        // CSS corners don't show a white rectangle behind them.
                        let _ = win.set_background_color(Some(Color(0, 0, 0, 0)));

                        // Remove the 1px border that Windows 11 draws around transparent layered windows
                        if let Ok(hwnd) = win.hwnd() {
                            let hwnd_val = HWND(hwnd.0 as _);
                            unsafe {
                                // Prevent Windows 11 DWM from drawing native rounded corners (which often draws a 1px border line)
                                let corner_preference = DWMWCP_DONOTROUND;
                                let _ = DwmSetWindowAttribute(
                                    hwnd_val,
                                    DWMWA_WINDOW_CORNER_PREFERENCE,
                                    &corner_preference as *const _ as *const _,
                                    std::mem::size_of::<i32>() as u32,
                                );

                                // Set border color to NONE to suppress the 1px border
                                let color = 0xFFFFFFFE_u32; // DWMWA_COLOR_NONE
                                let _ = DwmSetWindowAttribute(
                                    hwnd_val,
                                    DWMWA_BORDER_COLOR,
                                    &color as *const u32 as *const _,
                                    std::mem::size_of::<u32>() as u32,
                                );
                            }
                        }

                        // Auto-grant geolocation and microphone permissions
                        let _ = win.with_webview(|webview| {
                            let Ok(core) = (unsafe { webview.controller().CoreWebView2() }) else {
                                return;
                            };
                            let mut token = Default::default();
                            unsafe {
                                let _ = core.add_PermissionRequested(
                                    &PermissionRequestedEventHandler::create(Box::new(
                                        |_sender, args| {
                                            let Some(args) = args else { return Ok(()) };
                                            let mut kind = Default::default();
                                            args.PermissionKind(&mut kind)?;
                                            if kind == COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION
                                                || kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                                            {
                                                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                                            }
                                            Ok(())
                                        },
                                    )),
                                    &mut token,
                                );
                            }
                        });
                    }
                }
                attach_client_events(app);
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                api::runtime::runtime_context,
                api::runtime::create_child_instance,
                api::runtime::list_child_instances,
                api::runtime::rename_child_instance,
                api::runtime::remove_child_instance,
                api::runtime::launch_child_instance,
                api::auth::login,
                api::auth::login_with_jwt,
                api::auth::refresh_token,
                api::auth::logout,
                api::auth::auth_state,
                api::auth::account_status,
                api::auth::websocket_token,
                api::auth::sync_push_token,
                api::auth::list_saved_accounts,
                api::auth::switch_account,
                api::auth::remove_saved_account,
                api::rest::request,
                api::websocket::ws_connect,
                api::websocket::ws_send,
                api::websocket::ws_disconnect,
                api::websocket::ws_status,
                commands::fingerprint::check_fingerprint,
                commands::vision::detect_image_content,
                commands::google_drive::google_drive_config_status,
                commands::google_drive::google_drive_connection_status,
                commands::google_drive::google_drive_connect,
                commands::google_drive::google_drive_disconnect,
                commands::google_drive::google_drive_vault_key_status,
                commands::google_drive::google_drive_vault_key_create,
                commands::google_drive::google_drive_vault_key_import,
                commands::google_drive::google_drive_vault_key_export_for_pairing,
                commands::google_drive::google_drive_vault_key_delete,
                commands::google_drive::google_drive_encrypt,
                commands::google_drive::google_drive_decrypt,
                commands::google_drive::google_drive_list_app_data,
                commands::google_drive::google_drive_get_start_page_token,
                commands::google_drive::google_drive_list_changes,
                commands::google_drive::google_drive_download_app_data,
                commands::google_drive::google_drive_create_app_data,
                commands::google_drive::google_drive_update_app_data,
                commands::google_drive::google_drive_delete_app_data,
            ])
            .build(context)
            .expect("error while running tauri application");

        // On Windows, the desktop event loop terminates the process with
        // std::process::exit once the window closes and never returns control
        // to this function, so instance_lock_guard's Drop would otherwise
        // never run, leaving a stale instance.lock behind that blocks every
        // future launch of this child instance. RunEvent::Exit fires just
        // before that exit, so release the lock there instead.
        #[cfg(target_os = "windows")]
        {
            let mut instance_lock_guard = instance_lock_guard;
            app.run(move |_app_handle, event| {
                if let tauri::RunEvent::Exit = event {
                    instance_lock_guard.take();
                }
            });
        }
        #[cfg(not(target_os = "windows"))]
        {
            app.run(|_app_handle, _event| {});
        }
    }

    #[cfg(mobile)]
    {
        let context = tauri::generate_context!();
        let builder = tauri::Builder::default()
            .plugin(tauri_plugin_notification::init())
            .plugin(tauri_plugin_os::init())
            .plugin(tauri_plugin_geolocation::init())
            .plugin(tauri_plugin_fs::init())
            .plugin(tauri_plugin_http::init())
            .plugin(tauri_plugin_sql::Builder::default().build())
            .plugin(tauri_plugin_opener::init());

        #[cfg(target_os = "ios")]
        let builder = builder
            .plugin(tauri_plugin_ios_photos::init())
            .plugin(tauri_plugin_ios_keyboard_fix::init())
            .plugin(tauri_plugin_ios_google_oauth::init());

        #[cfg(target_os = "android")]
        let builder = builder.plugin(tauri_plugin_android_fs::init());

        builder
            .manage(AppState { client })
            .manage(Arc::new(WsState::new()))
            .setup(|app| {
                attach_client_events(app);
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                api::runtime::runtime_context,
                api::runtime::create_child_instance,
                api::runtime::list_child_instances,
                api::runtime::rename_child_instance,
                api::runtime::remove_child_instance,
                api::runtime::launch_child_instance,
                api::auth::login,
                api::auth::login_with_jwt,
                api::auth::refresh_token,
                api::auth::logout,
                api::auth::auth_state,
                api::auth::account_status,
                api::auth::websocket_token,
                api::auth::sync_push_token,
                api::auth::list_saved_accounts,
                api::auth::switch_account,
                api::auth::remove_saved_account,
                api::rest::request,
                api::websocket::ws_connect,
                api::websocket::ws_send,
                api::websocket::ws_disconnect,
                api::websocket::ws_status,
                commands::fingerprint::check_fingerprint,
                commands::vision::detect_image_content,
                commands::google_drive::google_drive_config_status,
                commands::google_drive::google_drive_connection_status,
                commands::google_drive::google_drive_connect,
                commands::google_drive::google_drive_disconnect,
                commands::google_drive::google_drive_vault_key_status,
                commands::google_drive::google_drive_vault_key_create,
                commands::google_drive::google_drive_vault_key_import,
                commands::google_drive::google_drive_vault_key_export_for_pairing,
                commands::google_drive::google_drive_vault_key_delete,
                commands::google_drive::google_drive_encrypt,
                commands::google_drive::google_drive_decrypt,
                commands::google_drive::google_drive_list_app_data,
                commands::google_drive::google_drive_get_start_page_token,
                commands::google_drive::google_drive_list_changes,
                commands::google_drive::google_drive_download_app_data,
                commands::google_drive::google_drive_create_app_data,
                commands::google_drive::google_drive_update_app_data,
                commands::google_drive::google_drive_delete_app_data,
            ])
            .run(context)
            .expect("error while running tauri application");
    }
}
