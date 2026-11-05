import Foundation

// Temporary roles (src/modules/tempRoles.js, normaliseTempRolesConfig, parseTempDuration; page
// route src/web/routes/v2TempRoles.js; web form web-v2/src/moduleForms/TempRoles.jsx): staff give a
// member a role for a set time and Sylo takes it back. The app edits the settings and lists the
// roles that are active; giving and removing one is left to the web dashboard.

/// The Temporary roles settings page.
public struct TempRolesPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "temp-roles"

    public let settings: TempRolesSettings
    public let roles: [RoleOption]
    /// The active temporary roles, soonest to end first (at most 200).
    public let list: TempRoleList

    public init(settings: TempRolesSettings, roles: [RoleOption] = [], list: TempRoleList = TempRoleList()) {
        self.settings = settings
        self.roles = roles
        self.list = list
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case roles, list
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: TempRolesSettings())
        roles = try c.decode(forKey: .roles, or: [])
        list = try c.decode(forKey: .list, or: TempRoleList())
    }
}

public struct TempRolesSettings: Codable, Sendable, Equatable {
    /// May use the commands without Manage Roles.
    public var staffRoles: [String]
    /// DM the member when they get the role, when it is taken back early and when it ends.
    public var dmMember: Bool
    /// What the dashboard's Add form starts with: "30m", "12h", "7d", "2w", "1d12h".
    public var defaultDuration: String

    public init(staffRoles: [String] = [], dmMember: Bool = false, defaultDuration: String = "7d") {
        self.staffRoles = staffRoles
        self.dmMember = dmMember
        self.defaultDuration = defaultDuration
    }

    public static let maxStaffRoles = 25
    public static let maxDurationLength = 30

    private enum CodingKeys: String, CodingKey { case staffRoles, dmMember, defaultDuration }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        staffRoles = try c.decode(forKey: .staffRoles, or: [])
        dmMember = try c.decode(forKey: .dmMember, or: false)
        defaultDuration = try c.decode(forKey: .defaultDuration, or: "7d")
    }

    /// Why the default duration is not one the server accepts, or nil when it is. The server would
    /// quietly replace a bad one with 7d on save, so the app says so first (same rules as
    /// `parseTempDuration`: units w, d, h and m, each at most once, 1 minute to 365 days).
    public var durationProblem: String? { Self.durationProblem(defaultDuration) }

    public static func durationProblem(_ text: String) -> String? {
        let raw = String(text.lowercased().filter { !$0.isWhitespace })
        let hint = "Write the time like 30m, 12h, 7d, 2w or 1d12h."
        if raw.isEmpty { return "Give a duration. \(hint)" }
        guard let parts = parts(of: raw) else { return "That is not a duration. \(hint)" }
        var seen = Set<Character>()
        var total = 0
        for (amount, unit) in parts {
            if !seen.insert(unit).inserted {
                return "Use each unit once, for example 1d12h. \(hint)"
            }
            total += amount * unitMinutes[unit, default: 0]
        }
        if total < 1 { return "The shortest time is 1 minute (1m)." }
        if total > 365 * 24 * 60 { return "The longest time is 365 days (365d)." }
        return nil
    }

    private static let unitMinutes: [Character: Int] = ["w": 7 * 24 * 60, "d": 24 * 60, "h": 60, "m": 1]

    /// `(amount, unit)` pairs of a string such as `1d12h`, or nil when it is not only such pairs
    /// (an amount is 1 to 6 digits).
    private static func parts(of raw: String) -> [(Int, Character)]? {
        var result: [(Int, Character)] = []
        var digits = ""
        for character in raw {
            if character.isASCII, character.isNumber {
                digits.append(character)
                if digits.count > 6 { return nil }
            } else if unitMinutes[character] != nil, !digits.isEmpty, let amount = Int(digits) {
                result.append((amount, character))
                digits = ""
            } else {
                return nil
            }
        }
        return digits.isEmpty && !result.isEmpty ? result : nil
    }
}

/// The list of active temporary roles on the page.
public struct TempRoleList: Decodable, Sendable, Equatable {
    /// All active temporary roles on the server.
    public let total: Int
    /// How many match the page's filter (all of them on the settings answer).
    public let matching: Int
    public let rows: [TempRoleRow]

    public init(total: Int = 0, matching: Int = 0, rows: [TempRoleRow] = []) {
        self.total = total
        self.matching = matching
        self.rows = rows
    }

    private enum CodingKeys: String, CodingKey { case total, matching, rows }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        total = try c.decode(forKey: .total, or: 0)
        matching = try c.decode(forKey: .matching, or: 0)
        rows = try c.decodeLossyArray(of: TempRoleRow.self, forKey: .rows)
    }
}

/// One member holding one temporary role.
public struct TempRoleRow: Decodable, Sendable, Hashable, Identifiable {
    public let userId: String
    public let roleId: String
    /// The member's display name (their id when Sylo cannot see them).
    public let member: String
    public let role: String
    /// When the role is taken back, in milliseconds since 1970.
    public let expiresAt: Double
    /// Who gave it; nil when unknown.
    public let addedByName: String?
    /// Kept in the mod log; "" when none.
    public let reason: String

    public var id: String { "\(userId):\(roleId)" }

    public init(userId: String, roleId: String, member: String, role: String, expiresAt: Double,
                addedByName: String? = nil, reason: String = "") {
        self.userId = userId
        self.roleId = roleId
        self.member = member
        self.role = role
        self.expiresAt = expiresAt
        self.addedByName = addedByName
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey {
        case userId, roleId, member, role, expiresAt, addedByName, reason
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let userId = try c.decode(String.self, forKey: .userId)
        let roleId = try c.decode(String.self, forKey: .roleId)
        self.init(
            userId: userId,
            roleId: roleId,
            member: try c.decode(forKey: .member, or: userId),
            role: try c.decode(forKey: .role, or: roleId),
            expiresAt: try c.decode(Double.self, forKey: .expiresAt),
            addedByName: try c.decodeIfPresent(String.self, forKey: .addedByName),
            reason: try c.decodeIfPresent(String.self, forKey: .reason) ?? "")
    }

    public var expiresDate: Date { Date(timeIntervalSince1970: expiresAt / 1000) }

    /// "Ends in 2 days". A role whose time has passed but that the server has not swept yet (it
    /// does so every minute) reads "Ending now", not "Ends 3 min. ago".
    public func endsText(now: Date = .now, locale: Locale = .current) -> String {
        expiresDate <= now ? "Ending now" : "Ends " + DateText.relative(expiresDate, now: now, locale: locale)
    }
}
