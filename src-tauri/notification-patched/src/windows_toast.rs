//! Windows toasts, through the WinRT notification APIs themselves.
//!
//! The cross-platform library this plugin uses on the other desktops can show
//! a toast and nothing more. Going to WinRT directly is what lets a toast
//! carry a tag and a group, tell the app when it is clicked, and be found
//! again and taken down once the chat it announced has been read.
//!
//! The app's identity for all of this is its AppUserModelID, which the app
//! sets for its own process when it starts and which is the `identifier` of
//! the Tauri configuration. Windows only shows a toast for an ID it can
//! resolve to a name, so that ID has to be registered on the machine.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use tauri::{AppHandle, Emitter, Manager, Runtime};
use windows::core::{IInspectable, HSTRING};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::UI::Notifications::{
    ToastDismissalReason, ToastDismissedEventArgs, ToastNotification, ToastNotificationManager,
    ToastNotifier,
};

use crate::{ActiveNotification, NotificationData};

/// The window hears on this event that a toast was clicked. The payload is
/// the group the toast was posted with: a conversation id, or "taps".
pub(crate) const CLICKED_EVENT: &str = "fg:notification-clicked";

/// Windows refuses a tag or a group longer than this many UTF-16 units.
const MAX_TAG_OR_GROUP_UNITS: usize = 64;

/// The group a toast is filed under when it was posted without one. Taking a
/// toast down again needs both its tag and its group, so every toast has one.
const NO_GROUP: &str = "ungrouped";

/// A toast shows a few lines at most and Windows rejects a payload over
/// 5 KB outright, so a long message is cut well short of that.
const MAX_TITLE_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 400;

/// How many toasts are remembered at once.
const MAX_REMEMBERED: usize = 256;

/// What is kept about a toast after it was shown.
struct Remembered {
    /// Rises with every toast, so the oldest can be found and let go.
    order: u64,
    id: i32,
    title: String,
    body: String,
    /// Windows reports a click to this object and to nothing else. Once it
    /// is dropped, clicking the toast does nothing at all, so it is kept for
    /// as long as the toast can still be clicked.
    toast: Option<ToastNotification>,
}

static NEXT_ORDER: AtomicU64 = AtomicU64::new(0);

/// Toasts shown by this process, by tag.
fn remembered() -> MutexGuard<'static, HashMap<String, Remembered>> {
    static REMEMBERED: OnceLock<Mutex<HashMap<String, Remembered>>> = OnceLock::new();
    REMEMBERED
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn remember(tag: String, id: i32, title: String, body: String, toast: ToastNotification) {
    let mut remembered = remembered();
    remembered.insert(
        tag,
        Remembered {
            order: NEXT_ORDER.fetch_add(1, Ordering::Relaxed),
            id,
            title,
            body,
            toast: Some(toast),
        },
    );

    // A long session shows a great many toasts. Windows keeps its own record
    // of them; this one only needs the recent ones.
    while remembered.len() > MAX_REMEMBERED {
        let oldest = remembered
            .iter()
            .min_by_key(|(_, entry)| entry.order)
            .map(|(tag, _)| tag.clone());
        match oldest {
            Some(tag) => remembered.remove(&tag),
            None => break,
        };
    }
}

/// Lets go of the object a toast reports its click to. What was shown stays
/// on record, since the toast may still sit in the notification centre.
fn stop_listening(tag: &str) {
    if let Some(entry) = remembered().get_mut(tag) {
        entry.toast = None;
    }
}

fn win_err(error: windows::core::Error) -> crate::Error {
    crate::Error::Show(error.to_string())
}

/// Text as a toast can carry it: without the characters XML has no way to
/// hold, and no longer than a toast has room for.
fn toast_text(text: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let mut count = 0;
    for ch in text.chars() {
        let allowed = match ch {
            '\t' | '\n' | '\r' => true,
            '\u{FFFE}' | '\u{FFFF}' => false,
            ch => ch >= ' ',
        };
        if !allowed {
            continue;
        }
        if count == max_chars {
            out.push('\u{2026}');
            break;
        }
        out.push(ch);
        count += 1;
    }
    out
}

