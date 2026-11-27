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

    /// What the last refresh said, when there is something to say (a server was added, or the server asks to
    /// wait); nil otherwise.
    public var refreshNote: String?

    /// The person asked for a fresh list (pull to refresh, the Refresh button): first the server looks again
    /// through the bot for servers it joined since sign-in (Sylo 5.3, `POST /api/v2/account/refresh-guilds`), then
    /// the list is loaded. An older Sylo has no such call (404) and a refresh within 30 seconds is refused (429):
    /// either way the list is still loaded, as before.
    public func refresh() async {
        refreshNote = nil
        do {
            let answer = try await session.send(Endpoints.RefreshServerList())
            if answer.added > 0 {
                refreshNote = answer.added == 1
                    ? String(localized: "1 new server was found.")
                    : String(localized: "\(answer.added) new servers were found.")
            }
        } catch {
            switch NetworkError(error) {
            case .rateLimited:
                refreshNote = String(localized: "The server list was just refreshed. Wait a few seconds and try again.")
            default:
                // 404 on a Sylo before 5.3, or offline: the load below says what is wrong, if anything.
                break
            }
        }
        await load()
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

/// The answer to a refresh of the server list: how many servers were added to the person's list.
public struct ServerListRefresh: Decodable, Sendable, Equatable {
    public let added: Int

    public init(added: Int = 0) { self.added = added }

    private enum CodingKeys: String, CodingKey { case added }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        added = max(0, (try? c.decodeIfPresent(Int.self, forKey: .added)) ?? 0)
    }
}

extension Endpoints {
    /// `POST /api/v2/account/refresh-guilds` (Sylo 5.3): look through the bot for servers the bot joined after
    /// sign-in, for the signed-in person's own logins. Once per 30 seconds per account.
    public struct RefreshServerList: APIEndpoint {
        public typealias Response = ServerListRefresh
        public init() {}
        public var path: String { "/api/v2/account/refresh-guilds" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { CommunityEmptyBody() }
    }
}
