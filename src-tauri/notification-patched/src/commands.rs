// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use tauri::{command, plugin::PermissionState, AppHandle, Runtime, State};

#[cfg(desktop)]
use crate::ActiveNotification;
use crate::{Notification, NotificationData, Result};

#[command]
pub(crate) async fn is_permission_granted<R: Runtime>(
    _app: AppHandle<R>,
    notification: State<'_, Notification<R>>,
) -> Result<Option<bool>> {
    let state = notification.permission_state()?;
    match state {
        PermissionState::Granted => Ok(Some(true)),
        PermissionState::Denied => Ok(Some(false)),
        PermissionState::Prompt | PermissionState::PromptWithRationale => Ok(None),
    }
}

#[command]
pub(crate) async fn request_permission<R: Runtime>(
    _app: AppHandle<R>,
    notification: State<'_, Notification<R>>,
) -> Result<PermissionState> {
    notification.request_permission()
}

#[command]
pub(crate) async fn notify<R: Runtime>(
    _app: AppHandle<R>,
    notification: State<'_, Notification<R>>,
    options: NotificationData,
) -> Result<()> {
    let mut builder = notification.builder();
    builder.data = options;
    builder.show()
}

/// One notification that is showing, as the window names it.
#[cfg(desktop)]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActiveNotificationRef {
    id: i32,
    tag: Option<String>,
}

// The two commands below exist on the desktop only. On a phone the same two
// calls are not Rust commands at all: they go straight to the native plugin,
// as they did before these were added.

#[cfg(desktop)]
#[command]
pub(crate) async fn get_active<R: Runtime>(
    _app: AppHandle<R>,
    notification: State<'_, Notification<R>>,
) -> Result<Vec<ActiveNotification>> {
    notification.active()
}

/// Takes down the notifications named, or every one of the app's when none
/// are named.
#[cfg(desktop)]
#[command]
pub(crate) async fn remove_active<R: Runtime>(
    _app: AppHandle<R>,
    notification: State<'_, Notification<R>>,
    notifications: Option<Vec<ActiveNotificationRef>>,
) -> Result<()> {
    notification.remove_active(
        notifications.map(|items| items.into_iter().map(|item| (item.id, item.tag)).collect()),
    )
}
