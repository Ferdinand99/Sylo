import Foundation
import Observation

// Application submissions (src/web/routes/v2Applications.js: `/applications/submissions`,
// `/applications/submissions/:id` and `/applications/submissions/:id/decide`). Staff read what
// members sent in and accept or deny with an optional reason, the same calls the dashboard makes.
// Retrying roles, deleting a submission and a member's history are in ApplicationActions.swift. Every
// one of these calls is staff only on the server, because answers are personal.

/// Where an application stands.
public enum ApplicationStatus: Hashable, Sendable, RawRepresentable {
    case pending
    case accepted
    case denied
    /// The applicant took it back.
    case withdrawn
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "pending": self = .pending
        case "accepted": self = .accepted
        case "denied": self = .denied
        case "withdrawn": self = .withdrawn
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .pending: "pending"
        case .accepted: "accepted"
        case .denied: "denied"
        case .withdrawn: "withdrawn"
        case .other(let raw): raw
        }
    }

    /// The statuses the list can be filtered by.
    public static let filters: [ApplicationStatus] = [.pending, .accepted, .denied, .withdrawn]
}

extension ApplicationStatus: Decodable {
    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }
}

/// A role change the form still has to make for an applicant (it failed earlier).
public struct ApplicationRoleChange: Decodable, Sendable, Hashable {
    /// `add` or `remove`.
    public let op: String
    public let roleName: String?

    public init(op: String, roleName: String? = nil) {
        self.op = op
        self.roleName = roleName
    }

    private enum CodingKeys: String, CodingKey { case op, roleName }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            op: try c.decode(forKey: .op, or: ""),
            roleName: try c.decodeIfPresent(String.self, forKey: .roleName))
    }
}

/// One answer, already worded by the server (a choice as its label, yes/no as Yes/No).
public struct ApplicationAnswer: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let label: String
    /// `text`, `choice`, `role` or `yesno`.
    public let type: String
    public let required: Bool
    /// "" for an optional question left empty.
    public let answer: String

    public init(id: String, label: String, type: String = "text", required: Bool = false, answer: String = "") {
        self.id = id
        self.label = label
        self.type = type
        self.required = required
        self.answer = answer
    }

    private enum CodingKeys: String, CodingKey { case id, label, type, required, answer }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(String.self, forKey: .id),
            label: try c.decode(forKey: .label, or: ""),
            type: try c.decode(forKey: .type, or: "text"),
            required: try c.decode(forKey: .required, or: false),
            answer: try c.decodeIfPresent(String.self, forKey: .answer) ?? "")
    }
}

/// One step in an application's history (`submitted`, `accepted`, `denied`, `roles_failed` …).
public struct ApplicationHistoryEntry: Decodable, Sendable, Hashable {
    /// When, in milliseconds since 1970.
    public let at: Double?
    /// Who did it; nil for Sylo itself or the applicant.
    public let byName: String?
    public let action: String
    public let note: String

    public init(at: Double? = nil, byName: String? = nil, action: String, note: String = "") {
        self.at = at
        self.byName = byName
        self.action = action
        self.note = note
    }

