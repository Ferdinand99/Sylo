import Foundation
import Observation

// Searching and deleting quotes (src/web/routes/v2Quotes.js: `GET /modules/quote-board/list?q=` and
// `POST /modules/quote-board/:number/delete`), the same calls the dashboard makes.

/// `GET /modules/quote-board/list`: the newest quotes, or the ones matching a search, at most 100.
public struct QuoteListAnswer: Decodable, Sendable, Equatable {
    /// How many quotes the server has in all (not only the ones that match).
    public let total: Int
    public let quotes: [QuoteSummary]

    public init(total: Int? = nil, quotes: [QuoteSummary] = []) {
        self.total = total ?? quotes.count
        self.quotes = quotes
    }

    private enum CodingKeys: String, CodingKey { case total, quotes }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let quotes = try c.decodeLossyArray(of: QuoteSummary.self, forKey: .quotes)
        self.init(total: try c.decodeIfPresent(Int.self, forKey: .total), quotes: quotes)
    }
}

/// What the server does to a search before it looks.
public enum QuoteSearch {
    /// The longest search the server reads (it cuts the rest).
    public static let maxLength = 100

    /// The server's cleaning of a search: runs of whitespace become one space, the ends are
    /// trimmed, and at most 100 characters stay.
    public static func normalised(_ text: String) -> String {
        let collapsed = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return String(collapsed.prefix(maxLength))
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/modules/quote-board/list?q=`: with an empty `q` the newest quotes, else
    /// the ones whose text or author name contains it.
    public struct QuoteList: APIEndpoint {
        public typealias Response = QuoteListAnswer
        public let server: ServerID
        /// What to look for; cleaned the way the server cleans it (see ``QuoteSearch/normalised(_:)``).
        public let search: String

        public init(server: ServerID, search: String = "") {
            self.server = server
            self.search = QuoteSearch.normalised(search)
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/quote-board/list" }
        public var query: [URLQueryItem] { [URLQueryItem(name: "q", value: search)] }
    }

    /// `POST /api/v2/guilds/:id/modules/quote-board/:number/delete`: removes the quote. Its number is
    /// never used again; the quoted message stays. 404 when it is already gone.
    public struct DeleteQuote: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let number: Int

        public init(server: ServerID, number: Int) {
            self.server = server
            self.number = number
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/quote-board/\(number)/delete" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { CommunityEmptyBody() }
    }
}

/// The quote list under the settings: searchable, with delete.
@MainActor
@Observable
public final class QuoteListModel {
    public let server: ServerID
    public private(set) var quotes: [QuoteSummary] = []
    /// How many quotes the server has in all.
    public private(set) var total = 0
    /// What the list on screen was searched for; "" for the newest quotes.
    public private(set) var search = ""
    /// Whether ``quotes`` is known: adopted from the page or fetched.
    public private(set) var hasLoaded = false
    public private(set) var isLoading = false
    public private(set) var isWorking = false
    /// Why the list could not be fetched (the last list stays).
    public var errorMessage: String?
    /// Why a delete did not go through.
    public var actionError: String?
    /// Goes up with every quote deleted, for a haptic.
    public private(set) var deleteCount = 0

    private let session: AppSession
    /// Goes up with every fetch, so a slow answer for an old search is dropped.
    private var generation = 0

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Takes over the list the settings page came with (the newest quotes). While a search is on,
    /// the search is run again instead.
    public func adopt(_ page: QuoteBoardPage) async {
        if search.isEmpty {
            generation += 1
            quotes = page.quotes
            total = page.total
            hasLoaded = true
            errorMessage = nil
        } else {
            await load(search: search)
        }
    }

    /// Fetches the quotes matching `search` (the newest when it is empty).
    public func load(search text: String) async {
        let wanted = QuoteSearch.normalised(text)
        generation += 1
        let mine = generation
        isLoading = true
        defer { if mine == generation { isLoading = false } }
        do {
            let answer = try await session.send(Endpoints.QuoteList(server: server, search: wanted))
            guard mine == generation else { return }
            quotes = answer.quotes
            total = answer.total
            search = wanted
            hasLoaded = true
            errorMessage = nil
        } catch {
            guard mine == generation else { return }
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.communityMessage }
        }
    }

    /// Deletes a quote and fetches the list again.
    @discardableResult
    public func delete(_ quote: QuoteSummary) async -> Bool {
        guard !isWorking else { return false }
        isWorking = true
        defer { isWorking = false }
        actionError = nil
        do {
            _ = try await session.send(Endpoints.DeleteQuote(server: server, number: quote.number))
            deleteCount += 1
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { actionError = error.communityMessage }
            return false
        }
        await load(search: search)
        return true
    }
}
