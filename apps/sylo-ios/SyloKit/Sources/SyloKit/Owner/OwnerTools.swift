import Foundation
import Observation

// The bot-wide pages of the web dashboard (src/web/routes/v2Api.js): the Bot Personalizer
// (identity, status, announcement; operators only), the Roadmap (everyone signed in; the board's
// admin for operators), the public command list and the stats cache (operators only).

// MARK: - Command list

/// One option of a slash command.
public struct CommandOption: Decodable, Sendable, Hashable {
    public let name: String
    public let description: String
    public let isRequired: Bool
    public let choices: [String]

    public init(name: String, description: String = "", isRequired: Bool = false, choices: [String] = []) {
        self.name = name
        self.description = description
        self.isRequired = isRequired
        self.choices = choices
    }

    private enum CodingKeys: String, CodingKey { case name, description, required, choices }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            name: try c.decode(String.self, forKey: .name),
            description: try c.decodeIfPresent(String.self, forKey: .description) ?? "",
            isRequired: try c.decode(forKey: .required, or: false),
            choices: try c.decode(forKey: .choices, or: []))
    }
}

/// One row of the slash command reference.
public struct CommandReference: Decodable, Sendable, Hashable, Identifiable {
    /// `/ban <user> [reason]`.
    public let signature: String
    public let description: String
    /// The permissions it needs, nil for none.
    public let permissions: [String]?
    public let options: [CommandOption]

    public var id: String { signature }

    public init(signature: String, description: String = "", permissions: [String]? = nil, options: [CommandOption] = []) {
        self.signature = signature
        self.description = description
        self.permissions = permissions
        self.options = options
    }

    private enum CodingKeys: String, CodingKey { case signature, description, permissions, options }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            signature: try c.decode(String.self, forKey: .signature),
            description: try c.decodeIfPresent(String.self, forKey: .description) ?? "",
            permissions: try c.decodeIfPresent([String].self, forKey: .permissions),
            options: try c.decodeLossyArray(of: CommandOption.self, forKey: .options))
    }
}

/// `GET /api/v2/public/commands`.
public struct CommandListPage: Decodable, Sendable, Equatable {
    public let commands: [CommandReference]

    public init(commands: [CommandReference] = []) { self.commands = commands }

    private enum CodingKeys: String, CodingKey { case commands }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        commands = try c.decodeLossyArray(of: CommandReference.self, forKey: .commands)
    }

    /// The commands whose signature or description contains the text (ignoring case).
    public func commands(matching query: String) -> [CommandReference] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return commands }
        return commands.filter {
            $0.signature.localizedCaseInsensitiveContains(text) || $0.description.localizedCaseInsensitiveContains(text)
        }
    }
}

// MARK: - Stats cache

public struct CachedStat: Decodable, Sendable, Hashable, Identifiable {
    public let id: UUID
    public let title: String
    public let username: String
    public let platform: String
    public let isFresh: Bool
    public let kd: String
    public let winRate: String
    public let timePlayed: String

    private enum CodingKeys: String, CodingKey { case title, username, platform, fresh, kd, winRate, timePlayed }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = UUID()
        title = try c.decode(forKey: .title, or: "")
        username = try c.decode(forKey: .username, or: "")
        platform = try c.decode(forKey: .platform, or: "")
        isFresh = try c.decode(forKey: .fresh, or: false)
        kd = try Self.text(c, .kd)
        winRate = try Self.text(c, .winRate)
        timePlayed = try Self.text(c, .timePlayed)
    }

    /// A number or text, "" for the server's "—".
    private static func text(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) throws -> String {
        if let string = try? c.decodeIfPresent(String.self, forKey: key) { return string == "—" ? "" : string }
        if let number = try? c.decodeIfPresent(Double.self, forKey: key) { return number.formatted() }
        return ""
    }

    /// "K/D 1.4 · Win 52% · 412 h played" for what the lookup has.
    public var facts: String {
        var parts: [String] = []
        if !kd.isEmpty { parts.append("K/D \(kd)") }
        if !winRate.isEmpty { parts.append("Win \(winRate)") }
        if let played = Self.played(timePlayed) { parts.append(played) }
        return parts.joined(separator: " \u{00B7} ")
    }

    /// "412 h played" from seconds ("1483200"), "412h" or any text; nil when unknown.
    static func played(_ value: String) -> String? {
        let text = value.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        if let seconds = Double(text) { return "\(Int((seconds / 3600).rounded()).formatted()) h played" }
        return "\(text) played"
    }
}

