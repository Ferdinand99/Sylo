import Foundation
import Testing
@testable import SyloKit

/// A value the stub's `@Sendable` handler reads while a test changes it.
private final class Box<Value: Sendable>: @unchecked Sendable {
    // @unchecked: `stored` is only touched while holding `lock`.
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

@MainActor
@Suite("Ticket thread model")
struct TicketThreadModelTests {
    nonisolated static func message(_ id: Int, _ kind: TicketAuthorKind = .user, _ content: String = "Hi") -> TicketMessage {
        TicketMessage(id: id, kind: kind, who: kind == .user ? "ferdi" : "Staff", content: content, ago: "1m ago")
    }

    nonisolated static func info(_ status: TicketStatus) -> TicketInfo {
        TicketInfo(id: 12, status: status, user: "ferdi", userId: "1", openedAgo: "1h ago")
    }

    nonisolated static let thread = TicketThread(ticket: info(.open), messages: [message(40), message(41, .staff)], lastId: 41)

    /// Answers each ticket call; by default the server has nothing new and takes every reply.
    static func clients(
        thread: @escaping @Sendable () -> TicketThread = { Self.thread },
        update: @escaping @Sendable (Endpoints.TicketMessages) throws -> TicketUpdate = { _ in
            TicketUpdate(status: .open, messages: [])
        },
        reply: @escaping @Sendable (Endpoints.ReplyToTicket) throws -> TicketReplyResult = { _ in
            TicketReplyResult(ok: true, isDelivered: true)
        },
        close: @escaping @Sendable (Endpoints.CloseTicket) throws -> OKResponse = { _ in OKResponse() }
    ) -> StubClients {
        StubClients { endpoint in
            switch endpoint {
            case let e as Endpoints.TicketMessages: return try update(e)
            case let e as Endpoints.ReplyToTicket: return try reply(e)
            case let e as Endpoints.CloseTicket: return try close(e)
            default: return thread()
            }
        }
    }

    func loadedModel(_ clients: StubClients) async -> TicketThreadModel {
        let model = TicketThreadModel(server: "fluxer:1", ticketID: 12, session: makeSignedInSession(clients: clients))
        await model.load()
        return model
    }

    func calls<E: APIEndpoint>(_ type: E.Type, _ clients: StubClients) -> [E] {
        clients.calls.compactMap { $0.endpoint as? E }
    }

    // MARK: - Loading

    @Test("loading shows the ticket and its messages, once each")
    func loads() async throws {
        let doubled = TicketThread(ticket: Self.info(.open), messages: [Self.message(40), Self.message(41), Self.message(41)], lastId: 41)
        let clients = Self.clients(thread: { doubled })
        let model = await loadedModel(clients)
        #expect(model.ticket == Self.info(.open))
        #expect(model.messages.map(\.id) == [40, 41])
        #expect(!model.isClosed)
        #expect(!model.isLoading)
        #expect(model.errorMessage == nil)
        let sent = try #require(calls(Endpoints.Ticket.self, clients).first)
        #expect(sent.path == "/api/v2/guilds/fluxer%3A1/tickets/12")
    }

    @Test("a failed load explains; a cancelled one says nothing")
    func failedLoad() async {
        let clients = StubClients { _ in throw NetworkError.notFound }
        let model = await loadedModel(clients)
        #expect(model.ticket == nil)
        #expect(model.errorMessage == NetworkError.notFound.userMessage)

        let quiet = await loadedModel(StubClients { _ in throw NetworkError.cancelled })
        #expect(quiet.errorMessage == nil)
    }

    // MARK: - Refreshing

    @Test("refreshing asks for what came after the last message, adds only new ones and takes the status")
    func refreshes() async throws {
        let clients = Self.clients(update: { _ in
            TicketUpdate(status: .closed, messages: [Self.message(41, .staff), Self.message(42, .system, "Closed")])
        })
        let model = await loadedModel(clients)
        await model.refresh()
        #expect(model.messages.map(\.id) == [40, 41, 42])
        #expect(model.ticket?.status == .closed)
        #expect(model.isClosed)
        let sent = try #require(calls(Endpoints.TicketMessages.self, clients).last)
        #expect(sent.after == 41)
        #expect(sent.id == 12)

        await model.refresh()
        let next = try #require(calls(Endpoints.TicketMessages.self, clients).last)
        #expect(next.after == 42)
        #expect(model.messages.map(\.id) == [40, 41, 42])
    }

    @Test("a failed refresh says nothing and keeps the messages")
    func quietRefresh() async {
        let clients = Self.clients(update: { _ in throw NetworkError.offline })
        let model = await loadedModel(clients)
        await model.refresh()
        #expect(model.errorMessage == nil)
        #expect(model.messages.map(\.id) == [40, 41])
    }

    @Test("polling stops when its task is cancelled")
    func pollStops() async {
        let model = await loadedModel(Self.clients())
        let task = Task { await model.poll(every: .seconds(60)) }
        task.cancel()
        await task.value
    }

    // MARK: - Replying

