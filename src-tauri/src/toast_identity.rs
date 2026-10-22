//! The identity Windows shows the app's notifications under.
//!
//! A toast carries no name or icon of its own. It carries the app's
//! AppUserModelID, and Windows looks that ID up to decide what to paint. An
//! ID it cannot resolve gets no toast at all. An installer registers the ID
//! through a Start Menu shortcut; this app is handed out as a plain exe, so
//! it registers itself, for the current user, every time it starts.
//!
//! The registration used to be a script to run once per machine
//! (`scripts/register-toast-aumid.ps1`). A machine where nobody ran it got no
//! notifications, and one where it ran before the app was renamed went on
//! showing the old name.

use std::path::{Path, PathBuf};

use windows::core::HSTRING;
use windows::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};

/// The app's AppUserModelID: the `identifier` of the Tauri configuration,
/// which is also what the notification plugin raises toasts under.
pub const APP_USER_MODEL_ID: &str = "dev.estopia.free-grind";

/// The name on a notification and in Settings > Notifications.
const DISPLAY_NAME: &str = "GrindFlop";

/// The picture on a notification. Windows reads it from a file when the
/// toast is shown, so it is written out next to the app's own data.
const ICON: &[u8] = include_bytes!("../icons/128x128.png");
const ICON_FILE_NAME: &str = "notification-icon.png";

/// Where Windows keeps what it knows about an AppUserModelID, per user.
fn registration_key(app_id: &str) -> String {
    format!("Software\\Classes\\AppUserModelId\\{app_id}")
}

/// Writes one text value under `HKEY_CURRENT_USER`, creating the key when it
/// is not there yet.
fn set_text_value(key: &str, name: &str, value: &str) -> Result<(), String> {
    // The data of a text value is UTF-16 with its closing zero, counted in bytes.
    let data: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    let status = unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            &HSTRING::from(key),
            &HSTRING::from(name),
            REG_SZ.0,
            Some(data.as_ptr().cast()),
            (data.len() * std::mem::size_of::<u16>()) as u32,
        )
    };
    if status.is_ok() {
        Ok(())
    } else {
        Err(format!("writing {name} under {key} failed: {status:?}"))
    }
}

/// Puts the notification picture on disk, unless the same one is there
/// already, and says where it is.
fn write_icon(app_data_root: &Path) -> std::io::Result<PathBuf> {
    let directory = app_data_root.join("free-grind");
    let path = directory.join(ICON_FILE_NAME);
    let up_to_date = std::fs::read(&path)
        .map(|existing| existing == ICON)
        .unwrap_or(false);
    if !up_to_date {
        std::fs::create_dir_all(&directory)?;
        std::fs::write(&path, ICON)?;
    }
    Ok(path)
}

fn register_as(app_id: &str, app_data_root: &Path) -> Result<(), String> {
    let key = registration_key(app_id);
    set_text_value(&key, "DisplayName", DISPLAY_NAME)?;

    // The name is what makes Windows show the toast at all. The picture is
    // a nicety: without it the toast still appears.
    match write_icon(app_data_root) {
        Ok(path) => set_text_value(&key, "IconUri", &path.display().to_string())?,
        Err(_error) => {
            #[cfg(debug_assertions)]
            eprintln!("[toast-identity] could not write the notification icon: {_error}");
        }
    }
    Ok(())
}

/// Registers the app's notification identity for the current user. Nothing
/// depends on it succeeding: a failure leaves notifications as they were.
pub fn register(app_data_root: &Path) {
    if let Err(_error) = register_as(APP_USER_MODEL_ID, app_data_root) {
        #[cfg(debug_assertions)]
        eprintln!("[toast-identity] {_error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_registration_lives_under_the_documented_key() {
        assert_eq!(
            registration_key("dev.estopia.free-grind"),
            "Software\\Classes\\AppUserModelId\\dev.estopia.free-grind"
        );
    }

    #[test]
    fn the_picture_is_a_png() {
        assert!(ICON.starts_with(b"\x89PNG\r\n\x1a\n"));
    }

    #[test]
    fn the_picture_is_written_once_and_left_alone_after() {
        let root = std::env::temp_dir().join(format!("grindflop-icon-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        let path = write_icon(&root).unwrap();
        assert_eq!(path, root.join("free-grind").join(ICON_FILE_NAME));
        assert_eq!(std::fs::read(&path).unwrap(), ICON);

        // A second start finds it and writes nothing.
        let written_at = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(write_icon(&root).unwrap(), path);
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), written_at);

        // A picture that is not ours, left by an older build, is replaced.
        std::fs::write(&path, b"not the icon").unwrap();
        write_icon(&root).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), ICON);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Writes a real registration under a throwaway ID, reads it back with
    /// `reg`, and removes it again. The app's own registration is not
    /// touched. Run by hand: `cargo test --lib toast_identity -- --ignored`
    #[test]
    #[ignore = "writes to the registry of the current user; run by hand"]
    fn a_registration_can_be_written_and_read_back() {
        let app_id = format!("dev.estopia.free-grind.selftest-{}", std::process::id());
        let root = std::env::temp_dir().join(format!("grindflop-identity-test-{}", std::process::id()));
        let full_key = format!("HKCU\\{}", registration_key(&app_id));

        register_as(&app_id, &root).expect("the registration can be written");

        let query = std::process::Command::new("reg")
            .args(["query", &full_key])
            .output()
            .expect("reg can be run");
        let listing = String::from_utf8_lossy(&query.stdout).to_string();

        let removed = std::process::Command::new("reg")
            .args(["delete", &full_key, "/f"])
            .output()
            .expect("reg can be run");
        let _ = std::fs::remove_dir_all(&root);

        assert!(query.status.success(), "the key was not found: {listing}");
        assert!(listing.contains("DisplayName"), "{listing}");
        assert!(listing.contains(DISPLAY_NAME), "{listing}");
        assert!(listing.contains("IconUri"), "{listing}");
        assert!(listing.contains(ICON_FILE_NAME), "{listing}");
        assert!(removed.status.success(), "the throwaway key could not be removed");
    }
}
