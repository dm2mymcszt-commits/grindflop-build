#[cfg(target_os = "windows")]
use std::fs::OpenOptions;
#[cfg(target_os = "windows")]
use std::io::Write;
#[cfg(target_os = "windows")]
use std::path::PathBuf;

#[cfg(target_os = "windows")]
pub struct InstanceLockGuard {
    path: PathBuf,
}

#[cfg(target_os = "windows")]
impl Drop for InstanceLockGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(target_os = "windows")]
fn is_process_running(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("tasklist")
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .args(&["/FI", &format!("PID eq {}", pid)])
        .output();
    if let Ok(out) = output {
        let text = String::from_utf8_lossy(&out.stdout);
        text.contains(&pid.to_string())
    } else {
        true
    }
}

#[cfg(target_os = "windows")]
pub fn acquire_for_current_child_instance() -> Result<Option<InstanceLockGuard>, String> {
    let instance = crate::windows_instance::WindowsInstance::current();
    if instance.is_manager() {
        return Ok(None);
    }

    let lock_path = instance.lock_file_path();

    // Check for stale lock file
    if lock_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&lock_path) {
            if let Some(pid_line) = content.lines().find(|l| l.starts_with("pid=")) {
                if let Ok(pid) = pid_line.trim_start_matches("pid=").parse::<u32>() {
                    if !is_process_running(pid) {
                        let _ = std::fs::remove_file(&lock_path);
                    }
                }
            }
        }
    }

    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create instance lock directory {}: {}",
                parent.display(),
                error
            )
        })?;
    }

    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&lock_path)
        .map_err(|error| {
            format!(
                "instance '{}' is already running (lock: {}, {})",
                instance.label(),
                lock_path.display(),
                error
            )
        })?;

    let _ = writeln!(file, "pid={}", std::process::id());

    Ok(Some(InstanceLockGuard { path: lock_path }))
}