    @Test("a reply shows at once, trimmed, then gives way to the server's copy")
    func sends() async throws {
        let sentReply = Box(false)
        let clients = Self.clients(
            update: { _ in
                TicketUpdate(status: .open, messages: sentReply.value ? [Self.message(42, .staff, "On it")] : [])
            },
            reply: { _ in
                sentReply.value = true
                return TicketReplyResult(ok: true, isDelivered: true)
            })
        let model = await loadedModel(clients)
        let task = try #require(model.send("  On it \n"))
        #expect(model.outgoing.count == 1)
        #expect(model.outgoing.first?.content == "On it")
        #expect(model.outgoing.first?.state == .sending)
        await task.value
        #expect(model.outgoing.isEmpty)
        #expect(model.messages.map(\.id) == [40, 41, 42])
        #expect(model.deliveryWarning == nil)
        let sent = try #require(calls(Endpoints.ReplyToTicket.self, clients).first)
        #expect(sent.content == "On it")
        #expect(sent.id == 12)
    }

    @Test("a reply the member did not get as a DM warns")
    func undelivered() async throws {
        let model = await loadedModel(Self.clients(reply: { _ in TicketReplyResult(ok: true, isDelivered: false) }))
        await model.send("On it")?.value
        #expect(model.outgoing.isEmpty)
        #expect(model.deliveryWarning != nil)
    }

    @Test("a failed reply stays, marked failed with the reason")
    func failedSend() async throws {
        let model = await loadedModel(Self.clients(reply: { _ in throw NetworkError.offline }))
        await model.send("On it")?.value
        #expect(model.outgoing.count == 1)
        #expect(model.outgoing.first?.content == "On it")
        #expect(model.outgoing.first?.state == .failed(NetworkError.offline.userMessage))
    }

    @Test("a reply to a ticket closed meanwhile fails and picks up the closed status")
    func closedMeanwhile() async throws {
        let clients = Self.clients(
            update: { _ in TicketUpdate(status: .closed, messages: []) },
            reply: { _ in throw NetworkError.http(status: 409) })
        let model = await loadedModel(clients)
        await model.send("On it")?.value
        guard case .failed(let reason)? = model.outgoing.first?.state else {
            Issue.record("expected a failed reply")
            return
        }
        #expect(!reason.isEmpty)
        #expect(model.isClosed)
        #expect(!calls(Endpoints.TicketMessages.self, clients).isEmpty)
    }

    @Test("empty, too long or to a closed ticket is not sent")
    func refuses() async throws {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        #expect(model.send("") == nil)
        #expect(model.send("  \n\t ") == nil)
        #expect(model.send(String(repeating: "a", count: 2001)) == nil)
        #expect(model.outgoing.isEmpty)
        await model.send(String(repeating: "a", count: 2000))?.value
        #expect(calls(Endpoints.ReplyToTicket.self, clients).count == 1)

        let closed = TicketThread(ticket: Self.info(.closed), messages: [], lastId: 0)
        let closedModel = await loadedModel(Self.clients(thread: { closed }))
        #expect(closedModel.isClosed)
        #expect(closedModel.send("On it") == nil)
        #expect(closedModel.outgoing.isEmpty)
    }

    @Test("a failed reply can be sent again, and only a failed one")
    func retries() async throws {
        let fails = Box(true)
        let clients = Self.clients(reply: { _ in
            if fails.value { throw NetworkError.offline }
            return TicketReplyResult(ok: true, isDelivered: true)
        })
        let model = await loadedModel(clients)
        await model.send("On it")?.value
        let id = try #require(model.outgoing.first?.id)

        fails.value = false
        let task = try #require(model.retry(id))
        #expect(model.outgoing.first?.state == .sending)
        #expect(model.retry(id) == nil)
        await task.value
        #expect(model.outgoing.isEmpty)
        #expect(calls(Endpoints.ReplyToTicket.self, clients).map(\.content) == ["On it", "On it"])
        #expect(model.retry(UUID()) == nil)
    }

    @Test("a failed reply can be thrown away")
    func discards() async throws {
        let model = await loadedModel(Self.clients(reply: { _ in throw NetworkError.offline }))
        await model.send("One")?.value
        await model.send("Two")?.value
        let first = try #require(model.outgoing.first?.id)
        model.discard(first)
        #expect(model.outgoing.map(\.content) == ["Two"])
    }

    // MARK: - Closing

    @Test("closing sends the trimmed closing message and reloads")
    func closes() async throws {
        let isClosed = Box(false)
        let clients = Self.clients(
            thread: {
                isClosed.value ? TicketThread(ticket: Self.info(.closed), messages: Self.thread.messages, lastId: 41) : Self.thread
            },
            close: { _ in
                isClosed.value = true
                return OKResponse()
            })
        let model = await loadedModel(clients)
        #expect(await model.close(message: "  Solved, thanks  "))
        #expect(model.isClosed)
        #expect(model.actionError == nil)
        let sent = try #require(calls(Endpoints.CloseTicket.self, clients).first)
        #expect(sent.message == "Solved, thanks")
        #expect(calls(Endpoints.Ticket.self, clients).count == 2)
    }

    @Test("a failed close explains and leaves the ticket open")
    func failedClose() async {
        let model = await loadedModel(Self.clients(close: { _ in throw NetworkError.forbidden }))
        #expect(await model.close(message: "") == false)
        #expect(model.actionError == NetworkError.forbidden.userMessage)
        #expect(!model.isClosed)
    }
}
