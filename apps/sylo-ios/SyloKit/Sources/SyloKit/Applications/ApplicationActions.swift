import Foundation
import Observation

// What staff do with applications beyond reading and deciding them (src/web/routes/v2Applications.js):
// save, delete and reorder forms, publish or remove the panel message, retry the roles of an
// application, delete an application, and read what one member has sent in. Every one of these is
// staff only on the server, because answers are personal data.

// MARK: - Panel

/// The answer to publishing or removing the panel: the module's settings as the server stored them
/// (with the panel's channel and message ids), and a warning when something around it went wrong.
public struct ApplicationsPanelResult: Decodable, Sendable, Equatable {
    public let settings: ApplicationsSettings
    /// Set when the panel is out but something is off (for example Sylo could not pin it).
    public let warning: String?

    public init(settings: ApplicationsSettings, warning: String? = nil) {
        self.settings = settings
        self.warning = warning
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case warning
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let warning = try c.decodeIfPresent(String.self, forKey: .warning)
        self.init(
            settings: try c.decode(forKey: .settings, or: ApplicationsSettings()),
            warning: warning?.isEmpty == false ? warning : nil)
    }
}

/// What a retry of the waiting role changes did.
public struct ApplicationRoleRetry: Decodable, Sendable, Equatable {
    /// How many role changes went through this time.
    public let applied: Int
    /// How many still did not.
    public let remaining: Int
    /// The application as it is now.
    public let submission: ApplicationSubmission?

    public init(applied: Int = 0, remaining: Int = 0, submission: ApplicationSubmission? = nil) {
        self.applied = applied
        self.remaining = remaining
        self.submission = submission
    }

    private enum CodingKeys: String, CodingKey { case applied, remaining, submission }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            applied: try c.decode(forKey: .applied, or: 0),
            remaining: try c.decode(forKey: .remaining, or: 0),
            submission: try? c.decodeIfPresent(ApplicationSubmission.self, forKey: .submission))
    }
}

/// `GET /applications/members/:userId`: everything one member has sent in, newest first (without
/// the answers; each application has them in its detail).
public struct ApplicantHistory: Decodable, Sendable, Equatable {
    public let userId: String
    /// nil when Sylo cannot name the member (they left, or are not cached).
    public let userName: String?
    public let submissions: [ApplicationSubmission]

    public init(userId: String, userName: String? = nil, submissions: [ApplicationSubmission] = []) {
        self.userId = userId
        self.userName = userName
        self.submissions = submissions
    }

    private enum CodingKeys: String, CodingKey { case userId, userName, submissions }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            userId: try c.decode(forKey: .userId, or: ""),
            userName: try c.decodeIfPresent(String.self, forKey: .userName),
            submissions: try c.decodeLossyArray(of: ApplicationSubmission.self, forKey: .submissions))
    }

    public var displayName: String { userName ?? userId }
}

// MARK: - Endpoints

/// A body of `{}`, for staff actions that send nothing (the web dashboard sends one too).
struct EmptyBody: Encodable, Sendable {}

extension Endpoints {
    /// `POST /api/v2/guilds/:id/applications/forms` (a new form) or `…/forms/:id` (an existing one)
    /// with the whole form as the body. 400 with the server's reason when the form cannot be saved
    /// (no name, a required question with no options, an open form that is not ready, too many forms).
    public struct SaveApplicationForm: APIEndpoint {
        public typealias Response = ApplicationFormSaved
        public let server: ServerID
        public let form: ApplicationForm

        public init(server: ServerID, form: ApplicationForm) {
            self.server = server
            self.form = form
        }

        public var path: String {
            let base = "/api/v2/guilds/\(server.pathComponent)/applications/forms"
            guard let id = form.id else { return base }
            return "\(base)/\(id)"
        }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { form }
    }

    /// `POST /api/v2/guilds/:id/applications/forms/:form/delete`. Applications already received stay.
    public struct DeleteApplicationForm: APIEndpoint {
        public typealias Response = EmptyResponse
        public let server: ServerID
        public let id: Int

        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/applications/forms/\(id)/delete" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST /api/v2/guilds/:id/applications/forms/reorder` with the form ids in their new order.
    public struct ReorderApplicationForms: APIEndpoint {
        public typealias Response = ApplicationFormList
        public let server: ServerID
        public let ids: [Int]

        public init(server: ServerID, ids: [Int]) {
            self.server = server
            self.ids = ids
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/applications/forms/reorder" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(ids: ids) }

        private struct Body: Encodable, Sendable { let ids: [Int] }
    }

