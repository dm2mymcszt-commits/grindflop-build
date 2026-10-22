import UIKit
import WebKit

/// Makes room for the keyboard by shortening the web view instead of letting
/// WebKit handle it.
///
/// Left to WebKit, the keyboard shrinks only the visual viewport and WebKit
/// pans the page to keep the focused field in sight. The chat locks the page
/// and moves its composer up itself, so whenever that pan won the race the
/// header slid off the top and a gap opened under the composer. The same
/// approach as Capacitor's native resize mode: WebKit stops hearing about the
/// keyboard, and the page simply gets a shorter window.
final class NativeKeyboardResize {
    private weak var webView: WKWebView?
    private var observers: [NSObjectProtocol] = []
    private var keyboardHeight: CGFloat = 0

    init(webView: WKWebView) {
        self.webView = webView

        let center = NotificationCenter.default
        for name in [
            UIResponder.keyboardWillShowNotification,
            UIResponder.keyboardWillHideNotification,
            UIResponder.keyboardWillChangeFrameNotification,
            UIResponder.keyboardDidChangeFrameNotification,
        ] {
            center.removeObserver(webView, name: name, object: nil)
        }

        observers.append(
            center.addObserver(
                forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main
            ) { [weak self] notification in
                self?.keyboardWillChangeFrame(notification)
            })
        observers.append(
            center.addObserver(
                forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main
            ) { [weak self] _ in
                self?.apply(height: 0)
            })
    }

    deinit {
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    /// Makes WebKit measure the viewport again.
    ///
    /// Opening a chat locks the page, and WebKit then sized the viewport 81
    /// points short of the screen, as if the safe areas still covered it. The
    /// stale size only went away once the web view's frame really changed,
    /// which until now meant opening the keyboard once. A one-point change and
    /// back does the same without it.
    func refreshViewport() {
        guard keyboardHeight == 0, let webView = webView, let host = webView.superview else { return }
        if #available(iOS 15.0, *) {
            host.backgroundColor = webView.underPageBackgroundColor
        }
        let full = host.bounds.height - webView.frame.minY
        var nudged = webView.frame
        nudged.size.height = full - 1
        webView.frame = nudged
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self = self, self.keyboardHeight == 0, let webView = self.webView,
                let host = webView.superview
            else {
                return
            }
            var restored = webView.frame
            restored.size.height = host.bounds.height - restored.minY
            webView.frame = restored
        }
    }

    private func keyboardWillChangeFrame(_ notification: Notification) {
        guard let webView = webView,
            let host = webView.superview,
            let screen = host.window?.screen,
            let value = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue
        else {
            return
        }
        let keyboard = host.convert(value.cgRectValue, from: screen.coordinateSpace)
        if keyboard.isEmpty {
            apply(height: 0)
            return
        }
        apply(height: max(0, host.bounds.maxY - keyboard.minY))
    }

    private func apply(height: CGFloat) {
        guard let webView = webView else { return }
        let rounded = height.rounded()
        guard rounded != keyboardHeight else { return }
        keyboardHeight = rounded

        // The page hears first, so that when its viewport shrinks it already
        // knows not to subtract the keyboard a second time.
        let points = Int(rounded)
        let script =
            "window.__FG_NATIVE_KEYBOARD__={height:\(points)};"
            + "window.dispatchEvent(new CustomEvent('fg:native-keyboard',{detail:{height:\(points)}}));"
        webView.evaluateJavaScript(script) { [weak self] _, _ in
            self?.resize(for: rounded)
        }
    }

    private func resize(for height: CGFloat) {
        guard height == keyboardHeight, let webView = webView, let host = webView.superview else {
            return
        }
        // Whatever shows between the shortened web view and the keyboard still
        // sliding in should be the page's own background, not the window's.
        if #available(iOS 15.0, *) {
            host.backgroundColor = webView.underPageBackgroundColor
        }
        var frame = webView.frame
        frame.size.height = max(0, host.bounds.height - frame.minY - height)
        webView.frame = frame
    }
}
