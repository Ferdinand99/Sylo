import Foundation
import Observation

// The permission and role-hierarchy health check of Sylo 5.2 (`health` in `GET /api/mobile/info`),
// `GET /api/v2/guilds/:id/health`: what Sylo cannot do in the channels and roles a module is set up to
// use (a channel it cannot post in, a role above its own, a permission an action needs). Only modules
// that are on are checked. The same checks come with the overview as `attention.health`. The check is
// not the operator's Health page (Health/); this one is per server and for its admins.

/// How serious a check is: an error stops a part of a module's job, a warning leaves it working.
public enum HealthSeverity: Hashable, Sendable, RawRepresentable, Decodable {
    case error
    case warning
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "error": self = .error
        case "warning": self = .warning
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .error: "error"
        case .warning: "warning"
        case .other(let raw): raw
        }
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }
}

/// One thing Sylo cannot do: the module it belongs to, what is wrong and what to do about it.
public struct HealthCheck: Decodable, Sendable, Hashable, Identifiable {
    public let module: String
    public let moduleName: String
    public let severity: HealthSeverity
    /// `role-above`, `missing-channel-permission` and the like; for tests and grouping, not for people.
    public let code: String
    /// `role-hierarchy`, `channel-permission`, `guild-permission`, ...
    public let kind: String
    /// What is wrong, as a sentence ("Sylo can't give Verified: Sylo's role is not above it.").
    public let message: String
    /// What to do about it, as a plain instruction.
    public let fix: String
    public let targetKind: String?
    public let targetID: String?
    public let targetName: String?
    /// The label of a server-wide permission that is missing, when this is about one.
    public let permissionLabel: String?

    public var id: String { "\(module)|\(code)|\(targetID ?? permissionLabel ?? "")|\(message)" }

    public init(module: String, moduleName: String? = nil, severity: HealthSeverity = .error, code: String = "",
                kind: String = "", message: String, fix: String = "", targetKind: String? = nil,
                targetID: String? = nil, targetName: String? = nil, permissionLabel: String? = nil) {
        self.module = module
        self.moduleName = moduleName ?? module
        self.severity = severity
        self.code = code
        self.kind = kind
        self.message = message
        self.fix = fix
        self.targetKind = targetKind
        self.targetID = targetID
        self.targetName = targetName
        self.permissionLabel = permissionLabel
    }

    private enum CodingKeys: String, CodingKey {
        case module, moduleName, severity, code, kind, message, fix, targetKind, targetId, targetName, permissionLabel
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        module = try c.decode(String.self, forKey: .module)
        moduleName = try c.decodeIfPresent(String.self, forKey: .moduleName) ?? module
        severity = try c.decodeIfPresent(HealthSeverity.self, forKey: .severity) ?? .warning
        code = try c.decodeIfPresent(String.self, forKey: .code) ?? ""
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        message = try c.decode(String.self, forKey: .message)
        fix = try c.decodeIfPresent(String.self, forKey: .fix) ?? ""
        targetKind = try c.decodeIfPresent(String.self, forKey: .targetKind)
        targetID = try c.decodeIfPresent(String.self, forKey: .targetId)
        targetName = try c.decodeIfPresent(String.self, forKey: .targetName)
        permissionLabel = try c.decodeIfPresent(String.self, forKey: .permissionLabel)
    }
}

/// The roles and channels Sylo cannot use, for a picker to warn about a choice that is not saved yet.
public struct HealthTargets: Decodable, Sendable, Equatable {
    /// A sentence for every role when Sylo cannot give any (it lacks Manage Roles); nil otherwise.
    public let allRolesBlocked: String?
    /// Role id to why Sylo cannot give it: `above` (Sylo's role is not above it) or `managed`.
    public let blockedRoles: [String: String]
    /// Channel id to the permissions Sylo lacks there.
    public let blockedChannels: [String: [String]]
    /// Channels where Sylo can send but lacks Embed Links.
    public let noEmbedChannels: [String]

    public static let none = HealthTargets()

    public init(allRolesBlocked: String? = nil, blockedRoles: [String: String] = [:],
                blockedChannels: [String: [String]] = [:], noEmbedChannels: [String] = []) {
        self.allRolesBlocked = allRolesBlocked
        self.blockedRoles = blockedRoles
        self.blockedChannels = blockedChannels
        self.noEmbedChannels = noEmbedChannels
    }

