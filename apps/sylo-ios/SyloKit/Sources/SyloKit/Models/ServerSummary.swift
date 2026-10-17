import Foundation

/// The servers the person manages, from `GET /api/v2/guilds`, sorted by name by the server.
public struct ServerList: Decodable, Sendable, Equatable {
    public let servers: [ServerSummary]

    public init(servers: [ServerSummary]) { self.servers = servers }

    private enum CodingKeys: String, CodingKey { case guilds }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        servers = try c.decodeLossyArray(of: ServerSummary.self, forKey: .guilds)
    }
}

/// One server (a Discord guild or Fluxer community) in the sidebar.
public struct ServerSummary: Decodable, Sendable, Hashable, Identifiable {
    public let id: ServerID
    public let name: String
    public let iconURL: URL?
    public let platform: Platform
    /// Open tickets, and those with a member message staff haven't seen (0 from an older server).
    public let openTickets: Int
    public let unreadTickets: Int

    public init(
        id: ServerID, name: String, iconURL: URL? = nil, platform: Platform, openTickets: Int = 0,
        unreadTickets: Int = 0
    ) {
        self.id = id
        self.name = name
        self.iconURL = iconURL
        self.platform = platform
        self.openTickets = openTickets
        self.unreadTickets = unreadTickets
    }

    private enum CodingKeys: String, CodingKey { case id, name, icon, platform, openTickets, unreadTickets }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ServerID.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        iconURL = try c.decodeURLIfPresent(forKey: .icon)
        platform = try c.decodeIfPresent(Platform.self, forKey: .platform)
            ?? (id.rawValue.hasPrefix("fluxer:") ? .fluxer : .discord)
        openTickets = try c.decodeIfPresent(Int.self, forKey: .openTickets) ?? 0
        unreadTickets = try c.decodeIfPresent(Int.self, forKey: .unreadTickets) ?? 0
    }
}
