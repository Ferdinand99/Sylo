import Foundation
import Observation

// Ban appeals review (src/web/routes/v2Staff.js: `GET /appeals` and `POST /appeals/:id/decide`).
// Staff read what a banned member wrote and accept (which unbans them) or deny, with a note the
// member sees. The appeal form's own settings are the Ban Appeals module screen.

/// Where an appeal stands.
public enum AppealStatus: Hashable, Sendable, RawRepresentable {
    case open
    case accepted
    case denied
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "open": self = .open
        case "accepted": self = .accepted
        case "denied": self = .denied
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .open: "open"
        case .accepted: "accepted"
        case .denied: "denied"
        case .other(let raw): raw
        }
    }
}

extension AppealStatus: Decodable {
    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }
}

/// One question of the appeal form and what the member answered.
public struct AppealAnswer: Decodable, Sendable, Hashable {
    public let question: String
    /// "" when left empty.
    public let answer: String

    public init(question: String, answer: String = "") {
        self.question = question
        self.answer = answer
    }

    private enum CodingKeys: String, CodingKey { case q, a }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            question: try c.decodeIfPresent(String.self, forKey: .q) ?? "",
            answer: try c.decodeIfPresent(String.self, forKey: .a) ?? "")
    }
}

/// One ban appeal.
public struct Appeal: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    /// The member's tag, or their id when Sylo has none.
    public let user: String
    public let userId: String
    /// "" when none was recorded (the server sends a dash, dropped here).
    public let banReason: String
    public let answers: [AppealAnswer]
    public let status: AppealStatus
    /// Who decided; nil while open.
    public let decidedBy: String?
    /// The note the member got; "" when none.
    public let decisionReason: String
    /// When it came in, in milliseconds since 1970.
    public let at: Double?
    public let decidedAt: Double?

    public var date: Date? { at.map { Date(timeIntervalSince1970: $0 / 1000) } }
    public var decidedDate: Date? { decidedAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
    public var isOpen: Bool { status == .open }

    public init(
        id: Int, user: String = "", userId: String = "", banReason: String = "", answers: [AppealAnswer] = [],
        status: AppealStatus = .open, decidedBy: String? = nil, decisionReason: String = "", at: Double? = nil,
        decidedAt: Double? = nil
    ) {
        self.id = id
        self.user = user
        self.userId = userId
        self.banReason = banReason
        self.answers = answers
        self.status = status
        self.decidedBy = decidedBy
        self.decisionReason = decisionReason
        self.at = at
        self.decidedAt = decidedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, user, userId, banReason, answers, status, decidedBy, decisionReason, at, decidedAt
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let ban = try c.decodeIfPresent(String.self, forKey: .banReason) ?? ""
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            user: try c.decodeIfPresent(String.self, forKey: .user) ?? "",
            userId: try c.decodeIfPresent(String.self, forKey: .userId) ?? "",
            banReason: ban == "\u{2014}" ? "" : ban,
            answers: try c.decodeLossyArray(of: AppealAnswer.self, forKey: .answers),
            status: try c.decode(forKey: .status, or: .open),
            decidedBy: try c.decodeIfPresent(String.self, forKey: .decidedBy),
            decisionReason: try c.decodeIfPresent(String.self, forKey: .decisionReason) ?? "",
            at: try c.decodeIfPresent(Double.self, forKey: .at),
            decidedAt: try c.decodeIfPresent(Double.self, forKey: .decidedAt))
    }

    /// The member's tag, or their id.
    public var memberName: String { user.isEmpty ? userId : user }
}

/// `GET /appeals`: the newest 100 appeals and how the module stands.
public struct AppealsReview: Decodable, Sendable, Equatable {
    public let appeals: [Appeal]
    /// How many are open.
    public let open: Int
    public let moduleEnabled: Bool
    /// Whether the appeal form has questions; without them members cannot appeal.
    public let configured: Bool

    public init(appeals: [Appeal] = [], open: Int? = nil, moduleEnabled: Bool = true, configured: Bool = true) {
        self.appeals = appeals
        self.open = open ?? appeals.filter(\.isOpen).count
        self.moduleEnabled = moduleEnabled
        self.configured = configured
    }

    private enum CodingKeys: String, CodingKey { case appeals, open, moduleEnabled, configured }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            appeals: try c.decodeLossyArray(of: Appeal.self, forKey: .appeals),
            open: try c.decodeIfPresent(Int.self, forKey: .open),
            moduleEnabled: try c.decode(forKey: .moduleEnabled, or: true),
            configured: try c.decode(forKey: .configured, or: true))
    }
}

/// What staff decide.
public enum AppealDecision: String, Sendable, CaseIterable {
    /// Accept, and unban the member.
    case accept
    case deny

    public var resultingStatus: AppealStatus { self == .accept ? .accepted : .denied }
}

