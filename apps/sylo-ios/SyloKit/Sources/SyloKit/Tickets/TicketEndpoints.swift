import Foundation

// The ticket calls. Staff-role holders may use them without being server admins, so a 403 here
// means neither Manage Server nor a configured staff role.
extension Endpoints {
    /// `GET /api/v2/guilds/:id/tickets`: the open tickets and the latest closed ones.
    public struct Tickets: APIEndpoint {
        public typealias Response = TicketList
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/tickets" }
    }

    /// `GET /api/v2/guilds/:id/tickets/:ticket`: one ticket with all its messages; marks it seen.
    public struct Ticket: APIEndpoint {
        public typealias Response = TicketThread
        public let server: ServerID
        public let id: Int

        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/tickets/\(id)" }
    }

    /// `GET /api/v2/guilds/:id/tickets/:ticket/messages?after=`: the messages after `after`, and
    /// the ticket's status. What the thread polls while it is open.
    public struct TicketMessages: APIEndpoint {
        public typealias Response = TicketUpdate
        public let server: ServerID
        public let id: Int
        /// The last message id already shown (0 for all of them).
        public let after: Int

        public init(server: ServerID, id: Int, after: Int) {
            self.server = server
            self.id = id
            self.after = after
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/tickets/\(id)/messages" }
        public var query: [URLQueryItem] { [URLQueryItem(name: "after", value: String(after))] }
    }

    /// `POST /api/v2/guilds/:id/tickets/:ticket/reply`: a staff reply, DMed to the member.
    /// 409 when the ticket is closed, 400 when the reply is empty; the server cuts it at 2000.
    public struct ReplyToTicket: APIEndpoint {
        public typealias Response = TicketReplyResult
        public let server: ServerID
        public let id: Int
        public let content: String

        public init(server: ServerID, id: Int, content: String) {
            self.server = server
            self.id = id
            self.content = content
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/tickets/\(id)/reply" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(content: content) }

        private struct Body: Encodable, Sendable { let content: String }
    }

    /// `POST /api/v2/guilds/:id/tickets/:ticket/close`: closes the ticket, DMing the member the
    /// closing message when there is one. Closing a closed ticket is fine.
    public struct CloseTicket: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let id: Int
        /// Sent to the member with the close notice; empty for none.
        public let message: String

        public init(server: ServerID, id: Int, message: String) {
            self.server = server
            self.id = id
            self.message = message
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/tickets/\(id)/close" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(content: message) }

        private struct Body: Encodable, Sendable { let content: String }
    }
}
