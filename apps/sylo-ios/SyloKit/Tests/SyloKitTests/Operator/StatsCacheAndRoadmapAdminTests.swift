import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

private struct AnyBody: Encodable {
    let value: any Encodable
    func encode(to encoder: any Encoder) throws { try value.encode(to: encoder) }
}

private func sentJSON(_ endpoint: some APIEndpoint) throws -> [String: Any]? {
    guard let body = endpoint.body else { return nil }
    return try JSONSerialization.jsonObject(with: JSONEncoder().encode(AnyBody(value: body))) as? [String: Any]
}

// MARK: - Stats cache

@Suite("Stats cache decoding")
struct StatsCacheDecodingTests {
    static let json = #"""
        {"rows":[
          {"game":"bf4","title":"Battlefield 4","username":"player_one","platform":"xboxone","ago":"5m ago","fresh":true,
           "kd":"1.52","winRate":"54%","timePlayed":"412h"},
          {"game":"osrs","title":"Old School RuneScape","username":"Zezima","platform":"","ago":"2h ago","fresh":false,
           "kd":"—","winRate":"—","timePlayed":"—"},
          {"game":"bf1","title":"Battlefield 1","username":"seconds","platform":"pc","ago":"1d ago","fresh":false,
           "kd":"0.9","winRate":"—","timePlayed":"1483200"},
          "not a row"],
         "ttlMinutes":30}
        """#

    @Test("Rows read in order, numbered, with what the game gave; the dashes mean nothing")
    func rows() throws {
        let cache = try decode(StatsCache.self, Self.json)
        #expect(cache.ttlMinutes == 30)
        #expect(cache.rows.count == 3)
        #expect(cache.rows.map(\.id) == [0, 1, 2])
        #expect(cache.rows[0].isFresh)
        #expect(cache.rows[0].kd == "1.52")
        #expect(cache.rows[1].kd == nil)
        #expect(cache.rows[1].winRate == nil)
        #expect(!cache.rows[1].isFresh)
    }

    @Test("A row's facts follow the dashboard: platform, K/D, win rate, time played, age")
    func facts() throws {
        let cache = try decode(StatsCache.self, Self.json)
        #expect(cache.rows[0].facts == ["Xbox One", "K/D 1.52", "Win 54%", "412 h played", "5m ago"])
        #expect(cache.rows[1].facts == ["2h ago"])
        #expect(cache.rows[2].facts == ["PC", "K/D 0.9", "412 h played", "1d ago"])
        #expect(cache.rows[0].heading == "Battlefield 4 \u{2014} player_one")
    }

    @Test("Time played from seconds, from hours, from text, and never a crash on odd numbers")
    func played() {
        #expect(StatsCacheRow.played("3600") == "1 h played")
        #expect(StatsCacheRow.played("412h") == "412 h played")
        #expect(StatsCacheRow.played("12 hours") == "12 h played")
        #expect(StatsCacheRow.played("3 days") == "3 days played")
        #expect(StatsCacheRow.played("nan") == "nan played")
        #expect(StatsCacheRow.played("99999999999999999999999999") == "99999999999999999999999999 played")
        #expect(StatsCacheRow.played(nil) == nil)
        #expect(StatsCacheRow.played("  ") == nil)
    }

    @Test("The call is a plain GET of the stats route")
    func endpoint() {
        #expect(Endpoints.StatsCacheLoad().path == "/api/v2/stats")
        #expect(Endpoints.StatsCacheLoad().method == .get)
    }
}

@MainActor
@Suite("Stats cache model")
struct StatsCacheModelTests {
    @Test("Loading keeps the rows")
    func loads() async {
        let cache = StatsCache(rows: [StatsCacheRow(game: "bf4", username: "a", isFresh: true)], ttlMinutes: 30)
        let model = StatsCacheModel(session: makeSignedInSession(clients: StubClients { _ in cache }))
        await model.load()
        #expect(model.cache?.rows.count == 1)
        #expect(!model.isRefused)
    }

    @Test("A person who is not an operator gets the refusal and no rows, even after rows were shown")
    func refused() async {
        let flag = LockedFlag()
        let cache = StatsCache(rows: [StatsCacheRow(game: "bf4")], ttlMinutes: 30)
        let clients = StubClients { _ in
            if flag.value { throw NetworkError.forbidden(message: "Restricted to Sylo's operators.") }
            return cache
        }
        let model = StatsCacheModel(session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.cache != nil)
        flag.value = true
        await model.load()
        #expect(model.isRefused)
        #expect(model.cache == nil)
        #expect(model.errorMessage == OperatorOnly.refusal)
    }
}

// MARK: - Roadmap admin

@Suite("Roadmap admin wire")
struct RoadmapAdminWireTests {
    static let json = #"""
        {"statuses":["planned","started","completed"],
         "pending":[{"id":4,"title":"Dark mode","description":"Please","status":"pending","ago":"2d ago","votes":0}],
         "posts":[{"id":1,"title":"Native app","description":"**Soon**","status":"started","votes":40,"ago":"3w ago"},
                  {"id":2,"title":"Old","status":"odd","votes":"x"}]}
        """#

    @Test("The board reads, with the stages the server offers")
    func board() throws {
        let board = try decode(RoadmapAdminBoard.self, Self.json)
        #expect(board.statuses == ["planned", "started", "completed"])
        #expect(board.pending.map(\.id) == [4])
        #expect(board.pending.first?.ago == "2d ago")
        #expect(board.posts.map(\.id) == [1, 2])
        #expect(board.posts.first?.votes == 40)
        #expect(board.posts.last?.votes == 0)
        #expect(board.posts.last?.description == "")

        let bare = try decode(RoadmapAdminBoard.self, "{}")
        #expect(bare.statuses == RoadmapAdminBoard.defaultStatuses)
        #expect(bare.pending.isEmpty && bare.posts.isEmpty)
    }

    @Test("Stages have the words the roadmap uses; an unknown one is shown as written")
    func labels() {
        #expect(RoadmapAdminBoard.label(for: "planned") == "Planned")
        #expect(RoadmapAdminBoard.label(for: "started") == "In progress")
        #expect(RoadmapAdminBoard.label(for: "completed") == "Recently shipped")
        #expect(RoadmapAdminBoard.label(for: "paused") == "paused")
    }

    @Test("Each call goes to its admin route with the dashboard's body")
    func routes() throws {
        #expect(Endpoints.RoadmapAdminLoad().path == "/api/v2/roadmap/admin")
        #expect(Endpoints.RoadmapAdminLoad().method == .get)

        let create = Endpoints.CreateRoadmapAdminPost(title: "T", description: "D")
        #expect(create.path == "/api/v2/roadmap/admin")
        #expect(create.method == .post)
        #expect(Set(try #require(try sentJSON(create)).keys) == ["title", "description"])

        let approve = Endpoints.ApproveRoadmapAdminPost(id: 4)
        #expect(approve.path == "/api/v2/roadmap/admin/4/approve")
        #expect(approve.method == .post)
        #expect(try sentJSON(approve) == nil)

        #expect(Endpoints.RejectRoadmapAdminPost(id: 4).path == "/api/v2/roadmap/admin/4/reject")
        #expect(Endpoints.DeleteRoadmapAdminPost(id: 4).path == "/api/v2/roadmap/admin/4/delete")
        #expect(Endpoints.DeleteRoadmapAdminPost(id: 4).method == .post)

        let status = Endpoints.SetRoadmapAdminStatus(id: 1, status: "completed")
        #expect(status.path == "/api/v2/roadmap/admin/1/status")
        let statusJSON = try #require(try sentJSON(status))
        #expect(statusJSON as? [String: String] == ["status": "completed"])

        let edit = Endpoints.EditRoadmapAdminPost(id: 1, title: "T", description: "D")
        #expect(edit.path == "/api/v2/roadmap/admin/1/edit")
        #expect(Set(try #require(try sentJSON(edit)).keys) == ["title", "description"])
    }
}

@MainActor
@Suite("Roadmap admin model")
struct RoadmapAdminModelTests {
    nonisolated static let board = RoadmapAdminBoard(
        pending: [RoadmapAdminPost(id: 4, title: "Dark mode", status: "pending")],
        posts: [RoadmapAdminPost(id: 1, title: "Native app", status: "started", votes: 40)])

    nonisolated static func clients() -> StubClients {
        StubClients { endpoint in
            if endpoint is Endpoints.RoadmapAdminLoad { return board }
            return EmptyResponse()
        }
    }

    @Test("Loading shows the pending suggestions and the public posts")
    func loads() async {
        let model = RoadmapAdminModel(session: makeSignedInSession(clients: Self.clients()))
        await model.load()
        #expect(model.board == Self.board)
    }

    @Test("A change goes out and the list is read again, as the dashboard does")
    func changeReloads() async {
        let clients = Self.clients()
        let model = RoadmapAdminModel(session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(await model.approve(4))
        #expect(await model.setStatus(1, to: "completed"))
        #expect(await model.reject(4))
        #expect(await model.delete(1))
        func name(_ endpoint: any APIEndpoint) -> String {
            switch endpoint {
            case is Endpoints.RoadmapAdminLoad: "load"
            case is Endpoints.ApproveRoadmapAdminPost: "approve"
            case is Endpoints.SetRoadmapAdminStatus: "status"
            case is Endpoints.RejectRoadmapAdminPost: "reject"
            case is Endpoints.DeleteRoadmapAdminPost: "delete"
            default: "other"
            }
        }
        #expect(clients.calls.map { name($0.endpoint) } == [
            "load", "approve", "load", "status", "load", "reject", "load", "delete", "load",
        ])
        #expect(model.busy.isEmpty)
    }

    @Test("A post needs the dashboard's title and description, or nothing is sent")
    func validation() async {
        let clients = Self.clients()
        let model = RoadmapAdminModel(session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(RoadmapAdminModel.problem(title: "ab", description: "x") != nil)
        #expect(RoadmapAdminModel.problem(title: String(repeating: "a", count: 101), description: "x") != nil)
        #expect(RoadmapAdminModel.problem(title: "Fine title", description: "  ") != nil)
        #expect(RoadmapAdminModel.problem(title: "Fine title", description: String(repeating: "d", count: 2001)) != nil)
        #expect(RoadmapAdminModel.problem(title: "Fine title", description: "ok") == nil)

        #expect(await model.create(title: "ab", description: "x") == false)
        #expect(model.actionError == "The title needs 3 to 100 characters.")
        #expect(await model.edit(1, title: "Fine title", description: "") == false)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.CreateRoadmapAdminPost })
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.EditRoadmapAdminPost })
    }

    @Test("Posting trims, and the server's refusal is shown")
    func createAndRefusal() async {
        let clients = Self.clients()
        let model = RoadmapAdminModel(session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(await model.create(title: "  New thing  ", description: " Why it helps "))
        let sent = clients.calls.compactMap { $0.endpoint as? Endpoints.CreateRoadmapAdminPost }.first
        #expect(sent?.title == "New thing")
        #expect(sent?.description == "Why it helps")

        clients.setHandler { _ in throw NetworkError.badRequest(message: "Title (3-100 chars) and description are required.") }
        #expect(await model.create(title: "Another", description: "Text") == false)
        #expect(model.actionError == "Title (3-100 chars) and description are required.")
    }

    @Test("A person who is not an operator gets the refusal, and no board")
    func refused() async {
        let clients = StubClients { _ in throw NetworkError.forbidden(message: "Restricted to Sylo's operators.") }
        let model = RoadmapAdminModel(session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.isRefused)
        #expect(model.board == nil)
        #expect(await model.approve(4) == false)
        #expect(clients.calls.count == 1)
    }
}
