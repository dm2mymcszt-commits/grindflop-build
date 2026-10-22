import UIKit
import WebKit
import BackgroundRuntime

/// Messages the page posts through window.webkit.messageHandlers.fgNative.
/// A plain script message handler, not a Tauri command, because none of this
/// is worth a capability of its own and the page can tell from the handler's
/// presence alone that this build has it.
final class NativeBridge: NSObject, WKScriptMessageHandler {
    static let name = "fgNative"

    private weak var webView: WKWebView?
    private let badge: ScreenshotBadge
    private let keyboard: NativeKeyboardResize
    private let appIcon: AppIconSwitch
    private let background: FGBackgroundRuntime

    init(
        webView: WKWebView, badge: ScreenshotBadge, keyboard: NativeKeyboardResize,
        appIcon: AppIconSwitch
    ) {
        self.webView = webView
        self.badge = badge
        self.keyboard = keyboard
        self.appIcon = appIcon
        self.background = FGBackgroundRuntime(webView: webView)
        super.init()
    }

    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else {
            return
        }
        switch type {
        case "badge":
            let visible = (body["visible"] as? NSNumber)?.boolValue ?? false
            badge.update(visible: visible, accent: color(from: body["accent"]))
        case "refreshViewport":
            keyboard.refreshViewport()
        case "setAppIcon":
            // No name, or anything that is not text, puts the app's own icon back.
            appIcon.set(body["name"] as? String)
        case "getAppIcon":
            appIcon.report(failed: false)
        case "getBackgroundExecution":
            background.report()
        case "setBackgroundExecution":
            guard message.frameInfo.isMainFrame, let enabled = body["enabled"] as? Bool else { return }
            background.setEnabled(enabled)
        default:
            break
        }
    }

    private func color(from value: Any?) -> UIColor? {
        guard let channels = value as? [NSNumber], channels.count >= 3 else { return nil }
        return UIColor(
            red: CGFloat(channels[0].doubleValue) / 255,
            green: CGFloat(channels[1].doubleValue) / 255,
            blue: CGFloat(channels[2].doubleValue) / 255,
            alpha: 1)
    }
}