fn xml_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            ch => out.push(ch),
        }
    }
    out
}

fn toast_xml(title: &str, body: &str) -> String {
    format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        xml_escape(&toast_text(title, MAX_TITLE_CHARS)),
        xml_escape(&toast_text(body, MAX_BODY_CHARS)),
    )
}

/// The group Windows files a toast under, for the group it was posted with.
fn windows_group(group: Option<&str>) -> &str {
    match group.map(str::trim) {
        Some(group)
            if !group.is_empty() && group.encode_utf16().count() <= MAX_TAG_OR_GROUP_UNITS =>
        {
            group
        }
        _ => NO_GROUP,
    }
}

/// The group a toast was posted with, for the group Windows has it under.
fn posted_group(windows_group: &str) -> Option<String> {
    (!windows_group.is_empty() && windows_group != NO_GROUP).then(|| windows_group.to_owned())
}

fn build_toast(title: &str, body: &str, tag: &str, group: &str) -> crate::Result<ToastNotification> {
    let document = XmlDocument::new().map_err(win_err)?;
    document
        .LoadXml(&HSTRING::from(toast_xml(title, body)))
        .map_err(win_err)?;

    let toast = ToastNotification::CreateToastNotification(&document).map_err(win_err)?;
    toast.SetTag(&HSTRING::from(tag)).map_err(win_err)?;
    toast.SetGroup(&HSTRING::from(group)).map_err(win_err)?;
    Ok(toast)
}

fn notifier(app_id: &str) -> crate::Result<ToastNotifier> {
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id)).map_err(win_err)
}

/// The tag and group of every toast Windows still holds for the app.
fn history_entries(app_id: &str) -> crate::Result<Vec<(String, String)>> {
    let history = ToastNotificationManager::History()
        .and_then(|history| history.GetHistoryWithId(&HSTRING::from(app_id)))
        .map_err(win_err)?;

    let mut entries = Vec::new();
    for toast in &history {
        let tag = toast.Tag().map(|tag| tag.to_string_lossy()).unwrap_or_default();
        let group = toast
            .Group()
            .map(|group| group.to_string_lossy())
            .unwrap_or_default();
        entries.push((tag, group));
    }
    Ok(entries)
}

fn remove_from_history(app_id: &str, tag: &str, group: &str) -> crate::Result<()> {
    ToastNotificationManager::History()
        .and_then(|history| {
            history.RemoveGroupedTagWithId(
                &HSTRING::from(tag),
                &HSTRING::from(group),
                &HSTRING::from(app_id),
            )
        })
        .map_err(win_err)
}

fn clear_history(app_id: &str) -> crate::Result<()> {
    ToastNotificationManager::History()
        .and_then(|history| history.ClearWithId(&HSTRING::from(app_id)))
        .map_err(win_err)
}

/// Shows a toast.
///
/// The work is handed to the main thread. A command runs on a worker thread,
/// and a toast raised from there can be reported as shown while Windows
/// quietly drops it, most of all while the window is minimised. Nothing can
/// be handed back from the main thread, so a failure there is logged.
pub(crate) fn show<R: Runtime>(app: &AppHandle<R>, data: NotificationData) -> crate::Result<()> {
    let app_id = app.config().identifier.clone();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = show_now(&handle, data, &app_id) {
            eprintln!("GrindFlop could not show a notification: {error}");
        }
    })
    .map_err(|error| crate::Error::Show(error.to_string()))
}

