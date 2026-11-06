import Foundation
import Observation

// The actions the web dashboard's module pages have next to their settings: the list pages of
// events, suggestions, quotes and temporary roles, and the one-off actions of the counting,
// leveling, invite tracker, giveaways, welcome channel and automod pages, plus "Send test message".
// The routes are in src/web/routes/v2Api.js, v2Events.js, v2Suggestions.js, v2Quotes.js and
// v2TempRoles.js.

/// Runs one-off actions of a module page (a count to set, a member to release, a giveaway to end) and
/// keeps what the person needs to see: that one is running, the server's reason when it was refused, and
/// a count for a haptic. The screen loads its page again after an action that went through.
@MainActor
@Observable
public final class ActionRunner {
    public private(set) var isWorking = false
    /// Why the last action did not go through, in the server's words when it sent some.
    public var errorMessage: String?
    public private(set) var successCount = 0

    private let session: AppSession

    public init(session: AppSession) {
        self.session = session
    }

    /// Sends the call. - Returns: The server's answer, or nil when it failed (``errorMessage`` says why) or another
    /// action was still running.
    @discardableResult
    public func run<E: APIEndpoint>(_ endpoint: E, changesModules: Bool = true) async -> E.Response? {
        guard !isWorking else {
            errorMessage = "Another change is still saving."
            return nil
        }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            let response = try await session.send(endpoint)
            successCount += 1
            if changesModules { session.noteModulesChanged() }
            return response
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.detailMessage }
            return nil
        }
    }
}

// MARK: - Send test message

/// The modules that can post a sample message from their saved settings (`TESTABLE` in
/// src/bot/lib/moduleTest.js).
public enum ModuleTest {
    public static let modules: Set<String> = [
        "welcome", "birthdays", "logging", "twitch-alerts", "youtube-alerts", "starboard", "free-games",
    ]

    public static func supports(_ module: ModuleID) -> Bool { modules.contains(module.rawValue) }
}

/// `{ok, channelName?, reason?}` after a test message.
public struct ModuleTestResult: Decodable, Sendable, Equatable {
    public let isOK: Bool
    public let channelName: String?
    /// `no-channel` or `send-failed`.
    public let reason: String?

    public init(isOK: Bool, channelName: String? = nil, reason: String? = nil) {
        self.isOK = isOK
        self.channelName = channelName
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey { case ok, channelName, reason }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isOK = try c.decode(forKey: .ok, or: false)
        channelName = try c.decodeIfPresent(String.self, forKey: .channelName)
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
    }

    /// What to tell the person, in the dashboard's words.
    public var message: String {
        if isOK { return "Test sent to #\(channelName ?? "the channel")" }
        if reason == "no-channel" { return "Set a channel for this module first." }
        return "Send failed. Check the bot has access to that channel."
    }
}

// MARK: - Counting, leveling, invites, giveaways, welcome channel, automod

/// The new count after setting or resetting it.
public struct CountingStateResult: Decodable, Sendable, Equatable {
    public let current: Int

    private enum CodingKeys: String, CodingKey { case state }
    private enum StateKeys: String, CodingKey { case current }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let state = try c.nestedContainer(keyedBy: StateKeys.self, forKey: .state)
        current = try state.decode(forKey: .current, or: 0)
    }
}

/// The welcome channel's settings after publishing, removing the post or making the channel.
public struct WelcomeChannelActionResult: Decodable, Sendable, Equatable {
    public let settings: WelcomeChannelSettings
    /// The channel list, which a created channel is in (only sent by `create-channel`).
    public let channels: [ChannelOption]?

    private enum CodingKeys: String, CodingKey { case settings = "config", channels }
}

public struct ImmunityResult: Decodable, Sendable, Equatable {
    public let exemptRoles: [String]
}

extension Endpoints {
    private static func module(_ server: ServerID, _ module: String, _ tail: String) -> String {
        "/api/v2/guilds/\(server.pathComponent)/modules/\(module)\(tail)"
    }

