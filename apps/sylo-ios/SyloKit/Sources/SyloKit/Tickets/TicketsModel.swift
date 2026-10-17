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
