import Foundation
import Testing
@testable import SyloKit

// Sylo 5.3 keeps the line breaks a server admin types: in a shop item's description, in the note on an appeal and
// in an application's reason (the public appeal page and the direct messages show them). The app sends them as they
// were typed, only trimmed at the ends. And the server list can be refreshed on request (`refresh-guilds`).

private func bodyJSON(_ body: (any Encodable & Sendable)?) throws -> [String: Any] {
    struct Box: Encodable {
        let value: any Encodable
        func encode(to encoder: any Encoder) throws { try value.encode(to: encoder) }
    }
    let value = try #require(body)
    let data = try JSONEncoder().encode(Box(value: value))
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

@MainActor
@Suite("Line breaks are sent as typed")
struct LineBreakTests {
    @Test("An appeal note keeps its inner line breaks; only the ends are trimmed")
    func appealNote() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.DecideAppeal { return AppealDecisionResult(status: .denied) }
            return AppealsReview(appeals: [Appeal(id: 3, user: "Alex")])
        }
        let model = AppealsReviewModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(await model.decide(Appeal(id: 3, user: "Alex"), .deny, reason: "\n Not this time.\n\nTry again in a month. \n"))
        let sent = clients.calls.compactMap { $0.endpoint as? Endpoints.DecideAppeal }
        #expect(sent.first?.reason == "Not this time.\n\nTry again in a month.")
    }

    @Test("An application's reason and a shop description go out with their line breaks")
    func bodies() throws {
        let decide = try bodyJSON(Endpoints.DecideApplication(server: "1", id: 2, action: .deny, reason: "Thanks!\nWe are full right now.").body)
        #expect(decide["reason"] as? String == "Thanks!\nWe are full right now.")

        var draft = ShopItemDraft()
        draft.name = "VIP"
        draft.description = "A gold name.\nAccess to #lounge.\n\nLasts a week."
        let item = try bodyJSON(draft.body(supportsCollectibles: false))
        #expect(item["description"] as? String == "A gold name.\nAccess to #lounge.\n\nLasts a week.")
    }

    @Test("A shop description from the server keeps its line breaks")
    func shopDecode() throws {
        let item = try JSONDecoder().decode(
            ShopItem.self, from: Data(#"{"id":1,"name":"VIP","description":"Line one\nLine two","type":"custom","price":10,"enabled":true}"#.utf8))
        #expect(item.description == "Line one\nLine two")
    }
}

@MainActor
@Suite("Server list: refresh")
struct ServerListRefreshTests {
    @Test("The route is the server's, a POST with an empty body")
    func route() throws {
        let call = Endpoints.RefreshServerList()
        #expect(call.path == "/api/v2/account/refresh-guilds")
        #expect(call.method == .post)
        #expect(try bodyJSON(call.body).isEmpty)
    }

    @Test("A refresh asks the server to look again, then loads the list, and says when servers were found")
    func refreshes() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.RefreshServerList { return ServerListRefresh(added: 2) }
            return ServerList(servers: [])
        }
        let model = ServersModel(session: makeSignedInSession(clients: clients))
        await model.refresh()
        let kinds = clients.calls.compactMap { call -> String? in
            if call.endpoint is Endpoints.RefreshServerList { return "refresh" }
            if call.endpoint is Endpoints.Servers { return "servers" }
            return nil
        }
        #expect(kinds == ["refresh", "servers"])
        #expect(model.hasLoaded)
        #expect(model.refreshNote == "2 new servers were found.")
    }

    @Test("An older Sylo without the call still loads the list, with nothing to say")
    func olderServer() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.RefreshServerList { throw NetworkError.notFound }
            return ServerList(servers: [])
        }
        let model = ServersModel(session: makeSignedInSession(clients: clients))
        await model.refresh()
        #expect(model.hasLoaded)
        #expect(model.refreshNote == nil)
        #expect(model.errorMessage == nil)
    }

    @Test("A refresh within 30 seconds is refused by the server: the list loads and the note asks to wait")
    func tooSoon() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.RefreshServerList { throw NetworkError.rateLimited }
            return ServerList(servers: [])
        }
        let model = ServersModel(session: makeSignedInSession(clients: clients))
        await model.refresh()
        #expect(model.hasLoaded)
        #expect(model.refreshNote?.contains("Wait a few seconds") == true)
    }

    @Test("A plain load sends no refresh, and nothing found says nothing")
    func plainLoad() async throws {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.RefreshServerList { return ServerListRefresh(added: 0) }
            return ServerList(servers: [])
        }
        let model = ServersModel(session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.RefreshServerList })
        await model.refresh()
        #expect(model.refreshNote == nil)
        #expect(try JSONDecoder().decode(ServerListRefresh.self, from: Data(#"{"ok":true,"added":-3}"#.utf8)).added == 0)
    }
}
