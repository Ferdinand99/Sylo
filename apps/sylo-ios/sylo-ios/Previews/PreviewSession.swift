import SwiftUI
import SyloKit

/// Sample answers, the shapes a current Sylo sends.
nonisolated enum PreviewData {
    static let info = ServerInfo(
        version: "4.1.0", loginProviders: [.discord, .fluxer], platforms: [.discord, .fluxer])

    static let servers = [
        ServerSummary(id: "1", name: "Sylo Test Server", platform: .discord),
        ServerSummary(id: "2", name: "Gaming Night", platform: .discord),
        ServerSummary(id: "fluxer:3", name: "Fluxer Friends", platform: .fluxer),
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
    func send<E: APIEndpoint>(_ endpoint: E) async throws -> E.Response {
        let answer: Any =
            switch endpoint {
            case is Endpoints.ServerInfo: PreviewData.info
            case is Endpoints.Servers: ServerList(servers: PreviewData.servers)
            case is Endpoints.Overview: PreviewData.overview
            case let set as Endpoints.SetModule: ModuleToggleResult(isEnabled: set.enabled)
            case is Endpoints.Account: PreviewData.account
            case is Endpoints.RevokeDevice: OKResponse()
            default: EmptyResponse()
            }
        guard let response = answer as? E.Response else { throw NetworkError.notFound }
        return response
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
    static func preview(_ state: PreviewState, server: ServerURL = .hosted) -> AppSession {
        let tokens = InMemoryTokenStore()
        if state == .signedIn {
            try? tokens.save(StoredToken(token: "sylo_preview", expiresAt: .distantFuture), for: server.description)
        }
        let session = AppSession(
            tokens: tokens,
            preference: PreviewServerPreference(state == .choosingServer ? nil : server),
            deviceName: "Preview",
            makeClient: { _, _ in PreviewClient() }
        )
        session.start()
        return session
    }
}
