import Foundation
import Observation

// The roadmap admin, for the operators of a Sylo server (web-v2/src/pages/RoadmapAdmin.jsx,
// `/api/v2/roadmap/admin*`, `requireOwner`): review the suggestions people sent, post something
// yourself, change a post's stage, edit or delete it. Members read and vote on the same board in the
// app's Roadmap screen.

/// A post as the admin list shows it: either a suggestion waiting for review or a public post.
public struct RoadmapAdminPost: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    public let title: String
    /// Markdown, as it was written.
    public let description: String
    /// `planned`, `started` or `completed` for a public post; `pending` for a suggestion.
    public let status: String
    public let votes: Int
    /// "2d ago", as the server words it.
    public let ago: String

    public init(id: Int, title: String, description: String = "", status: String = "planned", votes: Int = 0, ago: String = "") {
        self.id = id
        self.title = title
        self.description = description
        self.status = status
        self.votes = votes
        self.ago = ago
    }

    private enum CodingKeys: String, CodingKey { case id, title, description, status, votes, ago }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        votes = c.lenientCount(.votes)
        ago = try c.decodeIfPresent(String.self, forKey: .ago) ?? ""
    }
}

/// `GET /api/v2/roadmap/admin`.
public struct RoadmapAdminBoard: Decodable, Sendable, Equatable {
    /// The stages a public post can be moved to, in order (`pending` is not one of them).
    public let statuses: [String]
    public let pending: [RoadmapAdminPost]
    public let posts: [RoadmapAdminPost]

    public init(statuses: [String] = RoadmapAdminBoard.defaultStatuses, pending: [RoadmapAdminPost] = [], posts: [RoadmapAdminPost] = []) {
        self.statuses = statuses
        self.pending = pending
        self.posts = posts
    }

    public static let defaultStatuses = ["planned", "started", "completed"]

    private enum CodingKeys: String, CodingKey { case statuses, pending, posts }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let sent = (try? c.decodeIfPresent([String].self, forKey: .statuses)) ?? []
        statuses = sent.isEmpty ? Self.defaultStatuses : sent
        pending = try c.decodeLossyArray(of: RoadmapAdminPost.self, forKey: .pending)
        posts = try c.decodeLossyArray(of: RoadmapAdminPost.self, forKey: .posts)
    }

    /// What people call a stage ("In progress" for `started`); an unknown one is shown as the server wrote it.
    public static func label(for status: String) -> String {
        switch status {
        case "planned": "Planned"
        case "started": "In progress"
        case "completed": "Recently shipped"
        default: status
        }
    }
}

extension Endpoints {
    /// `GET /api/v2/roadmap/admin`: the suggestions to review and every public post.
    public struct RoadmapAdminLoad: APIEndpoint {
        public typealias Response = RoadmapAdminBoard
        public init() {}
        public var path: String { "/api/v2/roadmap/admin" }
    }

    /// `POST /api/v2/roadmap/admin` with `{title, description}`: a new post, planned. The answer is the
    /// post; the screen reads the list again.
    public struct CreateRoadmapAdminPost: APIEndpoint {
        public typealias Response = EmptyResponse
        public let title: String
        public let description: String
        public init(title: String, description: String) {
            self.title = title
            self.description = description
        }

        public var path: String { "/api/v2/roadmap/admin" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { RoadmapAdminTextBody(title: title, description: description) }
    }

    /// `POST /api/v2/roadmap/admin/:id/approve`: a suggestion goes on the board as planned.
    public struct ApproveRoadmapAdminPost: APIEndpoint {
        public typealias Response = EmptyResponse
        public let id: Int
        public init(id: Int) { self.id = id }
        public var path: String { "/api/v2/roadmap/admin/\(id)/approve" }
        public var method: HTTPMethod { .post }
    }

    /// `POST /api/v2/roadmap/admin/:id/reject`: a suggestion is deleted.
    public struct RejectRoadmapAdminPost: APIEndpoint {
        public typealias Response = EmptyResponse
        public let id: Int
        public init(id: Int) { self.id = id }
        public var path: String { "/api/v2/roadmap/admin/\(id)/reject" }
        public var method: HTTPMethod { .post }
    }

    /// `POST /api/v2/roadmap/admin/:id/status` with `{status}`.
    public struct SetRoadmapAdminStatus: APIEndpoint {
        public typealias Response = EmptyResponse
        public let id: Int
        public let status: String
        public init(id: Int, status: String) {
            self.id = id
            self.status = status
        }

        public var path: String { "/api/v2/roadmap/admin/\(id)/status" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(status: status) }

        private struct Body: Encodable, Sendable { let status: String }
    }

    /// `POST /api/v2/roadmap/admin/:id/edit` with `{title, description}`.
    public struct EditRoadmapAdminPost: APIEndpoint {
        public typealias Response = EmptyResponse
        public let id: Int
        public let title: String
        public let description: String
        public init(id: Int, title: String, description: String) {
            self.id = id
            self.title = title
            self.description = description
        }

        public var path: String { "/api/v2/roadmap/admin/\(id)/edit" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { RoadmapAdminTextBody(title: title, description: description) }
    }

