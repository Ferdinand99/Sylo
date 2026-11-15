import Foundation
import Observation

// The staff changes to the economy (src/web/routes/v2Economy.js: `/modules/economy/members/:userId/adjust`
// and `/modules/economy/reset`; the dashboard side is web-v2/src/moduleForms/Economy.jsx). Staff add,
// remove or set a member's money, reset one member, and reset the whole server's economy. Every change
// is in the ledger with who made it, and posts to the log channel when one is set.

/// The four staff changes to one member (`ACTIONS` in v2Economy.js; the same four as /eco).
public enum EconomyAdjustAction: String, Sendable, CaseIterable, Identifiable {
    /// Adds to the member's cash.
    case add
    /// Takes from cash first and then from the bank; refused when the member has less in all.
    case remove
    /// Sets the member's cash.
    case set
    /// Back to a new start: starting cash, an empty bank, no streak or cooldowns.
    case resetMember = "reset-user"

    public var id: String { rawValue }

    /// The words the dashboard uses.
    public var title: String {
        switch self {
        case .add: "Add to cash"
        case .remove: "Remove (cash first, then bank)"
        case .set: "Set cash to"
        case .resetMember: "Reset the member"
        }
    }

    /// Whether an amount goes along (not for a reset).
    public var needsAmount: Bool { self != .resetMember }

    /// The amounts the server takes: 1 and up to add or remove, 0 and up to set.
    public var amountRange: ClosedRange<Int> {
        self == .set ? 0...EconomyAdjustment.maxAmount : 1...EconomyAdjustment.maxAmount
    }

    /// Whether the change takes something away, so the confirmation button is red.
    public var isDestructive: Bool { self != .add }

    /// The question the confirmation asks. `amount` is already worded with the currency.
    public func question(member: String, amount: String) -> String {
        switch self {
        case .add: "Add \(amount) to \(member)?"
        case .remove: "Remove \(amount) from \(member)?"
        case .set: "Set \(member)'s cash to \(amount)?"
        case .resetMember: "Reset \(member)?"
        }
    }

    /// What the change does, under the question.
    public var consequence: String {
        switch self {
        case .add: "The amount goes into their cash. It is in their ledger with your name."
        case .remove: "Cash is taken first, then the bank. It is refused when they have less in all."
        case .set: "Their cash becomes this amount, whatever it was. The bank stays."
        case .resetMember:
            "Cash goes back to the starting balance, the bank is emptied, and the streak and cooldowns are cleared."
        }
    }

    /// The label of the confirming button.
    public var confirmTitle: String {
        switch self {
        case .add: "Add"
        case .remove: "Remove"
        case .set: "Set"
        case .resetMember: "Reset Member"
        }
    }
}

/// `POST .../economy/members/:userId/adjust`: what happened, and the member as they are now.
public struct EconomyAdjustment: Decodable, Sendable, Equatable {
    /// No member can hold more than this in cash and bank together.
    public static let maxAmount = 1_000_000_000

    /// The change that was made (can be less than asked when the cap was hit).
    public let applied: Int
    /// The add stopped at the most a member can hold.
    public let clamped: Bool
    /// "Now 🪙 450 coins in cash and 🪙 0 coins in the bank."
    public let summary: String
    public let detail: EconomyMemberDetail

    public init(applied: Int = 0, clamped: Bool = false, summary: String = "", detail: EconomyMemberDetail) {
        self.applied = applied
        self.clamped = clamped
        self.summary = summary
        self.detail = detail
    }

    private enum CodingKeys: String, CodingKey { case applied, clamped, summary }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            applied: try c.decode(forKey: .applied, or: 0),
            clamped: try c.decode(forKey: .clamped, or: false),
            summary: try c.decode(forKey: .summary, or: ""),
            // The member's balances, inventory and ledger sit in the same object.
            detail: try EconomyMemberDetail(from: decoder))
    }
}

/// The danger zone's reset of every account of the server.
public enum EconomyReset {
    /// The word the server wants typed (`RESET`).
    public static let confirmationWord = "RESET"

    /// Whether what was typed confirms the reset: the word, in any case, around any spaces.
    public static func accepts(_ typed: String) -> Bool {
        typed.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == confirmationWord
    }
}

/// `POST .../economy/reset`: how many accounts went back to a new start.
public struct EconomyResetResult: Decodable, Sendable, Equatable {
    public let ok: Bool
    public let accounts: Int

    public init(ok: Bool = true, accounts: Int = 0) {
        self.ok = ok
        self.accounts = accounts
    }

    private enum CodingKeys: String, CodingKey { case ok, accounts }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(ok: try c.decode(forKey: .ok, or: true), accounts: try c.decode(forKey: .accounts, or: 0))
    }
}

extension Endpoints {
    /// `POST .../economy/members/:userId/adjust`: one staff change, with a reason kept in the ledger.
    /// The amount is left out for a reset of the member. 400 carries the server's reason (the member has
    /// less, the number is out of range, Economy is off).
    public struct AdjustEconomyMember: APIEndpoint {
        public typealias Response = EconomyAdjustment
        public let server: ServerID
        public let userID: String
        public let action: EconomyAdjustAction
        public let amount: Int
        public let reason: String

        public init(server: ServerID, userID: String, action: EconomyAdjustAction, amount: Int = 0, reason: String = "") {
            self.server = server
            self.userID = userID
            self.action = action
            self.amount = amount
            self.reason = reason
        }

        public var path: String {
            "/api/v2/guilds/\(server.pathComponent)/modules/economy/members/\(userID.encodedPathSegment)/adjust"
        }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            Body(action: action.rawValue, amount: action.needsAmount ? amount : nil, reason: reason)
        }

        private struct Body: Encodable, Sendable {
            let action: String
            let amount: Int?
            let reason: String
        }
    }

    /// `POST .../economy/reset`: every account goes back to a new start. The server wants the typed word.
    public struct ResetEconomy: APIEndpoint {
        public typealias Response = EconomyResetResult
        public let server: ServerID

        public init(server: ServerID) { self.server = server }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/economy/reset" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(confirm: EconomyReset.confirmationWord) }

        private struct Body: Encodable, Sendable { let confirm: String }
    }
}

/// The reset of the whole economy: one call behind a typed word.
@MainActor
@Observable
public final class EconomyResetModel {
    public let server: ServerID
    public private(set) var isResetting = false
    /// Why the reset did not finish (the server says how far it got).
    public var errorMessage: String?
    /// How many accounts the last reset covered; nil before one finished.
    public private(set) var accountsReset: Int?

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Resets every account, when `typed` is the confirmation word. Nothing is sent otherwise.
    /// - Returns: Whether the reset finished.
    @discardableResult
    public func reset(typed: String) async -> Bool {
        guard EconomyReset.accepts(typed), !isResetting else { return false }
        isResetting = true
        defer { isResetting = false }
        errorMessage = nil
        do {
            accountsReset = try await session.send(Endpoints.ResetEconomy(server: server)).accounts
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
            return false
        }
    }
}
