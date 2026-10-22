// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PermissionState, PluginApi},
    AppHandle, Runtime,
};

use crate::NotificationBuilder;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Notification<R>> {
    Ok(Notification(app.clone()))
}

/// Access to the notification APIs.
///
/// You can get an instance of this type via [`NotificationExt`](crate::NotificationExt)
pub struct Notification<R: Runtime>(AppHandle<R>);

#[cfg(windows)]
impl<R: Runtime> crate::NotificationBuilder<R> {
    /// On Windows a toast is raised through WinRT itself: see `windows_toast`.
    pub fn show(self) -> crate::Result<()> {
        crate::windows_toast::show(&self.app, self.data)
    }
}

#[cfg(not(windows))]
impl<R: Runtime> crate::NotificationBuilder<R> {
    pub fn show(self) -> crate::Result<()> {
        let mut notification = imp::Notification::new(self.app.config().identifier.clone());

        if let Some(title) = self
            .data
            .title
            .or_else(|| self.app.config().product_name.clone())
        {
            notification = notification.title(title);
        }
        if let Some(body) = self.data.body {
            notification = notification.body(body);
        }
        if let Some(icon) = self.data.icon {
            notification = notification.icon(icon);
        }
        if let Some(sound) = self.data.sound {
            notification = notification.sound(sound);
        }
        #[cfg(feature = "windows7-compat")]
        {
            notification.notify(&self.app)?;
        }
        #[cfg(not(feature = "windows7-compat"))]
        notification.show()?;

        Ok(())
    }
}

impl<R: Runtime> Notification<R> {
    pub fn builder(&self) -> NotificationBuilder<R> {
        NotificationBuilder::new(self.0.clone())
    }

    pub fn request_permission(&self) -> crate::Result<PermissionState> {
        Ok(PermissionState::Granted)
    }

    pub fn permission_state(&self) -> crate::Result<PermissionState> {
        Ok(PermissionState::Granted)
    }
}

#[cfg(windows)]
impl<R: Runtime> Notification<R> {
    /// The notifications Windows still holds for the app.
    pub fn active(&self) -> crate::Result<Vec<crate::ActiveNotification>> {
        crate::windows_toast::active(&self.0)
    }

    /// `None` takes down every notification of the app; `Some` only the
    /// `(id, tag)` pairs given.
    pub fn remove_active(
        &self,
        notifications: Option<Vec<(i32, Option<String>)>>,
    ) -> crate::Result<()> {
        crate::windows_toast::remove_active(&self.0, notifications)
    }
}

// The other desktops show a notification and keep no record of it.
#[cfg(not(windows))]
impl<R: Runtime> Notification<R> {
    pub fn active(&self) -> crate::Result<Vec<crate::ActiveNotification>> {
        Ok(Vec::new())
    }

    pub fn remove_active(
        &self,
        _notifications: Option<Vec<(i32, Option<String>)>>,
    ) -> crate::Result<()> {
        Ok(())
    }
}

// Windows no longer goes through this module, unless the Windows 7 feature
// is on.
#[cfg_attr(windows, allow(dead_code))]
mod imp {
    //! Types and functions related to desktop notifications.

    /// The desktop notification definition.
    ///
    /// Allows you to construct a Notification data and send it.
    ///
    /// # Examples
    /// ```rust,no_run
    /// use tauri_plugin_notification::NotificationExt;
    /// // first we build the application to access the Tauri configuration
    /// let app = tauri::Builder::default()
    ///   // on an actual app, remove the string argument
    ///   .build(tauri::generate_context!("test/tauri.conf.json"))
    ///   .expect("error while building tauri application");
    ///
    /// // shows a notification with the given title and body
    /// app.notification()
    ///   .builder()
    ///   .title("New message")
    ///   .body("You've got a new message.")
    ///   .show();
    ///
    /// // run the app
    /// app.run(|_app_handle, _event| {});
    /// ```
    #[allow(dead_code)]
    #[derive(Debug, Default)]
    pub struct Notification {
        /// The notification body.
        body: Option<String>,
        /// The notification title.
        title: Option<String>,
        /// The notification icon.
        icon: Option<String>,
        /// The notification sound.
        sound: Option<String>,
        /// The notification identifier
        identifier: String,
    }

    impl Notification {
        /// Initializes a instance of a Notification.
        pub fn new(identifier: impl Into<String>) -> Self {
            Self {
                identifier: identifier.into(),
                ..Default::default()
            }
        }

        /// Sets the notification body.
        #[must_use]
        pub fn body(mut self, body: impl Into<String>) -> Self {
            self.body = Some(body.into());
            self
        }

        /// Sets the notification title.
        #[must_use]
        pub fn title(mut self, title: impl Into<String>) -> Self {
            self.title = Some(title.into());
            self
        }

        /// Sets the notification icon.
        #[must_use]
        pub fn icon(mut self, icon: impl Into<String>) -> Self {
            self.icon = Some(icon.into());
            self
        }

        /// Sets the notification sound file.
        #[must_use]
        pub fn sound(mut self, sound: impl Into<String>) -> Self {
            self.sound = Some(sound.into());
            self
        }