/// `GET /api/v2/stats`.
public struct StatsPage: Decodable, Sendable, Equatable {
    public let rows: [CachedStat]
    public let ttlMinutes: Int

    private enum CodingKeys: String, CodingKey { case rows, ttlMinutes }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rows = try c.decodeLossyArray(of: CachedStat.self, forKey: .rows)
        ttlMinutes = try c.decode(forKey: .ttlMinutes, or: 0)
    }

    public static func == (lhs: StatsPage, rhs: StatsPage) -> Bool { lhs.ttlMinutes == rhs.ttlMinutes && lhs.rows.count == rhs.rows.count }
}

// MARK: - Personalizer

public struct PersonalizerBot: Decodable, Sendable, Equatable {
    public let tag: String
    public let username: String
    public let avatarURL: URL?
    public let bannerURL: URL?

    public init(tag: String = "", username: String = "", avatarURL: URL? = nil, bannerURL: URL? = nil) {
        self.tag = tag
        self.username = username
        self.avatarURL = avatarURL
        self.bannerURL = bannerURL
    }

    private enum CodingKeys: String, CodingKey { case tag, username, avatar, banner }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            tag: try c.decode(forKey: .tag, or: ""), username: try c.decode(forKey: .username, or: ""),
            avatarURL: try c.decodeURLIfPresent(forKey: .avatar), bannerURL: try c.decodeURLIfPresent(forKey: .banner))
    }
}

/// `GET /api/v2/personalizer`: the bot, nil while it is not connected.
public struct PersonalizerIdentityPage: Decodable, Sendable, Equatable {
    public let bot: PersonalizerBot?
}

/// The bot's status and activity.
public struct PresenceConfig: Codable, Sendable, Equatable {
    /// `online`, `idle`, `dnd` or `invisible`.
    public var status: String
    /// `Playing`, `Listening`, `Watching`, `Competing` or `Custom`.
    public var type: String
    public var text: String

    public static let maxTextLength = 128

    public init(status: String = "online", type: String = "Listening", text: String = "") {
        self.status = status
        self.type = type
        self.text = text
    }
}

/// `GET /api/v2/personalizer/presence`.
public struct PersonalizerPresencePage: Decodable, Sendable, Equatable {
    public let presence: PresenceConfig
    public let types: [String]
    public let statuses: [String]
    public let severities: [String]

    private enum CodingKeys: String, CodingKey { case presence, types, statuses, announcementSeverities }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        presence = try c.decode(forKey: .presence, or: PresenceConfig())
        types = try c.decode(forKey: .types, or: ["Playing", "Listening", "Watching", "Competing", "Custom"])
        statuses = try c.decode(forKey: .statuses, or: ["online", "idle", "dnd", "invisible"])
        severities = try c.decode(forKey: .announcementSeverities, or: ["info", "warning", "critical"])
    }
}

/// The notice every signed-in person sees across the dashboard.
public struct AnnouncementDraft: Codable, Sendable, Equatable {
    public var title: String
    public var body: String
    /// `info`, `warning` or `critical`.
    public var severity: String

    public static let maxTitleLength = 200
    public static let maxBodyLength = 2000

    public init(title: String = "", body: String = "", severity: String = "info") {
        self.title = title
        self.body = body
        self.severity = severity
    }

    private enum CodingKeys: String, CodingKey { case title, body, severity }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            title: try c.decode(forKey: .title, or: ""), body: try c.decode(forKey: .body, or: ""),
            severity: try c.decode(forKey: .severity, or: "info"))
    }
}

public struct AnnouncementResult: Decodable, Sendable, Equatable {
    public let announcement: AnnouncementDraft?
}

/// The name, picture and banner to change. Empty fields are left alone; `resetAvatar` goes back to the
/// default picture.
public struct IdentityDraft: Sendable, Equatable {
    public var username = ""
    public var avatarUrl = ""
    public var bannerUrl = ""
    public var resetAvatar = false