    /// `POST …/modules/:module/test`: posts a sample from the saved settings.
    public struct SendModuleTest: APIEndpoint {
        public typealias Response = ModuleTestResult
        public let server: ServerID
        public let module: ModuleID
        public init(server: ServerID, module: ModuleID) {
            self.server = server
            self.module = module
        }
        public var path: String { Endpoints.module(server, module.pathComponent, "/test") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST …/counting/count` with `{current}` sets the count; ``reset(server:)`` sets it to 0.
    public struct SetCount: APIEndpoint {
        public typealias Response = CountingStateResult
        public let server: ServerID
        /// The new count; nil only for ``reset(server:)``.
        public let count: Int?
        public init(server: ServerID, count: Int) {
            self.server = server
            self.count = count
        }
        private init(resetOn server: ServerID) {
            self.server = server
            self.count = nil
        }
        /// Sets the count back to 0. The only way to build a reset, so a missing number can never
        /// wipe the count by accident.
        public static func reset(server: ServerID) -> SetCount { SetCount(resetOn: server) }
        public var path: String { Endpoints.module(server, "counting", "/count") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            if let count { return SetBody(current: count) }
            return ResetBody()
        }
        private struct SetBody: Encodable, Sendable { let current: Int }
        private struct ResetBody: Encodable, Sendable { let reset = true }
    }

    /// `POST …/counting/penalty/release` with `{userId}`: gives a benched member their access back.
    public struct ReleaseCountingPenalty: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let userId: String
        public init(server: ServerID, userId: String) {
            self.server = server
            self.userId = userId
        }
        public var path: String { Endpoints.module(server, "counting", "/penalty/release") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(userId: userId) }
        private struct Body: Encodable, Sendable { let userId: String }
    }

    /// `POST …/leveling/xp` with `{userId, xp}` sets a member's XP; `{reset: true}` wipes everyone's.
    public struct SetLevelingXP: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        /// nil only for ``resetAll(server:)``, which wipes the XP of the whole server.
        public let userId: String?
        public let xp: Int?
        public init(server: ServerID, userId: String, xp: Int) {
            self.server = server
            self.userId = userId
            self.xp = xp
        }
        private init(resetAllOn server: ServerID) {
            self.server = server
            self.userId = nil
            self.xp = nil
        }
        /// Wipes everyone's XP. The only way to build a reset, so a missing member or number can
        /// never wipe the whole server by accident.
        public static func resetAll(server: ServerID) -> SetLevelingXP { SetLevelingXP(resetAllOn: server) }
        public var path: String { Endpoints.module(server, "leveling", "/xp") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            if let userId, let xp { return SetBody(userId: userId, xp: xp) }
            return ResetBody()
        }
        private struct SetBody: Encodable, Sendable {
            let userId: String
            let xp: Int
        }
        private struct ResetBody: Encodable, Sendable { let reset = true }
    }

    /// `POST …/invite-tracker/bonus` with `{userId, bonus}` (a whole number from -100000 to 100000).
    public struct SetInviteBonus: APIEndpoint {
        public typealias Response = JSONValue
        public static let bonusRange = -100_000...100_000
        public let server: ServerID
        public let userId: String
        public let bonus: Int
        public init(server: ServerID, userId: String, bonus: Int) {
            self.server = server
            self.userId = userId
            self.bonus = bonus
        }
        public var path: String { Endpoints.module(server, "invite-tracker", "/bonus") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(userId: userId, bonus: bonus) }
        private struct Body: Encodable, Sendable {
            let userId: String
            let bonus: Int
        }
    }

    /// `POST …/giveaways/:id/end`: ends an active giveaway now and draws the winners.
    public struct EndGiveaway: APIEndpoint {
        public typealias Response = JSONValue
        public let server: ServerID
        public let id: Int
        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }
        public var path: String { Endpoints.module(server, "giveaways", "/\(id)/end") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST …/giveaways/:id/reroll` with `{count}`: draws new winners for an ended giveaway.
    public struct RerollGiveaway: APIEndpoint {
        public typealias Response = JSONValue
        public let server: ServerID
        public let id: Int
        public let count: Int
        public init(server: ServerID, id: Int, count: Int) {
            self.server = server
            self.id = id
            self.count = count
        }
        public var path: String { Endpoints.module(server, "giveaways", "/\(id)/reroll") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(count: count) }
        private struct Body: Encodable, Sendable { let count: Int }
    }

    /// `POST …/welcome-channel/publish`: posts (or updates) the message in the channel. The body is
    /// the settings, like a save.
    public struct PublishWelcomeChannel: APIEndpoint {
        public typealias Response = WelcomeChannelActionResult
        public let server: ServerID
        public let settings: WelcomeChannelSettings
        public init(server: ServerID, settings: WelcomeChannelSettings) {
            self.server = server
            self.settings = settings
        }
        public var path: String { Endpoints.module(server, "welcome-channel", "/publish") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { settings }
    }

    /// `POST …/welcome-channel/unpublish`: removes the posted message (the draft stays).
    public struct UnpublishWelcomeChannel: APIEndpoint {
        public typealias Response = WelcomeChannelActionResult
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { Endpoints.module(server, "welcome-channel", "/unpublish") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST …/welcome-channel/create-channel`: makes a read-only #welcome and picks it.
    public struct CreateWelcomeChannel: APIEndpoint {
        public typealias Response = WelcomeChannelActionResult
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { Endpoints.module(server, "welcome-channel", "/create-channel") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST …/automod/immunity` with `{exemptRoles}`: replaces the immunity roles.
    public struct SetAutomodImmunity: APIEndpoint {
        public typealias Response = ImmunityResult
        public let server: ServerID
        public let roles: [String]
        public init(server: ServerID, roles: [String]) {
            self.server = server
            self.roles = roles
        }
        public var path: String { Endpoints.module(server, "automod", "/immunity") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(exemptRoles: roles) }
        private struct Body: Encodable, Sendable { let exemptRoles: [String] }
    }
}

// MARK: - Suggestions

/// What staff do to a suggestion.
public enum SuggestionAction: String, Sendable, CaseIterable, Identifiable {
    case consider, approve, deny, implement

    public var id: String { rawValue }
}

public struct SuggestionList: Decodable, Sendable, Equatable {
    public let suggestions: [SuggestionSummary]

    public init(suggestions: [SuggestionSummary] = []) { self.suggestions = suggestions }

    private enum CodingKeys: String, CodingKey { case suggestions }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        suggestions = try c.decodeLossyArray(of: SuggestionSummary.self, forKey: .suggestions)
    }
}

/// The filter of the suggestions list.
public enum SuggestionFilter: String, Sendable, CaseIterable, Identifiable {
    case all, open, considering, approved, denied, implemented

    public var id: String { rawValue }
}

extension Endpoints {
    /// `GET …/suggestions/list?status=&sort=`: up to 100.
    public struct SuggestionsList: APIEndpoint {
        public typealias Response = SuggestionList
        public let server: ServerID
        public let status: SuggestionFilter
        /// `top` by votes, else newest first.
        public let sortByVotes: Bool
        public init(server: ServerID, status: SuggestionFilter = .all, sortByVotes: Bool = false) {
            self.server = server
            self.status = status
            self.sortByVotes = sortByVotes
        }
        public var path: String { Endpoints.module(server, "suggestions", "/list") }
        public var query: [URLQueryItem] {
            [URLQueryItem(name: "status", value: status.rawValue), URLQueryItem(name: "sort", value: sortByVotes ? "top" : "new")]
        }
    }

    /// `POST …/suggestions/:number/decision` with `{action, reason}`.
    public struct DecideSuggestion: APIEndpoint {
        public typealias Response = JSONValue
        public let server: ServerID
        public let number: Int
        public let action: SuggestionAction
        public let reason: String
        public init(server: ServerID, number: Int, action: SuggestionAction, reason: String) {
            self.server = server
            self.number = number
            self.action = action
            self.reason = reason
        }
        public var path: String { Endpoints.module(server, "suggestions", "/\(number)/decision") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(action: action.rawValue, reason: reason) }
        private struct Body: Encodable, Sendable {
            let action: String
            let reason: String
        }
    }

    /// `POST …/suggestions/:number/delete`.
    public struct DeleteSuggestion: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let number: Int
        public init(server: ServerID, number: Int) {
            self.server = server
            self.number = number
        }
        public var path: String { Endpoints.module(server, "suggestions", "/\(number)/delete") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }
}

// MARK: - Quotes

public struct QuoteList: Decodable, Sendable, Equatable {
    public let total: Int
    public let quotes: [QuoteSummary]

    public init(total: Int = 0, quotes: [QuoteSummary] = []) {
        self.total = total
        self.quotes = quotes
    }

    private enum CodingKeys: String, CodingKey { case total, quotes }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        total = try c.decode(forKey: .total, or: 0)
        quotes = try c.decodeLossyArray(of: QuoteSummary.self, forKey: .quotes)
    }
}

extension Endpoints {
    /// `GET …/quote-board/list?q=`: the newest 100, or those matching the text.
    public struct QuotesList: APIEndpoint {
        public typealias Response = QuoteList
        public let server: ServerID
        public let search: String
        public init(server: ServerID, search: String = "") {
            self.server = server
            self.search = search
        }
        public var path: String { Endpoints.module(server, "quote-board", "/list") }
        public var query: [URLQueryItem] { [URLQueryItem(name: "q", value: search)] }
    }

    /// `POST …/quote-board/:number/delete`.
    public struct DeleteQuote: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let number: Int
        public init(server: ServerID, number: Int) {
            self.server = server
            self.number = number
        }
        public var path: String { Endpoints.module(server, "quote-board", "/\(number)/delete") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }
}

// MARK: - Temporary roles

/// A member the temporary roles Add form can pick.
public struct MemberChoice: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let username: String

    public init(id: String, name: String, username: String = "") {
        self.id = id
        self.name = name
        self.username = username
    }

    private enum CodingKeys: String, CodingKey { case id, name, username }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(forKey: .name, or: id)
        username = try c.decode(forKey: .username, or: "")
    }
}

public struct MemberChoices: Decodable, Sendable, Equatable {
    public let members: [MemberChoice]