        /// Shows the notification.
        ///
        /// # Examples
        ///
        /// ```no_run
        /// use tauri_plugin_notification::NotificationExt;
        ///
        /// tauri::Builder::default()
        ///   .setup(|app| {
        ///     app.notification()
        ///       .builder()
        ///       .title("Tauri")
        ///       .body("Tauri is awesome!")
        ///       .show()
        ///       .unwrap();
        ///     Ok(())
        ///   })
        ///   .run(tauri::generate_context!("test/tauri.conf.json"))
        ///   .expect("error while running tauri application");
        /// ```
        ///
        /// ## Platform-specific
        ///
        /// - **Windows**: Not supported on Windows 7. If your app targets it, enable the `windows7-compat` feature and use [`Self::notify`].
        #[cfg_attr(
            all(not(docsrs), feature = "windows7-compat"),
            deprecated = "This function does not work on Windows 7. Use `Self::notify` instead."
        )]
        pub fn show(self) -> crate::Result<()> {
            let mut notification = notify_rust::Notification::new();
            if let Some(body) = self.body {
                notification.body(&body);
            }
            if let Some(title) = self.title {
                notification.summary(&title);
            }
            if let Some(icon) = self.icon {
                notification.icon(&icon);
            } else {
                notification.auto_icon();
            }
            if let Some(sound) = self.sound {
                notification.sound_name(&sound);
            }
            #[cfg(windows)]
            {
                // Always stamp the notification with our own System.AppUserModel.ID.
                //
                // Upstream skips this for `target/debug` and `target/release` builds,
                // because an AUMID Windows cannot resolve makes it drop the toast
                // silently — so unpackaged builds fall through to the default AUMID
                // baked into tauri-winrt-notification, which is PowerShell's. That is
                // why dev toasts announce themselves as "Windows PowerShell".
                //
                // The app registers `dev.estopia.free-grind` itself under
                // HKCU\Software\Classes\AppUserModelId each time it starts (see
                // src-tauri/src/toast_identity.rs), so the ID resolves no matter where
                // the exe lives and the toast carries the real name and icon.
                notification.app_id(&self.identifier);
            }
            #[cfg(target_os = "macos")]
            {
                let _ = notify_rust::set_application(if tauri::is_dev() {
                    "com.apple.Terminal"
                } else {
                    &self.identifier
                });
            }

            tauri::async_runtime::spawn(async move {
                // Dropping the handle immediately closes the underlying D-Bus
                // connection on Linux; some notification daemons rely on
                // that connection staying open to keep the notification
                // displayed (notify-rust's own docs: "keeps a connection
                // alive to ensure actions work on certain desktops"). Leak
                // it intentionally so the notification persists normally.
                // Windows' `show()` returns `Result<()>` (no handle to keep
                // alive), so forgetting it there is a no-op the compiler
                // warns about — only do it where it actually matters.
                if let Ok(handle) = notification.show() {
                    #[cfg(not(windows))]
                    std::mem::forget(handle);
                    #[cfg(windows)]
                    let _ = handle;
                }
            });

            Ok(())
        }

        /// Shows the notification. This API is similar to [`Self::show`], but it also works on Windows 7.
        ///
        /// # Examples
        ///
        /// ```no_run
        /// use tauri_plugin_notification::NotificationExt;
        ///
        /// tauri::Builder::default()
        ///   .setup(move |app| {
        ///     app.notification().builder()
        ///       .title("Tauri")
        ///       .body("Tauri is awesome!")
        ///       .show()
        ///       .unwrap();
        ///     Ok(())
        ///   })
        ///   .run(tauri::generate_context!("test/tauri.conf.json"))
        ///   .expect("error while running tauri application");
        /// ```
        #[cfg(feature = "windows7-compat")]
        #[cfg_attr(docsrs, doc(cfg(feature = "windows7-compat")))]
        #[allow(unused_variables)]
        pub fn notify<R: tauri::Runtime>(self, app: &tauri::AppHandle<R>) -> crate::Result<()> {
            #[cfg(windows)]
            {
                fn is_windows_7() -> bool {
                    let v = windows_version::OsVersion::current();
                    // windows 7 is 6.1
                    v.major == 6 && v.minor == 1
                }

                if is_windows_7() {
                    self.notify_win7(app)
                } else {
                    #[allow(deprecated)]
                    self.show()
                }
            }
            #[cfg(not(windows))]
            {
                #[allow(deprecated)]
                self.show()
            }
        }

        /// Shows the notification on Windows 7.
        #[cfg(all(windows, feature = "windows7-compat"))]
        fn notify_win7<R: tauri::Runtime>(self, app: &tauri::AppHandle<R>) -> crate::Result<()> {
            let app_ = app.clone();
            let _ = app.clone().run_on_main_thread(move || {
                let mut notification = win7_notifications::Notification::new();
                if let Some(body) = self.body {
                    notification.body(&body);
                }
                if let Some(title) = self.title {
                    notification.summary(&title);
                }
                if let Some(icon) = app_.default_window_icon() {
                    notification.icon(icon.rgba().to_vec(), icon.width(), icon.height());
                }
                let _ = notification.show();
            });

            Ok(())
        }
    }
}
