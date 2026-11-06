import Foundation

// Ban appeals (src/web/routes/v2Staff.js, `staffRouter` under /api/v2/guilds/:guildId/appeals; the
// dashboard page web-v2/src/pages/AppealsReview.jsx): a banned member's answers to the questions the
// Appeals module asks, and the staff's decision. Behind the server-admin guard like the module pages.

/// One question and the answer a member gave.
public struct AppealAnswer: Decodable, Sendable, Hashable {
    public let question: String
    public let answer: String

    public init(question: String, answer: String) {
        self.question = question
        self.answer = answer
    }

    private enum CodingKeys: String, CodingKey { case question = "q", answer = "a" }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        question = try c.decode(forKey: .question, or: "")
        answer = try c.decode(forKey: .answer, or: "")
    }
}

/// Where an appeal is.
public enum AppealStatus: Hashable, Sendable, RawRepresentable, Decodable {
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

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }
}

/// One appeal as the server lists it.
public struct Appeal: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    /// The member's name (their id when the server could not look it up).
    public let user: String
    public let userId: String
    /// The reason the member was banned for; "—" when none was recorded.
    public let banReason: String
    public let answers: [AppealAnswer]
    public let status: AppealStatus
    /// Who decided, as the decider's display name; nil while open.
    public let decidedBy: String?
    /// The note the member sees with the decision.
    public let decisionReason: String?
    public let submittedAt: Date?
    public let decidedAt: Date?

    public init(
        id: Int, user: String, userId: String = "", banReason: String = "—", answers: [AppealAnswer] = [],
        status: AppealStatus = .open, decidedBy: String? = nil, decisionReason: String? = nil,
        submittedAt: Date? = nil, decidedAt: Date? = nil
    ) {
        self.id = id
        self.user = user
        self.userId = userId
        self.banReason = banReason
        self.answers = answers
        self.status = status
        self.decidedBy = decidedBy
        self.decisionReason = decisionReason
        self.submittedAt = submittedAt
        self.decidedAt = decidedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, user, userId, banReason, answers, status, decidedBy, decisionReason, at, decidedAt
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            user: try c.decode(forKey: .user, or: ""),
            userId: try c.decode(forKey: .userId, or: ""),
            banReason: try c.decode(forKey: .banReason, or: "—"),
            answers: try c.decodeLossyArray(of: AppealAnswer.self, forKey: .answers),
            status: try c.decode(forKey: .status, or: .open),
            decidedBy: try c.decodeIfPresent(String.self, forKey: .decidedBy),
            decisionReason: try c.decodeIfPresent(String.self, forKey: .decisionReason),
            submittedAt: try c.decodeEpochMillisecondsIfPresent(forKey: .at),
            decidedAt: try c.decodeEpochMillisecondsIfPresent(forKey: .decidedAt))
    }

    /// The ban reason, nil when the server recorded none ("—" or empty).
    public var originalBanReason: String? {
        let text = banReason.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty || text == "—" ? nil : text
    }
}

/// `GET /api/v2/guilds/:id/appeals`: the open appeals first, then the decided ones (up to 100).
public struct AppealsInboxPage: Decodable, Sendable, Equatable {
    public let appeals: [Appeal]
    public let open: Int
    /// Whether the Appeals module is on.
    public let moduleEnabled: Bool
    /// Whether the module has at least one question set up.
    public let configured: Bool

    public init(appeals: [Appeal] = [], open: Int? = nil, moduleEnabled: Bool = true, configured: Bool = true) {
        self.appeals = appeals
        self.open = open ?? appeals.count(where: { $0.status == .open })
        self.moduleEnabled = moduleEnabled
        self.configured = configured
    }