/// The answer to a decision: how it ended, whether the member was told, whether they were unbanned.
public struct AppealDecisionResult: Decodable, Sendable, Equatable {
    public let status: AppealStatus
    public let dmDelivered: Bool
    /// False after an accept means the ban could not be lifted and must be lifted by hand.
    public let unbanned: Bool

    public init(status: AppealStatus, dmDelivered: Bool = true, unbanned: Bool = false) {
        self.status = status
        self.dmDelivered = dmDelivered
        self.unbanned = unbanned
    }

    private enum CodingKeys: String, CodingKey { case status, dmDelivered, unbanned }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            status: try c.decode(forKey: .status, or: .open),
            dmDelivered: try c.decode(forKey: .dmDelivered, or: true),
            unbanned: try c.decode(forKey: .unbanned, or: false))
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/appeals`.
    public struct LoadAppeals: APIEndpoint {
        public typealias Response = AppealsReview
        public let server: ServerID

        public init(server: ServerID) { self.server = server }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/appeals" }
    }

    /// `POST /api/v2/guilds/:id/appeals/:id/decide`: accepts (and unbans) or denies an open appeal.
    /// The note (at most 1000 characters; the server writes "No reason given" for none) goes to
    /// the member. 409 when it was already decided.
    public struct DecideAppeal: APIEndpoint {
        public typealias Response = AppealDecisionResult
        public let server: ServerID
        public let id: Int
        public let decision: AppealDecision
        public let reason: String

        public init(server: ServerID, id: Int, decision: AppealDecision, reason: String = "") {
            self.server = server
            self.id = id
            self.decision = decision
            self.reason = reason
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/appeals/\(id)/decide" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(decision: decision.rawValue, reason: reason) }

        private struct Body: Encodable, Sendable {
            let decision: String
            let reason: String
        }
    }
}

/// The appeals inbox: open appeals first, then the ones already decided, and deciding.
@MainActor
@Observable
public final class AppealsReviewModel {
    /// The longest note the server keeps, in characters.
    public static let maxReasonLength = 1000

    public let server: ServerID
    public private(set) var review: AppealsReview?
    public private(set) var isLoading = false
    public private(set) var isDeciding = false
    /// Why the appeals could not be loaded (the last ones, if any, stay).
    public var errorMessage: String?
    /// Why a decision did not go through, in the server's words.
    public var actionError: String?
    /// What the last decision left undone or unsaid (ban not lifted, member not told).
    public private(set) var decisionNotes: [String] = []
    /// What the last decision did, in a sentence.
    public private(set) var decisionSummary: String?
    /// The appeal the last decision was for, so a screen shows the notes only for that one.
    public private(set) var decisionAppealID: Int?
    /// Goes up with every decision that went through, for a haptic.
    public private(set) var decisionCount = 0
    /// Called after every load and decision with the number of open appeals, so a badge follows it.
    public var onOpenCount: (@MainActor (Int) -> Void)?

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public var hasLoaded: Bool { review != nil }
    public var open: [Appeal] { review?.appeals.filter(\.isOpen) ?? [] }
    public var decided: [Appeal] { review?.appeals.filter { !$0.isOpen } ?? [] }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let loaded = try await session.send(Endpoints.LoadAppeals(server: server))
            review = loaded
            errorMessage = nil
            onOpenCount?(loaded.open)
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    /// Accepts (and unbans) or denies an open appeal. The note is trimmed and cut at 1000
    /// characters; empty sends none. The list is reloaded afterwards.
    /// - Returns: Whether the decision went through. On failure ``actionError`` says why.
    @discardableResult
    public func decide(_ appeal: Appeal, _ decision: AppealDecision, reason: String) async -> Bool {
        guard appeal.isOpen, !isDeciding else { return false }
        isDeciding = true
        defer { isDeciding = false }
        actionError = nil
        let reason = String(reason.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maxReasonLength))
        do {
            let result = try await session.send(
                Endpoints.DecideAppeal(server: server, id: appeal.id, decision: decision, reason: reason))
            var notes: [String] = []
            if result.status == .accepted, !result.unbanned {
                notes.append("The ban could not be lifted. Unban them manually.")
            }
            if !result.dmDelivered { notes.append("The member could not be sent a DM.") }
            decisionNotes = notes
            decisionSummary = result.status == .accepted ? "Appeal accepted." : "Appeal denied."
            decisionAppealID = appeal.id
            decisionCount += 1
            await load()
            return true
        } catch {
            let error = NetworkError(error)
            if error == .http(status: 409) {
                actionError = error.serverMessage ?? "Someone already decided this appeal. Refresh to see how."
                await load()
            } else if error != .cancelled, error != .unauthorized {
                actionError = error.userMessage
            }
            return false
        }
    }
}
