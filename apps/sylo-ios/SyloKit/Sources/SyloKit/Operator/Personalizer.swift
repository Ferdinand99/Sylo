import Foundation
import Observation

// The Bot Personalizer, for the operators of a Sylo server (web-v2/src/pages/Personalizer.jsx, the
// dashboard's /settings page): the bot's name and pictures, its presence, and the announcement every
// signed-in person sees. All of it is bot-wide, not per server. The server routes are `requireOwner`
// (`/api/v2/personalizer*`); they accept an app token when the account is an operator.

/// The bot as the personalizer shows it.
public struct BotIdentity: Decodable, Sendable, Equatable {
    /// `Sylo#9455`.
    public let tag: String
    public let username: String
    public let id: String
    public let avatarURL: URL?
    public let bannerURL: URL?

    public init(tag: String, username: String = "", id: String = "", avatarURL: URL? = nil, bannerURL: URL? = nil) {
        self.tag = tag
        self.username = username
        self.id = id
        self.avatarURL = avatarURL
        self.bannerURL = bannerURL
    }

    private enum CodingKeys: String, CodingKey { case tag, username, id, avatar, banner }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tag = try c.decodeIfPresent(String.self, forKey: .tag) ?? ""
        username = try c.decodeIfPresent(String.self, forKey: .username) ?? ""
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        avatarURL = try c.decodeURLIfPresent(forKey: .avatar)
        bannerURL = try c.decodeURLIfPresent(forKey: .banner)
    }
}

/// `GET /api/v2/personalizer`: the bot, or nil while it is not connected yet.
public struct BotIdentityAnswer: Decodable, Sendable, Equatable {
    public let bot: BotIdentity?

    public init(bot: BotIdentity?) { self.bot = bot }

    private enum CodingKeys: String, CodingKey { case bot }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        bot = try? c.decodeIfPresent(BotIdentity.self, forKey: .bot)
    }
}

/// What the bot's status line says: online status, the kind of activity, and its text.
public struct PresenceSettings: Codable, Sendable, Equatable {
    public var status: String
    public var type: String
    public var text: String

    public init(status: String = "online", type: String = "Listening", text: String = "") {
        self.status = status
        self.type = type
        self.text = text
    }

    private enum CodingKeys: String, CodingKey { case status, type, text }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "online"
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "Listening"
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
    }

    /// What the server offers when it does not say (`PRESENCE_STATUSES`, `PRESENCE_TYPES`).
    public static let defaultStatuses = ["online", "idle", "dnd", "invisible"]
    public static let defaultTypes = ["Playing", "Listening", "Watching", "Competing", "Custom"]
    public static let defaultSeverities = ["info", "warning", "critical"]
}

/// `GET /api/v2/personalizer/presence`: the current presence and the choices.
public struct PresenceOptions: Decodable, Sendable, Equatable {
    public let presence: PresenceSettings
    public let types: [String]
    public let statuses: [String]
    public let announcementSeverities: [String]

    public init(
        presence: PresenceSettings = PresenceSettings(), types: [String] = PresenceSettings.defaultTypes,
        statuses: [String] = PresenceSettings.defaultStatuses,
        announcementSeverities: [String] = PresenceSettings.defaultSeverities
    ) {
        self.presence = presence
        self.types = types
        self.statuses = statuses
        self.announcementSeverities = announcementSeverities
    }

    private enum CodingKeys: String, CodingKey { case presence, types, statuses, announcementSeverities }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        presence = (try? c.decodeIfPresent(PresenceSettings.self, forKey: .presence)) ?? PresenceSettings()
        types = Self.nonEmpty(try? c.decodeIfPresent([String].self, forKey: .types), PresenceSettings.defaultTypes)
        statuses = Self.nonEmpty(try? c.decodeIfPresent([String].self, forKey: .statuses), PresenceSettings.defaultStatuses)
        announcementSeverities = Self.nonEmpty(
            try? c.decodeIfPresent([String].self, forKey: .announcementSeverities), PresenceSettings.defaultSeverities)
    }

    private static func nonEmpty(_ list: [String]?, _ fallback: [String]) -> [String] {
        guard let values = list, !values.isEmpty else { return fallback }
        return values
    }
}

