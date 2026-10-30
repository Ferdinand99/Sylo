import Foundation
import Testing
@testable import SyloKit

/// The registry (with one server's tag), a token store and a Sylo server whose push-event answers
/// the test chooses.
struct RewriterHarness: Sendable {
    let server = try! ServerURL("https://sylo.example.com")
    let rewriter: NotificationRewriter
    let clients: StubClients
    private let folder: URL

    init(
        registered: Bool = true, token: StoredToken? = StoredToken(token: "sylo_tok", expiresAt: .distantFuture),
        limit: Duration = .seconds(5),
        makeClient: (@Sendable (ServerURL, String) -> any APIClient)? = nil,
        answer: @escaping @Sendable (Endpoints.PushEvent) throws -> PushEventContent
    ) {
        folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("SyloKitTests-\(UUID().uuidString)", isDirectory: true)
        let registry = PushRegistry(fileURL: folder.appendingPathComponent("push-tags.json"))
        if registered {
            try? registry.save(
                PushEntry(
                    tag: NotificationRewriterTests.tag, server: server, relayDeviceId: "hrd_1", relayHandleId: "h1",
                    created: Date()))
        }
        let stub = StubClients { endpoint in
            guard let event = endpoint as? Endpoints.PushEvent else { throw NetworkError.notFound }
            return try answer(event)
        }
        clients = stub
        let tokens = InMemoryTokenStore(tokens: token.map { ["https://sylo.example.com": $0] } ?? [:])
        let make: @Sendable (ServerURL, String) -> any APIClient = makeClient ?? { server, token in
            stub.make(server, token)
        }
        rewriter = NotificationRewriter(registry: registry, tokens: tokens, limit: limit, makeClient: make)
    }

    func cleanUp() {
        try? FileManager.default.removeItem(at: folder)
    }
}

@Suite("Notification rewriter")
struct NotificationRewriterTests {
    static let tag = "AAAAAAAAAAAAAAAAAAAAAA"
    static let ref = "BBBBBBBBBBBBBBBBBBBBBB"
    static let ticket = PushEventContent(
        title: "Support", subtitle: "New ticket", body: "alice: Hello there", threadId: "1:12",
        link: .ticket(guildID: "1", ticketID: 12))

    static func payload(
        tag: String = tag, ref: String? = ref, kind: String = "alert", extra: [String: Any] = [:]
    ) -> PushPayload {
        var hr: [String: Any] = ["v": 1, "k": kind, "t": tag]
        if let ref { hr["r"] = ref }
        for (key, value) in extra { hr[key] = value }
        return PushPayload.parse(["aps": ["mutable-content": 1], "hr": hr])
    }

    // MARK: What it does

    @Test("A ticket push becomes the ticket's text, grouped by ticket, and a tap still opens the ticket")
    func rewritesTicket() async throws {
        let h = RewriterHarness { _ in Self.ticket }
        defer { h.cleanUp() }
        let rewrite = await h.rewriter.rewrite(Self.payload())

        #expect(rewrite.title == "Support")
        #expect(rewrite.subtitle == "New ticket")
        #expect(rewrite.body == "alice: Hello there")
        #expect(rewrite.threadIdentifier == "https://sylo.example.com#1:12")
        #expect(rewrite.link == .ticket(guildID: "1", ticketID: 12))
        #expect(rewrite.server == h.server)

        let call = try #require(h.clients.calls.first)
        #expect(h.clients.calls.count == 1)
        #expect(call.server == h.server)
        #expect(call.token == "sylo_tok")
        #expect((call.endpoint as? Endpoints.PushEvent)?.ref == Self.ref)

        // The app's own notification handling reads the same thing it reads from the older pushes.
        let info = try #require(rewrite.syloUserInfo)
        #expect(TicketNotification(userInfo: ["sylo": info]) == TicketNotification(server: h.server, guildID: "1", ticketID: 12))
    }

    @Test("A dev-log push opens the dev log")
    func rewritesDevLog() async throws {
        let h = RewriterHarness { _ in
            PushEventContent(
                title: "Sylo dev log · sylo.example.com", subtitle: "Warning · db", body: "Slow query",
                threadId: "devlog", link: .devLog(.warning))
        }
        defer { h.cleanUp() }
        let rewrite = await h.rewriter.rewrite(Self.payload())
        #expect(rewrite.threadIdentifier == "https://sylo.example.com#devlog")
        let info = try #require(rewrite.syloUserInfo)
        #expect(DevLogNotification(userInfo: ["sylo": info]) == DevLogNotification(server: h.server, level: .warning))
    }

