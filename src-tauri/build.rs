fn main() {
    println!("cargo:rerun-if-env-changed=FREE_GRIND_GOOGLE_DESKTOP_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=FREE_GRIND_GOOGLE_DESKTOP_CLIENT_SECRET");
    println!("cargo:rerun-if-env-changed=FREE_GRIND_GOOGLE_IOS_CLIENT_ID");
    tauri_build::build()
}
