import AuthenticationServices
import Foundation
import SwiftRs
import Tauri
import UIKit
import WebKit

private struct AuthorizeArgs: Decodable {
    let authorizationUrl: String
    let callbackScheme: String
}

private struct WebViewAuthorizeArgs: Decodable {
    let authorizationUrl: String
    let callbackPrefix: String
}

/// Hosts the system browser sheet may open: Google (Drive sync and Grindr
/// sign-in) and Facebook (Grindr sign-in).
private let browserHosts: Set<String> = [
    "accounts.google.com",
    "m.facebook.com",
    "www.facebook.com",
    "facebook.com",
]

/// Sign in with Apple returns to Grindr's own web address, which only an
/// embedded web view can intercept, so it gets its own allowlist.
private let webViewHosts: Set<String> = ["appleid.apple.com"]
private let webViewCallbackPrefixes: Set<String> = ["https://web.grindr.com/apple-login"]

private final class IosGoogleOAuthPlugin: Plugin,
    ASWebAuthenticationPresentationContextProviding
{
    private weak var webView: WKWebView?
    private var session: ASWebAuthenticationSession?
    private var webSignIn: UIViewController?
    private var sessionId: UUID?
    private var pendingInvoke: Invoke?
    private var timeoutWorkItem: DispatchWorkItem?

    @objc override func load(webview: WKWebView) {
        self.webView = webview
    }

    @objc func authorize(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(AuthorizeArgs.self)

        guard let authorizationUrl = URL(string: args.authorizationUrl),
            isAllowed(authorizationUrl, hosts: browserHosts),
            isValidCallbackScheme(args.callbackScheme)
        else {
            invoke.reject("The authorization request was invalid.", code: "oauth_invalid_request")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                invoke.reject("The sign-in could not start.", code: "oauth_failed")
                return
            }
            guard self.pendingInvoke == nil, self.session == nil, self.webSignIn == nil else {
                invoke.reject("A sign-in is already in progress.", code: "oauth_in_progress")
                return
            }

            let sessionId = UUID()
            let session = ASWebAuthenticationSession(
                url: authorizationUrl,
                callbackURLScheme: args.callbackScheme
            ) { [weak self] callbackUrl, error in
                DispatchQueue.main.async {
                    self?.complete(callbackUrl: callbackUrl, error: error, sessionId: sessionId)
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false

            self.session = session
            self.sessionId = sessionId
            self.pendingInvoke = invoke
            self.startTimeout(sessionId: sessionId)

            if !session.start() {
                self.rejectPending(
                    code: "oauth_failed", cancelSession: false, expectedSessionId: sessionId)
            }
        }
    }

    /// Opens the sign-in page in a sheet with its own web view and resolves
    /// with the first address that starts with `callbackPrefix`, without
    /// loading it.
    @objc func authorizeInWebView(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(WebViewAuthorizeArgs.self)

        guard let authorizationUrl = URL(string: args.authorizationUrl),
            isAllowed(authorizationUrl, hosts: webViewHosts),
            webViewCallbackPrefixes.contains(args.callbackPrefix)
        else {
            invoke.reject("The authorization request was invalid.", code: "oauth_invalid_request")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                invoke.reject("The sign-in could not start.", code: "oauth_failed")
                return
            }
            guard self.pendingInvoke == nil, self.session == nil, self.webSignIn == nil else {
                invoke.reject("A sign-in is already in progress.", code: "oauth_in_progress")
                return
            }
            guard let presenter = self.topViewController() else {
                invoke.reject("The sign-in could not start.", code: "oauth_failed")
                return
            }

            let sessionId = UUID()
            let controller = WebSignInViewController(
                startUrl: authorizationUrl,
                callbackPrefix: args.callbackPrefix
            ) { [weak self] callbackUrl in
                DispatchQueue.main.async {
                    self?.completeWebSignIn(callbackUrl: callbackUrl, sessionId: sessionId)
                }
            }
            let navigation = UINavigationController(rootViewController: controller)
            navigation.modalPresentationStyle = .pageSheet
            // Only Cancel closes it, so the pending call always gets an answer.
            navigation.isModalInPresentation = true

            self.webSignIn = navigation
            self.sessionId = sessionId
            self.pendingInvoke = invoke
            self.startTimeout(sessionId: sessionId)
            presenter.present(navigation, animated: true)
        }
    }

    @objc func cancel(_ invoke: Invoke) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                invoke.resolve()
                return
            }

            let pending = self.takePending()
            pending.invoke?.reject("The sign-in was cancelled.", code: "oauth_cancelled")
            pending.session?.cancel()
            invoke.resolve()
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        if let window = webView?.window {
            return window
        }

        let activeWindow = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }
        if let activeWindow = activeWindow {
            return activeWindow
        }

        if let viewControllerWindow = manager.viewController?.view.window {
            return viewControllerWindow
        }

        return ASPresentationAnchor()
    }

    private func topViewController() -> UIViewController? {
        var top = manager.viewController ?? webView?.window?.rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }

    private func startTimeout(sessionId: UUID) {
        let timeout = DispatchWorkItem { [weak self] in
            self?.rejectPending(
                code: "oauth_timeout", cancelSession: true, expectedSessionId: sessionId)
        }
        timeoutWorkItem = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 300, execute: timeout)
    }

    private func complete(callbackUrl: URL?, error: Error?, sessionId: UUID) {
        guard pendingInvoke != nil, self.sessionId == sessionId else { return }

        if let authenticationError = error as? ASWebAuthenticationSessionError,
            authenticationError.code == .canceledLogin
        {
            rejectPending(
                code: "oauth_cancelled", cancelSession: false, expectedSessionId: sessionId)
            return
        }
        guard error == nil, let callbackUrl = callbackUrl else {
            rejectPending(code: "oauth_failed", cancelSession: false, expectedSessionId: sessionId)
            return
        }

        let pending = takePending()
        pending.invoke?.resolve(["callbackUrl": callbackUrl.absoluteString])
    }

    private func completeWebSignIn(callbackUrl: URL?, sessionId: UUID) {
        guard pendingInvoke != nil, self.sessionId == sessionId else { return }
        guard let callbackUrl = callbackUrl else {
            rejectPending(
                code: "oauth_cancelled", cancelSession: false, expectedSessionId: sessionId)
            return
        }
        let pending = takePending()
        pending.invoke?.resolve(["callbackUrl": callbackUrl.absoluteString])
    }

    private func rejectPending(
        code: String, cancelSession: Bool, expectedSessionId: UUID? = nil
    ) {
        if let expectedSessionId = expectedSessionId, sessionId != expectedSessionId {
            return
        }
        let pending = takePending()
        guard let invoke = pending.invoke else { return }

        let message: String
        switch code {
        case "oauth_cancelled":
            message = "The sign-in was cancelled."
        case "oauth_timeout":
            message = "The sign-in timed out."
        default:
            message = "The sign-in failed."
        }
        invoke.reject(message, code: code)
        if cancelSession {
            pending.session?.cancel()
        }
    }

    /// Clears the pending sign-in and closes the web sheet if one is open.
    private func takePending() -> (invoke: Invoke?, session: ASWebAuthenticationSession?) {
        timeoutWorkItem?.cancel()
        timeoutWorkItem = nil
        let invoke = pendingInvoke
        let session = session
        if let webSignIn = webSignIn {
            webSignIn.presentingViewController?.dismiss(animated: true)
        }
        pendingInvoke = nil
        self.session = nil
        webSignIn = nil
        sessionId = nil
        return (invoke, session)
    }

    private func isAllowed(_ url: URL, hosts: Set<String>) -> Bool {
        guard url.scheme?.lowercased() == "https",
            let host = url.host?.lowercased(),
            hosts.contains(host),
            url.port == nil,
            url.user == nil,
            url.password == nil
        else {
            return false
        }
        return true
    }

    private func isValidCallbackScheme(_ scheme: String) -> Bool {
        guard !scheme.isEmpty, scheme.count <= 512,
            let first = scheme.unicodeScalars.first,
            CharacterSet.letters.contains(first)
        else {
            return false
        }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "+.-"))
        return scheme.unicodeScalars.allSatisfy { allowed.contains($0) }
    }
}

