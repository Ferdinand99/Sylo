import Foundation
import Observation

// Working through the suggestions (src/web/routes/v2Suggestions.js: `GET /modules/suggestions/list`,
// `POST /:number/decision`, `/:number/delete`, `/:number/move-back` and `/move-all-back`), the same
// calls the dashboard makes. Staff decide with an optional reason that is shown on the post and
// sent to the author. Moving back needs Sylo 5.1; a server without it sends no `canMoveBack`, so
// the buttons stay away.

/// What staff can do to a suggestion's status: the dashboard's "Set status" list.
public enum SuggestionAction: String, Sendable, CaseIterable {
    case approve
    case deny
    case implement
    case consider

    /// The status the action sets.
    public var resultingStatus: SuggestionStatus {
        switch self {
        case .approve: .approved
        case .deny: .denied
        case .implement: .implemented
        case .consider: .considering
        }
    }

    /// The actions that change a suggestion in this status: setting it to what it already is does nothing.
    public static func available(for status: SuggestionStatus) -> [SuggestionAction] {
        allCases.filter { $0.resultingStatus != status }
    }
}

/// Which suggestions the list shows.
public enum SuggestionFilter: String, Sendable, CaseIterable {
    case all
    /// Open and considering ones.
    case open
    case approved
    case denied
    case implemented
}

/// The order of the list.
public enum SuggestionSort: String, Sendable, CaseIterable {
    case new
    /// The most votes first.
    case top
}

/// `GET /modules/suggestions/list`: the suggestions for a filter, at most 100.
public struct SuggestionListAnswer: Decodable, Sendable, Equatable {
    public let suggestions: [SuggestionSummary]
    /// How many suggestions in the whole server could be moved back (the list is cut); 0 from a
    /// server that does not offer it.
    public let outside: Int

    public init(suggestions: [SuggestionSummary] = [], outside: Int = 0) {
        self.suggestions = suggestions
        self.outside = outside
    }

    private enum CodingKeys: String, CodingKey { case suggestions, outside }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        suggestions = try c.decodeLossyArray(of: SuggestionSummary.self, forKey: .suggestions)
        outside = try c.decode(forKey: .outside, or: 0)
    }
}

/// The answer to a decision: the suggestion as it is now, and what happened around it.
public struct SuggestionDecisionAnswer: Decodable, Sendable, Equatable {
    public let suggestion: SuggestionSummary
    /// The post moved to the log channel.
    public let moved: Bool
    /// A copy was posted in the log channel.
    public let copied: Bool
    /// The author was told by DM.
    public let dm: Bool

    private enum CodingKeys: String, CodingKey { case suggestion, moved, copied, dm }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        suggestion = try c.decode(SuggestionSummary.self, forKey: .suggestion)
        moved = try c.decode(forKey: .moved, or: false)
        copied = try c.decode(forKey: .copied, or: false)
        dm = try c.decode(forKey: .dm, or: false)
    }
}

/// A suggestion "move all back" could not move, and why.
public struct SuggestionMoveFailure: Decodable, Sendable, Equatable {
    public let number: Int
    public let error: String

    public init(number: Int, error: String) {
        self.number = number
        self.error = error
    }

    private enum CodingKeys: String, CodingKey { case number, error }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(number: try c.decode(Int.self, forKey: .number), error: try c.decode(forKey: .error, or: ""))
    }
}

/// One batch of "move all back". The server moves ten at a time; ask again after ``next`` until
/// nothing remains or it stops with an ``error`` (which is an answer, not a failed request).
public struct SuggestionMoveBatch: Decodable, Sendable, Equatable {
    public let moved: Int
    public let remaining: Int
    public let failed: [SuggestionMoveFailure]
    /// The number to pass as `after` in the next call.
    public let next: Int
    /// Why the run stopped; nil when the batch went through.
    public let error: String?

    public init(moved: Int = 0, remaining: Int = 0, failed: [SuggestionMoveFailure] = [], next: Int = 0,
                error: String? = nil) {
        self.moved = moved
        self.remaining = remaining
        self.failed = failed
        self.next = next
        self.error = error
    }

