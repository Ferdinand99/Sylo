import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

@Suite("Inbox number lookup")
struct InboxQueryTests {
    @Test("The shapes the server reads")
    func parses() {
        #expect(InboxQuery.parse("12") == InboxQuery.Parsed(kind: nil, number: 12))
        #expect(InboxQuery.parse("#12") == InboxQuery.Parsed(kind: nil, number: 12))
        #expect(InboxQuery.parse("  # 12  ") == InboxQuery.Parsed(kind: nil, number: 12))
        #expect(InboxQuery.parse("ticket 12") == InboxQuery.Parsed(kind: .ticket, number: 12))
        #expect(InboxQuery.parse("Ticket #12") == InboxQuery.Parsed(kind: .ticket, number: 12))
        #expect(InboxQuery.parse("suggestions #5") == InboxQuery.Parsed(kind: .suggestion, number: 5))
        #expect(InboxQuery.parse("appeal3") == InboxQuery.Parsed(kind: .appeal, number: 3))
        #expect(InboxQuery.parse("application 4") == InboxQuery.Parsed(kind: .application, number: 4))
    }

    @Test("Anything else is not a number")
    func rejects() {
        #expect(InboxQuery.parse("") == nil)
        #expect(InboxQuery.parse("welcome") == nil)
        #expect(InboxQuery.parse("ticket") == nil)
        #expect(InboxQuery.parse("0") == nil)
        #expect(InboxQuery.parse("12 ticket") == nil)
        #expect(InboxQuery.parse("1234567890") == nil)
        #expect(InboxQuery.parse("ticket 1.5") == nil)
    }

    @Test("The call carries the text, cut to what the server reads")
    func endpoint() {
        let call = Endpoints.SearchInbox(server: "fluxer:9", text: "ticket 12")
        #expect(call.path == "/api/v2/guilds/fluxer%3A9/search/inbox")
        #expect(call.query == [URLQueryItem(name: "q", value: "ticket 12")])
    }