/// `POST /api/v2/personalizer/presence`: the presence as the server kept it.
public struct PresenceAnswer: Decodable, Sendable, Equatable {
    public let presence: PresenceSettings

    public init(presence: PresenceSettings) { self.presence = presence }
}

/// What the identity form holds. Empty pictures are left as they are.
public struct IdentityDraft: Sendable, Equatable {
    public var username: String
    /// An `https://` link to the new avatar; empty keeps it.
    public var avatarURL: String
    /// An `https://` link to the new banner; empty keeps it.
    public var bannerURL: String
    /// Back to the platform's default avatar instead of a link.
    public var resetAvatar: Bool

    public init(username: String = "", avatarURL: String = "", bannerURL: String = "", resetAvatar: Bool = false) {
        self.username = username
        self.avatarURL = avatarURL
        self.bannerURL = bannerURL
        self.resetAvatar = resetAvatar
    }
}

/// `POST /api/v2/personalizer/identity`: what changed and what the platform refused, in words.
public struct IdentityResult: Decodable, Sendable, Equatable {
    public let done: [String]
    public let failed: [String]

    public init(done: [String] = [], failed: [String] = []) {
        self.done = done
        self.failed = failed
    }

    private enum CodingKeys: String, CodingKey { case done, failed }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        done = (try? c.decodeIfPresent([String].self, forKey: .done)) ?? []
        failed = (try? c.decodeIfPresent([String].self, forKey: .failed)) ?? []
    }
}

/// What the announcement form holds.
public struct AnnouncementDraft: Sendable, Equatable {
    public var title: String
    public var body: String
    public var severity: String

    public init(title: String = "", body: String = "", severity: String = "info") {
        self.title = title
        self.body = body
        self.severity = severity
    }

    public init(_ announcement: Announcement) {
        self.init(title: announcement.title, body: announcement.body, severity: announcement.severity.rawValue)
    }
}

extension Endpoints {
    /// `GET /api/v2/personalizer`: the bot (operators only).
    public struct Personalizer: APIEndpoint {
        public typealias Response = BotIdentityAnswer
        public init() {}
        public var path: String { "/api/v2/personalizer" }
    }

    /// `GET /api/v2/personalizer/presence`: the presence, the choices and the announcement severities.
    public struct PersonalizerPresence: APIEndpoint {
        public typealias Response = PresenceOptions
        public init() {}
        public var path: String { "/api/v2/personalizer/presence" }
    }

    /// `POST /api/v2/personalizer/identity` with `{username, avatarUrl, bannerUrl, resetAvatar}`: the
    /// same four keys the dashboard sends, trimmed. The server changes what is new and answers with
    /// `{done, failed}`.
    public struct SavePersonalizerIdentity: APIEndpoint {
        public typealias Response = IdentityResult
        public let change: IdentityDraft
        public init(change: IdentityDraft) { self.change = change }
        public var path: String { "/api/v2/personalizer/identity" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            Body(
                username: change.username.trimmingCharacters(in: .whitespacesAndNewlines),
                avatarUrl: change.avatarURL.trimmingCharacters(in: .whitespacesAndNewlines),
                bannerUrl: change.bannerURL.trimmingCharacters(in: .whitespacesAndNewlines),
                resetAvatar: change.resetAvatar)
        }

        private struct Body: Encodable, Sendable {
            let username: String
            let avatarUrl: String
            let bannerUrl: String
            let resetAvatar: Bool
        }
    }

    /// `POST /api/v2/personalizer/presence` with `{status, type, text}`.
    public struct SavePersonalizerPresence: APIEndpoint {
        public typealias Response = PresenceAnswer
        public let presence: PresenceSettings
        public init(presence: PresenceSettings) { self.presence = presence }
        public var path: String { "/api/v2/personalizer/presence" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { presence }
    }

