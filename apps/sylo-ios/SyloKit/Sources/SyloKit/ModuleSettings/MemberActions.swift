import Foundation
import Observation

// The tools that change one member or one counter on a module's page, next to its settings. They
// mirror the dashboard's forms (web-v2/src/moduleForms/Counting.jsx, InviteTracker.jsx, Leveling.jsx,
// TempRoles.jsx) and the routes in src/web/routes/v2Api.js and v2TempRoles.js:
//
// - Counting: set the count, reset it, release a benched member early.
// - Invite tracker: set a member's bonus invites.
// - Leveling: set a member's XP, wipe every member's XP.
// - Temporary roles: filter the list, give a role for a time, take it back early.
//
// The pages are read with ``ModuleSettingsModel``; after an action the screen reads its page again,
// so the numbers it shows are the server's.

/// The numbers the server accepts for these tools (`LIMITS` in counting.js and leveling.js, and
/// the bonus check in the invite-tracker route).
public enum MemberActionLimits {
    /// The count an admin can set by hand.
    public static let count = 0...1_000_000_000_000
    /// The XP an admin can set for one member.
    public static let xp = 0...1_000_000_000_000
    /// Bonus invites; negative takes invites away.
    public static let bonus = -100_000...100_000
    /// A staff reason for a temporary role, cut by the server at this many characters.
    public static let tempRoleReasonLength = 500
    /// What a person types to wipe all XP, as on the web.
    public static let resetXPWord = "RESET"
}

// MARK: - Endpoints

extension Endpoints {
    /// `POST /modules/counting/count` with `{current}`: sets the count. The last-counter lock is
    /// cleared, so anyone may post the next number. 400 for a number outside the limits.
    public struct SetCountingCount: APIEndpoint {
        public typealias Response = EmptyResponse
        public let server: ServerID
        public let count: Int

        public init(server: ServerID, count: Int) {
            self.server = server
            self.count = count
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/counting/count" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(current: count) }

        private struct Body: Encodable, Sendable { let current: Int }
    }

    /// `POST /modules/counting/count` with `{reset: true}`: the count goes back to 0, the best
    /// streak stays.
    public struct ResetCountingCount: APIEndpoint {
        public typealias Response = EmptyResponse
        public let server: ServerID

        public init(server: ServerID) { self.server = server }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/counting/count" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(reset: true) }

        private struct Body: Encodable, Sendable { let reset: Bool }
    }

    /// `POST /modules/counting/penalty/release` with `{userId}`: gives the penalty role back now.
    /// 404 when that member is not benched.
    public struct ReleaseCountingPenalty: APIEndpoint {
        public typealias Response = EmptyResponse
        public let server: ServerID
        public let userID: String

        public init(server: ServerID, userID: String) {
            self.server = server
            self.userID = userID
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/counting/penalty/release" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(userId: userID) }

        private struct Body: Encodable, Sendable { let userId: String }
    }

    /// `POST /modules/invite-tracker/bonus` with `{userId, bonus}`: replaces the member's bonus
    /// invites. The answer carries the new leaderboard; the app reads the page again instead.
    public struct SetInviteBonus: APIEndpoint {
        public typealias Response = EmptyResponse
        public let server: ServerID
        public let userID: String
        public let bonus: Int

        public init(server: ServerID, userID: String, bonus: Int) {
            self.server = server
            self.userID = userID
            self.bonus = bonus
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/invite-tracker/bonus" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(userId: userID, bonus: bonus) }

        private struct Body: Encodable, Sendable {
            let userId: String
            let bonus: Int
        }
    }

    /// `POST /modules/leveling/xp` with `{userId, xp}`: sets one member's XP total. The reward
    /// roles of the new level are handed out; the server refuses first when that would hand out a
    /// role the person may not give.
    public struct SetMemberXP: APIEndpoint {
        public typealias Response = EmptyResponse
        public let server: ServerID
        public let userID: String
        public let xp: Int

        public init(server: ServerID, userID: String, xp: Int) {
            self.server = server
            self.userID = userID
            self.xp = xp
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/leveling/xp" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(userId: userID, xp: xp) }

        private struct Body: Encodable, Sendable {
            let userId: String
            let xp: Int
        }
    }

    /// `POST /modules/leveling/xp` with `{reset: true}`: wipes every member's XP, level and message
    /// count. Cannot be undone.
    public struct ResetAllXP: APIEndpoint {
        public typealias Response = EmptyResponse
        public let server: ServerID