    private enum CodingKeys: String, CodingKey { case appeals, open, moduleEnabled, configured }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let appeals = try c.decodeLossyArray(of: Appeal.self, forKey: .appeals)
        self.init(
            appeals: appeals,
            open: try c.decodeIfPresent(Int.self, forKey: .open),
            moduleEnabled: try c.decode(forKey: .moduleEnabled, or: true),
            configured: try c.decode(forKey: .configured, or: true))
    }

    public var openAppeals: [Appeal] { appeals.filter { $0.status == .open } }
    public var decidedAppeals: [Appeal] { appeals.filter { $0.status != .open } }

    public func appeal(id: Int) -> Appeal? { appeals.first { $0.id == id } }
}

/// What staff decide.
public enum AppealDecision: String, Sendable, Equatable {
    case accept
    case deny
}

/// The answer to deciding: what happened beyond recording the decision.
public struct AppealDecisionResult: Decodable, Sendable, Equatable {
    /// `accepted` or `denied`.
    public let status: AppealStatus
    /// Whether the member could be sent the decision as a DM.
    public let dmDelivered: Bool
    /// Whether the ban was lifted (only asked for on accept).
    public let unbanned: Bool

    public init(status: AppealStatus, dmDelivered: Bool, unbanned: Bool) {
        self.status = status
        self.dmDelivered = dmDelivered
        self.unbanned = unbanned
    }

    private enum CodingKeys: String, CodingKey { case status, dmDelivered, unbanned }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decode(forKey: .status, or: .other(""))
        dmDelivered = try c.decode(forKey: .dmDelivered, or: false)
        unbanned = try c.decode(forKey: .unbanned, or: false)
    }

    /// What to tell staff after the decision, in the dashboard's words.
    public var summary: String {
        var parts = [status == .accepted ? "Appeal accepted." : "Appeal denied."]
        if status == .accepted, !unbanned { parts.append("The ban could not be lifted. Unban them manually.") }
        if !dmDelivered { parts.append("The member could not be sent a DM.") }
        return parts.joined(separator: " ")
    }

    /// Whether something needs staff's attention (the ban is still there).
    public var needsAttention: Bool { status == .accepted && !unbanned }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/appeals`.
    public struct Appeals: APIEndpoint {
        public typealias Response = AppealsInboxPage
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/appeals" }
    }

    /// `POST /api/v2/guilds/:id/appeals/:appeal/decide` with `{decision, reason}`. `reason` is
    /// what the member sees (the server cuts it at 1000 characters and says "No reason given"
    /// for an empty one). 409 when the appeal was decided already.
    public struct DecideAppeal: APIEndpoint {
        public typealias Response = AppealDecisionResult
        public static let maxReasonLength = 1000

        public let server: ServerID
        public let id: Int
        public let decision: AppealDecision
        public let reason: String

        public init(server: ServerID, id: Int, decision: AppealDecision, reason: String) {
            self.server = server
            self.id = id
            self.decision = decision
            self.reason = reason
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/appeals/\(id)/decide" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            Body(decision: decision.rawValue, reason: String(reason.prefix(Self.maxReasonLength)))
        }

        private struct Body: Encodable, Sendable {
            let decision: String
            let reason: String
        }
    }
}

extension RecordListModel where Page == AppealsInboxPage {
    /// The appeals screen's model.
    public convenience init(appeals server: ServerID, session: AppSession) {
        self.init(server: server, session: session) { session, server in
            try await session.send(Endpoints.Appeals(server: server))
        }
    }

    /// Accepts or denies an appeal. A refused decision (decided by someone else meanwhile, 409)
    /// loads the list again so the screen shows what the server holds.
    /// - Returns: What the server did, or nil when it did not go through (``actionError`` says why).
    public func decide(_ appeal: Appeal, _ decision: AppealDecision, reason: String) async -> AppealDecisionResult? {
        let result: AppealDecisionResult? = await perform { session, server in
            do {
                return try await session.send(
                    Endpoints.DecideAppeal(server: server, id: appeal.id, decision: decision, reason: reason))
            } catch NetworkError.http(status: 409) {
                throw NetworkError.badRequest(message: "This appeal has already been decided.")
            }
        }
        if result == nil { await load() }
        return result
    }
}