    /// `POST /api/v2/guilds/:id/applications/panel/publish`: posts the panel message with its Apply
    /// buttons in a channel (publishing again sends a new one and deletes the old). 400 with the
    /// server's reason when there is no channel or Sylo lacks a permission there.
    public struct PublishApplicationsPanel: APIEndpoint {
        public typealias Response = ApplicationsPanelResult
        public let server: ServerID
        public let channelId: String
        /// "" for the server's own text.
        public let text: String

        public init(server: ServerID, channelId: String, text: String) {
            self.server = server
            self.channelId = channelId
            self.text = text
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/applications/panel/publish" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(channelId: channelId, text: text) }

        private struct Body: Encodable, Sendable {
            let channelId: String
            let text: String
        }
    }

    /// `POST /api/v2/guilds/:id/applications/panel/unpublish`: deletes the panel message. 502 when Sylo
    /// may not delete it (the stored message stays so it can be tried again).
    public struct UnpublishApplicationsPanel: APIEndpoint {
        public typealias Response = ApplicationsPanelResult
        public let server: ServerID

        public init(server: ServerID) { self.server = server }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/applications/panel/unpublish" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST /api/v2/guilds/:id/applications/submissions/:submission/retry-roles`: tries the role
    /// changes that failed earlier again.
    public struct RetryApplicationRoles: APIEndpoint {
        public typealias Response = ApplicationRoleRetry
        public let server: ServerID
        public let id: Int

        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/applications/submissions/\(id)/retry-roles" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST /api/v2/guilds/:id/applications/submissions/:submission/delete`: deletes the answers and
    /// the posts. 502 when a post could not be deleted (the answers are erased and the row is kept).
    public struct DeleteApplicationSubmission: APIEndpoint {
        public typealias Response = EmptyResponse
        public let server: ServerID
        public let id: Int

        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/applications/submissions/\(id)/delete" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `GET /api/v2/guilds/:id/applications/members/:userId`: a member's applications, newest first.
    public struct ApplicantHistoryOf: APIEndpoint {
        public typealias Response = ApplicantHistory
        public let server: ServerID
        public let userID: String

        public init(server: ServerID, userID: String) {
            self.server = server
            self.userID = userID
        }

        public var path: String {
            "/api/v2/guilds/\(server.pathComponent)/applications/members/\(userID.encodedPathSegment)"
        }
    }
}

// MARK: - Models

/// Publishing and removing the panel message of Applications.
@MainActor
@Observable
public final class ApplicationsPanelModel {
    public let server: ServerID
    public private(set) var isBusy = false
    /// Why the last publish or removal did not go through.
    public var errorMessage: String?
    /// What the server flagged about a publish that did go through.
    public private(set) var notice: String?
    /// Goes up with every success, for a haptic.
    public private(set) var successCount = 0

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Posts the panel in `channelId` with `text` ("" for the server's own).
    /// - Returns: The settings as the server stored them, nil on failure (see ``errorMessage``).
    @discardableResult
    public func publish(channelId: String, text: String) async -> ApplicationsSettings? {
        guard !isBusy else { return nil }
        guard !channelId.isEmpty else {
            errorMessage = "Pick the channel for the panel first."
            return nil
        }
        return await run(Endpoints.PublishApplicationsPanel(server: server, channelId: channelId, text: text))
    }

    /// Deletes the panel message.
    @discardableResult
    public func unpublish() async -> ApplicationsSettings? {
        guard !isBusy else { return nil }
        return await run(Endpoints.UnpublishApplicationsPanel(server: server))
    }

    private func run<E: APIEndpoint>(_ endpoint: E) async -> ApplicationsSettings?
    where E.Response == ApplicationsPanelResult {
        isBusy = true
        defer { isBusy = false }
        errorMessage = nil
        notice = nil
        do {
            let result = try await session.send(endpoint)
            notice = result.warning
            successCount += 1
            return result.settings
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized {
                errorMessage = EditorFailure.message(
                    for: error,
                    serverFailure: "Sylo could not delete the panel message. It needs Manage Messages in that channel.")
            }
            return nil
        }
    }
}

/// One member's applications.
@MainActor
@Observable
public final class ApplicantHistoryModel {
    public let server: ServerID
    public let userID: String
    public private(set) var history: ApplicantHistory?
    public private(set) var isLoading = false
    public var errorMessage: String?

    private let session: AppSession

    public init(server: ServerID, userID: String, session: AppSession) {
        self.server = server
        self.userID = userID
        self.session = session
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            history = try await session.send(Endpoints.ApplicantHistoryOf(server: server, userID: userID))
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }
}
