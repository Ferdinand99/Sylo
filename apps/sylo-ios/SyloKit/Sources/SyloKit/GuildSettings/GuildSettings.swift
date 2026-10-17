import Foundation
import Observation

// A server's general settings ("Core → Settings" on the web): the mod-log channel, the default
// embed colour and the bot master roles. Loaded from `GET /api/v2/guilds/:id/settings` and saved
// with `POST` to the same path, which answers only `{ok: true}`, so a save is followed by a load.
// Mirrors web-v2/src/pages/Settings.jsx.

/// What the person edits on the server settings page. Its `Encodable` form is exactly the web
/// form's save body: `{modlogChannelId, botMasterRoleIds, embedColor}`, plus
/// `embedColorReset: true` when Sylo's colour is chosen (the web form's "Reset to default").
public struct GuildSettings: Codable, Sendable, Equatable {
    /// The channel every moderation action is posted to, or "" for off.
    public var modlogChannelId: String
    /// Roles that get dashboard access on top of those with Administrator.
    public var botMasterRoleIds: [String]
    /// "#rrggbb"; "" means Sylo's default colour (saved as embedColorReset).
    public var embedColorHex: String

    public init(modlogChannelId: String = "", botMasterRoleIds: [String] = [], embedColorHex: String = "") {
        self.modlogChannelId = modlogChannelId
        self.botMasterRoleIds = botMasterRoleIds
        self.embedColorHex = embedColorHex
    }

    /// Sylo's own embed colour, which the server uses (and reports) when none is set.
    public static let defaultColorHex = "#7aa2f7"

    /// Whether embeds use Sylo's colour: none chosen, or the one chosen is Sylo's.
    public var usesDefaultColor: Bool {
        embedColorHex.isEmpty || embedColorHex.lowercased() == Self.defaultColorHex
    }

    /// Goes back to Sylo's colour; saving sends a reset.
    public mutating func useDefaultColor() {
        embedColorHex = ""
    }

    /// The colour as 0...1 sRGB components, for a colour picker. No colour, or an unreadable one,
    /// reads as Sylo's.
    public var rgb: (red: Double, green: Double, blue: Double) {
        let value = Self.hexValue(embedColorHex) ?? Self.hexValue(Self.defaultColorHex) ?? 0
        return (Double((value >> 16) & 0xFF) / 255, Double((value >> 8) & 0xFF) / 255, Double(value & 0xFF) / 255)
    }

    /// Sets the colour from 0...1 sRGB components (clamped, since wide-gamut colours can go past
    /// them).
    public mutating func setRGB(red: Double, green: Double, blue: Double) {
        func hexByte(_ component: Double) -> String {
            let text = String(Int((min(max(component, 0), 1) * 255).rounded()), radix: 16)
            return text.count == 1 ? "0" + text : text
        }
        embedColorHex = "#" + hexByte(red) + hexByte(green) + hexByte(blue)
    }

    private static func hexValue(_ color: String) -> Int? {
        let hex = color.hasPrefix("#") ? color.dropFirst() : Substring(color)
        guard hex.count == 6, hex.allSatisfy(\.isHexDigit) else { return nil }
        return Int(hex, radix: 16)
    }

    /// "#rrggbb" for a readable colour (with or without "#"), otherwise the text as it is.
    private static func normalised(_ color: String) -> String {
        guard let value = hexValue(color) else { return color }
        let text = String(value, radix: 16)
        return "#" + String(repeating: "0", count: 6 - text.count) + text
    }

    private enum CodingKeys: String, CodingKey {
        case modlogChannelId, botMasterRoleIds, embedColor, embedColorReset
        /// How the settings page reports the colour (the save body calls it `embedColor`).
        case embedColorHex
    }

    /// Reads the settings page's fields (`embedColorHex`), or a save body (`embedColor`,
    /// `embedColorReset`).
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        modlogChannelId = try c.decode(forKey: .modlogChannelId, or: "")
        botMasterRoleIds = try c.decode(forKey: .botMasterRoleIds, or: [])
        if try c.decode(forKey: .embedColorReset, or: false) {
            embedColorHex = ""
        } else {
            let color = try c.decodeIfPresent(String.self, forKey: .embedColorHex)
                ?? c.decode(forKey: .embedColor, or: "")
            embedColorHex = Self.normalised(color)
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(modlogChannelId, forKey: .modlogChannelId)
        try c.encode(botMasterRoleIds, forKey: .botMasterRoleIds)
        try c.encode(embedColorHex, forKey: .embedColor)
        if embedColorHex.isEmpty { try c.encode(true, forKey: .embedColorReset) }
    }
}

/// The server settings page: the settings plus the channels and roles to pick from.
public struct GuildSettingsPage: Decodable, Sendable {
    public let settings: GuildSettings
    /// Text channels the mod log can go to.
    public let channels: [ChannelOption]
    /// Roles that can be made bot masters, highest first.
    public let roles: [RoleOption]

    public init(settings: GuildSettings, channels: [ChannelOption] = [], roles: [RoleOption] = []) {
        self.settings = settings
        self.channels = channels
        self.roles = roles
    }

    private enum CodingKeys: String, CodingKey { case channels, roles }

    /// The settings sit at the top level of the answer, next to the lists.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try GuildSettings(from: decoder)
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/settings`.
    public struct LoadGuildSettings: APIEndpoint {
        public typealias Response = GuildSettingsPage
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/settings" }
    }

    /// `POST /api/v2/guilds/:id/settings` with the settings as the body; answers `{ok: true}`, or
    /// 400 with an error for an unknown channel or a bad colour.
    public struct SaveGuildSettings: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let settings: GuildSettings

        public init(server: ServerID, settings: GuildSettings) {
            self.server = server
            self.settings = settings
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/settings" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { settings }
    }
}

/// Loads a server's settings page, holds the person's unsaved edits (``draft``) and saves them.
@MainActor
@Observable
public final class GuildSettingsModel {
    public let server: ServerID
    public private(set) var page: GuildSettingsPage?
    /// What the form edits. nil until the first load.
    public var draft: GuildSettings?
    /// The settings as last loaded or saved.
    public private(set) var saved: GuildSettings?
    public private(set) var isLoading = false
    public private(set) var isSaving = false
    /// Why the page could not be loaded.
    public var errorMessage: String?
    /// Why the last save did not go through (the draft is kept).
    public var saveError: String?
    /// Goes up with every successful save, for a "saved" haptic.
    public private(set) var saveCount = 0

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Whether the draft differs from what the server has.
    public var hasChanges: Bool { draft != nil && draft != saved }

    /// Loads the page. Unsaved edits are kept; only the lists around them are refreshed.
    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await session.send(Endpoints.LoadGuildSettings(server: server))
            let keepDraft = hasChanges
            self.page = page
            saved = page.settings
            if !keepDraft { draft = page.settings }
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    /// Saves the draft, then reloads the page, since the server answers a save with only `ok` (a
    /// reset colour comes back as the hex it stands for).
    /// - Returns: Whether the settings are saved (also true when there was nothing to save).
    @discardableResult
    public func save() async -> Bool {
        guard let draft, hasChanges else { return true }
        guard !isSaving else { return false }
        isSaving = true
        defer { isSaving = false }
        saveError = nil
        do {
            _ = try await session.send(Endpoints.SaveGuildSettings(server: server, settings: draft))
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { saveError = error.userMessage }
            return false
        }
        // Saved: the draft is what the server has now, so the reload replaces it.
        saved = draft
        saveCount += 1
        await load()
        return true
    }

    /// Throws the unsaved edits away.
    public func discardChanges() {
        draft = saved
    }
}
