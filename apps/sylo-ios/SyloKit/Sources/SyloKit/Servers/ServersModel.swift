import Foundation
import Observation

/// The servers of one platform, for one sidebar section.
public struct ServerSection: Identifiable, Equatable, Sendable {
    public let platform: Platform
    public let servers: [ServerSummary]

    public var id: Platform { platform }

    /// Discord first, then Fluxer, then anything newer; the server's (name) order inside each.
    public static func sections(for servers: [ServerSummary]) -> [ServerSection] {
        var order: [Platform] = [.discord, .fluxer]
        for server in servers where !order.contains(server.platform) {
            order.append(server.platform)
        }
        return order.compactMap { platform in
            let matching = servers.filter { $0.platform == platform }
            return matching.isEmpty ? nil : ServerSection(platform: platform, servers: matching)
        }
    }
}

/// The servers the signed-in person manages, for the sidebar.
@MainActor
@Observable
public final class ServersModel {
    public private(set) var servers: [ServerSummary] = []
    /// Whether a load has finished at least once, so an empty list means "none" and not "not yet".
    public private(set) var hasLoaded = false
    public private(set) var isLoading = false
    public var errorMessage: String?

    public var sections: [ServerSection] { ServerSection.sections(for: servers) }

    private let session: AppSession

    public init(session: AppSession) {
        self.session = session
    }

    public func server(_ id: ServerID?) -> ServerSummary? {
        servers.first { $0.id == id }
    }

    /// Loads the list. On failure the servers already shown stay; a 401 is the session's to show.
    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            servers = try await session.send(Endpoints.Servers()).servers
            hasLoaded = true
            errorMessage = nil
        } catch let error as NetworkError {
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        } catch {
            errorMessage = NetworkError(error).userMessage
        }
    }
}