    public init() {}

    /// Why the draft cannot be sent, nil when it can.
    public var problem: String? {
        let name = username.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty, !(2...32).contains(name.count) { return "The name is 2 to 32 characters." }
        for (label, value) in [("avatar", avatarUrl), ("banner", bannerUrl)] {
            let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty, !EmbedSpec.isWebLink(text) || !text.lowercased().hasPrefix("https://") {
                return "The \(label) must be an https image link."
            }
        }
        return nil
    }

    public var isEmpty: Bool {
        username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && avatarUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && bannerUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !resetAvatar
    }
}

/// `{done, failed}` after changing the identity: what worked and what Discord refused.
public struct IdentityResult: Decodable, Sendable, Equatable {
    public let done: [String]
    public let failed: [String]

    private enum CodingKeys: String, CodingKey { case done, failed }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        done = try c.decode(forKey: .done, or: [])
        failed = try c.decode(forKey: .failed, or: [])
    }

    public var summary: String {
        var parts: [String] = []
        if !done.isEmpty { parts.append("Updated \(done.joined(separator: ", ")).") }
        if !failed.isEmpty { parts.append("Failed: \(failed.joined(separator: "; ")).") }
        return parts.isEmpty ? "Nothing to change." : parts.joined(separator: " ")
    }
}

extension Endpoints {
    /// `GET /api/v2/personalizer`.
    public struct PersonalizerIdentity: APIEndpoint {
        public typealias Response = PersonalizerIdentityPage
        public init() {}
        public var path: String { "/api/v2/personalizer" }
    }

    /// `GET /api/v2/personalizer/presence`.
    public struct PersonalizerPresence: APIEndpoint {
        public typealias Response = PersonalizerPresencePage
        public init() {}
        public var path: String { "/api/v2/personalizer/presence" }
    }

    /// `GET /api/v2/announcement`: readable by everyone signed in.
    public struct Announcement: APIEndpoint {
        public typealias Response = AnnouncementResult
        public init() {}
        public var path: String { "/api/v2/announcement" }
    }

    /// `POST /api/v2/personalizer/identity` with `{username, avatarUrl, bannerUrl, resetAvatar}`.
    public struct SaveIdentity: APIEndpoint {
        public typealias Response = IdentityResult
        public let draft: IdentityDraft
        public init(draft: IdentityDraft) { self.draft = draft }
        public var path: String { "/api/v2/personalizer/identity" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            Body(
                username: draft.username.trimmingCharacters(in: .whitespacesAndNewlines),
                avatarUrl: draft.avatarUrl.trimmingCharacters(in: .whitespacesAndNewlines),
                bannerUrl: draft.bannerUrl.trimmingCharacters(in: .whitespacesAndNewlines), resetAvatar: draft.resetAvatar)
        }
        private struct Body: Encodable, Sendable {
            let username: String
            let avatarUrl: String
            let bannerUrl: String
            let resetAvatar: Bool
        }
    }

    /// `POST /api/v2/personalizer/presence` with `{status, type, text}`.
    public struct SavePresence: APIEndpoint {
        public typealias Response = SavedPresence
        public let presence: PresenceConfig
        public init(presence: PresenceConfig) { self.presence = presence }
        public var path: String { "/api/v2/personalizer/presence" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { presence }
    }

    /// `POST /api/v2/personalizer/announcement` with `{title, body, severity}`; a blank title clears it.
    public struct SaveAnnouncement: APIEndpoint {
        public typealias Response = AnnouncementResult
        public let draft: AnnouncementDraft
        public init(draft: AnnouncementDraft) { self.draft = draft }
        public var path: String { "/api/v2/personalizer/announcement" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { draft }
    }

