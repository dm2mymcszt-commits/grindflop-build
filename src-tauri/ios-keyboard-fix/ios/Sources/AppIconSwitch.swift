import UIKit
import WebKit

/// The home screen icon, swapped for one of the decoys the app carries
/// (CFBundleAlternateIcons in Info.plist), and what the page is told about it.
/// iOS announces every change with an alert of its own, and only the icon
/// changes: an app cannot set the name shown under it.
final class AppIconSwitch {
    /// The alternates there are, by their Info.plist key. A request for
    /// anything else is not passed on, and only these names are ever written
    /// into the script sent back to the page.
    private static let alternates: Set<String> = ["Calculator", "Notes", "Weather"]

    private weak var webView: WKWebView?

    init(webView: WKWebView) {
        self.webView = webView
    }

    /// `name` nil puts the app's own icon back.
    func set(_ name: String?) {
        let application = UIApplication.shared
        if let name = name, !AppIconSwitch.alternates.contains(name) {
            report(failed: true)
            return
        }
        guard application.supportsAlternateIcons else {
            report(failed: true)
            return
        }
        if application.alternateIconName == name {
            report(failed: false)
            return
        }
        application.setAlternateIconName(name) { [weak self] error in
            DispatchQueue.main.async {
                self?.report(failed: error != nil)
            }
        }
    }

    /// Tells the page whether icons can be swapped here and which one is on.
    func report(failed: Bool) {
        guard let webView = webView else { return }
        let application = UIApplication.shared
        let supported = application.supportsAlternateIcons ? "true" : "false"
        let failedText = failed ? "true" : "false"
        var current = "null"
        if let name = application.alternateIconName, AppIconSwitch.alternates.contains(name) {
            current = "'\(name)'"
        }
        let state = "{supported:\(supported),current:\(current)}"
        let detail = "{supported:\(supported),current:\(current),failed:\(failedText)}"
        let script =
            "window.__FG_APP_ICON__=\(state);"
            + "window.dispatchEvent(new CustomEvent('fg:app-icon',{detail:\(detail)}));"
        webView.evaluateJavaScript(script, completionHandler: nil)
    }
}