    private enum CodingKeys: String, CodingKey { case moved, remaining, failed, next, error }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            moved: try c.decode(forKey: .moved, or: 0),
            remaining: try c.decode(forKey: .remaining, or: 0),
            failed: try c.decodeLossyArray(of: SuggestionMoveFailure.self, forKey: .failed),
            next: try c.decode(forKey: .next, or: 0),
            error: try c.decodeIfPresent(String.self, forKey: .error))
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/modules/suggestions/list?status=&sort=`.
    public struct SuggestionList: APIEndpoint {
        public typealias Response = SuggestionListAnswer
        public let server: ServerID
        public let status: SuggestionFilter
        public let sort: SuggestionSort

        public init(server: ServerID, status: SuggestionFilter = .all, sort: SuggestionSort = .new) {
            self.server = server
            self.status = status
            self.sort = sort
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/suggestions/list" }
        public var query: [URLQueryItem] {
            [URLQueryItem(name: "status", value: status.rawValue), URLQueryItem(name: "sort", value: sort.rawValue)]
        }
    }

    /// `POST /api/v2/guilds/:id/modules/suggestions/:number/decision`: sets the status, with a
    /// reason (shown on the post and DMed to the author). 400 with the server's words when the
    /// module is off.
    public struct DecideSuggestion: APIEndpoint {
        public typealias Response = SuggestionDecisionAnswer
        public let server: ServerID
        public let number: Int
        public let action: SuggestionAction
        /// Empty for none; the server keeps at most 500 characters.
        public let reason: String

        public init(server: ServerID, number: Int, action: SuggestionAction, reason: String = "") {
            self.server = server
            self.number = number
            self.action = action
            self.reason = reason
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/suggestions/\(number)/decision" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(action: action.rawValue, reason: reason) }

        private struct Body: Encodable, Sendable {
            let action: String
            let reason: String
        }
    }

    /// `POST /api/v2/guilds/:id/modules/suggestions/:number/delete`: removes the suggestion, its
    /// votes and its post.
    public struct DeleteSuggestion: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let number: Int

        public init(server: ServerID, number: Int) {
            self.server = server
            self.number = number
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/suggestions/\(number)/delete" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { CommunityEmptyBody() }
    }

    /// `POST /api/v2/guilds/:id/modules/suggestions/:number/move-back`: posts the suggestion again
    /// in the suggestions channel.
    public struct MoveSuggestionBack: APIEndpoint {
        public typealias Response = SuggestionMoved
        public let server: ServerID
        public let number: Int

        public init(server: ServerID, number: Int) {
            self.server = server
            self.number = number
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/suggestions/\(number)/move-back" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { CommunityEmptyBody() }
    }

    /// `POST /api/v2/guilds/:id/modules/suggestions/move-all-back` with `{after}`: moves the next
    /// batch (oldest first) of the suggestions outside the suggestions channel, starting after
    /// number `after`.
    public struct MoveAllSuggestionsBack: APIEndpoint {
        public typealias Response = SuggestionMoveBatch
        public let server: ServerID
        public let after: Int

        public init(server: ServerID, after: Int = 0) {
            self.server = server
            self.after = after
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/suggestions/move-all-back" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(after: after) }

        private struct Body: Encodable, Sendable { let after: Int }
    }
}

/// The answer to moving one suggestion back.
public struct SuggestionMoved: Decodable, Sendable, Equatable {
    public let suggestion: SuggestionSummary
}

/// The suggestions list under the settings: a filter and an order, and staff's actions on it.
@MainActor
@Observable
public final class SuggestionListModel {
    /// The longest reason the server keeps, in characters (it cuts the rest).
    public static let maxReasonLength = 500

    public let server: ServerID
    public var filter: SuggestionFilter = .all
    public var sort: SuggestionSort = .new
    public private(set) var suggestions: [SuggestionSummary] = []
    /// How many suggestions could be moved back.
    public private(set) var outside = 0
    /// Whether ``suggestions`` is known: adopted from the page or fetched.
    public private(set) var hasLoaded = false
    public private(set) var isLoading = false
    /// An action is running.
    public private(set) var isWorking = false
    /// Why the list could not be fetched.
    public var errorMessage: String?
    /// Why the last action did not go through.
    public var actionError: String?
    /// What a move back did, for an alert.
    public var notice: CommunityNotice?
    /// Goes up with every action that went through, for a haptic.
    public private(set) var doneCount = 0

    private let session: AppSession
    /// Goes up with every fetch, so a slow answer for an old filter is dropped.
    private var generation = 0

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Takes over the list the settings page came with, which is the unfiltered one. With another
    /// filter or order chosen the list is fetched again instead.
    public func adopt(_ page: SuggestionsPage) async {
        if filter == .all, sort == .new {
            generation += 1
            suggestions = page.suggestions
            outside = page.outside
            hasLoaded = true
            errorMessage = nil
        } else {
            await load()
        }
    }

    /// Fetches the list for the current filter and order.
    public func load() async {
        generation += 1
        let mine = generation
        isLoading = true
        defer { if mine == generation { isLoading = false } }
        do {
            let answer = try await session.send(Endpoints.SuggestionList(server: server, status: filter, sort: sort))
            guard mine == generation else { return }
            suggestions = answer.suggestions
            outside = answer.outside
            hasLoaded = true
            errorMessage = nil
        } catch {
            guard mine == generation else { return }
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.communityMessage }
        }
    }

    /// Sets the status of a suggestion. The reason is trimmed; empty sends none.
    /// - Returns: Whether it went through. On failure ``actionError`` says why.
    @discardableResult
    public func decide(_ suggestion: SuggestionSummary, _ action: SuggestionAction, reason: String) async -> Bool {
        let reason = String(reason.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maxReasonLength))
        return await perform(
            Endpoints.DecideSuggestion(server: server, number: suggestion.number, action: action, reason: reason))
    }

    /// Deletes a suggestion, its votes and its post.
    @discardableResult
    public func delete(_ suggestion: SuggestionSummary) async -> Bool {
        await perform(Endpoints.DeleteSuggestion(server: server, number: suggestion.number))
    }

    /// Posts a suggestion again in the suggestions channel.
    @discardableResult
    public func moveBack(_ suggestion: SuggestionSummary) async -> Bool {
        let done = await perform(Endpoints.MoveSuggestionBack(server: server, number: suggestion.number))
        if done { notice = CommunityNotice("Suggestion #\(suggestion.number) is back in the suggestions channel.") }
        return done
    }

    /// Moves every suggestion outside the suggestions channel back, a batch at a time, and
    /// explains how it went in ``notice``.
    public func moveAllBack() async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        actionError = nil
        var total = 0
        var after = 0
        var failed: [SuggestionMoveFailure] = []
        var outcome = CommunityNotice("")
        do {
            while true {
                let batch = try await session.send(Endpoints.MoveAllSuggestionsBack(server: server, after: after))
                total += batch.moved
                failed += batch.failed
                if let error = batch.error {
                    outcome = CommunityNotice(
                        "\(error) \(total) moved back, \(batch.remaining) left.\(Self.skippedText(failed))", isError: true)
                    break
                }
                if batch.remaining == 0 || batch.next <= after {
                    let noun = total == 1 ? "suggestion" : "suggestions"
                    outcome = CommunityNotice(
                        "\(total) \(noun) moved back.\(Self.skippedText(failed))", isError: !failed.isEmpty)
                    break
                }
                after = batch.next
            }
        } catch {
            let error = NetworkError(error)
            guard error != .cancelled, error != .unauthorized else { return }
            outcome = CommunityNotice("\(error.communityMessage) \(total) moved back before that.", isError: true)
        }
        doneCount += total > 0 ? 1 : 0
        notice = outcome
        await load()
    }

    /// " 2 could not be moved and stay where they are: #4, #9. <why>", or nothing.
    nonisolated static func skippedText(_ failed: [SuggestionMoveFailure]) -> String {
        guard let first = failed.first else { return "" }
        let numbers = failed.map { "#\($0.number)" }.joined(separator: ", ")
        return " \(failed.count) could not be moved and stay where they are: \(numbers). \(first.error)"
    }

    private func perform<E: APIEndpoint>(_ endpoint: E) async -> Bool {
        guard !isWorking else { return false }
        isWorking = true
        defer { isWorking = false }
        actionError = nil
        do {
            _ = try await session.send(endpoint)
            doneCount += 1
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { actionError = error.communityMessage }
            return false
        }
        await load()
        return true
    }
}
