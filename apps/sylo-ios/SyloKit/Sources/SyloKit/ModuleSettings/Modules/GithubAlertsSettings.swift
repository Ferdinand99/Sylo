import Foundation
import Observation

// GitHub alerts (src/web/routes/v2Api.js, `/modules/github/watches`; the dashboard form is
// web-v2/src/moduleForms/GithubAlerts.jsx). A watch posts activity from one repository to a
// channel. GitHub pushes it to a per-watch webhook address, and the watch's secret signs what it
// sends. Watches are rows of their own table, not module settings, so they have their own list
// page and their own calls.

/// One kind of event a watch can post (`{key, label}`), as the server lists them.
public struct GithubEventType: Decodable, Sendable, Hashable, Identifiable {
    /// GitHub's own event name (`push`, `pull_request`).
    public let key: String
    public let label: String

    public var id: String { key }

    public init(key: String, label: String) {
        self.key = key
        self.label = label
    }

    /// What the server offers today; used when an older server does not send its list.
    public static let standard: [GithubEventType] = [
        GithubEventType(key: "push", label: "Commits pushed"),
        GithubEventType(key: "release", label: "Release published"),
        GithubEventType(key: "issues", label: "Issue opened / closed"),
        GithubEventType(key: "pull_request", label: "Pull request opened / merged / closed"),
        GithubEventType(key: "star", label: "Repo starred"),
        GithubEventType(key: "fork", label: "Repo forked"),
    ]
}

/// A watched repository as the server lists it.
public struct GithubWatch: Decodable, Sendable, Equatable, Identifiable, CustomDebugStringConvertible {
    public let id: Int
    /// "owner/repo".
    public let repo: String
    public let channelId: String
    /// The role pinged with each post, or "".
    public let roleId: String
    /// A file in the repository whose newest entry is posted when a push changes it, or "".
    public let changelogPath: String
    public let events: [String]
    public let enabled: Bool
    /// The webhook secret GitHub signs its calls with. Never printed or logged.
    public let secret: String
    /// Where GitHub sends events. nil while the server has no public address set.
    public let webhookUrl: String?

    public init(
        id: Int, repo: String = "", channelId: String = "", roleId: String = "", changelogPath: String = "",
        events: [String] = [], enabled: Bool = true, secret: String = "", webhookUrl: String? = nil
    ) {
        self.id = id
        self.repo = repo
        self.channelId = channelId
        self.roleId = roleId
        self.changelogPath = changelogPath
        self.events = events
        self.enabled = enabled
        self.secret = secret
        self.webhookUrl = webhookUrl
    }

    private enum CodingKeys: String, CodingKey {
        case id, repo, channelId, roleId, changelogPath, events, enabled, secret, webhookUrl
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let url = (try? c.decodeIfPresent(String.self, forKey: .webhookUrl)) ?? nil
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            repo: (try? c.decodeIfPresent(String.self, forKey: .repo)) ?? "",
            channelId: (try? c.decodeIfPresent(String.self, forKey: .channelId)) ?? "",
            roleId: (try? c.decodeIfPresent(String.self, forKey: .roleId)) ?? "",
            changelogPath: (try? c.decodeIfPresent(String.self, forKey: .changelogPath)) ?? "",
            events: (try? c.decodeIfPresent([String].self, forKey: .events)) ?? [],
            enabled: (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? true,
            secret: (try? c.decodeIfPresent(String.self, forKey: .secret)) ?? "",
            webhookUrl: (url?.isEmpty ?? true) ? nil : url)
    }

    /// Without the secret, so a log or a debugger never shows it.
    public var debugDescription: String { "GithubWatch(id: \(id), repo: \(repo), enabled: \(enabled))" }
}

/// The GitHub alerts page: the watches and what the form offers.
public struct GithubWatchesPage: Decodable, Sendable, Equatable {
    public let watches: [GithubWatch]
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    public let eventTypes: [GithubEventType]
    /// Whether the server has a public address for GitHub to send events to. True when an older
    /// server does not say, so the warning only shows when the server says it.
    public let dashboardUrlSet: Bool

