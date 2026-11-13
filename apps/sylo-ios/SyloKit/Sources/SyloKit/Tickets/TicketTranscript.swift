import Foundation

// A ticket's transcript (GET /api/v2/guilds/:id/tickets/:ticket/transcript in
// src/web/routes/v2Staff.js, built by buildTranscript in src/modules/tickets.js): the whole
// conversation as one HTML file named `ticket-<id>-transcript.html`. It holds what the member wrote,
// so the app shows it only through Quick Look or the share sheet and deletes the temporary file when
// that closes (see ``FileDownloadModel``). Ticket staff may use it without being server admins.

extension Endpoints {
    /// `GET /api/v2/guilds/:id/tickets/:ticket/transcript`: the conversation as an HTML download.
    /// 404 when the ticket is not on this server.
    public struct TicketTranscript: APIEndpoint {
        public typealias Response = EmptyResponse
        public let server: ServerID
        public let id: Int

        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/tickets/\(id)/transcript" }
    }
}
