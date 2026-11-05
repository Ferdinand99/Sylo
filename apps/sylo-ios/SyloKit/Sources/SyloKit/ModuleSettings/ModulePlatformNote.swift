import Foundation
import Observation

// What a module page should tell people about the platform of the server it is for (Fluxer has no
// threads, buttons or slash commands yet), from `GET /api/v2/guilds/:id/platform`. The server
// words the notes itself, including the server's own command prefix, so the app only shows them.
// Mirrors web-v2/src/pages/ModulePage.jsx.

/// A server's platform and the per-module notes for it.
public struct PlatformInfo: Decodable, Sendable, Equatable {
    public let platform: Platform
    /// Module id to the note that explains how the module behaves on this platform. Empty on
    /// Discord, which every module is written for.
    public let notes: [String: String]

    public init(platform: Platform, notes: [String: String] = [:]) {
        self.platform = platform
        self.notes = notes
    }

    private enum CodingKeys: String, CodingKey { case platform, notes }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        platform = try c.decodeIfPresent(Platform.self, forKey: .platform) ?? .discord
        notes = try c.decode(forKey: .notes, or: [:])
    }

    /// The note for a module, or nil when the platform needs none.
    public func note(for module: ModuleID) -> String? {
        guard let note = notes[module.rawValue], !note.isEmpty else { return nil }
        return note
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/platform`.
    public struct LoadPlatformInfo: APIEndpoint {
        public typealias Response = PlatformInfo
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/platform" }
    }
}

/// Loads the note for one module on one server. Failing to load is not an error worth showing: the
/// page simply has no note, like a Discord server.
@MainActor
@Observable
public final class ModulePlatformNoteModel {
    public let server: ServerID
    public let module: ModuleID
    public private(set) var note: String?
    public private(set) var platform: Platform?

    private let session: AppSession
    private var hasLoaded = false

    public init(server: ServerID, module: ModuleID, session: AppSession) {
        self.server = server
        self.module = module
        self.session = session
    }

    public func load() async {
        guard !hasLoaded else { return }
        guard let info = try? await session.send(Endpoints.LoadPlatformInfo(server: server)) else { return }
        hasLoaded = true
        platform = info.platform
        note = info.note(for: module)
    }
}

extension ServerURL {
    /// The module's own page in the web dashboard, for what the app leaves to the web (managing
    /// the lists on a module's page).
    public func dashboardURL(server: ServerID, module: ModuleID) -> URL {
        url(for: "/v2/guilds/\(server.pathComponent)/m/\(module.pathComponent)")
    }
}
