import Foundation
import Testing
@testable import SyloKit

@Suite("Member search models")
struct MemberSearchModelsTests {
    @Test("A search answer is read, with a missing name falling back to the id and a broken entry dropped")
    func decodes() throws {
        let json = #"""
        {"members":[{"id":"111111111111111111","name":"Alex","username":"alex_99"},
                    {"id":"222222222222222222"},
                    {"name":"no id"}]}
        """#
        let result = try JSONDecoder().decode(MemberSearchResult.self, from: Data(json.utf8))
        #expect(result.members == [
            MemberMatch(id: "111111111111111111", name: "Alex", username: "alex_99"),
            MemberMatch(id: "222222222222222222", name: "222222222222222222"),
        ])
        #expect(try JSONDecoder().decode(MemberSearchResult.self, from: Data("{}".utf8)).members.isEmpty)
    }

    @Test("Ids and mentions are read out of what was pasted", arguments: [
        ("123456789012345678", "123456789012345678"),
        ("  123456789012345678\n", "123456789012345678"),
        ("<@123456789012345678>", "123456789012345678"),
        ("<@!123456789012345678>", "123456789012345678"),
        (" <@123456789012345678> ", "123456789012345678"),
        ("12345678901234567", "12345678901234567"),
        ("12345678901234567890", "12345678901234567890"),
    ])
    func readsIDs(text: String, expected: String) {
        #expect(MemberReference.id(in: text) == expected)
    }

    @Test("Anything else is not an id", arguments: [
        "", "alex", "1234567890123456", "123456789012345678901", "<@&123456789012345678>",
        "<#123456789012345678>", "@123456789012345678", "<@123456789012345678", "12345678901234567x",
        "123456789 012345678", "<@!>", "\u{0661}\u{0662}\u{0663}\u{0664}\u{0665}\u{0666}\u{0667}\u{0668}\u{0669}\u{0661}\u{0662}\u{0663}\u{0664}\u{0665}\u{0666}\u{0667}\u{0668}",
    ])
    func rejectsNonIDs(text: String) {
        #expect(MemberReference.id(in: text) == nil)
    }

    @Test("A choice shows the name, or the id when only that is known")
    func choice() {
        let named = MemberChoice(MemberMatch(id: "1", name: "Alex", username: "a"))
        #expect(named.id == "1")
        #expect(named.name == "Alex")
        #expect(named.hasName)

        let pasted = MemberChoice(id: "123456789012345678")
        #expect(pasted.name == "123456789012345678")
        #expect(!pasted.hasName)
        #expect(MemberChoice(id: "5", name: "").name == "5")
    }

    @Test("The two search calls differ only in path, and carry the text as q")
    func endpoints() {
        let search = Endpoints.SearchMembers(server: "fluxer:123", text: "al ex")
        #expect(search.path == "/api/v2/guilds/fluxer%3A123/members")
        #expect(search.method == .get)
        #expect(search.query == [URLQueryItem(name: "q", value: "al ex")])

        let fallback = Endpoints.SearchTempRoleMembers(server: "1", text: "al")
        #expect(fallback.path == "/api/v2/guilds/1/modules/temp-roles/members")
        #expect(fallback.query == [URLQueryItem(name: "q", value: "al")])

        // The server cuts the text at 100 characters; so does the app.
        let long = Endpoints.SearchMembers(server: "1", text: String(repeating: "a", count: 150))
        #expect(long.query.first?.value?.count == 100)
    }
}

@MainActor
@Suite("Member search")
struct MemberSearchTests {
    nonisolated static let alex = MemberMatch(id: "111111111111111111", name: "Alex", username: "alex_99")
    nonisolated static let alexis = MemberMatch(id: "222222222222222222", name: "Alexis", username: "alexis")

    private func count<E: APIEndpoint>(_ type: E.Type, in clients: StubClients) -> Int {
        clients.calls.filter { $0.endpoint is E }.count
    }

    @Test("A search asks the server's member search and lists the matches")
    func searches() async {
        let clients = StubClients { endpoint in
            guard let search = endpoint as? Endpoints.SearchMembers else { throw NetworkError.notFound }
            #expect(search.text == "alex")
            return MemberSearchResult(members: [Self.alex, Self.alexis])
        }
        let model = MemberSearchModel(server: "1", session: makeSignedInSession(clients: clients))
        model.query = "  alex "
        await model.search()
        #expect(model.results == [Self.alex, Self.alexis])
        #expect(model.searchedText == "alex")
        #expect(model.errorMessage == nil)
        #expect(model.isAvailable)
        #expect(!model.isSearching)
        #expect(count(Endpoints.SearchTempRoleMembers.self, in: clients) == 0)
    }

    @Test("A server without /members falls back to the Temporary roles search, and remembers it")
    func fallsBack() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.SearchMembers { throw NetworkError.notFound }
            return MemberSearchResult(members: [Self.alex])
        }
        let model = MemberSearchModel(server: "1", session: makeSignedInSession(clients: clients))
        model.query = "alex"
        await model.search()
        #expect(model.results == [Self.alex])
        #expect(model.isAvailable)
        #expect(model.errorMessage == nil)
        #expect(count(Endpoints.SearchMembers.self, in: clients) == 1)
        #expect(count(Endpoints.SearchTempRoleMembers.self, in: clients) == 1)

        model.query = "alexi"
        await model.search()
        // The second search goes straight to the fallback.
        #expect(count(Endpoints.SearchMembers.self, in: clients) == 1)
        #expect(count(Endpoints.SearchTempRoleMembers.self, in: clients) == 2)
    }

    @Test("When neither route exists, search is unavailable and stops asking")
    func unavailable() async {
        let clients = StubClients { _ in throw NetworkError.notFound }
        let model = MemberSearchModel(server: "1", session: makeSignedInSession(clients: clients))
        model.query = "alex"
        await model.search()
        #expect(!model.isAvailable)
        #expect(model.results.isEmpty)
        // Not an error to show: the screen says search is unavailable and offers the id.
        #expect(model.errorMessage == nil)
        let asked = clients.calls.count

        model.query = "alexis"
        await model.search()
        #expect(clients.calls.count == asked)
    }

    @Test("Empty text clears the results without a call")
    func emptyClears() async {
        let clients = StubClients { _ in MemberSearchResult(members: [Self.alex]) }
        let model = MemberSearchModel(server: "1", session: makeSignedInSession(clients: clients))
        model.query = "alex"
        await model.search()
        #expect(model.results.count == 1)
        let asked = clients.calls.count

        model.query = "   "
        await model.search()
        #expect(model.results.isEmpty)
        #expect(model.searchedText == nil)
        #expect(clients.calls.count == asked)
    }

    @Test("A failed search says why and keeps the earlier results")
    func failure() async {
        let clients = StubClients { _ in MemberSearchResult(members: [Self.alex]) }
        let model = MemberSearchModel(server: "1", session: makeSignedInSession(clients: clients))
        model.query = "alex"
        await model.search()

        clients.setHandler { _ in throw NetworkError.offline }
        model.query = "alexi"
        await model.search()
        #expect(model.errorMessage == NetworkError.offline.userMessage)
        #expect(model.results == [Self.alex])
        #expect(model.isAvailable)

        clients.setHandler { _ in MemberSearchResult(members: []) }
        await model.search()
        #expect(model.errorMessage == nil)
        #expect(model.results.isEmpty)
        #expect(model.searchedText == "alexi")
    }

    @Test("A pasted mention is searched as its id")
    func mentionSearchedAsID() async {
        let clients = StubClients { endpoint in
            guard let search = endpoint as? Endpoints.SearchMembers else { throw NetworkError.notFound }
            #expect(search.text == "111111111111111111")
            return MemberSearchResult(members: [Self.alex])
        }
        let model = MemberSearchModel(server: "1", session: makeSignedInSession(clients: clients))
        model.query = "<@!111111111111111111>"
        await model.search()
        #expect(model.results == [Self.alex])
        #expect(model.searchedText == "<@!111111111111111111>")
    }

    @Test("What one search learned about the routes is kept for the sign-in, across pickers")
    func routeKeptOnSession() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.SearchMembers { throw NetworkError.notFound }
            return MemberSearchResult(members: [Self.alex])
        }
        let session = makeSignedInSession(clients: clients)
        let first = MemberSearchModel(server: "1", session: session)
        first.query = "al"
        await first.search()
        #expect(session.memberSearchRoute == .tempRoles)

        let second = MemberSearchModel(server: "1", session: session)
        second.query = "alex"
        await second.search()
        #expect(count(Endpoints.SearchMembers.self, in: clients) == 1)
        #expect(count(Endpoints.SearchTempRoleMembers.self, in: clients) == 2)
    }

    @Test("An older search that ends does not switch the spinner off under a newer one")
    func spinnerStaysForNewest() async {
        let clients = StubClients { _ in MemberSearchResult(members: [Self.alex]) }
        let session = makeSignedInSession(clients: clients)
        let model = MemberSearchModel(server: "1", session: session)
        // The newest search is the one that decides: after an empty one the spinner is off.
        model.query = "al"
        await model.search()
        #expect(!model.isSearching)
        model.query = ""
        await model.search()
        #expect(!model.isSearching)
        #expect(model.results.isEmpty)
    }

    @Test("A 401 signs the app out and shows no search error")
    func unauthorized() async {
        let clients = StubClients { _ in throw NetworkError.unauthorized }
        let session = makeSignedInSession(clients: clients)
        let model = MemberSearchModel(server: "1", session: session)
        model.query = "alex"
        await model.search()
        #expect(model.errorMessage == nil)
        #expect(session.notice == NetworkError.unauthorized.userMessage)
    }

    @Test("The pasted id is read from the typed text")
    func pastedID() {
        let model = MemberSearchModel(server: "1", session: makeSignedInSession(clients: StubClients { _ in throw NetworkError.notFound }))
        #expect(model.pastedID == nil)
        model.query = "<@!123456789012345678>"
        #expect(model.pastedID == "123456789012345678")
        model.query = "alex"
        #expect(model.pastedID == nil)
    }
}

extension APIClientTests {
    @Test("A member search goes to /members with the text as q, and falls back on the wire")
    func memberSearchOnTheWire() async throws {
        let mock = MockURLProtocol.state
        let client = URLSessionAPIClient(
            server: try ServerURL("https://example.com/sylo"), session: MockURLProtocol.session(), decoder: JSONDecoder(),
            retryDelays: [.zero, .zero], token: { "sylo_secret" })

        mock.reset([.json(200, #"{"members":[{"id":"111111111111111111","name":"Alex","username":"alex_99"}]}"#)])
        let found = try await client.send(Endpoints.SearchMembers(server: "fluxer:1", text: "al ex"))
        #expect(found.members.first?.name == "Alex")
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/fluxer%3A1/members?q=al%20ex")
        #expect(request.method == "GET")
        #expect(request.header("Authorization") == "Bearer sylo_secret")

        mock.reset([.json(404, #"{"error":"Not found"}"#)])
        await #expect(throws: NetworkError.notFound) {
            try await client.send(Endpoints.SearchMembers(server: "1", text: "al"))
        }

        mock.reset([.json(200, #"{"members":[]}"#)])
        _ = try await client.send(Endpoints.SearchTempRoleMembers(server: "1", text: "al"))
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/temp-roles/members?q=al")
    }
}
