import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// What the notification service extension changes about a notification. Everything here is plain
/// text. A field that is `nil` is left as it came (Pigeon's generic "Something needs your attention").
public struct NotificationRewrite: Equatable, Sendable {
    public var title: String?
    public var subtitle: String?
    public var body: String?
    /// Notifications with the same thread identifier group together on the lock screen.
    public var threadIdentifier: String?
    /// Where a tap goes, with ``server``: the extension puts ``syloUserInfo`` in the notification.
    public var link: NotificationLink?
    /// The Sylo server from the app's own registry, never from the push.
    public var server: ServerURL?

    public init(
        title: String? = nil, subtitle: String? = nil, body: String? = nil, threadIdentifier: String? = nil,
        link: NotificationLink? = nil, server: ServerURL? = nil
    ) {
        self.title = title
        self.subtitle = subtitle
        self.body = body
        self.threadIdentifier = threadIdentifier
        self.link = link
        self.server = server
    }

    /// The notification stays as Pigeon sent it.
    public static let unchanged = NotificationRewrite()

    /// `userInfo["sylo"]`, which ``TicketNotification`` and ``DevLogNotification`` read on a tap and
    /// while the app is open; nil when there is nothing to open.
    public var syloUserInfo: [String: Any]? {
        guard let link, let server else { return nil }
        return link.userInfo(server: server)
    }
}

/// The logic of the notification service extension: from the payload of a push to the text to show.
/// It lives here so it can be tested without a phone; the extension target only calls it.
///
/// What it does, and nothing more:
/// 1. reads the tag from the payload and looks it up in the ``PushRegistry`` (the app's own record),
///    which gives the Sylo server. The address never comes from the push;
/// 2. takes that server's app token from the shared Keychain group;
/// 3. asks that server for the text behind the `ref`, for at most `limit`;
/// 4. returns the title, subtitle and body as plain text.
///
/// Any failure (unknown tag, unknown version, no token, no network, a slow or unhappy server) is
/// `.unchanged` or only the grouping, and the notification keeps Pigeon's generic text. The
/// extension has about 30 seconds and little memory: one small request, no retries.
public struct NotificationRewriter: Sendable {
    /// The text is cut to what a notification can show anyway.
    static let maxTitle = 300
    static let maxSubtitle = 300
    static let maxBody = 4000
    static let maxThread = 100

    private let registry: PushRegistry
    private let tokens: any TokenStore
    private let limit: Duration
    private let makeClient: @Sendable (ServerURL, String) -> any APIClient

    public init(registry: PushRegistry, tokens: any TokenStore, limit: Duration = .seconds(10)) {
        self.init(registry: registry, tokens: tokens, limit: limit, makeClient: Self.liveClient(limit: limit))
    }

    init(
        registry: PushRegistry, tokens: any TokenStore, limit: Duration,
        makeClient: @escaping @Sendable (ServerURL, String) -> any APIClient
    ) {
        self.registry = registry
        self.tokens = tokens
        self.limit = limit
        self.makeClient = makeClient
    }

    /// The client for one fetch: nothing is cached (`no-store` on the request, no cache at all in the
    /// session), and the request gives up after `limit`.
    private static func liveClient(limit: Duration) -> @Sendable (ServerURL, String) -> any APIClient {
        let seconds = TimeInterval(limit.components.seconds) + TimeInterval(limit.components.attoseconds) / 1e18
        return { server, token in
            let configuration = URLSessionAPIClient.defaultConfiguration()
            configuration.timeoutIntervalForRequest = seconds
            configuration.timeoutIntervalForResource = seconds
            configuration.httpAdditionalHeaders = ["Cache-Control": "no-store"]
            return URLSessionAPIClient(server: server, session: URLSession(configuration: configuration), token: { token })
        }
    }

    /// Only the grouping: no network, no Keychain. What the notification gets when the text cannot be
    /// fetched (or the extension runs out of time).
    public func grouping(for payload: PushPayload) -> NotificationRewrite {
        guard let entry = registryEntry(for: payload) else { return .unchanged }
        return NotificationRewrite(threadIdentifier: entry.server.description)
    }

    /// The server's entry for an alert push; nil for anything else, and for a tag the app does not
    /// know (so a push from another app, a later format or a forged tag is left alone).
    private func registryEntry(for payload: PushPayload) -> PushEntry? {
        guard case .v1(let push) = payload, push.kind == .alert else { return nil }
        return registry.entry(forTag: push.tag)
    }