        public init(server: ServerID) { self.server = server }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/leveling/xp" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(reset: true) }

        private struct Body: Encodable, Sendable { let reset: Bool }
    }

    /// `GET /modules/temp-roles/list?q=&roleId=`: the active temporary roles that match.
    public struct TempRoleListing: APIEndpoint {
        public typealias Response = TempRoleListAnswer
        public let server: ServerID
        public let filter: TempRoleFilter

        public init(server: ServerID, filter: TempRoleFilter = TempRoleFilter()) {
            self.server = server
            self.filter = filter
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/temp-roles/list" }
        public var query: [URLQueryItem] {
            var items: [URLQueryItem] = []
            let text = filter.trimmedText
            if !text.isEmpty { items.append(URLQueryItem(name: "q", value: text)) }
            if !filter.roleID.isEmpty { items.append(URLQueryItem(name: "roleId", value: filter.roleID)) }
            return items
        }
    }

    /// `POST /modules/temp-roles/add`: gives a member a role for a time. Giving the same role again
    /// replaces the end time. 400 for a bad duration, role or member, or when the module is off;
    /// 403 for a role above the person's own.
    public struct AddTempRole: APIEndpoint {
        public typealias Response = TempRoleAdded
        public let server: ServerID
        public let userID: String
        public let roleID: String
        /// Like `30m`, `12h`, `7d`, `2w` or `1d12h`.
        public let duration: String
        /// Kept in the mod log; may be empty.
        public let reason: String
        /// The filter the returned list is cut with.
        public let filter: TempRoleFilter

        public init(server: ServerID, userID: String, roleID: String, duration: String, reason: String = "",
                    filter: TempRoleFilter = TempRoleFilter()) {
            self.server = server
            self.userID = userID
            self.roleID = roleID
            self.duration = duration
            self.reason = reason
            self.filter = filter
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/temp-roles/add" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            Body(userId: userID, roleId: roleID, duration: duration, reason: reason, filter: filter.body)
        }

        private struct Body: Encodable, Sendable {
            let userId: String
            let roleId: String
            let duration: String
            let reason: String
            let filter: TempRoleFilter.Body
        }
    }

    /// `POST /modules/temp-roles/remove`: takes the role back now instead of at the end time. 404
    /// when the member does not hold it as a temporary role.
    public struct RemoveTempRole: APIEndpoint {
        public typealias Response = TempRoleRemoved
        public let server: ServerID
        public let userID: String
        public let roleID: String
        public let filter: TempRoleFilter

        public init(server: ServerID, userID: String, roleID: String, filter: TempRoleFilter = TempRoleFilter()) {
            self.server = server
            self.userID = userID
            self.roleID = roleID
            self.filter = filter
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/temp-roles/remove" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            Body(userId: userID, roleId: roleID, filter: filter.body)
        }

        private struct Body: Encodable, Sendable {
            let userId: String
            let roleId: String
            let filter: TempRoleFilter.Body
        }
    }
}

// MARK: - Temporary roles: the filter and what the calls answer

/// The text and role the list of active temporary roles is cut with.
public struct TempRoleFilter: Sendable, Equatable {
    /// Matches the member's name or id, the role's name, or the reason.
    public var text: String
    /// Only this role; "" for all roles.
    public var roleID: String

    public init(text: String = "", roleID: String = "") {
        self.text = text
        self.roleID = roleID
    }

    var trimmedText: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Whether the list is narrowed at all.
    public var isActive: Bool { !trimmedText.isEmpty || !roleID.isEmpty }

    /// The filter as the server reads it inside a body (`{q, roleId}`).
    struct Body: Encodable, Sendable {
        let q: String
        let roleId: String
    }

    var body: Body { Body(q: trimmedText, roleId: roleID) }
}

/// `{list}`: the answer of the list call.
public struct TempRoleListAnswer: Decodable, Sendable, Equatable {
    public let list: TempRoleList

    public init(list: TempRoleList) { self.list = list }

    private enum CodingKeys: String, CodingKey { case list }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        list = try c.decode(forKey: .list, or: TempRoleList())
    }
}

/// The answer of `add`.
public struct TempRoleAdded: Decodable, Sendable, Equatable {
    /// An earlier end time for the same member and role was replaced.
    public let replaced: Bool
    /// The member already had the role (only the record was added).
    public let alreadyHadRole: Bool
    /// When the role is taken back, in milliseconds since 1970.
    public let expiresAt: Double
    public let list: TempRoleList

