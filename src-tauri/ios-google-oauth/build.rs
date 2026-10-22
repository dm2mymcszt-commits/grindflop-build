fn main() {
    tauri_plugin::Builder::new(&["authorize", "cancel"])
        .ios_path("ios")
        .build();
}
