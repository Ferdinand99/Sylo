import Foundation
import Observation

/// A server's ticket inbox.
@MainActor
@Observable
public final class TicketsModel {
    public let server: ServerID
    public private(set) var list: TicketList?
    public private(set) var isLoading = false
    /// Why the list could not be loaded (the last list, if any, stays).
    public var errorMessage: String?
    /// Why closing a ticket from the list did not go through.
    public var actionError: String?
    /// How many tickets were closed from the list, so a screen can refresh what depends on the counts.
    public private(set) var closeCount = 0

    private var closing: Set<Int> = []

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Open tickets with something new since staff last looked.
    public var unreadCount: Int { list?.open.count(where: \.isUnread) ?? 0 }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            list = try await session.send(Endpoints.Tickets(server: server))
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }
}

extension TicketsModel {
    /// Whether a close of this ticket is on its way to the server.
    public func isClosing(_ id: Int) -> Bool { closing.contains(id) }

    /// Closes a ticket without a closing message (a swipe in the list), then loads the list again.
    /// On failure explains in ``actionError``. Closing a ticket that is already being closed does
    /// nothing, so a second tap cannot send it twice.
    /// - Returns: Whether the ticket was closed.
    @discardableResult
    public func close(_ id: Int) async -> Bool {
        guard !closing.contains(id) else { return false }
        closing.insert(id)
        defer { closing.remove(id) }
        actionError = nil
        do {
            _ = try await session.send(Endpoints.CloseTicket(server: server, id: id, message: ""))
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { actionError = error.userMessage }
            return false
        }
        closeCount += 1
        await load()
        return true
    }
}
