import Foundation

// GitHub alerts (src/modules/githubAlerts.js and the routes in src/web/routes/v2Api.js under
// /modules/github; web form web-v2/src/moduleForms/GithubAlerts.jsx): GitHub activity from a
// repository posted to a channel through a webhook. A watch is a record with its own URL and secret.

/// An activity type a watch can post, from the server's list.
public struct GithubEventType: Decodable, Sendable, Equatable, Identifiable, Hashable {
    /// `push`, `release`, `issues`, `pull_request`, `star` or `fork`.
    public let key: String
    public let label: String

    public var id: String { key }

    public init(key: String, label: String) {
        self.key = key
        self.label = label
    }

    /// What the server offers today, for a server that does not send the list.
    public static let standard: [GithubEventType] = [
        GithubEventType(key: "push", label: "Commits pushed"),
        GithubEventType(key: "release", label: "Release published"),
        GithubEventType(key: "issues", label: "Issue opened / closed"),
        GithubEventType(key: "pull_request", label: "Pull request opened / merged / closed"),
        GithubEventType(key: "star", label: "Repo starred"),
        GithubEventType(key: "fork", label: "Repo forked"),
    ]
}

/// A watched repository.
public struct GithubWatch: Decodable, Sendable, Equatable, Identifiable {
    public let id: Int
    /// `owner/repo`.
    public let repo: String
    public let channelId: String
    /// The role pinged with each post; "" for none.
    public let roleId: String
    /// A file whose newest entry is posted when a push changes it; "" for none.
    public let changelogPath: String
    public let events: [String]
    public let isEnabled: Bool
    /// The secret to paste into the repository's webhook settings.
    public let secret: String
    /// The address to paste there; nil when the server has no public address set.
    public let webhookURL: String?

    public init(
        id: Int, repo: String, channelId: String, roleId: String = "", changelogPath: String = "",
        events: [String] = ["push", "release"], isEnabled: Bool = true, secret: String = "", webhookURL: String? = nil
    ) {
        self.id = id
        self.repo = repo
        self.channelId = channelId
        self.roleId = roleId
        self.changelogPath = changelogPath
        self.events = events
        self.isEnabled = isEnabled
        self.secret = secret
        self.webhookURL = webhookURL
    }

    private enum CodingKeys: String, CodingKey {
        case id, repo, channelId, roleId, changelogPath, events, enabled, secret, webhookUrl
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        repo = try c.decode(forKey: .repo, or: "")
        channelId = try c.decode(forKey: .channelId, or: "")
        roleId = try c.decode(forKey: .roleId, or: "")
        changelogPath = try c.decode(forKey: .changelogPath, or: "")
        events = try c.decode(forKey: .events, or: [])
        isEnabled = try c.decode(forKey: .enabled, or: true)
        secret = try c.decode(forKey: .secret, or: "")
        let url = try c.decodeIfPresent(String.self, forKey: .webhookUrl)
        webhookURL = (url ?? "").isEmpty ? nil : url
    }
}

/// `GET /api/v2/guilds/:id/modules/github/watches`.
public struct GithubPage: Decodable, Sendable, Equatable {
    public static let moduleID: ModuleID = "github"

    public let watches: [GithubWatch]
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    public let eventTypes: [GithubEventType]
    /// Whether the server knows its own public address; without it GitHub has nowhere to send events.
    public let hasPublicAddress: Bool

    public init(
        watches: [GithubWatch] = [], channels: [ChannelOption] = [], roles: [RoleOption] = [],
        eventTypes: [GithubEventType] = GithubEventType.standard, hasPublicAddress: Bool = true
    ) {
        self.watches = watches
        self.channels = channels
        self.roles = roles
        self.eventTypes = eventTypes
        self.hasPublicAddress = hasPublicAddress
    }

    private enum CodingKeys: String, CodingKey { case watches, channels, roles, eventTypes, dashboardUrlSet }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        watches = try c.decodeLossyArray(of: GithubWatch.self, forKey: .watches)
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        let types = try c.decodeLossyArray(of: GithubEventType.self, forKey: .eventTypes)
        eventTypes = types.isEmpty ? GithubEventType.standard : types
        hasPublicAddress = try c.decode(forKey: .dashboardUrlSet, or: true)
    }
}

