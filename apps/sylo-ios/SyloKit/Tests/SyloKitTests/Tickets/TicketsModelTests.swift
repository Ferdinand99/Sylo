import Foundation
import Testing
@testable import SyloKit

@MainActor
@Suite("Tickets model")
struct TicketsModelTests {
    nonisolated static let list = TicketList(
        open: [
            TicketSummary(id: 12, user: "ferdi", userId: "1", preview: "Help", previewKind: .user, ago: "5m ago", isUnread: true),
            TicketSummary(id: 11, user: "sam", userId: "2", preview: "Thanks", previewKind: .staff, ago: "1h ago"),
            TicketSummary(id: 10, user: "kim", userId: "3", preview: "Hello?", previewKind: .user, ago: "2h ago", isUnread: true),
        ],
        closed: [
            TicketSummary(id: 3, user: "lee", userId: "4", preview: "Bye", ago: "3d ago", isUnread: true),
        ])

    @Test("loading shows the list and counts the unread open tickets")
    func loads() async throws {
        let clients = StubClients { _ in Self.list }
        let model = TicketsModel(server: "fluxer:1", session: makeSignedInSession(clients: clients))
        #expect(model.unreadCount == 0)
        await model.load()
        #expect(model.list == Self.list)
        #expect(model.errorMessage == nil)
        #expect(!model.isLoading)
        #expect(model.unreadCount == 2)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.Tickets)
        #expect(sent.path == "/api/v2/guilds/fluxer%3A1/tickets")
    }

    @Test("a failed load explains and keeps the list it had; a later load clears it")
    func failedLoad() async {
        let clients = StubClients { _ in Self.list }
        let model = TicketsModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()

        clients.setHandler { _ in throw NetworkError.forbidden(message: nil) }
        await model.load()
        #expect(model.list == Self.list)
        #expect(model.errorMessage == NetworkError.forbidden(message: nil).userMessage)

        clients.setHandler { _ in Self.list }
        await model.load()
        #expect(model.errorMessage == nil)
    }

    @Test("a cancelled load says nothing")
    func cancelledLoad() async {
        let clients = StubClients { _ in throw NetworkError.cancelled }
        let model = TicketsModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.list == nil)
        #expect(model.errorMessage == nil)
    }

    @Test("closing a ticket from the list sends no message, reloads the list and counts the close")
    func closesFromTheList() async throws {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.CloseTicket { return OKResponse() }
            return Self.list
        }
        let model = TicketsModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        let closed = await model.close(11)
        #expect(closed)
        #expect(model.closeCount == 1)
        #expect(!model.isClosing(11))
        let closeCalls = clients.calls.compactMap { $0.endpoint as? Endpoints.CloseTicket }
        let close = try #require(closeCalls.first)
        #expect(close.id == 11)
        #expect(close.message == "")
        #expect(clients.calls.last?.endpoint is Endpoints.Tickets)
    }

    @Test("a close that fails explains and does not count; the ticket can be closed again")
    func failedClose() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.CloseTicket { throw NetworkError.forbidden(message: nil) }
            return Self.list
        }
        let model = TicketsModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        let closed = await model.close(11)
        #expect(!closed)
        #expect(model.actionError == NetworkError.forbidden(message: nil).userMessage)
        #expect(model.closeCount == 0)
        #expect(!model.isClosing(11))
    }
}