    public init(replaced: Bool = false, alreadyHadRole: Bool = false, expiresAt: Double,
                list: TempRoleList = TempRoleList()) {
        self.replaced = replaced
        self.alreadyHadRole = alreadyHadRole
        self.expiresAt = expiresAt
        self.list = list
    }

    public var expiresDate: Date { Date(timeIntervalSince1970: expiresAt / 1000) }

    private enum CodingKeys: String, CodingKey { case replaced, alreadyHadRole, expiresAt, list }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            replaced: try c.decode(forKey: .replaced, or: false),
            alreadyHadRole: try c.decode(forKey: .alreadyHadRole, or: false),
            expiresAt: try c.decode(forKey: .expiresAt, or: 0),
            list: try c.decode(forKey: .list, or: TempRoleList()))
    }
}

/// The answer of `remove`.
public struct TempRoleRemoved: Decodable, Sendable, Equatable {
    /// Whether Sylo took the role off the member (false when it could not, see ``warning``).
    public let roleRemoved: Bool
    /// What went wrong while taking the role off, when something did.
    public let warning: String?
    public let list: TempRoleList

    public init(roleRemoved: Bool = true, warning: String? = nil, list: TempRoleList = TempRoleList()) {
        self.roleRemoved = roleRemoved
        self.warning = warning
        self.list = list
    }

    private enum CodingKeys: String, CodingKey { case roleRemoved, warning, list }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let text = (try? c.decodeIfPresent(String.self, forKey: .warning))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        self.init(
            roleRemoved: try c.decode(forKey: .roleRemoved, or: true),
            warning: (text?.isEmpty ?? true) ? nil : text,
            list: try c.decode(forKey: .list, or: TempRoleList()))
    }
}

// MARK: - Model: counting, invite bonus, XP

/// Runs the one-off tools on a module's page and keeps the outcome for the screen. One call at a
/// time; each returns whether it went through, so the screen can read its page again.
@MainActor
@Observable
public final class MemberActionModel {
    public let server: ServerID
    public private(set) var isWorking = false
    /// What the last tool did, in a sentence, or nil.
    public private(set) var notice: String?
    /// Why the last tool did not go through (the server's own words when it gave any).
    public var errorMessage: String?
    /// Goes up with every successful call, for a haptic.
    public private(set) var doneCount = 0

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Sets the counting channel's count to `count`.
    public func setCount(_ count: Int) async -> Bool {
        guard MemberActionLimits.count.contains(count) else {
            errorMessage = "Enter a whole number, 0 or higher."
            return false
        }
        return await run(done: "The count is now \(count).") {
            _ = try await self.session.send(Endpoints.SetCountingCount(server: self.server, count: count))
        }
    }

    /// Sends the count back to 0.
    public func resetCount() async -> Bool {
        await run(done: "The count is back at 0.") {
            _ = try await self.session.send(Endpoints.ResetCountingCount(server: self.server))
        }
    }

    /// Gives a benched member the penalty role back now.
    public func releasePenalty(userID: String, name: String) async -> Bool {
        await run(done: "\(name) can count again.") {
            _ = try await self.session.send(Endpoints.ReleaseCountingPenalty(server: self.server, userID: userID))
        }
    }

    /// Replaces a member's bonus invites.
    public func setInviteBonus(member: MemberChoice, bonus: Int) async -> Bool {
        guard MemberActionLimits.bonus.contains(bonus) else {
            let range = MemberActionLimits.bonus
            errorMessage = "The bonus must be between \(range.lowerBound) and \(range.upperBound)."
            return false
        }
        return await run(done: "\(member.name) now has \(bonus) bonus invites.") {
            _ = try await self.session.send(
                Endpoints.SetInviteBonus(server: self.server, userID: member.id, bonus: bonus))
        }
    }

    /// Sets a member's XP total.
    public func setXP(member: MemberChoice, xp: Int) async -> Bool {
        guard MemberActionLimits.xp.contains(xp) else {
            errorMessage = "Enter a whole number of XP, 0 or higher."
            return false
        }
        return await run(done: "\(member.name) now has \(xp) XP.") {
            _ = try await self.session.send(Endpoints.SetMemberXP(server: self.server, userID: member.id, xp: xp))
        }
    }