    public init(
        watches: [GithubWatch] = [], channels: [ChannelOption] = [], roles: [RoleOption] = [],
        eventTypes: [GithubEventType] = GithubEventType.standard, dashboardUrlSet: Bool = true
    ) {
        self.watches = watches
        self.channels = channels
        self.roles = roles
        self.eventTypes = eventTypes
        self.dashboardUrlSet = dashboardUrlSet
    }

    private enum CodingKeys: String, CodingKey { case watches, channels, roles, eventTypes, dashboardUrlSet }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let types = try c.decodeLossyArray(of: GithubEventType.self, forKey: .eventTypes)
        self.init(
            watches: try c.decodeLossyArray(of: GithubWatch.self, forKey: .watches),
            channels: try c.decodeLossyArray(of: ChannelOption.self, forKey: .channels),
            roles: try c.decodeLossyArray(of: RoleOption.self, forKey: .roles),
            eventTypes: types.isEmpty ? GithubEventType.standard : types,
            dashboardUrlSet: (try? c.decodeIfPresent(Bool.self, forKey: .dashboardUrlSet)) ?? true)
    }
}

/// The answer to a save, a toggle or a new secret: the watch as it is now. nil when it is gone (a
/// toggle of a watch someone deleted meanwhile).
public struct GithubWatchAnswer: Decodable, Sendable, Equatable {
    public let watch: GithubWatch?

    public init(watch: GithubWatch? = nil) { self.watch = watch }

    private enum CodingKeys: String, CodingKey { case watch }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        watch = (try? c.decodeIfPresent(GithubWatch.self, forKey: .watch)) ?? nil
    }
}

/// How the server reads what is typed into the repository and changelog fields, so the form can
/// say what is wrong before it asks (`parseRepoInput` and `parseChangelogPath` in
/// src/modules/githubAlerts.js). The server checks again.
public enum GithubInput {
    public static let changelogPathLimit = 300

    private static let repoPattern = #"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$"#

    /// "owner/repo" from "owner/repo" or a pasted github.com address; nil when it is neither.
    public static func repo(from text: String) -> String? {
        var value = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(300))
        if let prefix = value.range(of: #"^https?://(www\.)?github\.com/"#, options: [.regularExpression, .caseInsensitive]) {
            value.removeSubrange(prefix)
        }
        if let suffix = value.range(of: #"\.git$"#, options: [.regularExpression, .caseInsensitive]) {
            value.removeSubrange(suffix)
        }
        while value.hasSuffix("/") { value.removeLast() }
        guard let match = value.range(of: repoPattern, options: .regularExpression),
              match == value.startIndex..<value.endIndex
        else { return nil }
        return value
    }

    /// The changelog path as the server keeps it ("" for none), or nil when it is not acceptable: a
    /// plain relative path, with no `..` and no control characters.
    public static func changelogPath(from text: String, limit: Int = changelogPathLimit) -> String? {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasPrefix("/") { value.removeFirst() }
        if value.isEmpty { return "" }
        if value.count > limit || value.contains("..") { return nil }
        if value.unicodeScalars.contains(where: { $0.value == 0 || $0 == "\r" || $0 == "\n" }) { return nil }
        return value
    }
}

/// What the watch form edits: a new watch, or one that is already stored.
public struct GithubWatchDraft: Sendable, Equatable {
    public var repo: String
    public var channelId: String
    public var roleId: String
    public var changelogPath: String
    /// Event keys. A stored key the form does not list is kept, and goes back as it was.
    public var events: Set<String>

    /// A new watch: pushes and releases (the dashboard's blank form).
    public init() {
        repo = ""
        channelId = ""
        roleId = ""
        changelogPath = ""
        events = ["push", "release"]
    }

    public init(editing watch: GithubWatch) {
        repo = watch.repo
        channelId = watch.channelId
        roleId = watch.roleId
        changelogPath = watch.changelogPath
        events = Set(watch.events)
    }