fn show_now<R: Runtime>(
    app: &AppHandle<R>,
    data: NotificationData,
    app_id: &str,
) -> crate::Result<()> {
    let title = data
        .title
        .clone()
        .or_else(|| app.config().product_name.clone())
        .unwrap_or_default();
    let body = data.body.clone().unwrap_or_default();
    let tag = data.id.to_string();
    let clicked_group = data.group.as_deref().and_then(|group| {
        let group = group.trim();
        (!group.is_empty()).then(|| group.to_owned())
    });

    let toast = build_toast(&title, &body, &tag, windows_group(data.group.as_deref()))?;

    let click_app = app.clone();
    let click_tag = tag.clone();
    toast
        .Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
            move |_toast, _args| {
                stop_listening(&click_tag);

                // Windows calls this on a thread of its own. The window has
                // to be raised, and told, from the main thread.
                let app = click_app.clone();
                let group = clicked_group.clone();
                let _ = click_app.run_on_main_thread(move || {
                    // Telling the page is not enough when the window is
                    // minimised or behind another one: nothing would be seen.
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    if let Some(group) = group {
                        let _ = app.emit(CLICKED_EVENT, group);
                    }
                });
                Ok(())
            },
        ))
        .map_err(win_err)?;

    let dismissed_tag = tag.clone();
    toast
        .Dismissed(&TypedEventHandler::<ToastNotification, ToastDismissedEventArgs>::new(
            move |_toast, args| {
                // A toast that timed out has only moved to the notification
                // centre, where it can still be clicked. One the user or the
                // app took down is gone.
                let timed_out = args.as_ref().and_then(|args| args.Reason().ok())
                    == Some(ToastDismissalReason::TimedOut);
                if !timed_out {
                    stop_listening(&dismissed_tag);
                }
                Ok(())
            },
        ))
        .map_err(win_err)?;

    remember(tag, data.id, title, body, toast.clone());
    notifier(app_id)?.Show(&toast).map_err(win_err)
}

/// The toasts Windows still holds for the app, with what this process knows
/// about the ones it showed itself. Windows hands back a toast's tag and
/// group and nothing of what it said.
pub(crate) fn active<R: Runtime>(app: &AppHandle<R>) -> crate::Result<Vec<ActiveNotification>> {
    let entries = history_entries(&app.config().identifier)?;
    let remembered = remembered();

    Ok(entries
        .into_iter()
        .map(|(tag, group)| {
            let known = remembered.get(&tag);
            // The tag is the id written out, so a toast from an earlier run
            // of the app still has its id.
            let id = known
                .map(|entry| entry.id)
                .or_else(|| tag.parse().ok())
                .unwrap_or_default();
            ActiveNotification::new(
                id,
                Some(tag),
                known.map(|entry| entry.title.clone()),
                known.map(|entry| entry.body.clone()),
                posted_group(&group),
            )
        })
        .collect())
}