/// A watch while it is edited, and the body that saves it.
public struct GithubWatchDraft: Sendable, Equatable, Identifiable {
    public let localID = LocalID()
    /// The watch's id; nil for a new one.
    public var watchID: Int?
    /// `owner/repo` or the repository's github.com address.
    public var repo: String
    public var channelId: String
    public var roleId: String
    public var changelogPath: String
    public var events: [String]

    public var id: UUID { localID.value }

    public static let maxChangelogPathLength = 200

    /// A new watch: commits and releases, as the web form starts.
    public init() {
        watchID = nil
        repo = ""
        channelId = ""
        roleId = ""
        changelogPath = ""
        events = ["push", "release"]
    }

    public init(watch: GithubWatch) {
        watchID = watch.id
        repo = watch.repo
        channelId = watch.channelId
        roleId = watch.roleId
        changelogPath = watch.changelogPath
        events = watch.events
    }

    /// Why the watch cannot be saved yet, in words for the person; nil when it can.
    public var problem: String? {
        if repo.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Enter a repository as owner/repo or its github.com address."
        }
        if channelId.isEmpty { return "Choose a channel." }
        if events.isEmpty, changelogPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Choose at least one event to post, or a changelog file."
        }
        return nil
    }

    /// Turns an event type on or off.
    public mutating func setEvent(_ key: String, on: Bool) {
        if on {
            if !events.contains(key) { events.append(key) }
        } else {
            events.removeAll { $0 == key }
        }
    }

    struct Body: Encodable, Sendable {
        let repo: String
        let channelId: String
        let roleId: String
        let changelogPath: String
        let events: [String]
    }

    var body: Body {
        Body(repo: repo, channelId: channelId, roleId: roleId, changelogPath: changelogPath, events: events)
    }
}

/// The answer to saving, switching or renewing the secret of a watch.
public struct SavedGithubWatch: Decodable, Sendable, Equatable {
    public let watch: GithubWatch?
}

extension Endpoints {
    /// `GET …/github/watches`.
    public struct LoadGithub: APIEndpoint {
        public typealias Response = GithubPage
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/github/watches" }
    }

    /// `POST …/watches` adds a repository; `POST …/watches/:id` updates it.
    public struct SaveGithubWatch: APIEndpoint {
        public typealias Response = SavedGithubWatch
        public let server: ServerID
        public let draft: GithubWatchDraft
        public init(server: ServerID, draft: GithubWatchDraft) {
            self.server = server
            self.draft = draft
        }
        public var path: String {
            let base = "/api/v2/guilds/\(server.pathComponent)/modules/github/watches"
            return draft.watchID.map { "\(base)/\($0)" } ?? base
        }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { draft.body }
    }

    /// `POST …/watches/:id/toggle`.
    public struct ToggleGithubWatch: APIEndpoint {
        public typealias Response = SavedGithubWatch
        public let server: ServerID
        public let id: Int
        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/github/watches/\(id)/toggle" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST …/watches/:id/delete`.
    public struct DeleteGithubWatch: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let id: Int
        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/github/watches/\(id)/delete" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST …/watches/:id/regen-secret`: a new webhook secret; the old one stops working at once.
    public struct RegenerateGithubSecret: APIEndpoint {
        public typealias Response = SavedGithubWatch
        public let server: ServerID
        public let id: Int
        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }
        public var path: String {
            "/api/v2/guilds/\(server.pathComponent)/modules/github/watches/\(id)/regen-secret"
        }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }
}

extension RecordListModel where Page == GithubPage {
    /// The GitHub alerts screen's model.
    public convenience init(github server: ServerID, session: AppSession) {
        self.init(server: server, session: session) { session, server in
            try await session.send(Endpoints.LoadGithub(server: server))
        }
    }

    public func save(_ draft: GithubWatchDraft) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.SaveGithubWatch(server: server, draft: draft))
            return true
        }
        return done != nil
    }

    public func toggle(_ watch: GithubWatch) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.ToggleGithubWatch(server: server, id: watch.id))
            return true
        }
        return done != nil
    }

    public func delete(_ watch: GithubWatch) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.DeleteGithubWatch(server: server, id: watch.id))
            return true
        }
        return done != nil
    }

    /// Gives a watch a new webhook secret.
    public func regenerateSecret(_ watch: GithubWatch) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.RegenerateGithubSecret(server: server, id: watch.id))
            return true
        }
        return done != nil
    }
}
