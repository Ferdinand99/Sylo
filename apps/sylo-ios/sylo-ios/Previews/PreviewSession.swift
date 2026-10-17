#if DEBUG
import SwiftUI
import SyloKit

/// Answers like a current Sylo with both logins, without a network.
nonisolated struct PreviewClient: APIClient {
    var info = ServerInfo(
        version: "4.1.0", loginProviders: [.discord, .fluxer], platforms: [.discord, .fluxer])

    func send<E: APIEndpoint>(_ endpoint: E) async throws -> E.Response {
        let answer: Any = endpoint is Endpoints.ServerInfo ? info : EmptyResponse()
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
#endif
