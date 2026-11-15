import Foundation
import Observation

/// The three stages of a roadmap post, in the order the board shows them.
public enum RoadmapStatus: String, CaseIterable, Sendable, Hashable, Identifiable {
    case planned
    case started
    case completed

    public var id: String { rawValue }
}

/// One post on the roadmap.
public struct RoadmapPost: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    public let title: String
    /// Markdown, as the author wrote it.
    public let description: String
    public var votes: Int
    /// Whether the signed-in person voted for it.
    public var hasVoted: Bool

    public init(id: Int, title: String, description: String = "", votes: Int = 0, hasVoted: Bool = false) {
        self.id = id
        self.title = title
        self.description = description
        self.votes = votes
        self.hasVoted = hasVoted
    }

    private enum CodingKeys: String, CodingKey { case id, title, description, votes, voted }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        votes = c.lenientCount(.votes)
        hasVoted = try c.decodeIfPresent(Bool.self, forKey: .voted) ?? false
    }
}

/// A suggestion of the signed-in person that is still waiting for review.
public struct RoadmapSuggestion: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    public let title: String
    /// How long ago it was sent, as the server words it ("2d ago").
    public let ago: String

    public init(id: Int, title: String, ago: String = "") {
        self.id = id
        self.title = title
        self.ago = ago
    }

    private enum CodingKeys: String, CodingKey { case id, title, ago }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        ago = try c.decodeIfPresent(String.self, forKey: .ago) ?? ""
    }
}

/// The roadmap board as `GET /api/v2/roadmap` gives it to one person.
public struct RoadmapBoard: Decodable, Sendable, Equatable {
    /// The posts of each stage; a stage the server did not send is empty.
    public var groups: [RoadmapStatus: [RoadmapPost]]
    /// The person's own suggestions awaiting review.
    public let pending: [RoadmapSuggestion]
    /// Voting and suggesting need a real login; false on an open server without one.
    public let canParticipate: Bool

    public init(
        groups: [RoadmapStatus: [RoadmapPost]] = [:], pending: [RoadmapSuggestion] = [], canParticipate: Bool = true
    ) {
        self.groups = groups
        self.pending = pending
        self.canParticipate = canParticipate
    }

    private enum CodingKeys: String, CodingKey { case groups, mine, signedIn }

    private struct AnyKey: CodingKey {
        let stringValue: String
        let intValue: Int? = nil
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var groups: [RoadmapStatus: [RoadmapPost]] = [:]
        if let raw = try? c.nestedContainer(keyedBy: AnyKey.self, forKey: .groups) {
            for status in RoadmapStatus.allCases {
                guard let key = AnyKey(stringValue: status.rawValue) else { continue }
                groups[status] = try raw.decodeLossyArray(of: RoadmapPost.self, forKey: key)
            }
        }
        self.groups = groups
        pending = try c.decodeLossyArray(of: RoadmapSuggestion.self, forKey: .mine)
        canParticipate = try c.decodeIfPresent(Bool.self, forKey: .signedIn) ?? false
    }

    /// The stages that have posts, in board order.
    public var sections: [(status: RoadmapStatus, posts: [RoadmapPost])] {
        RoadmapStatus.allCases.compactMap { status in
            guard let posts = groups[status], !posts.isEmpty else { return nil }
            return (status, posts)
        }
    }

    public static func == (lhs: RoadmapBoard, rhs: RoadmapBoard) -> Bool {
        lhs.groups == rhs.groups && lhs.pending == rhs.pending && lhs.canParticipate == rhs.canParticipate
    }
}

/// The answer to a vote: the post after the change.
public struct RoadmapVoteResult: Decodable, Sendable, Equatable {
    public let voted: Bool
    public let votes: Int

    public init(voted: Bool, votes: Int) {
        self.voted = voted
        self.votes = votes
    }

    private enum CodingKeys: String, CodingKey { case voted, votes }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        voted = try c.decodeIfPresent(Bool.self, forKey: .voted) ?? false
        votes = c.lenientCount(.votes)
    }
}

extension Endpoints {
    /// `GET /api/v2/roadmap`: the board with the person's own votes and pending suggestions (the
    /// public `/api/v2/public/roadmap` has the same shape, but cannot tell who is asking).
    public struct Roadmap: APIEndpoint {
        public typealias Response = RoadmapBoard
        public init() {}
        public var path: String { "/api/v2/roadmap" }
    }

    /// `POST /api/v2/roadmap/:id/vote`: votes for a post, or takes the vote back.
    public struct VoteRoadmapPost: APIEndpoint {
        public typealias Response = RoadmapVoteResult
        public let id: Int
        public init(id: Int) { self.id = id }
        public var path: String { "/api/v2/roadmap/\(id)/vote" }
        public var method: HTTPMethod { .post }
    }

