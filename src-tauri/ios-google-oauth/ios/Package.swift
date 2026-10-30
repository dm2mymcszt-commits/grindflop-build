// swift-tools-version:5.5
import PackageDescription

let package = Package(
    name: "tauri-plugin-ios-google-oauth",
    platforms: [
        .macOS(.v10_13),
        .iOS(.v13),
    ],
    products: [
        .library(
            name: "tauri-plugin-ios-google-oauth",
            type: .static,
            targets: ["tauri-plugin-ios-google-oauth"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-ios-google-oauth",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources")
    ]
)