/// A sheet with a web view and a Cancel button. Reports the callback address
/// the first time the page tries to go there, or nil when cancelled.
private final class WebSignInViewController: UIViewController, WKNavigationDelegate {
    private let startUrl: URL
    private let callbackPrefix: String
    private let onFinish: (URL?) -> Void
    private var finished = false
    private var signInWebView: WKWebView?

    init(startUrl: URL, callbackPrefix: String, onFinish: @escaping (URL?) -> Void) {
        self.startUrl = startUrl
        self.callbackPrefix = callbackPrefix
        self.onFinish = onFinish
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        return nil
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = "Sign in with Apple"
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .cancel, target: self, action: #selector(cancelTapped))

        let configuration = WKWebViewConfiguration()
        // Nothing from this sign-in is kept once the sheet closes.
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: view.bounds, configuration: configuration)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        view.addSubview(webView)
        signInWebView = webView
        webView.load(URLRequest(url: startUrl))
    }

    @objc private func cancelTapped() {
        finish(nil)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if let url = navigationAction.request.url,
            url.absoluteString.hasPrefix(callbackPrefix)
        {
            decisionHandler(.cancel)
            finish(url)
            return
        }
        decisionHandler(.allow)
    }

    private func finish(_ url: URL?) {
        guard !finished else { return }
        finished = true
        signInWebView?.stopLoading()
        onFinish(url)
    }
}

@_cdecl("init_plugin_ios_google_oauth")
func initPlugin() -> Plugin {
    return IosGoogleOAuthPlugin()
}
