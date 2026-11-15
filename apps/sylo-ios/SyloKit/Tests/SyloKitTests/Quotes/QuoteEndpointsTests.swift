import Foundation
import Testing
@testable import SyloKit

@Suite("Quote search and delete")
struct QuoteEndpointsTests {
    let fluxer: ServerID = "fluxer:1"

    /// `GET /modules/quote-board/list` as src/web/routes/v2Quotes.js sends it.
    static let listJSON = #"""
    {"total": 41, "quotes": [
      {"number": 7, "authorId": "810000000000000001", "author": "Alex", "text": "I meant to do that.",
       "attachments": 1, "channelId": "222222222222222222", "channel": "general", "messageAt": 1794000000000,
       "savedBy": "810000000000000002", "savedAt": 1794000100000, "publicSource": true,
       "url": "https://discord.com/channels/1/2/3"},
      {"number": 6, "author": "Sam", "text": "", "attachments": 0, "channel": null, "publicSource": false, "url": null}
    ]}
    """#

    @Test("the list answer carries the number of quotes in all, not only the ones that match")
    func decodes() throws {
        let answer = try JSONDecoder().decode(QuoteListAnswer.self, from: Data(Self.listJSON.utf8))
        #expect(answer.total == 41)
        #expect(answer.quotes.map(\.number) == [7, 6])
        #expect(answer.quotes[0].author == "Alex")
        #expect(answer.quotes[1].channel == nil)
        #expect(!answer.quotes[1].publicSource)
        // A server that sends no total reports what it listed; a quote that does not read is dropped.
        let bare = try JSONDecoder().decode(
            QuoteListAnswer.self, from: Data(#"{"quotes":[{"number":1},{"author":"no number"}]}"#.utf8))
        #expect(bare.total == 1)
        #expect(bare.quotes.map(\.number) == [1])
    }

    @Test("a search is cleaned the way the server cleans it")
    func normalises() {
        #expect(QuoteSearch.normalised("  meant   to \n do ") == "meant to do")
        #expect(QuoteSearch.normalised("") == "")
        #expect(QuoteSearch.normalised("   ") == "")
        #expect(QuoteSearch.normalised(String(repeating: "a", count: 150)).count == QuoteSearch.maxLength)
        #expect(QuoteSearch.maxLength == 100)
    }

    @Test("the list is a GET with the search as q, cleaned")
    func listEndpoint() {
        let newest = Endpoints.QuoteList(server: fluxer)
        #expect(newest.path == "/api/v2/guilds/fluxer%3A1/modules/quote-board/list")
        #expect(newest.method == .get)
        #expect(newest.body == nil)
        #expect(newest.requiresAuth)
        #expect(newest.query == [URLQueryItem(name: "q", value: "")])
        let search = Endpoints.QuoteList(server: "1", search: "  meant   to ")
        #expect(search.query == [URLQueryItem(name: "q", value: "meant to")])
    }

    @Test("a delete is a POST of an empty object to the quote's number")
    func deleteEndpoint() throws {
        let e = Endpoints.DeleteQuote(server: fluxer, number: 7)
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/modules/quote-board/7/delete")
        #expect(e.method == .post)
        #expect(e.requiresAuth)
        let body = try #require(e.body)
        let sent = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        #expect(sent.isEmpty)
    }
}

@MainActor
@Suite("Quote list model")
struct QuoteListModelTests {
    nonisolated static func quote(_ number: Int) -> QuoteSummary {
        QuoteSummary(number: number, author: "Alex", text: "Quote \(number)")
    }

    @Test("the page's newest quotes are taken over without a call, and a search is run again instead")
    func adopts() async throws {
        let clients = StubClients { _ in QuoteListAnswer(total: 9, quotes: [Self.quote(2)]) }
        let model = QuoteListModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(!model.hasLoaded)
        let page = QuoteBoardPage(settings: QuoteBoardSettings(), total: 5, quotes: [Self.quote(5), Self.quote(4)])
        await model.adopt(page)
        #expect(model.quotes.map(\.number) == [5, 4])
        #expect(model.total == 5)
        #expect(model.hasLoaded)
        #expect(clients.calls.isEmpty)

        await model.load(search: "alex")
        #expect(model.search == "alex")
        await model.adopt(page)
        #expect(model.quotes.map(\.number) == [2])
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.QuoteList)
        #expect(sent.search == "alex")
    }

    @Test("searching sends the cleaned text and keeps the old list when the call fails")
    func searches() async throws {
        let clients = StubClients { _ in QuoteListAnswer(total: 41, quotes: [Self.quote(7)]) }
        let model = QuoteListModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load(search: "  meant  to ")
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.QuoteList)
        #expect(sent.search == "meant to")
        #expect(model.search == "meant to")
        #expect(model.quotes.map(\.number) == [7])
        #expect(model.total == 41)

        clients.setHandler { _ in throw NetworkError.offline }
        await model.load(search: "other")
        #expect(model.quotes.map(\.number) == [7])
        #expect(model.search == "meant to")
        #expect(model.errorMessage == NetworkError.offline.userMessage)
    }

    @Test("deleting a quote posts its number and fetches the same search again")
    func deletes() async throws {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.DeleteQuote { return OKResponse() }
            return QuoteListAnswer(total: 1, quotes: [Self.quote(1)])
        }
        let model = QuoteListModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load(search: "quote")
        #expect(await model.delete(Self.quote(7)))
        let delete = try #require(clients.calls.first(where: { $0.endpoint is Endpoints.DeleteQuote })?.endpoint
            as? Endpoints.DeleteQuote)
        #expect(delete.number == 7)
        let refetch = try #require(clients.calls.last?.endpoint as? Endpoints.QuoteList)
        #expect(refetch.search == "quote")
        #expect(model.deleteCount == 1)
        #expect(model.actionError == nil)
    }

    @Test("a quote that is already gone is explained and the list is left alone")
    func deleteFails() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.DeleteQuote { throw NetworkError.notFound }
            return QuoteListAnswer(total: 1, quotes: [Self.quote(1)])
        }
        let model = QuoteListModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(await model.delete(Self.quote(7)) == false)
        #expect(model.actionError == NetworkError.notFound.userMessage)
        #expect(model.deleteCount == 0)
        #expect(clients.calls.count == 1)
    }
}
