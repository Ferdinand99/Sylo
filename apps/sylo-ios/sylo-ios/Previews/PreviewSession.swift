import SwiftUI
import SyloKit

/// Sample answers, the shapes a current Sylo sends.
nonisolated enum PreviewData {
    static let info = ServerInfo(
        version: "4.1.0", loginProviders: [.discord, .fluxer], platforms: [.discord, .fluxer],
        features: [.appLogin, .liveAccess, .push])

    static let pushSettings = PushSettingsInfo(isEnabled: true, mutedServers: ["2"])

    static let servers = [
        ServerSummary(id: "1", name: "Sylo Test Server", platform: .discord, openTickets: 2, unreadTickets: 1),
        ServerSummary(id: "2", name: "Gaming Night", platform: .discord),
        ServerSummary(id: "fluxer:3", name: "Fluxer Friends", platform: .fluxer, openTickets: 1),
    ]

    static let overview = ServerOverview(
        server: OverviewServer(id: "1", name: "Sylo Test Server", memberCount: 128),
        openTickets: 2,
        groups: [
            OverviewGroup(title: "Core", cards: [
                OverviewCard(kind: .link, id: "general", name: "Settings", icon: "gear", hasToggle: false,
                             isEnabled: nil, status: .link, webPath: "/guild/1"),
                OverviewCard(kind: .module, id: "logging", name: "Logging", icon: "file-text", hasToggle: true,
                             isEnabled: true, status: .on,
                             lines: [StatusLine(label: "Log channel", value: "#mod-log", state: .on)]),
                OverviewCard(kind: .module, id: "automod", name: "Auto-moderation", icon: "shield", hasToggle: true,
                             isEnabled: false, status: .off),
            ]),
            OverviewGroup(title: "Engagement", cards: [
                OverviewCard(kind: .module, id: "welcome", name: "Welcome", icon: "user-plus", hasToggle: true,
                             isEnabled: true, missingIntents: ["GuildMembers"], status: .blocked),
                OverviewCard(kind: .module, id: "auto-react", name: "Auto-react", icon: "smile", hasToggle: true,
                             isEnabled: false, isBeta: true, status: .off),
            ]),
        ])

    static let tickets: TicketList = decode(#"""
    {"open": [
      {"id": 1, "user": "member#0001", "userId": "1", "preview": "My role is gone after the update, can you check?",
       "previewKind": "user", "ago": "2m ago", "lastAt": \#(nowMillis - 120_000), "unread": true},
      {"id": 2, "user": "gamer#4242", "userId": "2", "preview": "Thanks, that worked!", "previewKind": "staff",
       "ago": "3h ago", "lastAt": \#(nowMillis - 10_800_000), "unread": false}
    ], "closed": [
      {"id": 3, "user": "old#1111", "userId": "3", "preview": "Ticket closed.", "previewKind": "system",
       "ago": "4d ago", "lastAt": \#(nowMillis - 345_600_000), "unread": false}
    ]}
    """#)

    static let ticketThread: TicketThread = decode(#"""
    {"ticket": {"id": 1, "status": "open", "user": "member#0001", "userId": "1", "openedAgo": "1h ago",
                "openedAt": \#(nowMillis - 3_600_000)},
     "messages": [
      {"id": 1, "kind": "system", "who": "System", "content": "Ticket opened.", "attachments": [], "delivered": true,
       "ago": "1h ago", "at": \#(nowMillis - 3_600_000)},
      {"id": 2, "kind": "user", "who": "member#0001", "content": "Hi! My role is gone after the update.",
       "attachments": [], "delivered": true, "ago": "1h ago", "at": \#(nowMillis - 3_590_000)},
      {"id": 3, "kind": "staff", "who": "Staff", "content": "Hi! Which role was it?", "attachments": [],
       "delivered": true, "ago": "5m ago", "at": \#(nowMillis - 300_000)},
      {"id": 4, "kind": "user", "who": "member#0001", "content": "Supporter. Can you check?", "attachments": [],
       "delivered": true, "ago": "2m ago", "at": \#(nowMillis - 120_000)}
     ], "lastId": 4}
    """#)

    private static var nowMillis: Int { Int(Date().timeIntervalSince1970 * 1000) }

    private static func decode<T: Decodable>(_ json: String) -> T {
        // Sample data spelled out above; a typo here is a programming error in the previews.
        try! JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    static let account = AccountInfo(
        platforms: [
            PlatformConnection(platform: .discord, isConnected: true, username: "ferdi", serverCount: 2),
            PlatformConnection(platform: .fluxer, isConnected: false),
        ],
        devices: [
            SignedInDevice(id: "a", name: "iPhone — Sylo app", createdAt: .now.addingTimeInterval(-86_400 * 3),
                           lastUsedAt: .now, isCurrent: true),
            SignedInDevice(id: "b", name: "iPad — Sylo app", createdAt: .now.addingTimeInterval(-86_400 * 20),
                           lastUsedAt: .now.addingTimeInterval(-86_400 * 2)),
        ])
}

/// Answers like a current Sylo, without a network.
nonisolated struct PreviewClient: APIClient {
    /// Answers a screen's own calls (a module's settings page) before the shared ones.
    typealias Answer = @Sendable (any APIEndpoint) -> Any?
    var extra: Answer?

    func send<E: APIEndpoint>(_ endpoint: E) async throws -> E.Response {
        guard let response = (extra?(endpoint) ?? Self.shared(endpoint)) as? E.Response else {
            throw NetworkError.notFound
        }
        return response
    }

    private static func shared(_ endpoint: any APIEndpoint) -> Any {
        switch endpoint {
        case is Endpoints.ServerInfo: PreviewData.info
        case is Endpoints.Servers: ServerList(servers: PreviewData.servers)
        case is Endpoints.Overview: PreviewData.overview
        case let set as Endpoints.SetModule: ModuleToggleResult(isEnabled: set.enabled)
        case is Endpoints.Account: PreviewData.account
        case is Endpoints.RevokeDevice: OKResponse()
        case is Endpoints.PushSettings: PreviewData.pushSettings
        case is Endpoints.RegisterPush: OKResponse()
        case let mute as Endpoints.MutePushForServer: PushMuteResult(mutedServers: mute.muted ? [mute.server] : [])
        default: EmptyResponse()
        }
    }
}

nonisolated final class PreviewServerPreference: ServerPreference {
    var server: ServerURL?
    init(_ server: ServerURL?) { self.server = server }
}

extension AppSession {
    enum PreviewState {
        case choosingServer
        case signIn
        case signedIn
    }

    /// A session already in `state`, for previews.
    /// - Parameter answer: Answers the screen's own calls; nil falls back to ``PreviewData``.
    static func preview(
        _ state: PreviewState, server: ServerURL = .hosted, answer: PreviewClient.Answer? = nil
    ) -> AppSession {
        let tokens = InMemoryTokenStore()
        if state == .signedIn {
            try? tokens.save(StoredToken(token: "sylo_preview", expiresAt: .distantFuture), for: server.description)
        }
        let session = AppSession(
            tokens: tokens,
            preference: PreviewServerPreference(state == .choosingServer ? nil : server),
            deviceName: "Preview",
            makeClient: { _, _ in PreviewClient(extra: answer) }
        )
        session.start()
        return session
    }
}