    /// `POST /api/v2/personalizer/announcement` with `{title, body, severity}`: publishes the
    /// announcement everyone signed in sees. A blank title clears it on the server.
    public struct SavePersonalizerAnnouncement: APIEndpoint {
        public typealias Response = AnnouncementAnswer
        public let draft: AnnouncementDraft
        public init(draft: AnnouncementDraft) { self.draft = draft }
        public var path: String { "/api/v2/personalizer/announcement" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            Body(title: draft.title, body: draft.body, severity: draft.severity)
        }

        private struct Body: Encodable, Sendable {
            let title: String
            let body: String
            let severity: String
        }
    }

    /// `POST /api/v2/personalizer/announcement/clear`: takes the announcement down for everyone.
    public struct ClearPersonalizerAnnouncement: APIEndpoint {
        public typealias Response = AnnouncementAnswer
        public init() {}
        public var path: String { "/api/v2/personalizer/announcement/clear" }
        public var method: HTTPMethod { .post }
    }
}

/// The Bot Personalizer screen's state: the identity, presence and announcement forms, each saved on
/// its own, with what was last saved kept so the screen can say "Unsaved changes".
@MainActor
@Observable
public final class PersonalizerModel {
    public static let usernameLimit = 32
    public static let presenceTextLimit = 128
    public static let announcementTitleLimit = 200
    public static let announcementBodyLimit = 2000

    public private(set) var bot: BotIdentity?
    public private(set) var statuses = PresenceSettings.defaultStatuses
    public private(set) var types = PresenceSettings.defaultTypes
    public private(set) var severities = PresenceSettings.defaultSeverities
    /// The announcement everyone sees right now, nil when there is none.
    public private(set) var liveAnnouncement: Announcement?

    public var identity = IdentityDraft()
    public var presence = PresenceSettings()
    public var announcement = AnnouncementDraft()

    public private(set) var isLoading = false
    public private(set) var hasLoaded = false
    public private(set) var isSaving = false
    /// The server said this account is not an operator (403): nothing is shown.
    public private(set) var isRefused = false
    /// Why the screen could not load.
    public var errorMessage: String?
    /// Why the last save did not go through.
    public var actionError: String?
    /// What the last save did ("Updated username."), shown until the next one.
    public var notice: String?

    private var savedIdentity = IdentityDraft()
    private var savedPresence = PresenceSettings()
    private var savedAnnouncement = AnnouncementDraft()
    private let session: AppSession

    public init(session: AppSession) {
        self.session = session
    }

    public var isIdentityDirty: Bool { identity != savedIdentity }
    public var isPresenceDirty: Bool { presence != savedPresence }
    public var isAnnouncementDirty: Bool { announcement != savedAnnouncement }

    /// Whether any of the three forms holds edits that were not saved. Reading the screen again would
    /// overwrite them, so the screen asks first.
    public var hasUnsavedChanges: Bool { isIdentityDirty || isPresenceDirty || isAnnouncementDirty }

    /// Whether Publish can run: the dashboard lets a blank title clear the announcement, the app asks for
    /// the Clear button (with its confirmation) instead.
    public var canPublish: Bool {
        !announcement.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Reads the bot, the presence and the live announcement, and fills the three forms.
    public func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        let generation = session.generation
        do {
            async let identityCall = session.send(Endpoints.Personalizer())
            async let presenceCall = session.send(Endpoints.PersonalizerPresence())
            async let announcementCall = session.send(Endpoints.CurrentAnnouncement())
            let (identityAnswer, options, current) = try await (identityCall, presenceCall, announcementCall)
            // Another account signed in while this was on its way: its answer is not for this screen.
            guard session.generation == generation else { return }
            bot = identityAnswer.bot
            statuses = options.statuses
            types = options.types
            severities = options.announcementSeverities
            liveAnnouncement = current.announcement

            identity = IdentityDraft(username: identityAnswer.bot?.username ?? "")
            savedIdentity = identity
            presence = options.presence
            savedPresence = options.presence
            announcement = current.announcement.map { AnnouncementDraft($0) } ?? AnnouncementDraft()
            savedAnnouncement = announcement
            hasLoaded = true
            isRefused = false
            errorMessage = nil
        } catch {
            guard session.generation == generation else { return }
            if let text = describe(error) { errorMessage = text }
        }
    }

