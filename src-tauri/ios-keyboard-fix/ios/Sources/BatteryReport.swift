import UIKit
import WebKit

/// The battery level and whether the phone is charging, for the background
/// day report. Sent to the page on request and on every change iOS
/// announces, as `fg:battery` with `{level: 0...1, charging: Bool}`
/// (level -1 when iOS does not say).
final class BatteryReport: NSObject {
    private weak var webView: WKWebView?

    init(webView: WKWebView) {
        self.webView = webView
        super.init()
        UIDevice.current.isBatteryMonitoringEnabled = true
        let center = NotificationCenter.default
        center.addObserver(
            self, selector: #selector(changed),
            name: UIDevice.batteryLevelDidChangeNotification, object: nil)
        center.addObserver(
            self, selector: #selector(changed),
            name: UIDevice.batteryStateDidChangeNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func changed() {
        DispatchQueue.main.async { [weak self] in self?.report() }
    }

    func report() {
        guard let webView = webView else { return }
        let device = UIDevice.current
        let level = device.batteryLevel
        let charging = device.batteryState == .charging || device.batteryState == .full
        // Only numbers and literals go into the script.
        let levelText = level.isFinite ? String(format: "%.3f", level) : "-1"
        let detail = "{level:\(levelText),charging:\(charging ? "true" : "false")}"
        let script =
            "window.__FG_BATTERY__=\(detail);"
            + "window.dispatchEvent(new CustomEvent('fg:battery',{detail:\(detail)}));"
        webView.evaluateJavaScript(script, completionHandler: nil)
    }
}