    /// `POST /api/v2/personalizer/announcement/clear`.
    public struct ClearAnnouncement: APIEndpoint {
        public typealias Response = AnnouncementResult
        public init() {}
        public var path: String { "/api/v2/personalizer/announcement/clear" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `GET /api/v2/public/commands`: needs no sign-in.
    public struct CommandList: APIEndpoint {
        public typealias Response = CommandListPage
        public init() {}
        public var path: String { "/api/v2/public/commands" }
    }

    /// `GET /api/v2/stats`: operators only.
    public struct Stats: APIEndpoint {
        public typealias Response = StatsPage
        public init() {}
        public var path: String { "/api/v2/stats" }
    }
}

public struct SavedPresence: Decodable, Sendable, Equatable {
    public let presence: PresenceConfig
}

/// The Bot Personalizer: loads the bot, its status and the announcement, and saves each on its own.
@MainActor
@Observable
public final class PersonalizerModel {
    public private(set) var bot: PersonalizerBot?
    public private(set) var presencePage: PersonalizerPresencePage?
    public var presence = PresenceConfig()
    public private(set) var savedPresence = PresenceConfig()
    public var announcement = AnnouncementDraft()
    public private(set) var savedAnnouncement = AnnouncementDraft()
    public var identity = IdentityDraft()
    public private(set) var isLoading = false
    public private(set) var isWorking = false
    /// Why the page could not be loaded.
    public var errorMessage: String?
    /// Why the last save failed.
    public var actionError: String?
    /// What to tell the person after a save.
    public var notice: String?
    public private(set) var successCount = 0

    private let session: AppSession

    public init(session: AppSession) {
        self.session = session
    }

    public var presenceHasChanges: Bool { presence != savedPresence }
    public var announcementHasChanges: Bool { announcement != savedAnnouncement }
    public var hasAnnouncement: Bool { !savedAnnouncement.title.isEmpty }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let identityPage = session.send(Endpoints.PersonalizerIdentity())
            async let presencePage = session.send(Endpoints.PersonalizerPresence())
            async let announcementResult = session.send(Endpoints.Announcement())
            let (identityPage1, presencePage1, announcementResult1) = try await (identityPage, presencePage, announcementResult)
            bot = identityPage1.bot
            self.presencePage = presencePage1
            presence = presencePage1.presence
            savedPresence = presencePage1.presence
            let loaded = announcementResult1.announcement ?? AnnouncementDraft()
            announcement = loaded
            savedAnnouncement = loaded
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.detailMessage }
        }
    }

    public func saveIdentity() async {
        if let problem = identity.problem {
            actionError = problem
            return
        }
        await run {
            let result = try await self.session.send(Endpoints.SaveIdentity(draft: self.identity))
            self.notice = result.summary
            if result.failed.isEmpty { self.identity = IdentityDraft() }
            if let page = try? await self.session.send(Endpoints.PersonalizerIdentity()) { self.bot = page.bot }
        }
    }

    public func savePresence() async {
        await run {
            let result = try await self.session.send(Endpoints.SavePresence(presence: self.presence))
            self.presence = result.presence
            self.savedPresence = result.presence
            self.notice = "Presence updated."
        }
    }

    public func saveAnnouncement() async {
        await run {
            let result = try await self.session.send(Endpoints.SaveAnnouncement(draft: self.announcement))
            let saved = result.announcement ?? AnnouncementDraft()
            self.announcement = saved
            self.savedAnnouncement = saved
            self.notice = result.announcement == nil ? "Announcement cleared (the title was blank)." : "Announcement published."
        }
    }

    public func clearAnnouncement() async {
        await run {
            _ = try await self.session.send(Endpoints.ClearAnnouncement())
            self.announcement = AnnouncementDraft()
            self.savedAnnouncement = AnnouncementDraft()
            self.notice = "Announcement cleared."
        }
    }

    private func run(_ work: @MainActor () async throws -> Void) async {
        guard !isWorking else { return }
        isWorking = true
        actionError = nil
        defer { isWorking = false }
        do {
            try await work()
            successCount += 1
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { actionError = error.detailMessage }
        }
    }
}

// MARK: - Roadmap

public enum RoadmapStatus: String, Sendable, CaseIterable, Identifiable {
    case planned, started, completed

    public var id: String { rawValue }
}

public struct RoadmapPost: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    public let title: String
    public let description: String
    /// `pending`, `planned`, `started` or `completed`.
    public let status: String
    public var votes: Int
    public var hasVoted: Bool
    public let createdAt: Date?
    /// "3d ago", for the admin lists.
    public let ago: String