    private enum CodingKeys: String, CodingKey { case members }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        members = try c.decodeLossyArray(of: MemberChoice.self, forKey: .members)
    }
}

public struct TempRolesListResult: Decodable, Sendable, Equatable {
    public let list: TempRoleList
}

/// The answer to giving a temporary role.
public struct TempRoleAdded: Decodable, Sendable, Equatable {
    /// An existing temporary role was replaced.
    public let replaced: Bool
    public let alreadyHadRole: Bool
    /// Whether the member could be sent a DM.
    public let dm: Bool

    private enum CodingKeys: String, CodingKey { case replaced, alreadyHadRole, dm }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        replaced = try c.decode(forKey: .replaced, or: false)
        alreadyHadRole = try c.decode(forKey: .alreadyHadRole, or: false)
        dm = try c.decode(forKey: .dm, or: false)
    }
}

/// The answer to taking a temporary role back early.
public struct TempRoleRemoved: Decodable, Sendable, Equatable {
    public let roleRemoved: Bool
    /// What went wrong beyond the record ("could not remove the role"), if anything.
    public let warning: String?

    private enum CodingKeys: String, CodingKey { case roleRemoved, warning }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        roleRemoved = try c.decode(forKey: .roleRemoved, or: true)
        warning = try c.decodeIfPresent(String.self, forKey: .warning)
    }
}

