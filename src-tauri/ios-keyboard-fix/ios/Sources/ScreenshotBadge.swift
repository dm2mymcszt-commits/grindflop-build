import UIKit
import WebKit

/// The GrindFlop pill drawn where the notch or Dynamic Island sits, so the
/// hardware covers it in use and screenshots show it.
///
/// It is a native view rather than part of the page because the app switcher
/// shows a picture of the app with no notch over it. A page can hide the pill
/// only after the app has already resigned, and WebKit stops painting by then,
/// so the switcher kept showing it. A native view hides in the same moment
/// iOS announces the switch.
final class ScreenshotBadge {
    private weak var webView: WKWebView?
    private var pill: BadgePillView?
    private var wanted = false
    private var accent = UIColor(red: 34 / 255, green: 197 / 255, blue: 94 / 255, alpha: 1)
    private var observers: [NSObjectProtocol] = []

    init(webView: WKWebView) {
        self.webView = webView
        let center = NotificationCenter.default
        for name in [
            UIApplication.willResignActiveNotification,
            UIApplication.didEnterBackgroundNotification,
        ] {
            observers.append(
                center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    self?.hide()
                })
        }
        observers.append(
            center.addObserver(
                forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
            ) { [weak self] _ in
                self?.refresh()
            })
    }

    deinit {
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    /// Called by the page: whether it wants the pill, and its accent colour.
    func update(visible: Bool, accent: UIColor?) {
        wanted = visible
        if let accent = accent {
            self.accent = accent
        }
        refresh()
    }

    private func hide() {
        guard let pill = pill, !pill.isHidden else { return }
        pill.isHidden = true
        // Commit now rather than at the end of this run loop pass, ahead of
        // the picture iOS is about to take.
        CATransaction.flush()
    }

    private func refresh() {
        guard wanted,
            UIApplication.shared.applicationState == .active,
            let webView = webView,
            let host = webView.superview
        else {
            hide()
            return
        }

        let pill = self.pill ?? BadgePillView()
        self.pill = pill
        if pill.superview !== host {
            host.addSubview(pill)
        }
        host.bringSubviewToFront(pill)
        pill.apply(accent: accent)

        let size = pill.intrinsicContentSize
        let safeTop = host.window?.safeAreaInsets.top ?? host.safeAreaInsets.top
        // Inside the notch (safe area 44–47) or the Dynamic Island (59).
        pill.frame = CGRect(
            x: ((host.bounds.width - size.width) / 2).rounded(),
            y: max(safeTop - 43, 2),
            width: size.width,
            height: size.height)
        pill.isHidden = false
    }
}

private final class BadgePillView: UIView {
    private static let height: CGFloat = 24
    private static let iconSize: CGFloat = 14

    private let effectView = UIVisualEffectView(effect: nil)
    private let tintView = UIView()
    private let shine = CAGradientLayer()
    private let iconView = UIImageView(image: UIImage(named: "LaunchLogo"))
    private let label = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear

        effectView.clipsToBounds = true
        effectView.layer.cornerRadius = Self.height / 2
        addSubview(effectView)

        tintView.isUserInteractionEnabled = false
        effectView.contentView.addSubview(tintView)

        shine.colors = [UIColor(white: 1, alpha: 0.4).cgColor, UIColor(white: 1, alpha: 0).cgColor]
        shine.startPoint = CGPoint(x: 0.5, y: 0)
        shine.endPoint = CGPoint(x: 0.5, y: 0.7)
        effectView.contentView.layer.addSublayer(shine)

        iconView.contentMode = .scaleAspectFit
        effectView.contentView.addSubview(iconView)

        label.attributedText = NSAttributedString(
            string: "GRINDFLOP",
            attributes: [
                .font: UIFont.systemFont(ofSize: 10, weight: .black),
                .foregroundColor: UIColor.white,
                .kern: 0.6,
            ])
        effectView.contentView.addSubview(label)

        layer.cornerRadius = Self.height / 2
        layer.borderWidth = 0.5
        layer.borderColor = UIColor(white: 1, alpha: 0.35).cgColor
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var intrinsicContentSize: CGSize {
        let text = label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: Self.height))
        let icon = iconView.image == nil ? 0 : Self.iconSize + 4
        return CGSize(width: ceil(10 + icon + text.width + 10), height: Self.height)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        effectView.frame = bounds
        tintView.frame = bounds

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shine.frame = bounds
        CATransaction.commit()

        var x: CGFloat = 10
        if iconView.image != nil {
            iconView.frame = CGRect(
                x: x, y: (bounds.height - Self.iconSize) / 2, width: Self.iconSize, height: Self.iconSize)
            x += Self.iconSize + 4
        }
        let text = label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: bounds.height))
        label.frame = CGRect(
            x: x, y: ((bounds.height - text.height) / 2).rounded(), width: text.width, height: text.height)
    }

    /// Liquid Glass tinted with the app's accent where iOS has it, and a
    /// frosted, tinted pill with a highlight everywhere else.
    func apply(accent: UIColor) {
        #if compiler(>=6.2)
            if #available(iOS 26.0, *) {
                let glass = UIGlassEffect(style: .clear)
                glass.tintColor = accent.withAlphaComponent(0.5)
                effectView.effect = glass
                tintView.backgroundColor = .clear
                shine.isHidden = true
                return
            }
        #endif
        effectView.effect = UIBlurEffect(style: .systemUltraThinMaterialDark)
        tintView.backgroundColor = accent.withAlphaComponent(0.4)
        shine.isHidden = false
    }
}