    /// `POST /api/v2/roadmap/admin/:id/delete`: a post is removed from the board for good.
    public struct DeleteRoadmapAdminPost: APIEndpoint {
        public typealias Response = EmptyResponse
        public let id: Int
        public init(id: Int) { self.id = id }
        public var path: String { "/api/v2/roadmap/admin/\(id)/delete" }
        public var method: HTTPMethod { .post }
    }
}

private struct RoadmapAdminTextBody: Encodable, Sendable {
    let title: String
    let description: String
}

/// The Roadmap admin screen.
@MainActor
@Observable
public final class RoadmapAdminModel {
    public static let titleLimit = 100
    public static let descriptionLimit = 2000

    public private(set) var board: RoadmapAdminBoard?
    public private(set) var isLoading = false
    /// The server said this account is not an operator (403): nothing is shown.
    public private(set) var isRefused = false
    /// Why the board could not be loaded.
    public var errorMessage: String?
    /// Why the last change did not go through.
    public var actionError: String?
    /// The posts a change is on its way for, so their rows can show it.
    public private(set) var busy: Set<Int> = []
    public private(set) var isPosting = false

    private let session: AppSession

    public init(session: AppSession) {
        self.session = session
    }

    /// Why a post cannot be saved yet, nil when it can: the server's limits (3 to 100 characters in the
    /// title, a description of up to 2,000).
    public static func problem(title: String, description: String) -> String? {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let description = description.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.utf16.count < 3 || title.utf16.count > titleLimit { return "The title needs 3 to 100 characters." }
        if description.isEmpty { return "Add a description." }
        if description.utf16.count > descriptionLimit { return "The description can be 2,000 characters at most." }
        return nil
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        let generation = session.generation
        do {
            let loaded = try await session.send(Endpoints.RoadmapAdminLoad())
            guard session.generation == generation else { return }
            board = loaded
            isRefused = false
            errorMessage = nil
        } catch {
            guard session.generation == generation else { return }
            if let text = describe(error) { errorMessage = text }
            if isRefused { board = nil }
        }
    }

    /// Posts something new, planned.
    /// - Returns: Whether it was posted; otherwise ``actionError`` says why.
    @discardableResult
    public func create(title: String, description: String) async -> Bool {
        guard !isPosting, !isRefused else { return false }
        if let problem = Self.problem(title: title, description: description) {
            actionError = problem
            return false
        }
        isPosting = true
        defer { isPosting = false }
        return await run {
            _ = try await self.session.send(Endpoints.CreateRoadmapAdminPost(
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                description: description.trimmingCharacters(in: .whitespacesAndNewlines)))
        }
    }

    /// Puts a suggestion on the board, planned.
    @discardableResult
    public func approve(_ id: Int) async -> Bool {
        await change(id) { _ = try await self.session.send(Endpoints.ApproveRoadmapAdminPost(id: id)) }
    }

    /// Deletes a suggestion. The caller asks for confirmation first.
    @discardableResult
    public func reject(_ id: Int) async -> Bool {
        await change(id) { _ = try await self.session.send(Endpoints.RejectRoadmapAdminPost(id: id)) }
    }

    /// Moves a public post to another stage.
    @discardableResult
    public func setStatus(_ id: Int, to status: String) async -> Bool {
        await change(id) { _ = try await self.session.send(Endpoints.SetRoadmapAdminStatus(id: id, status: status)) }
    }

    @discardableResult
    public func edit(_ id: Int, title: String, description: String) async -> Bool {
        if let problem = Self.problem(title: title, description: description) {
            actionError = problem
            return false
        }
        return await change(id) {
            _ = try await self.session.send(Endpoints.EditRoadmapAdminPost(
                id: id, title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                description: description.trimmingCharacters(in: .whitespacesAndNewlines)))
        }
    }

    /// Deletes a public post for good. The caller asks for confirmation first.
    @discardableResult
    public func delete(_ id: Int) async -> Bool {
        await change(id) { _ = try await self.session.send(Endpoints.DeleteRoadmapAdminPost(id: id)) }
    }

    // MARK: - Helpers

    private func change(_ id: Int, _ call: @MainActor () async throws -> Void) async -> Bool {
        guard !busy.contains(id), !isRefused else { return false }
        busy.insert(id)
        defer { busy.remove(id) }
        return await run(call)
    }

    /// Runs a change, then reads the list again as the dashboard does.
    private func run(_ call: @MainActor () async throws -> Void) async -> Bool {
        actionError = nil
        let generation = session.generation
        do {
            try await call()
        } catch {
            guard session.generation == generation else { return false }
            actionError = describe(error)
            return false
        }
        guard session.generation == generation else { return false }
        await load()
        return true
    }

    private func describe(_ error: any Error) -> String? {
        let error = NetworkError(error)
        if error == .cancelled || error == .unauthorized { return nil }
        if OperatorOnly.isRefusal(error) {
            isRefused = true
            return OperatorOnly.refusal
        }
        if case .badRequest(let message?) = error { return message }
        return error.userMessage
    }
}