    @Test("The answer holds numbers and states, no text")
    func answer() throws {
        let found = try decode(InboxSearchAnswer.self, #"""
            {"items":[{"kind":"ticket","number":12,"status":"open","href":"/x"},{"kind":"suggestion","number":12,"status":"approved"},{"nope":1}]}
            """#)
        #expect(found.items.map(\.id) == ["ticket-12", "suggestion-12"])
        #expect(found.items[0].kind.title == "Ticket")
        #expect(InboxItemKind.appeal.title == "Ban appeal")
        #expect(try decode(InboxSearchAnswer.self, "{}").items.isEmpty)
    }
}

@Suite("Search ranking")
struct SearchIndexTests {
    private func overview() throws -> ServerOverview {
        try decode(ServerOverview.self, #"""
            {"guild":{"id":"1","name":"A"},"groups":[
              {"title":"Core","cards":[
                {"kind":"link","id":"general","name":"Settings","hasToggle":false,"status":"link"},
                {"kind":"link","id":"commands","name":"Commands","hasToggle":false,"status":"link"},
                {"kind":"module","id":"tickets","name":"Tickets","icon":"inbox","hasToggle":true,"enabled":true,"status":"on"}]},
              {"title":"Engagement","cards":[
                {"kind":"module","id":"leveling","name":"Leveling","hasToggle":true,"enabled":false,"status":"off"},
                {"kind":"module","id":"starboard","name":"Starboard","hasToggle":true,"enabled":true,"status":"on"}]}]}
            """#)
    }

    private func items() throws -> [SearchItem] {
        SearchIndex.items(overview: try overview(), pages: [.tickets, .auditLog, .settings])
    }

    @Test("Every page and module is listed, also a module that is off; link cards are pages, not modules")
    func lists() throws {
        let items = try items()
        #expect(items.map(\.id) == ["page:tickets", "page:auditLog", "page:settings", "module:tickets", "module:leveling", "module:starboard"])
        let leveling = try #require(items.first { $0.id == "module:leveling" })
        #expect(leveling.hint == "Engagement \u{00B7} Off")
        #expect(leveling.target == .module("leveling"))
    }

    @Test("With nothing typed the pages are listed")
    func empty() throws {
        #expect(SearchIndex.ranked(try items(), query: "  ").map(\.id) == ["page:tickets", "page:auditLog", "page:settings"])
    }

    @Test("A title that starts with the word beats one that only contains it")
    func ranking() throws {
        let ranked = SearchIndex.ranked(try items(), query: "tick")
        #expect(ranked.map(\.id) == ["page:tickets", "module:tickets"])
        #expect(SearchIndex.ranked(try items(), query: "star").first?.id == "module:starboard")
    }

    @Test("The old name Tickets had is still found, and accents and case do not matter")
    func keywords() throws {
        #expect(SearchIndex.ranked(try items(), query: "modmail").map(\.id) == ["page:tickets"])
        #expect(SearchIndex.ranked(try items(), query: "AUDIT").map(\.id) == ["page:auditLog"])
        #expect(SearchIndex.ranked(try items(), query: "LEVELÍNG").map(\.id) == ["module:leveling"])
    }

    @Test("Every word must be found")
    func everyWord() throws {
        #expect(SearchIndex.ranked(try items(), query: "audit zzz").isEmpty)
        #expect(SearchIndex.ranked(try items(), query: "audit log").map(\.id) == ["page:auditLog"])
    }

    @Test("What the lookups found comes first")
    func foundFirst() throws {
        let found = [SearchItem(id: "inbox:ticket-12", group: .inboxItems, title: "Ticket #12", symbol: "number",
                                target: .inbox(kind: .ticket, number: 12))]
        let ranked = SearchIndex.ranked(try items(), query: "ticket 12", found: found)
        #expect(ranked.first?.id == "inbox:ticket-12")
    }
}

@MainActor
@Suite("Server search model")
struct ServerSearchModelTests {
    nonisolated static let members = try! decode(MemberSearchResult.self, #"{"members":[{"id":"7","name":"Alex","username":"alex"}]}"#)

    @Test("A number finds the inbox item and members by the same text")
    func numberAndMembers() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.SearchInbox {
                return InboxSearchAnswer(items: [InboxHit(kind: .ticket, number: 12, status: "open")])
            }
            return Self.members
        }
        let model = ServerSearchModel(server: "1", session: makeSignedInSession(clients: clients))
        model.query = "ticket 12"
        await model.search()
        #expect(model.inboxHits.map(\.id) == ["ticket-12"])
        #expect(model.members.map(\.id) == ["7"])
        let found = model.foundItems
        #expect(found.map(\.group) == [.inboxItems, .members])
        #expect(found[0].title == "Ticket #12")
        #expect(found[0].target == .inbox(kind: .ticket, number: 12))
        #expect(found[1].target == .member(id: "7", name: "Alex"))
    }

    @Test("A word is a member search only: the inbox is not asked")
    func wordOnly() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.SearchInbox { throw NetworkError.notFound }
            return Self.members
        }
        let model = ServerSearchModel(server: "1", session: makeSignedInSession(clients: clients))
        model.query = "alex"
        await model.search()
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.SearchInbox })
        #expect(model.members.map(\.name) == ["Alex"])
        #expect(model.inboxHits.isEmpty)
    }

    @Test("A Sylo without the lookup answers 404 once and is not asked again")
    func noLookup() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.SearchInbox { throw NetworkError.notFound }
            return Self.members
        }
        let model = ServerSearchModel(server: "1", session: makeSignedInSession(clients: clients))
        model.query = "12"
        await model.search()
        #expect(!model.hasInboxLookup)
        #expect(model.inboxHits.isEmpty)
        model.query = "13"
        await model.search()
        #expect(clients.calls.filter { $0.endpoint is Endpoints.SearchInbox }.count == 1)
    }

    @Test("Clearing the text clears the results")
    func clears() async {
        let clients = StubClients { _ in Self.members }
        let model = ServerSearchModel(server: "1", session: makeSignedInSession(clients: clients))
        model.query = "alex"
        await model.search()
        #expect(!model.members.isEmpty)
        model.query = ""
        await model.search()
        #expect(model.members.isEmpty)
        #expect(model.foundItems.isEmpty)
    }
}