    /// `POST /api/v2/roadmap/suggest` with `{title, description}`: a suggestion for review.
    public struct SuggestRoadmapPost: APIEndpoint {
        public typealias Response = OKResponse
        public let title: String
        public let description: String

        public init(title: String, description: String) {
            self.title = title
            self.description = description
        }

        public var path: String { "/api/v2/roadmap/suggest" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(title: title, description: description) }

        private struct Body: Encodable, Sendable {
            let title: String
            let description: String
        }
    }
}

/// The Roadmap page: what is planned, in progress and shipped; voting; suggesting.
@MainActor
@Observable
public final class RoadmapModel {
    /// The server's limits on a suggestion.
    public static let titleLimits = 3...100
    public static let descriptionLimit = 2000

    public private(set) var board: RoadmapBoard?
    public private(set) var isLoading = false
    public private(set) var isSuggesting = false
    /// Why the board could not be loaded.
    public var errorMessage: String?
    /// Why the last vote or suggestion did not go through.
    public var actionError: String?
    /// Set once a suggestion was sent, until the person closes the notice.
    public var suggestionSent = false

    private var voting: Set<Int> = []
    private let session: AppSession

    public init(session: AppSession) {
        self.session = session
    }

    public func isVoting(_ id: Int) -> Bool { voting.contains(id) }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            board = try await session.send(Endpoints.Roadmap())
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    /// Votes for a post, or takes the vote back. The count changes at once; the server's answer
    /// then replaces it, and a failure puts the post back with ``actionError``.
    /// - Returns: The running vote, or nil when there is no such post, voting is not possible, or
    ///   a vote on it is already on its way.
    @discardableResult
    public func toggleVote(_ id: Int) -> Task<Void, Never>? {
        guard let board, board.canParticipate, !voting.contains(id), let before = post(id) else { return nil }
        actionError = nil
        voting.insert(id)
        update(id) {
            $0.hasVoted = !before.hasVoted
            $0.votes = max(0, before.votes + (before.hasVoted ? -1 : 1))
        }
        return Task {
            defer { voting.remove(id) }
            do {
                let result = try await session.send(Endpoints.VoteRoadmapPost(id: id))
                update(id) {
                    $0.hasVoted = result.voted
                    $0.votes = result.votes
                }
            } catch {
                update(id) {
                    $0.hasVoted = before.hasVoted
                    $0.votes = before.votes
                }
                let error = NetworkError(error)
                if error != .cancelled, error != .unauthorized { actionError = Self.voteMessage(for: error) }
            }
        }
    }

    /// Why a suggestion cannot be sent yet, nil when it can. Mirrors the server's limits.
    public static func suggestionProblem(title: String, description: String) -> String? {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let description = description.trimmingCharacters(in: .whitespacesAndNewlines)
        if !titleLimits.contains(title.utf16.count) { return "The title needs 3 to 100 characters." }
        if description.isEmpty { return "Describe the idea." }
        if description.utf16.count > descriptionLimit { return "The description can be 2,000 characters at most." }
        return nil
    }

    /// Sends a suggestion for review.
    /// - Returns: Whether it was sent; otherwise ``actionError`` says why.
    @discardableResult
    public func suggest(title: String, description: String) async -> Bool {
        guard !isSuggesting else { return false }
        if let problem = Self.suggestionProblem(title: title, description: description) {
            actionError = problem
            return false
        }
        isSuggesting = true
        actionError = nil
        defer { isSuggesting = false }
        do {
            _ = try await session.send(Endpoints.SuggestRoadmapPost(
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                description: description.trimmingCharacters(in: .whitespacesAndNewlines)))
            suggestionSent = true
            await load()
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized {
                if case .badRequest(let message?) = error {
                    actionError = message
                } else {
                    actionError = error.userMessage
                }
            }
            return false
        }
    }

    // MARK: - Helpers

    private func post(_ id: Int) -> RoadmapPost? {
        board?.groups.values.lazy.flatMap { $0 }.first { $0.id == id }
    }

    private func update(_ id: Int, _ change: (inout RoadmapPost) -> Void) {
        guard var board else { return }
        for (status, posts) in board.groups {
            guard let index = posts.firstIndex(where: { $0.id == id }) else { continue }
            var posts = posts
            change(&posts[index])
            board.groups[status] = posts
            break
        }
        self.board = board
    }

    private static func voteMessage(for error: NetworkError) -> String {
        switch error {
        case .notFound: "That post is gone. Refresh the roadmap."
        case .rateLimited: "You're voting too fast. Wait a moment, then try again."
        default: error.userMessage
        }
    }
}