    public func rewrite(_ payload: PushPayload) async -> NotificationRewrite {
        guard case .v1(let push) = payload, let entry = registryEntry(for: payload) else { return .unchanged }

        let grouping = NotificationRewrite(threadIdentifier: entry.server.description)
        guard let ref = push.ref else { return grouping }
        // A locked phone before its first unlock has no Keychain: the same as no token.
        guard let stored = try? tokens.token(for: entry.server.description), !stored.token.isEmpty else {
            return grouping
        }

        let client = makeClient(entry.server, stored.token)
        do {
            let content = try await withDeadline(limit) {
                try await client.send(Endpoints.PushEvent(ref: ref))
            }
            let title = Self.plainText(content.title, limit: Self.maxTitle, keepNewlines: false)
            guard !title.isEmpty else { return grouping }
            var subtitle: String?
            if let raw = content.subtitle {
                let text = Self.plainText(raw, limit: Self.maxSubtitle, keepNewlines: false)
                if !text.isEmpty { subtitle = text }
            }
            // The server's own thread (one per ticket), kept apart per Sylo server.
            var thread = entry.server.description
            if let raw = content.threadId {
                let text = Self.plainText(raw, limit: Self.maxThread, keepNewlines: false)
                if !text.isEmpty { thread += "#" + text }
            }
            return NotificationRewrite(
                title: title, subtitle: subtitle,
                body: Self.plainText(content.body, limit: Self.maxBody, keepNewlines: true),
                threadIdentifier: thread, link: content.link, server: entry.server)
        } catch {
            return grouping
        }
    }

    /// Text from a server, made safe to show: control characters and invisible format characters
    /// (bidi overrides included) are dropped, line breaks are kept in a body, surrounding space is
    /// trimmed and the length is limited. A joiner stays so emoji hold together.
    static func plainText(_ text: String, limit: Int, keepNewlines: Bool) -> String {
        var out = String.UnicodeScalarView()
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
        for scalar in normalized.unicodeScalars {
            if scalar == "\n" || scalar == "\r" {
                out.append(keepNewlines ? "\n" : " ")
            } else if scalar == "\t" {
                out.append(" ")
            } else if scalar.properties.generalCategory == .control
                || (scalar.properties.generalCategory == .format && scalar.value != 0x200D)
            {
                continue
            } else {
                out.append(scalar)
            }
        }
        let trimmed = String(out).trimmingCharacters(in: .whitespacesAndNewlines)
        return String(trimmed.prefix(limit))
    }
}

/// Pigeon's generic notification text. Its push names it by key (`loc-key`, `HR_PUSH_TITLE` and
/// `HR_PUSH_BODY`), which iOS looks up in the app's own `Localizable.xcstrings`. The extension makes
/// sure a notification is never blank or shows a bare key, whatever iOS did with the key.
public enum GenericNotificationText {
    public static let titleKey = "HR_PUSH_TITLE"
    public static let bodyKey = "HR_PUSH_BODY"

    /// Whether neither the title nor the body is real text (each is empty or still the bare key), so
    /// the notification has to get the localised generic text. A notification with a real title or
    /// body (the older push paths) is left alone.
    public static func needsGenericText(title: String, body: String) -> Bool {
        isMissing(title, key: titleKey) && isMissing(body, key: bodyKey)
    }

    private static func isMissing(_ text: String, key: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed == key
    }
}

/// Runs `operation` and gives up after `limit`: the operation is cancelled and
/// ``NetworkError/timeout`` is thrown, so a slow server cannot hold the extension until the system
/// ends it. Cancelling the caller cancels the operation.
func withDeadline<T: Sendable>(
    _ limit: Duration, operation: @escaping @Sendable () async throws -> T
) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(for: limit)
            throw NetworkError.timeout
        }
        defer { group.cancelAll() }
        guard let first = try await group.next() else { throw CancellationError() }
        return first
    }
}

#if canImport(Security)
extension NotificationRewriter {
    /// The rewriter the extension uses: the shared tag registry and the app's Keychain tokens.
    public static func live() -> NotificationRewriter {
        NotificationRewriter(
            registry: PushRegistry(fileURL: SyloAppStorage.pushRegistryFile), tokens: SyloAppStorage.makeTokenStore())
    }
}
#endif