    /// Wipes every member's XP. The screen asks for a typed confirmation first.
    public func resetAllXP() async -> Bool {
        await run(done: "All leveling data is wiped.") {
            _ = try await self.session.send(Endpoints.ResetAllXP(server: self.server))
        }
    }

    public func clearNotice() { notice = nil }

    private func run(done: String, _ call: @MainActor () async throws -> Void) async -> Bool {
        guard !isWorking else { return false }
        isWorking = true
        errorMessage = nil
        notice = nil
        defer { isWorking = false }
        do {
            try await call()
            notice = done
            doneCount += 1
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
            return false
        }
    }
}

// MARK: - Model: temporary roles

/// The active temporary roles on the Temporary roles page, with their filter, and the give and take
/// back calls. The page's own list is the starting point (``list`` is nil until the first filter or
/// action); after that this model's list is the one to show.
@MainActor
@Observable
public final class TempRolesModel {
    /// What a successful give did, for the sentence under the form.
    public struct Given: Sendable, Equatable {
        public let memberName: String
        public let roleName: String
        public let expires: Date
        public let replaced: Bool
    }

    public let server: ServerID
    /// The list for the current filter; nil until this model has fetched one.
    public private(set) var list: TempRoleList?
    public var filter = TempRoleFilter()
    public private(set) var isWorking = false
    public private(set) var lastGiven: Given?
    /// The server's warning after taking a role back (the record is gone, the role may not be).
    public private(set) var removalWarning: String?
    public var errorMessage: String?

    private let session: AppSession
    private var filterRequest = 0

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Reads the list for the current filter. A newer filter wins over an older answer.
    public func applyFilter() async {
        filterRequest += 1
        let request = filterRequest
        let wanted = filter
        do {
            let answer = try await session.send(Endpoints.TempRoleListing(server: server, filter: wanted))
            if request == filterRequest { list = answer.list }
        } catch {
            let error = NetworkError(error)
            if request == filterRequest, error != .cancelled, error != .unauthorized {
                errorMessage = error.userMessage
            }
        }
    }

    /// The page was read again: drop what was fetched, and fetch again when a filter is set.
    public func pageReloaded() async {
        list = nil
        if filter.isActive { await applyFilter() }
    }

    /// Why a give cannot be sent yet, or nil. The same checks as the server, so the person is told
    /// before the call.
    public static func problem(member: MemberChoice?, roleID: String, duration: String) -> String? {
        if member == nil { return "Pick a member." }
        if roleID.isEmpty { return "Pick a role." }
        return TempRolesSettings.durationProblem(duration)
    }

    /// Gives the member the role for `duration`.
    /// - Returns: Whether the role was given.
    public func give(member: MemberChoice, roleID: String, roleName: String, duration: String,
                     reason: String) async -> Bool {
        if let problem = Self.problem(member: member, roleID: roleID, duration: duration) {
            errorMessage = problem
            return false
        }
        guard !isWorking else { return false }
        isWorking = true
        errorMessage = nil
        lastGiven = nil
        removalWarning = nil
        defer { isWorking = false }
        let trimmed = String(reason.trimmingCharacters(in: .whitespacesAndNewlines)
            .prefix(MemberActionLimits.tempRoleReasonLength))
        do {
            let added = try await session.send(Endpoints.AddTempRole(
                server: server, userID: member.id, roleID: roleID, duration: duration, reason: trimmed,
                filter: filter))
            filterRequest += 1
            list = added.list
            lastGiven = Given(memberName: member.name, roleName: roleName, expires: added.expiresDate,
                              replaced: added.replaced)
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
            return false
        }
    }

    /// Takes the role back now.
    /// - Returns: Whether the record is gone.
    public func remove(_ row: TempRoleRow) async -> Bool {
        guard !isWorking else { return false }
        isWorking = true
        errorMessage = nil
        lastGiven = nil
        removalWarning = nil
        defer { isWorking = false }
        do {
            let removed = try await session.send(Endpoints.RemoveTempRole(
                server: server, userID: row.userId, roleID: row.roleId, filter: filter))
            filterRequest += 1
            list = removed.list
            removalWarning = removed.warning
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
            return false
        }
    }

    public func dismissLastGiven() { lastGiven = nil }
}