    @Test("A notification of a kind this version doesn't know still gets its text, and opens nothing")
    func unknownLink() async {
        let h = RewriterHarness { _ in PushEventContent(title: "Hi", body: "There") }
        defer { h.cleanUp() }
        let rewrite = await h.rewriter.rewrite(Self.payload())
        #expect(rewrite.title == "Hi")
        #expect(rewrite.link == nil)
        #expect(rewrite.syloUserInfo == nil)
        #expect(rewrite.threadIdentifier == "https://sylo.example.com")
    }

    @Test("The server is the one in the app's registry, whatever the push says")
    func serverFromRegistry() async throws {
        let h = RewriterHarness { _ in Self.ticket }
        defer { h.cleanUp() }
        let rewrite = await h.rewriter.rewrite(
            Self.payload(extra: ["s": "https://evil.example.com", "server": "https://evil.example.com"]))
        let call = try #require(h.clients.calls.first)
        #expect(call.server == h.server)
        #expect(rewrite.server == h.server)
        let info = try #require(rewrite.syloUserInfo)
        #expect(info["server"] as? String == h.server.description)
    }

    // MARK: What it leaves alone

    @Test("A tag the app doesn't know, or a tag nobody registered, is left as it came")
    func unknownTag() async {
        let h = RewriterHarness { _ in Self.ticket }
        defer { h.cleanUp() }
        #expect(await h.rewriter.rewrite(Self.payload(tag: "ZZZZZZZZZZZZZZZZZZZZZZ")) == .unchanged)
        #expect(h.rewriter.grouping(for: Self.payload(tag: "ZZZZZZZZZZZZZZZZZZZZZZ")) == .unchanged)

        let none = RewriterHarness(registered: false) { _ in Self.ticket }
        defer { none.cleanUp() }
        #expect(await none.rewriter.rewrite(Self.payload()) == .unchanged)
        #expect(h.clients.calls.isEmpty)
        #expect(none.clients.calls.isEmpty)
    }

    @Test("A silent push, a later format and a push that isn't Pigeon's are left as they came")
    func notAnAlert() async {
        let h = RewriterHarness { _ in Self.ticket }
        defer { h.cleanUp() }
        let payloads: [PushPayload] = [
            Self.payload(kind: "sync"), Self.payload(kind: "other"),
            PushPayload.parse(["aps": ["mutable-content": 1], "hr": ["v": 2, "k": "alert", "t": Self.tag]]),
            PushPayload.parse(["aps": ["alert": ["title": "Alpha"]], "sylo": ["kind": "ticket"]]),
            .malformed, .unsupportedVersion,
        ]
        for payload in payloads {
            #expect(await h.rewriter.rewrite(payload) == .unchanged, "\(payload)")
            #expect(h.rewriter.grouping(for: payload) == .unchanged, "\(payload)")
        }
        #expect(h.clients.calls.isEmpty)
    }

    // MARK: When the text can't be fetched

    @Test("Without a ref there is nothing to fetch: only the grouping")
    func noRef() async {
        let h = RewriterHarness { _ in Self.ticket }
        defer { h.cleanUp() }
        let rewrite = await h.rewriter.rewrite(Self.payload(ref: nil))
        #expect(rewrite == NotificationRewrite(threadIdentifier: "https://sylo.example.com"))
        #expect(h.clients.calls.isEmpty)
    }

    @Test("Without a token (not signed in, or the Keychain isn't open yet) nothing is sent anywhere")
    func noToken() async {
        let missing = RewriterHarness(token: nil) { _ in Self.ticket }
        defer { missing.cleanUp() }
        #expect(
            await missing.rewriter.rewrite(Self.payload()) == NotificationRewrite(threadIdentifier: "https://sylo.example.com"))
        #expect(missing.clients.calls.isEmpty)