extension Endpoints {
    /// `GET …/temp-roles/list?q=&roleId=`.
    public struct TempRolesList: APIEndpoint {
        public typealias Response = TempRolesListResult
        public let server: ServerID
        public let search: String
        public let roleId: String
        public init(server: ServerID, search: String = "", roleId: String = "") {
            self.server = server
            self.search = search
            self.roleId = roleId
        }
        public var path: String { Endpoints.module(server, "temp-roles", "/list") }
        public var query: [URLQueryItem] {
            [URLQueryItem(name: "q", value: search), URLQueryItem(name: "roleId", value: roleId)]
        }
    }

    /// `GET …/temp-roles/members?q=`: up to 10 members by name, or one by id.
    public struct TempRoleMembers: APIEndpoint {
        public typealias Response = MemberChoices
        public let server: ServerID
        public let search: String
        public init(server: ServerID, search: String) {
            self.server = server
            self.search = search
        }
        public var path: String { Endpoints.module(server, "temp-roles", "/members") }
        public var query: [URLQueryItem] { [URLQueryItem(name: "q", value: search)] }
    }

    /// `POST …/temp-roles/add` with `{userId, roleId, duration, reason}`. The duration is text like
    /// `30m`, `12h`, `7d`, `2w` or `1d12h` (1 minute to 365 days).
    public struct AddTempRole: APIEndpoint {
        public typealias Response = TempRoleAdded
        public let server: ServerID
        public let userId: String
        public let roleId: String
        public let duration: String
        public let reason: String
        public init(server: ServerID, userId: String, roleId: String, duration: String, reason: String) {
            self.server = server
            self.userId = userId
            self.roleId = roleId
            self.duration = duration
            self.reason = reason
        }
        public var path: String { Endpoints.module(server, "temp-roles", "/add") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            Body(userId: userId, roleId: roleId, duration: duration, reason: reason)
        }
        private struct Body: Encodable, Sendable {
            let userId: String
            let roleId: String
            let duration: String
            let reason: String
        }
    }

