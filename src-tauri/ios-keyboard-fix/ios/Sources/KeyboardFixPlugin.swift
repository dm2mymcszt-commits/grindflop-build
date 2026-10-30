import SwiftRs
import Tauri
import UIKit
import WebKit

private class NoInputAccessoryView: UIView {
    override var inputAccessoryView: UIView? { nil }
}

extension WKWebView {
    func hideInputAccessoryView() {
        guard let target = findContentView(in: self) else { return }

        let baseClassName = String(describing: type(of: target))
        let noAccessoryClassName = "\(baseClassName)_NoInputAccessory"

        var patchedClass: AnyClass? = NSClassFromString(noAccessoryClassName)
        if patchedClass == nil {
            guard let targetClass = object_getClass(target),
                let nameCString = noAccessoryClassName.cString(using: .utf8),
                let allocatedClass = objc_allocateClassPair(targetClass, nameCString, 0)
            else {
                return
            }
            if let method = class_getInstanceMethod(
                NoInputAccessoryView.self,
                #selector(getter: NoInputAccessoryView.inputAccessoryView)
            ) {
                class_addMethod(
                    allocatedClass,
                    #selector(getter: UIResponder.inputAccessoryView),
                    method_getImplementation(method),
                    method_getTypeEncoding(method)
                )
            }
            objc_registerClassPair(allocatedClass)
            patchedClass = allocatedClass
        }

        if let patchedClass = patchedClass {
            object_setClass(target, patchedClass)
        }
    }

    private func findContentView(in view: UIView) -> UIView? {
        if String(describing: type(of: view)).hasPrefix("WKContent") {
            return view
        }
        for subview in view.subviews {
            if let found = findContentView(in: subview) {
                return found
            }
        }
        return nil
    }
}

/// Everything the iOS web view needs beyond what Tauri sets up: no input
/// accessory bar, the keyboard handled by resizing the web view, the
/// screenshot badge, and swapping the home screen icon.
class KeyboardFixPlugin: Plugin {
    private var keyboardObserver: NSObjectProtocol?
    private weak var patchedWebView: WKWebView?
    private var keyboardResize: NativeKeyboardResize?
    private var badge: ScreenshotBadge?
    private var bridge: NativeBridge?

    @objc public override func load(webview: WKWebView) {
        patchedWebView = webview

        keyboardObserver = NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillShowNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.patchedWebView?.hideInputAccessoryView()
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self, let webview = self.patchedWebView else { return }
            webview.hideInputAccessoryView()

            // The page places everything around the notch and home indicator
            // itself (viewport-fit=cover). Left to UIKit, the scroll view
            // inset itself by the safe areas whenever the page stopped
            // scrolling, WebKit counted those insets as covered screen, and
            // the chat, which locks the page, got a viewport 81 points short.
            webview.scrollView.contentInsetAdjustmentBehavior = .never

            let keyboardResize = NativeKeyboardResize(webView: webview)
            self.keyboardResize = keyboardResize

            let badge = ScreenshotBadge(webView: webview)
            let bridge = NativeBridge(
                webView: webview, badge: badge, keyboard: keyboardResize,
                appIcon: AppIconSwitch(webView: webview))
            let controller = webview.configuration.userContentController
            controller.removeScriptMessageHandler(forName: NativeBridge.name)
            controller.add(bridge, name: NativeBridge.name)
            self.badge = badge
            self.bridge = bridge

            // Left by the restart diagnostics, which are gone.
            UserDefaults.standard.removeObject(forKey: "fg.webContentTerminations")
        }
    }

    deinit {
        if let keyboardObserver = keyboardObserver {
            NotificationCenter.default.removeObserver(keyboardObserver)
        }
    }
}

@_cdecl("init_plugin_ios_keyboard_fix")
func initPlugin() -> Plugin {
    return KeyboardFixPlugin()
}
