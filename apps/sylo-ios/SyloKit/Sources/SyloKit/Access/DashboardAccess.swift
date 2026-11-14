import Foundation
import Observation

// Dashboard access levels (Sylo 5.2, `access-levels` in `GET /api/mobile/info`): per server, the person
// has View (read only), Inbox (View, plus acting on tickets, ban appeals, applications and suggestions)
// or Edit (everything). The server enforces the level on every route; the app reads `access` from the
// server list and hides or disables what the person may not use, so a View-only person is not offered
// a button the server would refuse. A server without levels sends no `access`: that is Edit, as before.

/// How much of a server the signed-in person may use.
public enum DashboardAccess: Hashable, Sendable, RawRepresentable, Codable {
    case view
    case inbox
    case edit
    /// A level a newer Sylo added. The app does not hide anything for it (the server still enforces
    /// what it means).
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "view": self = .view
        case "inbox": self = .inbox
        case "edit": self = .edit
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .view: "view"
        case .inbox: "inbox"
        case .edit: "edit"
        case .other(let raw): raw
        }
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    private var rank: Int {
        switch self {
        case .view: 1
        case .inbox: 2
        case .edit, .other: 3
        }
    }

    /// Whether this level reaches `required` (Edit reaches everything, Inbox reaches Inbox and View).
    public func allows(_ required: DashboardAccess) -> Bool { rank >= required.rank }

    /// May reply to tickets, decide appeals, applications and suggestions.
    public var canActOnInbox: Bool { allows(.inbox) }
    /// May change settings and run every other action.
    public var canEdit: Bool { allows(.edit) }
    /// Whether the person sees everything inside the inboxes (ticket texts, answers, reasons). View
    /// gets the lists without their content (`contentHidden`).
    public var seesInboxContent: Bool { allows(.inbox) }

    /// The badge for a level below Edit ("View only", "Inbox only"); nil for Edit.
    public var badgeTitle: String? {
        switch self {
        case .view: "View only"
        case .inbox: "Inbox only"
        case .edit, .other: nil
        }
    }

    /// One sentence for a screen that is read only, saying what the level allows.
    public var limitNote: String? {
        switch self {
        case .view: "You have view-only access to this server, so settings and actions are switched off."
        case .inbox: "You have Inbox access to this server: you can handle tickets, appeals, applications and suggestions. Settings are switched off."
        case .edit, .other: nil
        }
    }
}

extension ServerFeature {
    /// The server's dashboard access levels: `access` on each server and `GET/POST .../access`.
    public static let accessLevels = ServerFeature(rawValue: "access-levels")
    /// `GET /api/v2/guilds/:id/health`, the permission and role-hierarchy check.
    public static let health = ServerFeature(rawValue: "health")
}

// MARK: - The Dashboard access settings

/// `GET /api/v2/guilds/:id/access`: who has which level, and whether the person may change the Edit
/// roles. The Edit roles are the bot master roles, the same list the server settings save; the
/// Inbox and View lists are the ones this route saves.
public struct DashboardAccessSettings: Decodable, Sendable, Equatable {
    /// The person's own level in this server.
    public let level: DashboardAccess
    public let editRoleIds: [String]
    public let inboxRoleIds: [String]
    public let viewRoleIds: [String]
    /// Only the owner or someone with Manage Server may change the Edit roles.
    public let canChangeEditRoles: Bool

    public init(level: DashboardAccess = .edit, editRoleIds: [String] = [], inboxRoleIds: [String] = [],
                viewRoleIds: [String] = [], canChangeEditRoles: Bool = true) {
        self.level = level
        self.editRoleIds = editRoleIds
        self.inboxRoleIds = inboxRoleIds
        self.viewRoleIds = viewRoleIds
        self.canChangeEditRoles = canChangeEditRoles
    }

    private enum CodingKeys: String, CodingKey {
        case level, editRoleIds, inboxRoleIds, viewRoleIds, canChangeEditRoles
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        level = try c.decodeIfPresent(DashboardAccess.self, forKey: .level) ?? .edit
        editRoleIds = try c.decode(forKey: .editRoleIds, or: [])
        inboxRoleIds = try c.decode(forKey: .inboxRoleIds, or: [])
        viewRoleIds = try c.decode(forKey: .viewRoleIds, or: [])
        canChangeEditRoles = try c.decode(forKey: .canChangeEditRoles, or: true)
    }

    /// The Inbox and View lists, the part this route saves.
    public var roles: DashboardAccessRoles {
        DashboardAccessRoles(inboxRoleIds: inboxRoleIds, viewRoleIds: viewRoleIds)
    }
}

/// The two lists the access route saves. Only Inbox and View: the Edit roles go with the server
/// settings (`botMasterRoleIds`), as in the dashboard, so Manage Server is checked there.
public struct DashboardAccessRoles: Encodable, Sendable, Equatable {
    public var inboxRoleIds: [String]
    public var viewRoleIds: [String]

    public init(inboxRoleIds: [String] = [], viewRoleIds: [String] = []) {
        self.inboxRoleIds = inboxRoleIds
        self.viewRoleIds = viewRoleIds
    }

    /// The same set of roles in any order.
    public func sameRoles(as other: DashboardAccessRoles) -> Bool {
        Set(inboxRoleIds) == Set(other.inboxRoleIds) && Set(viewRoleIds) == Set(other.viewRoleIds)
    }

    /// Why this choice is not sensible, or nil: a role that is in two lists (the strongest one wins on
    /// the server) or that has Edit already. The form says it and keeps Save off.
    public func conflict(editRoleIds: [String]) -> String? {
        let edit = Set(editRoleIds)
        let inbox = Set(inboxRoleIds)
        let view = Set(viewRoleIds)
        if !inbox.isDisjoint(with: edit) || !view.isDisjoint(with: edit) {
            return "A role that has Edit access doesn't need to be an Inbox or View role as well."
        }
        if !view.isDisjoint(with: inbox) {
            return "A role can be an Inbox role or a View role, not both."
        }
        return nil
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/access`. A 404 means a Sylo without access levels.
    public struct LoadDashboardAccess: APIEndpoint {
        public typealias Response = DashboardAccessSettings
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/access" }
    }

    /// `POST /api/v2/guilds/:id/access` with the Inbox and View roles; answers the access settings as
    /// they are now. Needs Edit. The Edit roles are not sent from here.
    public struct SaveDashboardAccess: APIEndpoint {
        public typealias Response = DashboardAccessSettings
        public let server: ServerID
        public let roles: DashboardAccessRoles
        public init(server: ServerID, roles: DashboardAccessRoles) {
            self.server = server
            self.roles = roles
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/access" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { roles }
    }
}

extension NetworkError {
    /// A 404 from a path this Sylo does not have (no text, or the stock "Not found"), as opposed to a
    /// 404 that names a missing server or item. The app uses it to hide what an older server lacks.
    public var isMissingRoute: Bool {
        guard case .notFound(let message) = self else { return false }
        guard let message else { return true }
        return NetworkError.isStockPhrase(message)
    }

    /// A 403 that says the person's dashboard level is too low ("Your dashboard access in this server
    /// is View only, so you can't do this."). The server's sentence is in ``userMessage``.
    public var isAccessRefusal: Bool {
        guard case .forbidden(let message) = self, let message else { return false }
        return message.localizedCaseInsensitiveContains("dashboard access")
    }
}
