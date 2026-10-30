import Foundation
import SyloKit
import UserNotifications

/// Notification service extension: swaps Postal Pigeon's generic "Something needs your attention"
/// for the real text, which it fetches from the Sylo server the push belongs to, with the app token
/// in the shared Keychain group.
///
/// All the logic is `NotificationRewriter` in SyloKit (tested there). This class only hands it the
/// payload and puts the answer into the notification. Which server to ask comes from the app's own
/// tag registry, never from the push. It keeps the generic localised text whenever anything goes
/// wrong, and it answers before the system's time limit in every case: the fetch has its own limit
/// of 10 seconds, and `serviceExtensionTimeWillExpire` delivers what there is.
///
/// The older push paths (direct and relay) carry their own text and no Pigeon payload, so they pass
/// through untouched.
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var delivery: Delivery?

    override func didReceive(
        _ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        // Read here, so the task below holds only values that are safe to pass on.
        let payload = PushPayload.parse(request.content.userInfo)
        let rewriter = NotificationRewriter.live()
        // What goes out if the text cannot be fetched in time: the generic text, grouped by server.
        let delivery = Delivery(content: content, handler: contentHandler, fallback: rewriter.grouping(for: payload))
        lock.lock()
        self.delivery = delivery
        lock.unlock()

        Task {
            let rewrite = await rewriter.rewrite(payload)
            delivery.finish(with: rewrite)
        }
    }

    /// The system is about to end the extension: the notification goes out with the generic text,
    /// but still grouped by server.
    override func serviceExtensionTimeWillExpire() {
        lock.lock()
        let pending = delivery
        lock.unlock()
        pending?.expire()
    }
}

/// The content and the system's completion handler, used once. Whichever of the fetch and the time
/// limit comes first delivers; the other finds it done.
private final class Delivery: @unchecked Sendable {
    private let lock = NSLock()
    private var content: UNMutableNotificationContent?
    private var handler: ((UNNotificationContent) -> Void)?
    private let fallback: NotificationRewrite

    init(
        content: UNMutableNotificationContent, handler: @escaping (UNNotificationContent) -> Void,
        fallback: NotificationRewrite
    ) {
        self.content = content
        self.handler = handler
        self.fallback = fallback
    }

    func expire() {
        finish(with: fallback)
    }

    func finish(with rewrite: NotificationRewrite) {
        lock.lock()
        let content = self.content
        let handler = self.handler
        self.content = nil
        self.handler = nil
        lock.unlock()
        guard let content, let handler else { return }

        // Plain text only: the fields are set as strings, never parsed.
        if let title = rewrite.title { content.title = title }
        if let subtitle = rewrite.subtitle { content.subtitle = subtitle }
        if let body = rewrite.body { content.body = body }
        if let thread = rewrite.threadIdentifier { content.threadIdentifier = thread }
        if let sylo = rewrite.syloUserInfo {
            // What the app reads on a tap; the server is the one from the app's own registry.
            var userInfo = content.userInfo
            userInfo["sylo"] = sylo
            content.userInfo = userInfo
        }
        // Never blank, and never a bare key: if iOS left Pigeon's `loc-key` text unresolved, look
        // the generic text up in the app's own strings.
        if GenericNotificationText.needsGenericText(title: content.title, body: content.body) {
            content.title = Generic.title
            content.body = Generic.body
        }
        handler(content)
    }
}

/// Pigeon's generic text in the language of the phone. `loc-key` names it, and the strings live in
/// the app (`Localizable.xcstrings`), not in this extension.
private enum Generic {
    /// `Sylo.app/PlugIns/SyloNotificationService.appex`: the app is two folders up.
    private static var appBundle: Bundle {
        let appURL = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
        return Bundle(url: appURL) ?? Bundle.main
    }

    static var title: String {
        NSLocalizedString(GenericNotificationText.titleKey, tableName: nil, bundle: appBundle, value: "Sylo", comment: "")
    }

    static var body: String {
        NSLocalizedString(
            GenericNotificationText.bodyKey, tableName: nil, bundle: appBundle, value: "Something needs your attention",
            comment: "")
    }
}