    /// `POST …/temp-roles/remove` with `{userId, roleId, reason}`: takes the role back now.
    public struct RemoveTempRole: APIEndpoint {
        public typealias Response = TempRoleRemoved
        public let server: ServerID
        public let userId: String
        public let roleId: String
        public let reason: String
        public init(server: ServerID, userId: String, roleId: String, reason: String = "") {
            self.server = server
            self.userId = userId
            self.roleId = roleId
            self.reason = reason
        }
        public var path: String { Endpoints.module(server, "temp-roles", "/remove") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(userId: userId, roleId: roleId, reason: reason) }
        private struct Body: Encodable, Sendable {
            let userId: String
            let roleId: String
            let reason: String
        }
    }
}

// MARK: - Events

/// One event with everything the edit form needs (the settings page's list only shows a summary).
public struct EventRecord: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    public let title: String
    public let description: String
    public let location: String
    public let imageUrl: String
    public let startAt: Date?
    public let endAt: Date?
    public let timeZone: String
    public let capacity: Int?
    public let roleId: String
    public let reminderMinutes: Int
    public let channelId: String
    /// The channel's name (its id when it is gone).
    public let channel: String
    public let state: EventState
    public let joined: Int
    public let maybe: Int

    public init(
        id: Int, title: String, description: String = "", location: String = "", imageUrl: String = "",
        startAt: Date? = nil, endAt: Date? = nil, timeZone: String = "UTC", capacity: Int? = nil,
        roleId: String = "", reminderMinutes: Int = 60, channelId: String = "", channel: String = "",
        state: EventState = .scheduled, joined: Int = 0, maybe: Int = 0
    ) {
        self.id = id
        self.title = title
        self.description = description
        self.location = location
        self.imageUrl = imageUrl
        self.startAt = startAt
        self.endAt = endAt
        self.timeZone = timeZone
        self.capacity = capacity
        self.roleId = roleId
        self.reminderMinutes = reminderMinutes
        self.channelId = channelId
        self.channel = channel
        self.state = state
        self.joined = joined
        self.maybe = maybe
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, description, location, imageUrl, startAt, endAt, timeZone, capacity, roleId
        case reminderMinutes, channelId, channel, state, joined, maybe
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            title: try c.decode(forKey: .title, or: ""),
            description: try c.decodeIfPresent(String.self, forKey: .description) ?? "",
            location: try c.decodeIfPresent(String.self, forKey: .location) ?? "",
            imageUrl: try c.decodeIfPresent(String.self, forKey: .imageUrl) ?? "",
            startAt: try c.decodeEpochMillisecondsIfPresent(forKey: .startAt),
            endAt: try c.decodeEpochMillisecondsIfPresent(forKey: .endAt),
            timeZone: try c.decode(forKey: .timeZone, or: "UTC"),
            capacity: try c.decodeIfPresent(Int.self, forKey: .capacity),
            roleId: try c.decodeIfPresent(String.self, forKey: .roleId) ?? "",
            reminderMinutes: try c.decode(forKey: .reminderMinutes, or: 60),
            channelId: try c.decode(forKey: .channelId, or: ""),
            channel: try c.decode(forKey: .channel, or: ""),
            state: try c.decode(forKey: .state, or: .scheduled),
            joined: try c.decode(forKey: .joined, or: 0),
            maybe: try c.decode(forKey: .maybe, or: 0))
    }

    public var zone: TimeZone { TimeZone(identifier: timeZone) ?? .current }
}

