import Foundation

// The calls of the moderation hub, one value each (src/web/routes/v2Staff.js). Member ids go out
// as the server reads them (`userId`); the server checks them, so a wrong id comes back as its own
// words. Every POST sends a JSON body, an empty one where the dashboard sends `{}`.

/// A body with no fields (`{}`), for calls that only name what to do in the path.
struct EmptyJSONBody: Encodable, Sendable {}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/moderation`.
    public struct LoadModeration: APIEndpoint {
        public typealias Response = ModerationOverview
        public let server: ServerID

        public init(server: ServerID) { self.server = server }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/moderation" }
    }

    /// `POST /moderation/unban`: lifts a ban and its scheduled unban. 404 when the member is not
    /// banned, 403 when the bot may not unban.
    public struct UnbanMember: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let userId: String

        public init(server: ServerID, userId: String) {
            self.server = server
            self.userId = userId
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/moderation/unban" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(userId: userId) }

        private struct Body: Encodable, Sendable { let userId: String }
    }

    /// `POST /moderation/lock-all`: locks every text channel that is not locked yet.
    public struct LockAllChannels: APIEndpoint {
        public typealias Response = LockAllResult
        public let server: ServerID

        public init(server: ServerID) { self.server = server }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/moderation/lock-all" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyJSONBody() }
    }

    /// `POST /moderation/unlock-all`: ends the lockdown.
    public struct UnlockAllChannels: APIEndpoint {
        public typealias Response = UnlockAllResult
        public let server: ServerID

        public init(server: ServerID) { self.server = server }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/moderation/unlock-all" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyJSONBody() }
    }

    /// `POST /moderation/unlock-channel`: unlocks one locked channel. 404 when it is not locked.
    public struct UnlockChannel: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let channelId: String

        public init(server: ServerID, channelId: String) {
            self.server = server
            self.channelId = channelId
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/moderation/unlock-channel" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(channelId: channelId) }

        private struct Body: Encodable, Sendable { let channelId: String }
    }

    /// `POST /moderation/warn`: warns a member of this server. The reason is required (at most 400
    /// characters) and goes to the member by DM. 404 when they are not a member, 403 when the
    /// server refuses (rank).
    public struct WarnMember: APIEndpoint {
        public typealias Response = WarnResult
        public let server: ServerID
        public let userId: String
        public let reason: String

        public init(server: ServerID, userId: String, reason: String) {
            self.server = server
            self.userId = userId
            self.reason = reason
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/moderation/warn" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(userId: userId, reason: reason) }

        private struct Body: Encodable, Sendable {
            let userId: String
            let reason: String
        }
    }

    /// `POST /moderation/warnings/clear`: removes every warning of a member. 404 when they have none.
    public struct ClearWarnings: APIEndpoint {
        public typealias Response = ClearWarningsResult
        public let server: ServerID
        public let userId: String

        public init(server: ServerID, userId: String) {
            self.server = server
            self.userId = userId
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/moderation/warnings/clear" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(userId: userId) }

        private struct Body: Encodable, Sendable { let userId: String }
    }

    /// `POST /moderation/cases/:n/reason`: rewrites a case's reason (required, at most 1000 characters).
    public struct EditCaseReason: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let caseNumber: Int
        public let reason: String

        public init(server: ServerID, caseNumber: Int, reason: String) {
            self.server = server
            self.caseNumber = caseNumber
            self.reason = reason
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/moderation/cases/\(caseNumber)/reason" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(reason: reason) }

        private struct Body: Encodable, Sendable { let reason: String }
    }

    /// `POST /moderation/cases/:n/delete` or `/restore`: takes a case off the record, or puts it back.
    public struct SetCaseActive: APIEndpoint {
        public typealias Response = CaseActiveResult
        public let server: ServerID
        public let caseNumber: Int
        /// True restores the case; false deletes it.
        public let active: Bool

        public init(server: ServerID, caseNumber: Int, active: Bool) {
            self.server = server
            self.caseNumber = caseNumber
            self.active = active
        }

        public var path: String {
            "/api/v2/guilds/\(server.pathComponent)/moderation/cases/\(caseNumber)/\(active ? "restore" : "delete")"
        }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyJSONBody() }
    }
}
