import Foundation
import Testing
@testable import SyloKit

@Suite("Ticket endpoints")
struct TicketEndpointsTests {
    let fluxer: ServerID = "fluxer:1"

    private func json(_ endpoint: some APIEndpoint) throws -> [String: String] {
        let body = try #require(endpoint.body)
        return try JSONDecoder().decode([String: String].self, from: JSONEncoder().encode(body))
    }

    @Test("The list and one ticket are GETs below the server's tickets path")
    func reads() {
        let list = Endpoints.Tickets(server: fluxer)
        #expect(list.path == "/api/v2/guilds/fluxer%3A1/tickets")
        #expect(list.method == .get)
        #expect(list.body == nil)
        #expect(list.query.isEmpty)

        let ticket = Endpoints.Ticket(server: fluxer, id: 12)
        #expect(ticket.path == "/api/v2/guilds/fluxer%3A1/tickets/12")
        #expect(ticket.method == .get)
        #expect(Endpoints.Ticket(server: "123", id: 5).path == "/api/v2/guilds/123/tickets/5")
    }

    @Test("New messages are asked for after the last one seen")
    func messages() {
        let e = Endpoints.TicketMessages(server: fluxer, id: 12, after: 42)
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/tickets/12/messages")
        #expect(e.method == .get)
        #expect(e.query == [URLQueryItem(name: "after", value: "42")])
    }

    @Test("A reply posts its content")
    func reply() throws {
        let e = Endpoints.ReplyToTicket(server: fluxer, id: 12, content: "On it")
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/tickets/12/reply")
        #expect(e.method == .post)
        #expect(try json(e) == ["content": "On it"])
    }

    @Test("Closing posts the closing message as content")
    func close() throws {
        let e = Endpoints.CloseTicket(server: fluxer, id: 12, message: "Solved, thanks")
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/tickets/12/close")
        #expect(e.method == .post)
        #expect(try json(e) == ["content": "Solved, thanks"])
        #expect(try json(Endpoints.CloseTicket(server: fluxer, id: 12, message: "")) == ["content": ""])
    }

    @Test("Every ticket call is signed in")
    func signedIn() {
        let all: [any APIEndpoint] = [
            Endpoints.Tickets(server: fluxer), Endpoints.Ticket(server: fluxer, id: 1),
            Endpoints.TicketMessages(server: fluxer, id: 1, after: 0),
            Endpoints.ReplyToTicket(server: fluxer, id: 1, content: "x"),
            Endpoints.CloseTicket(server: fluxer, id: 1, message: ""),
        ]
        for endpoint in all { #expect(endpoint.requiresAuth, "\(endpoint.path)") }
    }
}