    private enum CodingKeys: String, CodingKey { case at, byName, action, note }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            at: try c.decodeIfPresent(Double.self, forKey: .at),
            byName: try c.decodeIfPresent(String.self, forKey: .byName),
            action: try c.decode(forKey: .action, or: ""),
            note: try c.decodeIfPresent(String.self, forKey: .note) ?? "")
    }

    public var date: Date? { at.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

/// One application. The list has everything but ``answers`` and ``history``, which only the
/// detail (and the answer to a decision) carries.
public struct ApplicationSubmission: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    public let formId: Int
    public let formName: String
    public let userId: String
    /// nil when Sylo cannot name the applicant (they left, or are not cached).
    public let userName: String?
    public let status: ApplicationStatus
    /// `dm` or `web`: where the applicant filled it in.
    public let source: String
    /// When it came in, in milliseconds since 1970.
    public let createdAt: Double?
    public let decidedAt: Double?
    public let decidedByName: String?
    /// The reason staff gave; "" when none.
    public let reason: String
    /// Set when the decision could not be DMed to the applicant.
    public let dmNote: String
    /// The answers were cleared (the member used /forget).
    public let cleared: Bool
    /// Role changes that failed and wait to be retried.
    public let rolesPending: [ApplicationRoleChange]
    public let answers: [ApplicationAnswer]
    public let history: [ApplicationHistoryEntry]

    /// The applicant's name, or their id.
    public var applicantName: String { userName ?? userId }
    public var createdDate: Date? { createdAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
    public var decidedDate: Date? { decidedAt.map { Date(timeIntervalSince1970: $0 / 1000) } }

    public init(id: Int, formId: Int = 0, formName: String = "", userId: String = "", userName: String? = nil,
                status: ApplicationStatus = .pending, source: String = "dm", createdAt: Double? = nil,
                decidedAt: Double? = nil, decidedByName: String? = nil, reason: String = "", dmNote: String = "",
                cleared: Bool = false, rolesPending: [ApplicationRoleChange] = [],
                answers: [ApplicationAnswer] = [], history: [ApplicationHistoryEntry] = []) {
        self.id = id
        self.formId = formId
        self.formName = formName
        self.userId = userId
        self.userName = userName
        self.status = status
        self.source = source
        self.createdAt = createdAt
        self.decidedAt = decidedAt
        self.decidedByName = decidedByName
        self.reason = reason
        self.dmNote = dmNote
        self.cleared = cleared
        self.rolesPending = rolesPending
        self.answers = answers
        self.history = history
    }

    private enum CodingKeys: String, CodingKey {
        case id, formId, formName, userId, userName, status, source, createdAt, decidedAt, decidedByName
        case reason, dmNote, cleared, rolesPending, answers, history
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            formId: try c.decode(forKey: .formId, or: 0),
            formName: try c.decode(forKey: .formName, or: ""),
            userId: try c.decode(forKey: .userId, or: ""),
            userName: try c.decodeIfPresent(String.self, forKey: .userName),
            status: try c.decode(forKey: .status, or: .pending),
            source: try c.decode(forKey: .source, or: "dm"),
            createdAt: try c.decodeIfPresent(Double.self, forKey: .createdAt),
            decidedAt: try c.decodeIfPresent(Double.self, forKey: .decidedAt),
            decidedByName: try c.decodeIfPresent(String.self, forKey: .decidedByName),
            reason: try c.decodeIfPresent(String.self, forKey: .reason) ?? "",
            dmNote: try c.decodeIfPresent(String.self, forKey: .dmNote) ?? "",
            cleared: try c.decode(forKey: .cleared, or: false),
            rolesPending: try c.decodeLossyArray(of: ApplicationRoleChange.self, forKey: .rolesPending),
            answers: try c.decodeLossyArray(of: ApplicationAnswer.self, forKey: .answers),
            history: try c.decodeLossyArray(of: ApplicationHistoryEntry.self, forKey: .history))
    }
}

/// `GET /applications/submissions`: a page of the list, newest first.
public struct ApplicationSubmissionList: Decodable, Sendable, Equatable {
    public let submissions: [ApplicationSubmission]
    /// How many applications match the filter in all.
    public let total: Int
    public let page: Int
    public let pageSize: Int

    public init(submissions: [ApplicationSubmission] = [], total: Int? = nil, page: Int = 1, pageSize: Int = 25) {
        self.submissions = submissions
        self.total = total ?? submissions.count
        self.page = page
        self.pageSize = pageSize
    }

    private enum CodingKeys: String, CodingKey { case submissions, total, page, pageSize }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let submissions = try c.decodeLossyArray(of: ApplicationSubmission.self, forKey: .submissions)
        self.init(
            submissions: submissions,
            total: try c.decodeIfPresent(Int.self, forKey: .total),
            page: try c.decode(forKey: .page, or: 1),
            pageSize: try c.decode(forKey: .pageSize, or: 25))
    }
}

/// `GET /applications/submissions/:id`: one application with its answers and history.
public struct ApplicationSubmissionDetail: Decodable, Sendable, Equatable {
    public let submission: ApplicationSubmission
}

/// What a decision does to the application.
public enum ApplicationDecisionAction: String, Sendable, CaseIterable {
    case accept
    case deny

    /// The status the application ends in.
    public var resultingStatus: ApplicationStatus { self == .accept ? .accepted : .denied }
}

/// The answer to a decision: the application as it is now, and what did not go through.
public struct ApplicationDecision: Decodable, Sendable, Equatable {
    public let submission: ApplicationSubmission
    /// Things that went wrong around the decision (roles that could not be changed, a post that
    /// could not be moved). The decision itself stands.
    public let warnings: [String]
    /// Whether the applicant was told by DM.
    public let dm: Bool

    public init(submission: ApplicationSubmission, warnings: [String] = [], dm: Bool = true) {
        self.submission = submission
        self.warnings = warnings
        self.dm = dm
    }