    private enum CodingKeys: String, CodingKey { case roles, channels }
    private enum RoleKeys: String, CodingKey { case blockedAll, blocked }
    private enum ChannelKeys: String, CodingKey { case blocked, noEmbed }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var all: String?
        var roles: [String: String] = [:]
        if c.contains(.roles), let r = try? c.nestedContainer(keyedBy: RoleKeys.self, forKey: .roles) {
            // `blockedAll` is a sentence, or null; anything else reads as none.
            all = (try? r.decodeIfPresent(String.self, forKey: .blockedAll)) ?? nil
            roles = (try? r.decodeIfPresent([String: String].self, forKey: .blocked)) ?? [:]
        }
        var blocked: [String: [String]] = [:]
        var noEmbed: [String] = []
        if c.contains(.channels), let ch = try? c.nestedContainer(keyedBy: ChannelKeys.self, forKey: .channels) {
            blocked = (try? ch.decodeIfPresent([String: [String]].self, forKey: .blocked)) ?? [:]
            noEmbed = (try? ch.decodeIfPresent([String].self, forKey: .noEmbed)) ?? []
        }
        self.init(allRolesBlocked: all?.isEmpty == true ? nil : all, blockedRoles: roles, blockedChannels: blocked,
                  noEmbedChannels: noEmbed)
    }

    /// Why Sylo cannot give this role, as a sentence for a picker; nil when it can (or nothing is known).
    public func roleWarning(_ roleID: String) -> String? {
        guard !roleID.isEmpty else { return nil }
        if let all = allRolesBlocked { return all }
        switch blockedRoles[roleID] {
        case "above": return "Sylo can't give this role: move Sylo's role above it in the server's role settings."
        case "managed": return "Sylo can't give this role: it is managed by an integration, so pick another role."
        default: return nil
        }
    }

    /// Why Sylo cannot post in this channel; nil when it can. A channel where only Embed Links is
    /// missing is a problem just for a picker whose module sends an embed (`embed`).
    public func channelWarning(_ channelID: String, embed: Bool = false) -> String? {
        guard !channelID.isEmpty else { return nil }
        if let missing = blockedChannels[channelID], !missing.isEmpty {
            return "Sylo can't post in this channel: it is missing \(missing.joined(separator: ", "))."
        }
        if embed, noEmbedChannels.contains(channelID) {
            return "Sylo can't send embeds in this channel: it is missing Embed Links."
        }
        return nil
    }

    /// The notes for a list of picked roles or channels: each failing one with its name.
    public func warnings(forRoles ids: [String], names: [String: String] = [:]) -> [String] {
        ids.compactMap { id in
            guard let text = roleWarning(id) else { return nil }
            return names[id].map { "@\($0): \(text)" } ?? text
        }
    }

    public func warnings(forChannels ids: [String], names: [String: String] = [:], embed: Bool = false) -> [String] {
        ids.compactMap { id in
            guard let text = channelWarning(id, embed: embed) else { return nil }
            return names[id].map { "#\($0): \(text)" } ?? text
        }
    }
}

/// The answer of `GET .../health` (and `attention.health` of the overview, which has no `targets`).
public struct ServerHealthReport: Decodable, Sendable, Equatable {
    /// False when the bot's member is not known (it cannot check) or the check failed.
    public let available: Bool
    public let platform: Platform?
    public let checkedAt: Date?
    public let errorCount: Int
    public let warningCount: Int
    public let checks: [HealthCheck]
    public let targets: HealthTargets

    public static let empty = ServerHealthReport(available: false)

    public init(available: Bool = true, platform: Platform? = nil, checkedAt: Date? = nil,
                errorCount: Int? = nil, warningCount: Int? = nil, checks: [HealthCheck] = [],
                targets: HealthTargets = .none) {
        self.available = available
        self.platform = platform
        self.checkedAt = checkedAt
        self.errorCount = errorCount ?? checks.filter { $0.severity == .error }.count
        self.warningCount = warningCount ?? checks.filter { $0.severity != .error }.count
        self.checks = checks
        self.targets = targets
    }

