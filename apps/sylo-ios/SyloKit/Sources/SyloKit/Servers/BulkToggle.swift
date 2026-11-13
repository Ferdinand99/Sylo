import Foundation

/// The answer of `POST /api/v2/guilds/:id/modules/bulk`: how many modules the server switched.
/// It skips an id it does not know (or that only operators may switch) without an error, so a
/// count below the number sent means some modules did not change.
public struct BulkToggleResult: Decodable, Sendable, Equatable {
    public let count: Int
    public let isEnabled: Bool

    public init(count: Int, isEnabled: Bool) {
        self.count = count
        self.isEnabled = isEnabled
    }

    private enum CodingKeys: String, CodingKey { case count, enabled }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        count = c.lenientCount(.count)
        isEnabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
    }
}

extension Endpoints {
    /// `POST /api/v2/guilds/:id/modules/bulk` with `{ids, enabled}`: switches several modules at
    /// once, the overview's "Bulk edit".
    public struct SetModulesBulk: APIEndpoint {
        public typealias Response = BulkToggleResult
        public let server: ServerID
        public let modules: [ModuleID]
        public let enabled: Bool

        public init(server: ServerID, modules: [ModuleID], enabled: Bool) {
            self.server = server
            self.modules = modules
            self.enabled = enabled
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/bulk" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(ids: modules.map(\.rawValue), enabled: enabled) }

        private struct Body: Encodable, Sendable {
            let ids: [String]
            let enabled: Bool
        }
    }
}