    public init(id: Int, title: String, description: String = "", status: String = "planned", votes: Int = 0, hasVoted: Bool = false, createdAt: Date? = nil, ago: String = "") {
        self.id = id
        self.title = title
        self.description = description
        self.status = status
        self.votes = votes
        self.hasVoted = hasVoted
        self.createdAt = createdAt
        self.ago = ago
    }

    private enum CodingKeys: String, CodingKey { case id, title, description, status, votes, voted, createdAt, ago }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(Int.self, forKey: .id), title: try c.decode(forKey: .title, or: ""),
            description: try c.decode(forKey: .description, or: ""), status: try c.decode(forKey: .status, or: "planned"),
            votes: try c.decode(forKey: .votes, or: 0), hasVoted: try c.decode(forKey: .voted, or: false),
            createdAt: try c.decodeEpochMillisecondsIfPresent(forKey: .createdAt), ago: try c.decode(forKey: .ago, or: ""))
    }
}

/// `GET /api/v2/roadmap`: what a signed-in person sees.
public struct RoadmapBoard: Decodable, Sendable, Equatable {
    public var planned: [RoadmapPost]
    public var started: [RoadmapPost]
    public var completed: [RoadmapPost]
    /// The person's own suggestions that wait for review.
    public let mine: [RoadmapPost]
    public let isOwner: Bool

    public init(planned: [RoadmapPost] = [], started: [RoadmapPost] = [], completed: [RoadmapPost] = [], mine: [RoadmapPost] = [], isOwner: Bool = false) {
        self.planned = planned
        self.started = started
        self.completed = completed
        self.mine = mine
        self.isOwner = isOwner
    }

    private enum CodingKeys: String, CodingKey { case groups, mine, isOwner }
    private enum GroupKeys: String, CodingKey { case planned, started, completed }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let groups = try c.nestedContainer(keyedBy: GroupKeys.self, forKey: .groups)
        self.init(
            planned: try groups.decodeLossyArray(of: RoadmapPost.self, forKey: .planned),
            started: try groups.decodeLossyArray(of: RoadmapPost.self, forKey: .started),
            completed: try groups.decodeLossyArray(of: RoadmapPost.self, forKey: .completed),
            mine: try c.decodeLossyArray(of: RoadmapPost.self, forKey: .mine),
            isOwner: try c.decode(forKey: .isOwner, or: false))
    }

    public var isEmpty: Bool { planned.isEmpty && started.isEmpty && completed.isEmpty }

    /// The board with one post's vote replaced by the server's answer.
    public func applying(vote: RoadmapVoteResult, to id: Int) -> RoadmapBoard {
        func update(_ posts: [RoadmapPost]) -> [RoadmapPost] {
            posts.map { post in
                guard post.id == id else { return post }
                var changed = post
                changed.votes = vote.votes
                changed.hasVoted = vote.hasVoted
                return changed
            }
        }
        return RoadmapBoard(planned: update(planned), started: update(started), completed: update(completed), mine: mine, isOwner: isOwner)
    }
}

public struct RoadmapVoteResult: Decodable, Sendable, Equatable {
    public let hasVoted: Bool
    public let votes: Int

    public init(hasVoted: Bool, votes: Int) {
        self.hasVoted = hasVoted
        self.votes = votes
    }

    private enum CodingKeys: String, CodingKey { case voted, votes }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hasVoted = try c.decode(forKey: .voted, or: false)
        votes = try c.decode(forKey: .votes, or: 0)
    }
}

/// `GET /api/v2/roadmap/admin`: the posts waiting for review and all public ones.
public struct RoadmapAdminPage: Decodable, Sendable, Equatable {
    public let pending: [RoadmapPost]
    public let posts: [RoadmapPost]

    public init(pending: [RoadmapPost] = [], posts: [RoadmapPost] = []) {
        self.pending = pending
        self.posts = posts
    }

    private enum CodingKeys: String, CodingKey { case pending, posts }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            pending: try c.decodeLossyArray(of: RoadmapPost.self, forKey: .pending),
            posts: try c.decodeLossyArray(of: RoadmapPost.self, forKey: .posts))
    }
}

public enum RoadmapLimits {
    public static let titleRange = 3...100
    public static let maxDescription = 2000