    private enum CodingKeys: String, CodingKey { case available, platform, checkedAt, summary, checks, targets }
    private enum SummaryKeys: String, CodingKey { case errors, warnings }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let checks = try c.decodeLossyArray(of: HealthCheck.self, forKey: .checks)
        var errors: Int?
        var warnings: Int?
        if c.contains(.summary), let s = try? c.nestedContainer(keyedBy: SummaryKeys.self, forKey: .summary) {
            errors = try? s.decodeIfPresent(Int.self, forKey: .errors)
            warnings = try? s.decodeIfPresent(Int.self, forKey: .warnings)
        }
        self.init(
            available: try c.decodeIfPresent(Bool.self, forKey: .available) ?? true,
            platform: try c.decodeIfPresent(Platform.self, forKey: .platform),
            checkedAt: try c.decodeEpochMillisecondsIfPresent(forKey: .checkedAt),
            errorCount: errors, warningCount: warnings, checks: checks,
            targets: (try? c.decodeIfPresent(HealthTargets.self, forKey: .targets)) ?? .none)
    }

    /// The checks of one module, errors first.
    public func checks(forModule module: String) -> [HealthCheck] {
        checks.filter { $0.module == module }.sorted { ($0.severity == .error ? 0 : 1) < ($1.severity == .error ? 0 : 1) }
    }

    /// Nothing to fix.
    public var isClean: Bool { checks.isEmpty }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/health`, from a Sylo that announces `health`. `refresh` asks for a look
    /// right now instead of the server's minute-old copy (6 a minute; a 429 says it was just done).
    public struct LoadServerHealth: APIEndpoint {
        public typealias Response = ServerHealthReport
        public let server: ServerID
        public let refresh: Bool

        public init(server: ServerID, refresh: Bool = false) {
            self.server = server
            self.refresh = refresh
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/health" }
        public var query: [URLQueryItem] { refresh ? [URLQueryItem(name: "refresh", value: "1")] : [] }
    }
}

/// One server's health check as the module screens and pickers read it. Loaded once per server screen,
/// read again after a save and on "Check again". A server without `health` (Sylo 5.1) has no report, and
/// then nothing is shown; a failed read never looks like "all fixed": the last answer stays.
@MainActor
@Observable
public final class ServerHealthModel {
    /// The wording of the notice when the server refuses a second check right away.
    public static let tooSoon = "Checked recently. Try again in a moment."

    public let server: ServerID
    public private(set) var report: ServerHealthReport?
    /// False once this server is known not to have the health check.
    public private(set) var isSupported = true
    public private(set) var isRechecking = false
    /// What "Check again" said, when it did not give a new answer (it was too soon, or it failed).
    public private(set) var notice: String?

    private let session: AppSession
    /// Goes up with every read, so an older answer that arrives late is dropped.
    private var newest = 0

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public var targets: HealthTargets { report?.targets ?? .none }

    /// The checks of one module, errors first. Empty without a report.
    public func checks(forModule module: String) -> [HealthCheck] {
        report?.checks(forModule: module) ?? []
    }

    /// Reads the check (the server may answer from its minute-old copy).
    public func load() async {
        guard isSupported else { return }
        guard await session.supports(.health) else {
            isSupported = false
            return
        }
        _ = await read(refresh: false)
    }

    /// "Check again": asks the server to look now. A refusal for asking too soon, or any failure, keeps
    /// the answer on screen and says so in ``notice``.
    public func recheck() async {
        guard isSupported, !isRechecking else { return }
        isRechecking = true
        notice = nil
        defer { isRechecking = false }
        if let problem = await read(refresh: true) { notice = problem }
    }

    /// Reads the check again after a save (the server dropped its copy then). Quiet on failure.
    public func refreshAfterSave() async {
        guard isSupported else { return }
        _ = await read(refresh: false)
    }

    /// - Returns: A sentence when the read did not give an answer; nil when it did.
    private func read(refresh: Bool) async -> String? {
        newest += 1
        let mine = newest
        do {
            let answer = try await session.send(Endpoints.LoadServerHealth(server: server, refresh: refresh))
            guard mine == newest else { return nil }
            report = answer
            return nil
        } catch {
            let error = NetworkError(error)
            if error == .cancelled || error == .unauthorized { return nil }
            if error.isMissingRoute {
                isSupported = false
                report = nil
                return nil
            }
            if error == .rateLimited { return Self.tooSoon }
            return error.userMessage
        }
    }
}

// MARK: - The overview's "Needs attention" list

/// What `attention` in the overview says: modules that are on but not set up, the permissions Sylo is
/// missing, the health check, and the work that waits for a person. Every field is optional on an older
/// server, which sends none of it (or only part).
public struct OverviewAttention: Decodable, Sendable, Equatable {
    public struct Problem: Decodable, Sendable, Hashable {
        public let id: String
        public let name: String
        public let issues: [String]

        public init(id: String, name: String, issues: [String]) {
            self.id = id
            self.name = name
            self.issues = issues
        }
    }

    public struct Waiting: Decodable, Sendable, Hashable {
        public let tickets: Int
        public let appeals: Int
        public let applications: Int
        public let suggestions: Int

        public init(tickets: Int = 0, appeals: Int = 0, applications: Int = 0, suggestions: Int = 0) {
            self.tickets = tickets
            self.appeals = appeals
            self.applications = applications
            self.suggestions = suggestions
        }

        private enum CodingKeys: String, CodingKey { case tickets, appeals, applications, suggestions }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(tickets: c.lenientCount(.tickets), appeals: c.lenientCount(.appeals),
                      applications: c.lenientCount(.applications), suggestions: c.lenientCount(.suggestions))
        }
    }

    /// A module that waits for API keys only the bot operator can add (sent to an operator only).
    public struct OwnerWait: Decodable, Sendable, Hashable {
        public let id: String
        public let name: String
        public let keys: String

        public init(id: String, name: String, keys: String) {
            self.id = id
            self.name = name
            self.keys = keys
        }

        private enum CodingKeys: String, CodingKey { case id, name, keys }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
            if let text = try? c.decodeIfPresent(String.self, forKey: .keys) {
                keys = text
            } else if let list = try? c.decodeIfPresent([String].self, forKey: .keys) {
                keys = ListFormatter.localizedString(byJoining: list)
            } else {
                keys = "keys"
            }
        }
    }

    public let problems: [Problem]
    public let waitingForOwner: [OwnerWait]
    public let platform: Platform?
    public let missingPermissions: [String]
    /// nil from a server that does not count waiting work per module (the overview's two totals apply).
    public let waiting: Waiting?
    /// The health check (5.2); nil from an older server.
    public let health: ServerHealthReport?

    public init(problems: [Problem] = [], waitingForOwner: [OwnerWait] = [], platform: Platform? = nil,
                missingPermissions: [String] = [], waiting: Waiting? = nil, health: ServerHealthReport? = nil) {
        self.problems = problems
        self.waitingForOwner = waitingForOwner
        self.platform = platform
        self.missingPermissions = missingPermissions
        self.waiting = waiting
        self.health = health
    }

    private enum CodingKeys: String, CodingKey {
        case problems, waitingForOwner, platform, missingPermissions, waiting, health
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        problems = try c.decodeLossyArray(of: Problem.self, forKey: .problems)
        waitingForOwner = try c.decodeLossyArray(of: OwnerWait.self, forKey: .waitingForOwner)
        platform = try? c.decodeIfPresent(Platform.self, forKey: .platform)
        missingPermissions = (try? c.decodeIfPresent([String].self, forKey: .missingPermissions)) ?? []
        waiting = try? c.decodeIfPresent(Waiting.self, forKey: .waiting)
        health = try? c.decodeIfPresent(ServerHealthReport.self, forKey: .health)
    }
}

/// One row of the overview's "Needs attention" list.
public struct AttentionItem: Sendable, Hashable, Identifiable {
    public enum Kind: Sendable, Hashable { case waiting, setup, health, info, blocked, permissions }

    /// Where a row leads.
    public enum Destination: Sendable, Hashable {
        case module(String)
        case tickets
        case appeals
        /// A row with nothing to open (a permission to give in the platform, a wait for the operator).
        case none
    }

    public let id: String
    public let kind: Kind
    public let severity: HealthSeverity?
    public let title: String
    public let detail: String
    public let destination: Destination
    /// For a health row: every problem of the module, with what to do about it.
    public let lines: [HealthLine]

    public init(id: String, kind: Kind, severity: HealthSeverity? = nil, title: String, detail: String,
                destination: Destination = .none, lines: [HealthLine] = []) {
        self.id = id
        self.kind = kind
        self.severity = severity
        self.title = title
        self.detail = detail
        self.destination = destination
        self.lines = lines
    }
}

/// A problem of a health row: what is wrong and the fix.
public struct HealthLine: Sendable, Hashable {
    public let message: String
    public let fix: String
    public let severity: HealthSeverity

    public init(message: String, fix: String, severity: HealthSeverity) {
        self.message = message
        self.fix = fix
        self.severity = severity
    }
}

extension ServerOverview {
    /// The "Needs attention" rows, in the dashboard's order: waiting work, modules that are on but not
    /// set up, the health check (one row per module, errors first), modules waiting for the operator,
    /// modules that cannot run, and the permissions Sylo lacks. A module switched off since the data was
    /// built is never a problem. Without `attention` (an older server) only the two totals count.
    public var attentionItems: [AttentionItem] {
        let cards = groups.flatMap(\.cards)
        func isOff(_ id: String) -> Bool { cards.first { $0.id == id }?.isEnabled == false }
        let a = attention
        var items: [AttentionItem] = []

        func work(_ key: String, _ count: Int, _ one: String, _ many: String, _ destination: AttentionItem.Destination) {
            guard count > 0 else { return }
            items.append(AttentionItem(
                id: key, kind: .waiting, title: count == 1 ? "1 \(one)" : "\(count) \(many)",
                detail: "Waiting for a person", destination: destination))
        }
        let waiting = a?.waiting
        work("tickets", waiting?.tickets ?? openTickets, "open ticket", "open tickets", .tickets)
        work("appeals", waiting?.appeals ?? openAppeals, "open ban appeal", "open ban appeals", .appeals)
        work("applications", waiting?.applications ?? 0, "application waiting", "applications waiting",
             .module("applications"))
        work("suggestions", waiting?.suggestions ?? 0, "open suggestion", "open suggestions", .module("suggestions"))

        guard let a else { return items }
        for problem in a.problems where !isOff(problem.id) {
            items.append(AttentionItem(
                id: "setup-\(problem.id)", kind: .setup, title: "\(problem.name) is on but not set up",
                detail: problem.issues.joined(separator: ". "), destination: .module(problem.id)))
        }
        if let health = a.health {
            // A permission the "Sylo is missing n permissions" row names is not repeated per module.
            let named = Set(a.missingPermissions)
            let checks = health.checks.filter { check in
                guard check.kind == "guild-permission", let label = check.permissionLabel else { return true }
                return !named.contains(label)
            }
            var order: [String] = []
            var byModule: [String: [HealthCheck]] = [:]
            for check in checks {
                if byModule[check.module] == nil { order.append(check.module) }
                byModule[check.module, default: []].append(check)
            }
            var rows: [AttentionItem] = []
            for module in order where !isOff(module) {
                let found = byModule[module] ?? []
                guard let first = found.first else { continue }
                let severity: HealthSeverity = found.contains { $0.severity == .error } ? .error : .warning
                rows.append(AttentionItem(
                    id: "health-\(module)", kind: .health, severity: severity,
                    title: "\(first.moduleName): Sylo can't do everything it needs",
                    detail: found.count == 1 ? first.message : "\(first.message) And \(found.count - 1) more.",
                    destination: .module(module),
                    lines: found.map { HealthLine(message: $0.message, fix: $0.fix, severity: $0.severity) }))
            }
            // Errors before warnings, otherwise in the order the server gave them.
            items += rows.filter { $0.severity == .error } + rows.filter { $0.severity != .error }
        }
        for wait in a.waitingForOwner where !isOff(wait.id) {
            items.append(AttentionItem(
                id: "owner-\(wait.id)", kind: .info, title: "\(wait.name) is waiting for the bot owner",
                detail: "The bot owner has not added the \(wait.keys) yet, so nothing is posted. There is nothing to fix here."))
        }
        for card in cards where card.hasToggle && card.isEnabled == true && card.status == .blocked {
            items.append(AttentionItem(
                id: "blocked-\(card.id)", kind: .blocked, title: "\(card.name) cannot run",
                detail: "The bot lacks a permission that only the bot owner can allow.",
                destination: .module(card.id)))
        }
        if !a.missingPermissions.isEmpty {
            let count = a.missingPermissions.count
            let where_ = a.platform == .fluxer ? "Fluxer" : "Discord"
            items.append(AttentionItem(
                id: "permissions", kind: .permissions,
                title: "Sylo is missing \(count == 1 ? "1 permission" : "\(count) permissions")",
                detail: "Give Sylo's role in \(where_): \(a.missingPermissions.joined(separator: ", "))."))
        }
        return items
    }
}