/// Takes toasts down. `None` clears everything Windows holds for the app;
/// otherwise each `(id, tag)` names one toast, by its tag when it has one.
pub(crate) fn remove_active<R: Runtime>(
    app: &AppHandle<R>,
    notifications: Option<Vec<(i32, Option<String>)>>,
) -> crate::Result<()> {
    let app_id = app.config().identifier.clone();

    let Some(notifications) = notifications else {
        clear_history(&app_id)?;
        remembered().clear();
        return Ok(());
    };

    // Windows wants the group along with the tag, and the caller has only
    // the tag, so the group is looked up in what Windows itself holds.
    let groups: HashMap<String, String> = history_entries(&app_id)?.into_iter().collect();
    for (id, tag) in notifications {
        let tag = tag.unwrap_or_else(|| id.to_string());
        if let Some(group) = groups.get(&tag) {
            remove_from_history(&app_id, &tag, group)?;
        }
        remembered().remove(&tag);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_escaped_for_xml() {
        assert_eq!(
            xml_escape(r#"Tom & "Jerry" <3 it's"#),
            "Tom &amp; &quot;Jerry&quot; &lt;3 it&apos;s"
        );
        assert_eq!(xml_escape("plain \u{1F600} text"), "plain \u{1F600} text");
    }

    #[test]
    fn characters_xml_cannot_hold_are_dropped() {
        assert_eq!(toast_text("a\u{0}b\u{8}c\u{1F}d", 100), "abcd");
        assert_eq!(toast_text("line\nbreak\tand\rreturn", 100), "line\nbreak\tand\rreturn");
        assert_eq!(toast_text("x\u{FFFE}y\u{FFFF}z", 100), "xyz");
    }

    #[test]
    fn long_text_is_cut_with_a_mark() {
        assert_eq!(toast_text("abcdef", 6), "abcdef");
        assert_eq!(toast_text("abcdefg", 6), "abcdef\u{2026}");
        // Counted in characters, so a cut never lands inside one.
        assert_eq!(toast_text("\u{1F600}\u{1F600}\u{1F600}", 2), "\u{1F600}\u{1F600}\u{2026}");
        assert_eq!(toast_text("", 5), "");
    }

    #[test]
    fn the_payload_stays_far_below_what_windows_accepts() {
        // The worst case: every character is one that escapes to six.
        let xml = toast_xml(&"\"".repeat(5_000), &"\"".repeat(50_000));
        assert!(xml.len() < 5 * 1024, "payload is {} bytes", xml.len());
        assert!(xml.starts_with("<toast><visual>"));
        assert!(xml.ends_with("</binding></visual></toast>"));
    }

    #[test]
    fn a_toast_always_has_a_group_windows_accepts() {
        assert_eq!(windows_group(Some("900000002_920000003")), "900000002_920000003");
        assert_eq!(windows_group(Some("  taps ")), "taps");
        assert_eq!(windows_group(None), NO_GROUP);
        assert_eq!(windows_group(Some("")), NO_GROUP);
        assert_eq!(windows_group(Some("   ")), NO_GROUP);
        let at_the_limit = "g".repeat(MAX_TAG_OR_GROUP_UNITS);
        assert_eq!(windows_group(Some(&at_the_limit)), at_the_limit);
        let too_long = "g".repeat(MAX_TAG_OR_GROUP_UNITS + 1);
        assert_eq!(windows_group(Some(&too_long)), NO_GROUP);
    }

    #[test]
    fn the_stand_in_group_is_not_reported_as_a_group() {
        assert_eq!(posted_group("taps").as_deref(), Some("taps"));
        assert_eq!(posted_group(NO_GROUP), None);
        assert_eq!(posted_group(""), None);
    }

    /// Shows a real toast on this machine, finds it in what Windows holds,
    /// and takes it down again. Needs the app's AppUserModelID registered
    /// here, so it is run by hand:
    /// `cargo test -p tauri-plugin-notification --lib -- --ignored`
    #[test]
    #[ignore = "shows a real toast; run by hand on a machine where the app is registered"]
    fn a_toast_can_be_shown_found_and_taken_down() {
        let app_id = "dev.estopia.free-grind";
        let tag = format!("{}", 1_000_000 + (std::process::id() % 1_000_000));
        let group = "self-test";
        let holds_it = |entries: &[(String, String)]| {
            entries
                .iter()
                .any(|(found_tag, found_group)| found_tag == &tag && found_group == group)
        };

        let toast = build_toast(
            "GrindFlop self-test",
            "Checking that notifications work. This one goes away by itself.",
            &tag,
            group,
        )
        .expect("the toast can be built");
        notifier(app_id)
            .expect("Windows knows the app")
            .Show(&toast)
            .expect("the toast can be shown");

        std::thread::sleep(std::time::Duration::from_millis(1500));
        let shown = history_entries(app_id).expect("the history can be read");
        assert!(holds_it(&shown), "Windows does not hold the toast: {shown:?}");

        remove_from_history(app_id, &tag, group).expect("the toast can be taken down");
        std::thread::sleep(std::time::Duration::from_millis(500));
        let after = history_entries(app_id).expect("the history can be read");
        assert!(!holds_it(&after), "the toast is still there: {after:?}");
    }
}