        let empty = RewriterHarness(token: StoredToken(token: "", expiresAt: .distantFuture)) { _ in Self.ticket }
        defer { empty.cleanUp() }
        #expect(
            await empty.rewriter.rewrite(Self.payload()) == NotificationRewrite(threadIdentifier: "https://sylo.example.com"))
        #expect(empty.clients.calls.isEmpty)
    }

    @Test("Any failure keeps the generic text, grouped by server")
    func failures() async {
        let errors: [NetworkError] = [
            .notFound, .unauthorized, .forbidden, .offline, .timeout, .server(status: 500), .rateLimited,
            .notASyloServer, .decoding("x"),
        ]
        for error in errors {
            let h = RewriterHarness { _ in throw error }
            defer { h.cleanUp() }
            let rewrite = await h.rewriter.rewrite(Self.payload())
            #expect(rewrite == NotificationRewrite(threadIdentifier: "https://sylo.example.com"), "\(error)")
            #expect(h.clients.calls.count == 1, "\(error)")
        }
    }

    @Test("A server that never answers is given up on at the limit")
    func timeout() async {
        let h = RewriterHarness(limit: .milliseconds(100), makeClient: { _, _ in NeverAnswers() }) { _ in Self.ticket }
        defer { h.cleanUp() }
        let start = ContinuousClock.now
        let rewrite = await h.rewriter.rewrite(Self.payload())
        #expect(ContinuousClock.now - start < .seconds(5))
        #expect(rewrite == NotificationRewrite(threadIdentifier: "https://sylo.example.com"))
    }

    // MARK: Text from a server is only text

    @Test("Control characters and bidi overrides are dropped, line breaks only stay in a body")
    func hostileText() async {
        let h = RewriterHarness { _ in
            PushEventContent(
                title: "\u{202E}Pay\u{0007} now\u{200B}\nplease", subtitle: "\u{202E}\u{200B}",
                body: "line one\r\nline two\u{0000}\u{2066}x\ttab", threadId: "a\u{202E}b")
        }
        defer { h.cleanUp() }
        let rewrite = await h.rewriter.rewrite(Self.payload())
        #expect(rewrite.title == "Pay now please")
        #expect(rewrite.subtitle == nil)
        #expect(rewrite.body == "line one\nline twox tab")
        #expect(rewrite.threadIdentifier == "https://sylo.example.com#ab")
    }

    @Test("Long text is cut to what a notification can show")
    func longText() async {
        let h = RewriterHarness { _ in
            PushEventContent(
                title: String(repeating: "t", count: 1_000), subtitle: String(repeating: "s", count: 1_000),
                body: String(repeating: "x", count: 10_000), threadId: String(repeating: "h", count: 1_000))
        }
        defer { h.cleanUp() }
        let rewrite = await h.rewriter.rewrite(Self.payload())
        #expect(rewrite.title?.count == 300)
        #expect(rewrite.subtitle?.count == 300)
        #expect(rewrite.body?.count == 4_000)
        #expect(rewrite.threadIdentifier == "https://sylo.example.com#" + String(repeating: "h", count: 100))
    }

    @Test("A joiner stays, so emoji hold together, and a title with nothing left is no title")
    func joinerAndEmpty() async {
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"
        let h = RewriterHarness { _ in PushEventContent(title: "Hi " + family, body: "b") }
        defer { h.cleanUp() }
        #expect(await h.rewriter.rewrite(Self.payload()).title == "Hi " + family)

        let empty = RewriterHarness { _ in PushEventContent(title: "\u{202E}\u{200B}  ", body: "b") }
        defer { empty.cleanUp() }
        #expect(
            await empty.rewriter.rewrite(Self.payload()) == NotificationRewrite(threadIdentifier: "https://sylo.example.com"))
    }

    @Test("The grouping alone needs no network and no token")
    func grouping() {
        let h = RewriterHarness { _ in Self.ticket }
        defer { h.cleanUp() }
        #expect(h.rewriter.grouping(for: Self.payload()) == NotificationRewrite(threadIdentifier: "https://sylo.example.com"))
        #expect(h.clients.calls.isEmpty)
    }

    // MARK: Generic text

    @Test("Only a notification with neither a real title nor a real body needs the generic text")
    func genericText() {
        #expect(GenericNotificationText.needsGenericText(title: "", body: ""))
        #expect(GenericNotificationText.needsGenericText(title: "HR_PUSH_TITLE", body: "HR_PUSH_BODY"))
        #expect(GenericNotificationText.needsGenericText(title: " ", body: "HR_PUSH_BODY"))
        #expect(!GenericNotificationText.needsGenericText(title: "Sylo", body: "Something needs your attention"))
        #expect(!GenericNotificationText.needsGenericText(title: "Alpha", body: ""))
        #expect(!GenericNotificationText.needsGenericText(title: "", body: "alice: Hi"))
    }
}

/// A client whose calls never end by themselves.
struct NeverAnswers: APIClient {
    func send<E: APIEndpoint>(_ endpoint: E) async throws -> E.Response {
        try await Task.sleep(for: .seconds(60))
        throw NetworkError.timeout
    }
}