/// `GET …/events/config`, read for its events: the list, the channels and roles to post with, and the
/// settings the form starts from.
public struct EventsManagePage: Decodable, Sendable, Equatable {
    public let settings: EventsSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    public let events: [EventRecord]

    public init(settings: EventsSettings = EventsSettings(), channels: [ChannelOption] = [], roles: [RoleOption] = [], events: [EventRecord] = []) {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.events = events
    }

    private enum CodingKeys: String, CodingKey { case settings = "config", channels, roles, events }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            settings: try c.decode(forKey: .settings, or: EventsSettings()),
            channels: try c.decode(forKey: .channels, or: []),
            roles: try c.decode(forKey: .roles, or: []),
            events: try c.decodeLossyArray(of: EventRecord.self, forKey: .events))
    }

    public var upcoming: [EventRecord] { events.filter { $0.state == .scheduled } }
    public var past: [EventRecord] { events.filter { $0.state != .scheduled } }
}

/// An event while it is edited, and the body that saves it.
public struct EventDraft: Sendable, Equatable, Identifiable {
    public let localID = LocalID()
    /// The event's id; nil for a new one.
    public var eventID: Int?
    public var title: String
    public var description: String
    public var start: Date
    public var hasEnd: Bool
    public var end: Date
    /// An IANA name such as `Europe/Oslo`; the times are read in this zone.
    public var timeZone: String
    public var channelId: String
    public var roleId: String
    public var location: String
    public var imageUrl: String
    public var hasCapacity: Bool
    public var capacity: Int
    public var reminderMinutes: Int

    public var id: UUID { localID.value }

    public static let defaultCapacity = 10

    /// A new event: tomorrow, an hour from now, in the zone set for events on the server, else the device's.
    public init(settings: EventsSettings = EventsSettings(), now: Date = .now, deviceZone: TimeZone = .current) {
        eventID = nil
        title = ""
        description = ""
        let tomorrow = now.addingTimeInterval(86_400)
        let hour = (tomorrow.timeIntervalSince1970 / 3600).rounded(.up) * 3600
        start = Date(timeIntervalSince1970: hour)
        hasEnd = false
        end = start.addingTimeInterval(3600)
        // The server's own zone for events when it is set (and a real one), else this device's.
        timeZone = TimeZone(identifier: settings.timeZone) != nil ? settings.timeZone : deviceZone.identifier
        channelId = settings.channel
        roleId = ""
        location = ""
        imageUrl = ""
        hasCapacity = false
        capacity = Self.defaultCapacity
        reminderMinutes = settings.reminderMinutes
    }

    public init(event: EventRecord) {
        eventID = event.id
        title = event.title
        description = event.description
        start = event.startAt ?? .now
        hasEnd = event.endAt != nil
        end = event.endAt ?? (event.startAt ?? .now).addingTimeInterval(3600)
        timeZone = event.timeZone
        channelId = event.channelId
        roleId = event.roleId
        location = event.location
        imageUrl = event.imageUrl
        hasCapacity = event.capacity != nil
        capacity = event.capacity ?? Self.defaultCapacity
        reminderMinutes = event.reminderMinutes
    }

    public var zone: TimeZone { TimeZone(identifier: timeZone) ?? TimeZone(identifier: "UTC") ?? .current }

    /// Why the event cannot be saved yet, in words for the person; nil when it can.
    public func problem(now: Date = .now) -> String? {
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Give the event a title." }
        if TimeZone(identifier: timeZone) == nil { return "Pick a time zone." }
        if eventID == nil {
            if channelId.isEmpty { return "Pick a text channel." }
            if start <= now { return "The start time must be in the future." }
        }
        if hasEnd, end <= start { return "The end time must be after the start time." }
        if let url = URL(string: imageUrl), !imageUrl.isEmpty, url.scheme?.lowercased() != "https" {
            return "The image must be an https link."
        }
        return nil
    }

    /// `2026-11-05T19:00`: the way the dashboard's date field sends a time, read in ``timeZone``.
    public static func localText(_ date: Date, in zone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm"
        return formatter.string(from: date)
    }

    struct Body: Encodable, Sendable {
        let title: String
        let description: String
        let start: String
        let end: String
        let timeZone: String
        let channelId: String
        let roleId: String
        let location: String
        let imageUrl: String
        let capacity: Int?
        let reminderMinutes: Int