    private enum CodingKeys: String, CodingKey { case submission, warnings, dm }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            submission: try c.decode(ApplicationSubmission.self, forKey: .submission),
            warnings: try c.decode(forKey: .warnings, or: []),
            dm: try c.decode(forKey: .dm, or: true))
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/applications/submissions`: newest first, 25 to a page; `status`
    /// narrows it to one status and `formId` to one form.
    public struct ApplicationSubmissions: APIEndpoint {
        public typealias Response = ApplicationSubmissionList
        public let server: ServerID
        public let status: ApplicationStatus?
        public let formID: Int?
        public let page: Int

        public init(server: ServerID, status: ApplicationStatus? = nil, formID: Int? = nil, page: Int = 1) {
            self.server = server
            self.status = status
            self.formID = formID
            self.page = page
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/applications/submissions" }
        public var query: [URLQueryItem] {
            var items: [URLQueryItem] = []
            if let status { items.append(URLQueryItem(name: "status", value: status.rawValue)) }
            if let formID { items.append(URLQueryItem(name: "formId", value: String(formID))) }
            if page > 1 { items.append(URLQueryItem(name: "page", value: String(page))) }
            return items
        }
    }

    /// `GET /api/v2/guilds/:id/applications/submissions/:submission`.
    public struct ApplicationSubmissionByID: APIEndpoint {
        public typealias Response = ApplicationSubmissionDetail
        public let server: ServerID
        public let id: Int

        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/applications/submissions/\(id)" }
    }

    /// `POST /api/v2/guilds/:id/applications/submissions/:submission/decide`: accepts or denies a
    /// pending application, with a reason that goes into the DM to the applicant. 404 when it is
    /// gone, 409 when it was already decided.
    public struct DecideApplication: APIEndpoint {
        public typealias Response = ApplicationDecision
        public let server: ServerID
        public let id: Int
        public let action: ApplicationDecisionAction
        /// Empty for none; the server keeps at most 500 characters.
        public let reason: String

        public init(server: ServerID, id: Int, action: ApplicationDecisionAction, reason: String = "") {
            self.server = server
            self.id = id
            self.action = action
            self.reason = reason
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/applications/submissions/\(id)/decide" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(action: action.rawValue, reason: reason) }

        private struct Body: Encodable, Sendable {
            let action: String
            let reason: String
        }
    }
}

/// The application inbox: a page at a time, filtered by status.
@MainActor
@Observable
public final class ApplicationSubmissionsModel {
    public let server: ServerID
    /// Which status the list shows; nil for all.
    public var filter: ApplicationStatus? = .pending
    /// Which form the list shows; nil for all.
    public var formFilter: Int?
    public private(set) var submissions: [ApplicationSubmission] = []
    /// How many applications match the filter in all.
    public private(set) var total = 0
    public private(set) var isLoading = false
    public private(set) var hasLoaded = false
    /// Why the list could not be loaded (the last list, if any, stays).
    public var errorMessage: String?

    private var page = 0
    private var loadedFilter: ApplicationStatus?
    private var loadedForm: Int?
    /// Goes up with every new list, so a slow answer for an old filter is dropped.
    private var generation = 0
    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public var canLoadMore: Bool { submissions.count < total }

    /// Loads the first page for the current filter.
    public func load() async {
        generation += 1
        let mine = generation
        isLoading = true
        defer { if mine == generation { isLoading = false } }
        let asked = filter
        let askedForm = formFilter
        do {
            let list = try await session.send(
                Endpoints.ApplicationSubmissions(server: server, status: asked, formID: askedForm))
            guard mine == generation else { return }
            loadedFilter = asked
            loadedForm = askedForm
            submissions = list.submissions
            total = list.total
            page = list.page
            hasLoaded = true
            errorMessage = nil
        } catch {
            guard mine == generation else { return }
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    /// Adds the next page.
    public func loadMore() async {
        guard canLoadMore, !isLoading else { return }
        let mine = generation
        isLoading = true
        defer { if mine == generation { isLoading = false } }
        do {
            let list = try await session.send(
                Endpoints.ApplicationSubmissions(
                    server: server, status: loadedFilter, formID: loadedForm, page: page + 1))
            guard mine == generation else { return }
            var seen = Set(submissions.map(\.id))
            submissions += list.submissions.filter { seen.insert($0.id).inserted }
            total = list.total
            page = list.page
            errorMessage = nil
        } catch {
            guard mine == generation else { return }
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }
}

/// One application: its answers and history, and accepting or denying it.
@MainActor
@Observable
public final class ApplicationSubmissionModel {
    /// The longest reason the server keeps, in characters (it cuts the rest).
    public static let maxReasonLength = 500

    public let server: ServerID
    public let submissionID: Int
    public private(set) var submission: ApplicationSubmission?
    public private(set) var isLoading = false
    public private(set) var isDeciding = false
    /// Whether a retry of the roles or a delete is on its way.
    public private(set) var isWorking = false
    /// Whether the application was deleted here; the screen closes.
    public private(set) var wasDeleted = false
    /// Why the application could not be loaded.
    public var errorMessage: String?
    /// Why a decision did not go through.
    public var actionError: String?
    /// What the last decision left undone, in the server's words (roles, a post, the DM).
    public private(set) var decisionNotes: [String] = []
    /// Goes up with every decision that went through, for a haptic.
    public private(set) var decisionCount = 0

    private let session: AppSession

    public init(server: ServerID, submissionID: Int, session: AppSession) {
        self.server = server
        self.submissionID = submissionID
        self.session = session
    }

    /// Only a pending application can be decided.
    public var canDecide: Bool { submission?.status == .pending && !isDeciding && !isWorking }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            submission = try await session.send(Endpoints.ApplicationSubmissionByID(server: server, id: submissionID))
                .submission
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    /// Accepts or denies the application. The reason is trimmed; empty sends none.
    /// - Returns: Whether the decision went through. On failure ``actionError`` says why.
    @discardableResult
    public func decide(_ action: ApplicationDecisionAction, reason: String) async -> Bool {
        guard canDecide else { return false }
        isDeciding = true
        defer { isDeciding = false }
        actionError = nil
        let reason = String(reason.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maxReasonLength))
        do {
            let result = try await session.send(
                Endpoints.DecideApplication(server: server, id: submissionID, action: action, reason: reason))
            submission = result.submission
            var notes = result.warnings
            if !result.dm {
                notes.append("The applicant could not be told by DM. They may have DMs turned off or have left the server.")
            }
            decisionNotes = notes
            decisionCount += 1
            return true
        } catch {
            let error = NetworkError(error)
            if error == .http(status: 409) {
                actionError = "Someone already decided this application. Refresh to see how."
                await load()
            } else if error != .cancelled, error != .unauthorized {
                actionError = error.userMessage
            }
            return false
        }
    }

    /// Tries the role changes that failed earlier again. What is left over stays in
    /// ``ApplicationSubmission/rolesPending`` and is noted in ``decisionNotes``.
    /// - Returns: Whether the call went through.
    @discardableResult
    public func retryRoles() async -> Bool {
        guard submission != nil, !isWorking, !isDeciding else { return false }
        isWorking = true
        defer { isWorking = false }
        actionError = nil
        do {
            let result = try await session.send(Endpoints.RetryApplicationRoles(server: server, id: submissionID))
            if let fresh = result.submission {
                submission = fresh
            } else {
                await load()
            }
            if result.remaining == 1 {
                decisionNotes = ["1 role change still did not go through. Check that Sylo can manage the role."]
            } else if result.remaining > 1 {
                decisionNotes = [
                    "\(result.remaining) role changes still did not go through. Check that Sylo can manage the roles.",
                ]
            } else {
                decisionNotes = []
            }
            decisionCount += 1
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { actionError = EditorFailure.message(for: error) }
            return false
        }
    }

    /// Deletes the application with its answers and its posts. This cannot be undone.
    /// - Returns: Whether it is gone. When a post could not be deleted the server erases the answers
    ///   and keeps the row; the failure says so and the screen is reloaded.
    @discardableResult
    public func deleteSubmission() async -> Bool {
        guard submission != nil, !isWorking, !isDeciding else { return false }
        isWorking = true
        defer { isWorking = false }
        actionError = nil
        do {
            _ = try await session.send(Endpoints.DeleteApplicationSubmission(server: server, id: submissionID))
            wasDeleted = true
            return true
        } catch {
            let error = NetworkError(error)
            if error == .notFound {
                // Already gone (deleted elsewhere): the screen closes.
                wasDeleted = true
                return true
            }
            if error != .cancelled, error != .unauthorized {
                actionError = EditorFailure.message(
                    for: error,
                    serverFailure: "A post could not be deleted, so the answers were erased and the application was kept.")
                await load()
            }
            return false
        }
    }
}