    /// Why this cannot be sent yet, in a sentence; nil when it can (the dashboard's own wording).
    public func problem(changelogLimit: Int = GithubInput.changelogPathLimit) -> String? {
        if GithubInput.repo(from: repo) == nil {
            return String(localized: "Enter a repo as owner/repo (or paste its github.com URL).")
        }
        if channelId.isEmpty { return String(localized: "Pick a channel.") }
        guard let path = GithubInput.changelogPath(from: changelogPath, limit: changelogLimit) else {
            return String(localized: "That changelog path looks invalid: use a plain relative file path, for example CHANGELOG.md.")
        }
        if events.isEmpty, path.isEmpty {
            return String(localized: "Pick at least one event to announce, or set a changelog file path.")
        }
        return nil
    }
}

/// The body of a create or an edit: the fields the dashboard's form sends.
struct GithubWatchBody: Encodable, Sendable {
    let draft: GithubWatchDraft

    private enum CodingKeys: String, CodingKey { case repo, channelId, roleId, changelogPath, events }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(draft.repo.trimmingCharacters(in: .whitespacesAndNewlines), forKey: .repo)
        try c.encode(draft.channelId, forKey: .channelId)
        try c.encode(draft.roleId, forKey: .roleId)
        try c.encode(draft.changelogPath.trimmingCharacters(in: .whitespacesAndNewlines), forKey: .changelogPath)
        try c.encode(draft.events.sorted(), forKey: .events)
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/modules/github/watches`.
    public struct LoadGithubWatches: APIEndpoint {
        public typealias Response = GithubWatchesPage
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/github/watches" }
    }

    /// `POST .../github/watches` for a new watch, `POST .../watches/:id` for a stored one.
    public struct SaveGithubWatch: APIEndpoint {
        public typealias Response = GithubWatchAnswer
        public let server: ServerID
        /// nil creates a watch.
        public let id: Int?
        public let draft: GithubWatchDraft

        public init(server: ServerID, id: Int? = nil, draft: GithubWatchDraft) {
            self.server = server
            self.id = id
            self.draft = draft
        }

        public var path: String {
            let base = "/api/v2/guilds/\(server.pathComponent)/modules/github/watches"
            return id.map { "\(base)/\($0)" } ?? base
        }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { GithubWatchBody(draft: draft) }
    }

    /// `POST .../watches/:id/delete`.
    public struct DeleteGithubWatch: APIEndpoint {
        public typealias Response = EmptyResponse
        public let server: ServerID
        public let id: Int
        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/github/watches/\(id)/delete" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { CommunityEmptyBody() }
    }

    /// `POST .../watches/:id/toggle`: pauses an active watch, resumes a paused one.
    public struct ToggleGithubWatch: APIEndpoint {
        public typealias Response = GithubWatchAnswer
        public let server: ServerID
        public let id: Int
        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/github/watches/\(id)/toggle" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { CommunityEmptyBody() }
    }

    /// `POST .../watches/:id/regen-secret`: makes a new secret. The old one, and the value saved in
    /// GitHub's webhook settings, stops working at once.
    public struct RegenerateGithubSecret: APIEndpoint {
        public typealias Response = GithubWatchAnswer
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
        public var body: (any Encodable & Sendable)? { CommunityEmptyBody() }
    }
}

/// The GitHub alerts screen's state: the watches, and every action on them. Each answer carries the
/// watch as it is now, which replaces the one in the list (a new secret included).
@MainActor
@Observable
public final class GithubAlertsModel {
    public let server: ServerID
    public private(set) var watches: [GithubWatch] = []
    public private(set) var channels: [ChannelOption] = []
    public private(set) var roles: [RoleOption] = []
    public private(set) var eventTypes = GithubEventType.standard
    public private(set) var dashboardUrlSet = true
    public private(set) var isLoading = false
    public private(set) var hasLoaded = false
    /// Why the page could not be loaded (the last list, if any, stays).
    public var errorMessage: String?
    /// Why the last pause, resume, delete or new secret did not go through.
    public var actionError: String?
    /// Why the last save did not go through; the form shows it.
    public var saveError: String?
    public private(set) var isSaving = false
    /// The watches a pause, resume, delete or new secret is running for.
    public private(set) var busy: Set<Int> = []
    /// Goes up with every action that went through, for a haptic.
    public private(set) var successCount = 0

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public func watch(id: Int) -> GithubWatch? { watches.first { $0.id == id } }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await session.send(Endpoints.LoadGithubWatches(server: server))
            watches = page.watches
            channels = page.channels
            roles = page.roles
            eventTypes = page.eventTypes
            dashboardUrlSet = page.dashboardUrlSet
            hasLoaded = true
            errorMessage = nil
        } catch {
            if let message = ListFailure.message(for: error) { errorMessage = message }
        }
    }

    /// Creates a watch (`id` nil) or saves one.
    /// - Returns: Whether it went through. On failure ``saveError`` says why.
    @discardableResult
    public func save(_ draft: GithubWatchDraft, editing id: Int?) async -> Bool {
        guard !isSaving else { return false }
        saveError = nil
        if let problem = draft.problem() {
            saveError = problem
            return false
        }
        isSaving = true
        defer { isSaving = false }
        do {
            let answer = try await session.send(Endpoints.SaveGithubWatch(server: server, id: id, draft: draft))
            if let saved = answer.watch {
                if let index = watches.firstIndex(where: { $0.id == saved.id }) {
                    watches[index] = saved
                } else {
                    watches.append(saved)
                }
            } else {
                await load()
            }
            successCount += 1
            return true
        } catch {
            if let message = ListFailure.message(for: error) { saveError = message }
            // Deleted elsewhere: the stale row goes, and the message says why.
            if let id, ListFailure.isGone(error) { watches.removeAll { $0.id == id } }
            return false
        }
    }

    /// Pauses an active watch or resumes a paused one.
    public func toggle(_ id: Int) async {
        guard !busy.contains(id) else { return }
        busy.insert(id)
        defer { busy.remove(id) }
        actionError = nil
        do {
            let answer = try await session.send(Endpoints.ToggleGithubWatch(server: server, id: id))
            if let updated = answer.watch {
                if let index = watches.firstIndex(where: { $0.id == id }) { watches[index] = updated }
            } else {
                // Deleted elsewhere in the meantime.
                watches.removeAll { $0.id == id }
            }
            successCount += 1
        } catch {
            if let message = ListFailure.message(for: error) { actionError = message }
        }
    }

    public func delete(_ id: Int) async {
        guard !busy.contains(id) else { return }
        busy.insert(id)
        defer { busy.remove(id) }
        actionError = nil
        do {
            _ = try await session.send(Endpoints.DeleteGithubWatch(server: server, id: id))
            watches.removeAll { $0.id == id }
            successCount += 1
        } catch {
            if let message = ListFailure.message(for: error) { actionError = message }
        }
    }

    /// Makes a new webhook secret; the watch in the list takes it at once, so what the screen shows
    /// is the one GitHub has to be given.
    /// - Returns: Whether it went through.
    @discardableResult
    public func regenerateSecret(_ id: Int) async -> Bool {
        guard !busy.contains(id) else { return false }
        busy.insert(id)
        defer { busy.remove(id) }
        actionError = nil
        do {
            let answer = try await session.send(Endpoints.RegenerateGithubSecret(server: server, id: id))
            guard let updated = answer.watch else {
                // The watch is gone.
                watches.removeAll { $0.id == id }
                actionError = String(localized: "That watch no longer exists.")
                return false
            }
            if let index = watches.firstIndex(where: { $0.id == id }) {
                watches[index] = updated
            } else {
                watches.append(updated)
            }
            successCount += 1
            return true
        } catch {
            if let message = ListFailure.message(for: error) { actionError = message }
            // The server answers 404 "No such watch" for a watch that is gone: the stale row goes too.
            if ListFailure.isGone(error) { watches.removeAll { $0.id == id } }
            return false
        }
    }
}