    /// Saves the username and pictures. The server changes what is new and says what it could not
    /// (a name can change only about twice an hour); the form counts as saved only when nothing failed.
    public func saveIdentity() async {
        guard begin() else { return }
        defer { isSaving = false }
        let sent = identity
        let generation = session.generation
        do {
            let result = try await session.send(Endpoints.SavePersonalizerIdentity(change: sent))
            guard session.generation == generation else { return }
            if !result.done.isEmpty { notice = "Updated \(result.done.joined(separator: ", "))." }
            if !result.failed.isEmpty { actionError = "Failed: \(result.failed.joined(separator: "; "))." }
            if result.done.isEmpty, result.failed.isEmpty { notice = "Nothing to change." }
            if result.failed.isEmpty { savedIdentity = sent }
            if !result.done.isEmpty, let fresh = try? await session.send(Endpoints.Personalizer()),
                session.generation == generation
            {
                bot = fresh.bot
            }
        } catch {
            guard session.generation == generation else { return }
            actionError = describe(error)
        }
    }

    public func savePresence() async {
        guard begin() else { return }
        defer { isSaving = false }
        let generation = session.generation
        do {
            let result = try await session.send(Endpoints.SavePersonalizerPresence(presence: presence))
            guard session.generation == generation else { return }
            presence = result.presence
            savedPresence = result.presence
            notice = "Presence updated."
        } catch {
            guard session.generation == generation else { return }
            actionError = describe(error)
        }
    }

    /// Publishes the announcement for everyone signed in. Needs a title.
    public func publishAnnouncement() async {
        guard begin() else { return }
        defer { isSaving = false }
        guard canPublish else {
            actionError = "Add a title to publish. To take the announcement down, use Clear Announcement."
            return
        }
        let sent = announcement
        let generation = session.generation
        do {
            let result = try await session.send(Endpoints.SavePersonalizerAnnouncement(draft: sent))
            guard session.generation == generation else { return }
            liveAnnouncement = result.announcement
            savedAnnouncement = sent
            notice = result.announcement == nil ? "Announcement cleared." : "Announcement published."
        } catch {
            guard session.generation == generation else { return }
            actionError = describe(error)
        }
    }

    /// Takes the live announcement down for everyone. `typed` is what the person typed to confirm
    /// (``OperatorConfirmation/clearAnnouncement``); nothing is sent without it.
    public func clearAnnouncement(typed: String) async {
        guard OperatorConfirmation.clearAnnouncement.accepts(typed) else {
            actionError = "Type \(OperatorConfirmation.clearAnnouncement.word) to clear the announcement."
            return
        }
        guard begin() else { return }
        defer { isSaving = false }
        let generation = session.generation
        do {
            _ = try await session.send(Endpoints.ClearPersonalizerAnnouncement())
            guard session.generation == generation else { return }
            liveAnnouncement = nil
            announcement = AnnouncementDraft()
            savedAnnouncement = announcement
            notice = "Announcement cleared."
        } catch {
            guard session.generation == generation else { return }
            actionError = describe(error)
        }
    }

    private func begin() -> Bool {
        guard !isSaving, !isRefused else { return false }
        isSaving = true
        actionError = nil
        notice = nil
        return true
    }

    /// The words for a failure, nil when nothing should be said (cancelled, or signed out).
    private func describe(_ error: any Error) -> String? {
        let error = NetworkError(error)
        if error == .cancelled || error == .unauthorized { return nil }
        if OperatorOnly.isRefusal(error) {
            isRefused = true
            return OperatorOnly.refusal
        }
        return error.userMessage
    }
}
