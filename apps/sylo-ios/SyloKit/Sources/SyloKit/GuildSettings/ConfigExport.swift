import Foundation

// The server's configuration as a JSON file (GET /api/v2/guilds/:id/export in
// src/web/routes/v2GuildData.js; the dashboard's "Export configuration" in Settings). The server
// names the file `sylo-<server id>-config.json` in its Content-Disposition header. The file holds the
// server's settings, not member data, but it is still the server's own configuration, so the screen
// shows it through Quick Look or the share sheet and deletes the temporary file afterwards (see
// ``FileDownloadModel``).

extension Endpoints {
    /// `GET /api/v2/guilds/:id/export`: the configuration of every module, as a download.
    /// Modules only a Sylo operator may configure are left out for other admins, by the server.
    public struct ExportGuildConfig: APIEndpoint {
        public typealias Response = EmptyResponse
        public let server: ServerID

        public init(server: ServerID) { self.server = server }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/export" }
    }
}