    /// Why a title and description cannot be sent, nil when they can.
    public static func problem(title: String, description: String) -> String? {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let d = description.trimmingCharacters(in: .whitespacesAndNewlines)
        if !titleRange.contains(t.count) { return "The title is 3 to 100 characters." }
        if d.isEmpty { return "Add a description." }
        if d.count > maxDescription { return "The description is at most 2000 characters." }
        return nil
    }
}

extension Endpoints {
    /// `GET /api/v2/roadmap`.
    public struct Roadmap: APIEndpoint {
        public typealias Response = RoadmapBoard
        public init() {}
        public var path: String { "/api/v2/roadmap" }
    }

    /// `POST /api/v2/roadmap/:id/vote`: toggles the person's vote.
    public struct VoteRoadmapPost: APIEndpoint {
        public typealias Response = RoadmapVoteResult
        public let id: Int
        public init(id: Int) { self.id = id }
        public var path: String { "/api/v2/roadmap/\(id)/vote" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST /api/v2/roadmap/suggest` with `{title, description}`: waits for the operator's review.
    public struct SuggestRoadmapPost: APIEndpoint {
        public typealias Response = OKResponse
        public let title: String
        public let description: String
        public init(title: String, description: String) {
            self.title = title
            self.description = description
        }
        public var path: String { "/api/v2/roadmap/suggest" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { TextBody(title: title, description: description) }
    }

    /// `GET /api/v2/roadmap/admin`: operators only.
    public struct RoadmapAdmin: APIEndpoint {
        public typealias Response = RoadmapAdminPage
        public init() {}
        public var path: String { "/api/v2/roadmap/admin" }
    }

    /// `POST /api/v2/roadmap/admin` with `{title, description}`: a new public post (planned).
    public struct CreateRoadmapPost: APIEndpoint {
        public typealias Response = JSONValue
        public let title: String
        public let description: String
        public init(title: String, description: String) {
            self.title = title
            self.description = description
        }
        public var path: String { "/api/v2/roadmap/admin" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { TextBody(title: title, description: description) }
    }

    /// `POST /api/v2/roadmap/admin/:id/approve`.
    public struct ApproveRoadmapPost: APIEndpoint {
        public typealias Response = JSONValue
        public let id: Int
        public init(id: Int) { self.id = id }
        public var path: String { "/api/v2/roadmap/admin/\(id)/approve" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST /api/v2/roadmap/admin/:id/reject`: deletes the suggestion.
    public struct RejectRoadmapPost: APIEndpoint {
        public typealias Response = OKResponse
        public let id: Int
        public init(id: Int) { self.id = id }
        public var path: String { "/api/v2/roadmap/admin/\(id)/reject" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST /api/v2/roadmap/admin/:id/status` with `{status}`.
    public struct SetRoadmapStatus: APIEndpoint {
        public typealias Response = JSONValue
        public let id: Int
        public let status: RoadmapStatus
        public init(id: Int, status: RoadmapStatus) {
            self.id = id
            self.status = status
        }
        public var path: String { "/api/v2/roadmap/admin/\(id)/status" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(status: status.rawValue) }
        private struct Body: Encodable, Sendable { let status: String }
    }

    /// `POST /api/v2/roadmap/admin/:id/edit` with `{title, description}`.
    public struct EditRoadmapPost: APIEndpoint {
        public typealias Response = JSONValue
        public let id: Int
        public let title: String
        public let description: String
        public init(id: Int, title: String, description: String) {
            self.id = id
            self.title = title
            self.description = description
        }
        public var path: String { "/api/v2/roadmap/admin/\(id)/edit" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { TextBody(title: title, description: description) }
    }

    /// `POST /api/v2/roadmap/admin/:id/delete`.
    public struct DeleteRoadmapPost: APIEndpoint {
        public typealias Response = OKResponse
        public let id: Int
        public init(id: Int) { self.id = id }
        public var path: String { "/api/v2/roadmap/admin/\(id)/delete" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    struct TextBody: Encodable, Sendable {
        let title: String
        let description: String
    }
}

// MARK: - Backups and other Health actions

extension Endpoints {
    /// `POST /api/v2/health/backups`: makes a backup now; answers `{name}`.
    public struct CreateBackup: APIEndpoint {
        public typealias Response = BackupName
        public init() {}
        public var path: String { "/api/v2/health/backups" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `GET /api/v2/health/backups/:name`: the file.
    public struct DownloadBackup: APIEndpoint {
        public typealias Response = RawBytes
        public let name: String
        public init(name: String) { self.name = name }
        public var path: String { "/api/v2/health/backups/\(name.encodedPathSegment)" }
    }

    /// `POST /api/v2/health/backups/import` with the file as the body (up to 128 MB).
    public struct ImportBackup: APIEndpoint {
        public typealias Response = BackupName
        public let data: Data
        public init(data: Data) { self.data = data }
        public var path: String { "/api/v2/health/backups/import" }
        public var method: HTTPMethod { .post }
        public var rawBody: Data? { data }
    }

    /// `POST /api/v2/health/backups/:name/delete`.
    public struct DeleteBackup: APIEndpoint {
        public typealias Response = OKResponse
        public let name: String
        public init(name: String) { self.name = name }
        public var path: String { "/api/v2/health/backups/\(name.encodedPathSegment)/delete" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST /api/v2/health/backups/:name/restore`: replaces the database with the backup; Sylo
    /// restarts afterwards.
    public struct RestoreBackup: APIEndpoint {
        public typealias Response = OKResponse
        public let name: String
        public init(name: String) { self.name = name }
        public var path: String { "/api/v2/health/backups/\(name.encodedPathSegment)/restore" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST /api/v2/health/dev-log-error-test`: logs a test error, to check the whole error path.
    public struct SendDevLogErrorTest: APIEndpoint {
        public typealias Response = OKResponse
        public init() {}
        public var path: String { "/api/v2/health/dev-log-error-test" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST /api/v2/account/disconnect/:platform`: removes one sign-in (404 or 400 for the last).
    public struct DisconnectPlatform: APIEndpoint {
        public typealias Response = OKResponse
        public let platform: String
        public init(platform: String) { self.platform = platform }
        public var path: String { "/api/v2/account/disconnect/\(platform.encodedPathSegment)" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }
}

public struct BackupName: Decodable, Sendable, Equatable {
    public let name: String
}

/// Writes a downloaded backup to a temporary file, to hand to the share sheet.
public enum BackupFiles {
    /// The file for a backup named like `sylo-2026-11-05.db`. The name is reduced to safe characters.
    public static func write(_ bytes: RawBytes, name: String) throws -> URL {
        let safe = String(name.map { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" || $0 == "_" ? $0 : "-" })
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(safe.isEmpty ? "sylo-backup" : safe)
        try bytes.data.write(to: url, options: .atomic)
        return url
    }
}

// MARK: - Add Sylo to a server

/// A link that adds Sylo to a server on one platform (`GET /api/v2/invites`): the platform's own
/// authorize page, not a page of the web dashboard.
public struct BotInvite: Decodable, Sendable, Hashable, Identifiable {
    public let platform: Platform
    public let label: String
    public let url: URL

    public var id: String { platform.rawValue }

    public init(platform: Platform, label: String, url: URL) {
        self.platform = platform
        self.label = label
        self.url = url
    }

    private enum CodingKeys: String, CodingKey { case platform, label, url }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let platform = try c.decode(forKey: .platform, or: Platform.discord)
        guard let url = try c.decodeURLIfPresent(forKey: .url), url.scheme?.lowercased() == "https" else {
            throw DecodingError.dataCorruptedError(forKey: .url, in: c, debugDescription: "An https link")
        }
        self.init(platform: platform, label: try c.decode(forKey: .label, or: platform.displayName), url: url)
    }
}

public struct BotInvites: Decodable, Sendable, Equatable {
    public let invites: [BotInvite]

    private enum CodingKeys: String, CodingKey { case invites }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        invites = try c.decodeLossyArray(of: BotInvite.self, forKey: .invites)
    }
}

extension Endpoints {
    /// `GET /api/v2/invites`.
    public struct Invites: APIEndpoint {
        public typealias Response = BotInvites
        public init() {}
        public var path: String { "/api/v2/invites" }
    }
}
