import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

@Suite("Roadmap")
struct RoadmapDecodingTests {
    static let json = #"""
        {"groups":{
           "planned":[{"id":1,"title":"Dark mode","description":"A **dark** theme.","descriptionHtml":"<p>x</p>",
                       "status":"planned","votes":12,"createdAt":1,"voted":false}],
           "started":[{"id":2,"title":"Native app","description":"On iOS.","status":"started","votes":40,"createdAt":2,"voted":true},
                      {"title":"broken"}],
           "completed":[],
           "mystery":[{"id":9,"title":"Unknown stage","description":"","votes":1}]},
         "mine":[{"id":7,"title":"Shop themes","description":"x","descriptionHtml":"<p>x</p>","ago":"2d ago"}],
         "isOwner":false,"signedIn":true,"open":false}
        """#

    @Test("The board reads its stages, the person's votes and pending suggestions")
    func decodes() throws {
        let board = try decode(RoadmapBoard.self, Self.json)
        #expect(board.canParticipate)
        #expect(board.groups[.planned]?.map(\.id) == [1])
        #expect(board.groups[.started]?.map(\.id) == [2])
        #expect(board.groups[.completed]?.isEmpty == true)
        #expect(board.groups[.started]?.first?.hasVoted == true)
        #expect(board.groups[.planned]?.first?.votes == 12)
        #expect(board.groups[.planned]?.first?.description == "A **dark** theme.")
        #expect(board.pending == [RoadmapSuggestion(id: 7, title: "Shop themes", ago: "2d ago")])
    }

    @Test("Stages the app does not know are ignored, and empty ones are left out of the sections")
    func sections() throws {
        let board = try decode(RoadmapBoard.self, Self.json)
        #expect(board.sections.map(\.status) == [.planned, .started])
    }

    @Test("Without a login nobody can vote, and a bare answer is an empty board")
    func anonymous() throws {
        let board = try decode(RoadmapBoard.self, #"{"groups":{"planned":[]},"signedIn":false,"open":true}"#)
        #expect(!board.canParticipate)
        #expect(try decode(RoadmapBoard.self, "{}").sections.isEmpty)
    }

    @Test("The calls go where the server expects")
    func endpoints() throws {
        #expect(Endpoints.Roadmap().path == "/api/v2/roadmap")
        let vote = Endpoints.VoteRoadmapPost(id: 12)
        #expect(vote.path == "/api/v2/roadmap/12/vote")
        #expect(vote.method == .post)
        let suggest = Endpoints.SuggestRoadmapPost(title: "T", description: "D")
        #expect(suggest.path == "/api/v2/roadmap/suggest")
        #expect(suggest.method == .post)
        let result = try decode(RoadmapVoteResult.self, #"{"voted":true,"votes":13}"#)
        #expect(result == RoadmapVoteResult(voted: true, votes: 13))
    }
}

@MainActor
@Suite("Roadmap model")
struct RoadmapModelTests {
    nonisolated static let board = try! decode(RoadmapBoard.self, RoadmapDecodingTests.json)

    static func clients(
        vote: @escaping @Sendable (Endpoints.VoteRoadmapPost) throws -> RoadmapVoteResult = { call in
            call.id == 1 ? RoadmapVoteResult(voted: true, votes: 13) : RoadmapVoteResult(voted: false, votes: 39)
        },
        suggest: @escaping @Sendable (Endpoints.SuggestRoadmapPost) throws -> OKResponse = { _ in OKResponse() }
    ) -> StubClients {
        StubClients { endpoint in
            switch endpoint {
            case let call as Endpoints.VoteRoadmapPost: return try vote(call)
            case let call as Endpoints.SuggestRoadmapPost: return try suggest(call)
            default: return Self.board
            }
        }
    }

    func loadedModel(_ clients: StubClients) async -> RoadmapModel {
        let model = RoadmapModel(session: makeSignedInSession(clients: clients))
        await model.load()
        return model
    }

    func post(_ model: RoadmapModel, _ id: Int) -> RoadmapPost? {
        model.board?.groups.values.flatMap { $0 }.first { $0.id == id }
    }

    @Test("Loading shows the board")
    func loads() async {
        let model = await loadedModel(Self.clients())
        #expect(model.board == Self.board)
        #expect(model.errorMessage == nil)
    }

    @Test("Voting counts at once, then shows the server's answer")
    func votes() async throws {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        let task = try #require(model.toggleVote(1))
        #expect(post(model, 1)?.hasVoted == true)
        #expect(post(model, 1)?.votes == 13)
        #expect(model.isVoting(1))
        await task.value
        #expect(!model.isVoting(1))
        #expect(post(model, 1)?.votes == 13)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.VoteRoadmapPost)
        #expect(sent.id == 1)
        #expect(model.actionError == nil)
    }

    @Test("Taking a vote back counts down")
    func unvotes() async throws {
        let model = await loadedModel(Self.clients())
        let task = try #require(model.toggleVote(2))
        #expect(post(model, 2)?.hasVoted == false)
        #expect(post(model, 2)?.votes == 39)
        await task.value
        #expect(post(model, 2)?.hasVoted == false)
        #expect(post(model, 2)?.votes == 39)
    }

    @Test("The server's count wins over the guess")
    func serverCountWins() async {
        let model = await loadedModel(Self.clients(vote: { _ in RoadmapVoteResult(voted: true, votes: 20) }))
        await model.toggleVote(1)?.value
        #expect(post(model, 1)?.votes == 20)
    }

    @Test("A vote that fails goes back and explains")
    func failedVote() async {
        let model = await loadedModel(Self.clients(vote: { _ in throw NetworkError.rateLimited }))
        await model.toggleVote(1)?.value
        #expect(post(model, 1)?.hasVoted == false)
        #expect(post(model, 1)?.votes == 12)
        #expect(model.actionError == "You're voting too fast. Wait a moment, then try again.")
    }

    @Test("A post that is gone says so")
    func goneVote() async {
        let model = await loadedModel(Self.clients(vote: { _ in throw NetworkError.notFound }))
        await model.toggleVote(1)?.value
        #expect(model.actionError == "That post is gone. Refresh the roadmap.")
    }

    @Test("A second vote while one is on its way, an unknown post, or no login is ignored")
    func ignored() async throws {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        let first = model.toggleVote(1)
        #expect(model.toggleVote(1) == nil)
        #expect(model.toggleVote(404) == nil)
        await first?.value
        #expect(clients.calls.filter { $0.endpoint is Endpoints.VoteRoadmapPost }.count == 1)

        let anonymous = RoadmapBoard(groups: [.planned: [RoadmapPost(id: 1, title: "A")]], canParticipate: false)
        let guest = await loadedModel(StubClients { _ in anonymous })
        #expect(guest.toggleVote(1) == nil)
    }

    @Test("A suggestion needs a title of 3 to 100 characters and a description of up to 2000")
    func suggestionLimits() {
        #expect(RoadmapModel.suggestionProblem(title: "ab", description: "x") == "The title needs 3 to 100 characters.")
        #expect(RoadmapModel.suggestionProblem(title: String(repeating: "a", count: 101), description: "x") != nil)
        #expect(RoadmapModel.suggestionProblem(title: "  abc  ", description: "x") == nil)
        #expect(RoadmapModel.suggestionProblem(title: "abc", description: "   ") == "Describe the idea.")
        #expect(RoadmapModel.suggestionProblem(title: "abc", description: String(repeating: "x", count: 2001)) != nil)
        #expect(RoadmapModel.suggestionProblem(title: "abc", description: String(repeating: "x", count: 2000)) == nil)
    }

    @Test("Sending a suggestion trims it, reloads the board and thanks the person")
    func suggests() async throws {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        let sent = await model.suggest(title: "  New idea ", description: " Please. ")
        #expect(sent)
        #expect(model.suggestionSent)
        let call = try #require(clients.calls.compactMap { $0.endpoint as? Endpoints.SuggestRoadmapPost }.first)
        #expect(call.title == "New idea")
        #expect(call.description == "Please.")
        #expect(clients.calls.last?.endpoint is Endpoints.Roadmap)
    }

    @Test("A suggestion the server refuses shows the server's own words")
    func refusedSuggestion() async {
        let model = await loadedModel(Self.clients(suggest: { _ in
            throw NetworkError.badRequest(message: "Title (3-100 chars) and description are required.")
        }))
        let sent = await model.suggest(title: "Idea", description: "Text")
        #expect(!sent)
        #expect(!model.suggestionSent)
        #expect(model.actionError == "Title (3-100 chars) and description are required.")
    }

    @Test("A suggestion that is too short is stopped before it is sent")
    func shortSuggestion() async {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        let sent = await model.suggest(title: "ab", description: "x")
        #expect(!sent)
        #expect(model.actionError == "The title needs 3 to 100 characters.")
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.SuggestRoadmapPost })
    }
}