        private enum CodingKeys: String, CodingKey {
            case title, description, start, end, timeZone, channelId, roleId, location, imageUrl, capacity, reminderMinutes
        }

        /// Like the dashboard's form: no limit is an explicit `null`, not a missing key.
        func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(title, forKey: .title)
            try c.encode(description, forKey: .description)
            try c.encode(start, forKey: .start)
            try c.encode(end, forKey: .end)
            try c.encode(timeZone, forKey: .timeZone)
            try c.encode(channelId, forKey: .channelId)
            try c.encode(roleId, forKey: .roleId)
            try c.encode(location, forKey: .location)
            try c.encode(imageUrl, forKey: .imageUrl)
            try c.encode(capacity, forKey: .capacity)
            try c.encode(reminderMinutes, forKey: .reminderMinutes)
        }
    }

    var body: Body {
        Body(
            title: title.trimmingCharacters(in: .whitespacesAndNewlines), description: description,
            start: Self.localText(start, in: zone), end: hasEnd ? Self.localText(end, in: zone) : "",
            timeZone: timeZone, channelId: channelId, roleId: roleId, location: location, imageUrl: imageUrl,
            capacity: hasCapacity ? capacity : nil, reminderMinutes: reminderMinutes)
    }
}

extension Endpoints {
    /// `GET …/events/config`, read for the full events.
    public struct LoadEventsManage: APIEndpoint {
        public typealias Response = EventsManagePage
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { Endpoints.module(server, "events", "/config") }
    }

    /// `POST …/events/events` creates an event (posts it in the channel); `POST …/events/events/:id`
    /// edits one (the channel and role are fixed once it is posted). Both answer `{events}`.
    public struct SaveEvent: APIEndpoint {
        public typealias Response = EventsListResult
        public let server: ServerID
        public let draft: EventDraft
        public init(server: ServerID, draft: EventDraft) {
            self.server = server
            self.draft = draft
        }
        public var path: String {
            let tail = draft.eventID.map { "/events/\($0)" } ?? "/events"
            return Endpoints.module(server, "events", tail)
        }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { draft.body }
    }

    /// `POST …/events/events/:id/cancel`.
    public struct CancelEvent: APIEndpoint {
        public typealias Response = EventsListResult
        public let server: ServerID
        public let id: Int
        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }
        public var path: String { Endpoints.module(server, "events", "/events/\(id)/cancel") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }
}

public struct EventsListResult: Decodable, Sendable, Equatable {
    public let events: [EventRecord]

    private enum CodingKeys: String, CodingKey { case events }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        events = try c.decodeLossyArray(of: EventRecord.self, forKey: .events)
    }
}

// MARK: - Models

extension RecordListModel where Page == EventsManagePage {
    public convenience init(events server: ServerID, session: AppSession) {
        self.init(server: server, session: session) { session, server in
            try await session.send(Endpoints.LoadEventsManage(server: server))
        }
    }

    public func save(_ draft: EventDraft) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.SaveEvent(server: server, draft: draft))
            return true
        }
        return done != nil
    }

    public func cancel(eventID: Int) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.CancelEvent(server: server, id: eventID))
            return true
        }
        return done != nil
    }
}

// MARK: - A list that is loaded with a query

/// A list page whose query changes (a filter, a search): the screen says which call to make, this keeps the
/// answer, whether it is loading and why it failed. A newer load replaces an older one still on its
/// way, so a slow answer for an earlier search never overwrites the current one.
@MainActor
@Observable
public final class QueryListModel<Value: Sendable> {
    public private(set) var value: Value?
    public private(set) var isLoading = false
    /// Why the list could not be loaded (the last list, if any, stays).
    public var errorMessage: String?

    private let session: AppSession
    private var generation = 0

    public init(session: AppSession) {
        self.session = session
    }

    public func load<E: APIEndpoint>(_ endpoint: E, map: @Sendable (E.Response) -> Value) async {
        generation += 1
        let mine = generation
        isLoading = true
        defer { if mine == generation { isLoading = false } }
        do {
            let response = try await session.send(endpoint)
            guard mine == generation else { return }
            value = map(response)
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if mine == generation, error != .cancelled, error != .unauthorized { errorMessage = error.detailMessage }
        }
    }
}
