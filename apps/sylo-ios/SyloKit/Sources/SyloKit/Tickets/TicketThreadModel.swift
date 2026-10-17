import Foundation
import Observation

/// One ticket's conversation: its messages, staff replies on their way, and closing it.
@MainActor
@Observable
public final class TicketThreadModel {
    /// A staff reply the server has not shown back yet: on its way, or failed and waiting to be
    /// sent again or thrown away.
    public struct OutgoingReply: Identifiable, Hashable, Sendable {
        public let id: UUID
        public let content: String
        public var state: State

        public enum State: Hashable, Sendable {
            case sending
            /// Not sent, with why.
            case failed(String)
        }
    }

    /// The longest reply the server keeps, in UTF-16 units as it counts them (it cuts the rest).
    public static let maxReplyLength = 2000

    public let server: ServerID
    public let ticketID: Int
    public private(set) var ticket: TicketInfo?
    /// In the server's order, each message once.
    public private(set) var messages: [TicketMessage] = []
    /// Replies not yet seen in ``messages``, oldest first.
    public private(set) var outgoing: [OutgoingReply] = []
    public private(set) var isLoading = false
    /// Why the ticket could not be loaded.
    public var errorMessage: String?
    /// Why closing did not go through.
    public var actionError: String?
    /// Set when the server stored a reply but could not DM it to the member.
    public var deliveryWarning: String?

    /// The newest message id seen, for asking what came after it.
    private var lastID = 0
    private let session: AppSession

    public init(server: ServerID, ticketID: Int, session: AppSession) {
        self.server = server
        self.ticketID = ticketID
        self.session = session
    }

    public var isClosed: Bool { ticket?.status == .closed }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let thread = try await session.send(Endpoints.Ticket(server: server, id: ticketID))
            ticket = thread.ticket
            messages = []
            lastID = thread.lastId
            append(thread.messages)
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    /// Adds the messages written since the newest one shown and takes the ticket's status.
    /// Quiet on failure: the next refresh tries again.
    public func refresh() async {
        guard let update = try? await session.send(
            Endpoints.TicketMessages(server: server, id: ticketID, after: lastID))
        else { return }
        ticket = ticket?.with(status: update.status)
        append(update.messages)
    }

    /// Keeps refreshing every `interval` until the task is cancelled (the view runs it in `.task`).
    public func poll(every interval: Duration) async {
        while !Task.isCancelled {
            do { try await Task.sleep(for: interval) } catch { return }
            await refresh()
        }
    }

    /// Sends a staff reply. It shows in ``outgoing`` at once; once sent it gives way to the
    /// server's copy in ``messages``, and on failure it stays there, marked failed.
    /// - Returns: The running send, or nil when the trimmed text is empty or longer than
    ///   ``maxReplyLength``, or the ticket is closed.
    @discardableResult
    public func send(_ text: String) -> Task<Void, Never>? {
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, content.utf16.count <= Self.maxReplyLength, !isClosed else { return nil }
        let reply = OutgoingReply(id: UUID(), content: content, state: .sending)
        outgoing.append(reply)
        return deliver(reply)
    }

    /// Sends a failed reply again.
    /// - Returns: The running send, or nil when there is no such failed reply or the ticket is closed.
    @discardableResult
    public func retry(_ id: UUID) -> Task<Void, Never>? {
        guard let index = outgoing.firstIndex(where: { $0.id == id }), case .failed = outgoing[index].state,
              !isClosed
        else { return nil }
        outgoing[index].state = .sending
        return deliver(outgoing[index])
    }

    /// Throws away a reply that was not sent.
    public func discard(_ id: UUID) {
        outgoing.removeAll { $0.id == id }
    }

    /// Closes the ticket, DMing the member `message` with the close notice when it is not empty,
    /// then loads it again. On failure explains in ``actionError``.
    /// - Returns: Whether the ticket was closed.
    public func close(message: String) async -> Bool {
        actionError = nil
        let message = message.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            _ = try await session.send(Endpoints.CloseTicket(server: server, id: ticketID, message: message))
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { actionError = error.userMessage }
            return false
        }
        await load()
        return true
    }

    // MARK: - Private

    private func deliver(_ reply: OutgoingReply) -> Task<Void, Never> {
        Task {
            do {
                let result = try await session.send(
                    Endpoints.ReplyToTicket(server: server, id: ticketID, content: reply.content))
                if !result.isDelivered {
                    deliveryWarning = "The reply is saved, but Sylo couldn't DM it to the member. "
                        + "They may have DMs turned off or have left the server."
                }
                // Fetch the server's copy before dropping this one, so the reply never blinks out.
                await refresh()
                discard(reply.id)
            } catch {
                let error = NetworkError(error)
                if error == .http(status: 409) {
                    markFailed(reply.id, "This ticket was closed, so the reply wasn't sent.")
                    await refresh()
                } else {
                    markFailed(reply.id, error.userMessage)
                }
            }
        }
    }

    private func markFailed(_ id: UUID, _ reason: String) {
        guard let index = outgoing.firstIndex(where: { $0.id == id }) else { return }
        outgoing[index].state = .failed(reason)
    }

    /// Adds the messages not shown yet, in the order given.
    private func append(_ new: [TicketMessage]) {
        var seen = Set(messages.map(\.id))
        for message in new where seen.insert(message.id).inserted {
            messages.append(message)
            lastID = max(lastID, message.id)
        }
    }
}
