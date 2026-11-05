import Foundation
import Observation

// A server's general settings ("Core → Settings" on the web): the mod-log channel, the default
// embed colour and the bot master roles. Loaded from `GET /api/v2/guilds/:id/settings` and saved
// with `POST` to the same path, which answers only `{ok: true}`, so a save is followed by a load.
// Mirrors web-v2/src/pages/Settings.jsx.

/// What the person edits on the server settings page. Its `Encodable` form is exactly the web
/// form's save body: `{modlogChannelId, botMasterRoleIds, embedColor}`, plus
/// `embedColorReset: true` when Sylo's colour is chosen (the web form's "Reset to default"), and
/// `commandPrefix` on a Fluxer server.
public struct GuildSettings: Codable, Sendable, Equatable {
    /// The channel every moderation action is posted to, or "" for off.
    public var modlogChannelId: String
    /// Roles that get dashboard access on top of those with Administrator.
    public var botMasterRoleIds: [String]
    /// "#rrggbb"; "" means Sylo's default colour (saved as embedColorReset).
    public var embedColorHex: String
    /// The server's own chat-command prefix; "" = the instance default. nil when the server has no
    /// prefix to set (a Discord server, which uses slash commands): then none is sent.
    public var commandPrefix: String?

    public init(modlogChannelId: String = "", botMasterRoleIds: [String] = [], embedColorHex: String = "",
                commandPrefix: String? = nil) {
        self.modlogChannelId = modlogChannelId
        self.botMasterRoleIds = botMasterRoleIds
        self.embedColorHex = embedColorHex
        self.commandPrefix = commandPrefix
    }

    /// The most characters a prefix can have when the server does not say (commandPrefixMaxLength).
    public static let defaultCommandPrefixMaxLength = 5

    /// The settings as they are sent and compared: the prefix trimmed, like the web form does.
    public var normalised: GuildSettings {
        var copy = self
        copy.commandPrefix = commandPrefix.map(Self.trimmed)
        return copy
    }

    /// Why the command prefix cannot be saved, or nil when it can (or there is none). The same rules
    /// as the server (src/lib/commandPrefix.js, which has the last word): empty is the default;
    /// otherwise at most `max` characters counted as UTF-16 units (an emoji counts as two), none of
    /// them whitespace, a backtick or an invisible or control character.
    public func commandPrefixProblem(max: Int = GuildSettings.defaultCommandPrefixMaxLength) -> String? {
        guard let prefix = commandPrefix.map(Self.trimmed) else { return nil }
        return Self.commandPrefixProblem(prefix, max: max)
    }

    /// The text without whitespace at either end, the way JavaScript's trim() does it (what the
    /// web form and the server do): not Foundation's, which also strips zero-width spaces that the
    /// server then refuses as invisible characters.
    static func trimmed(_ text: String) -> String {
        func isSpace(_ scalar: Unicode.Scalar) -> Bool { scalar.properties.isWhitespace || scalar.value == 0xFEFF }
        var scalars = Substring(text).unicodeScalars
        while let first = scalars.first, isSpace(first) { scalars.removeFirst() }
        while let last = scalars.last, isSpace(last) { scalars.removeLast() }
        return String(scalars)
    }

    /// See ``commandPrefixProblem(max:)``; `prefix` is already trimmed.
    public static func commandPrefixProblem(_ prefix: String, max: Int = defaultCommandPrefixMaxLength) -> String? {
        if prefix.isEmpty { return nil }
        if prefix.unicodeScalars.contains(where: { $0.properties.isWhitespace }) {
            return "The prefix can not contain spaces."
        }
        if prefix.contains("`") { return "The prefix can not contain a backtick (`)." }
        let invisible: Set<Unicode.GeneralCategory> = [.control, .format, .privateUse, .unassigned, .surrogate]
        if prefix.unicodeScalars.contains(where: { invisible.contains($0.properties.generalCategory) }) {
            return "The prefix can not contain invisible or control characters."
        }
        if prefix.utf16.count > max {
            return "The prefix can be at most \(max) characters. Emoji and some symbols count as two."
        }
        return nil
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
        case modlogChannelId, botMasterRoleIds, embedColor, embedColorReset, commandPrefix
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
        commandPrefix = try c.decodeIfPresent(String.self, forKey: .commandPrefix)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(modlogChannelId, forKey: .modlogChannelId)
        try c.encode(botMasterRoleIds, forKey: .botMasterRoleIds)
        try c.encode(embedColorHex, forKey: .embedColor)
        if embedColorHex.isEmpty { try c.encode(true, forKey: .embedColorReset) }
        // Only Fluxer servers have one (the server refuses a prefix for Discord); "" resets it.
        if let commandPrefix {
            try c.encode(Self.trimmed(commandPrefix), forKey: .commandPrefix)
        }
    }
}

/// The server settings page: the settings plus the channels and roles to pick from.
public struct GuildSettingsPage: Decodable, Sendable {
    public let settings: GuildSettings
    /// Text channels the mod log can go to.
    public let channels: [ChannelOption]
    /// Roles that can be made bot masters, highest first.
    public let roles: [RoleOption]
    /// The server's platform; nil when an older Sylo does not say.
    public let platform: Platform?
    /// The prefix a server without its own uses (Fluxer only).
    public let defaultCommandPrefix: String
    /// The prefix members type today: the server's own, or the default.
    public let effectiveCommandPrefix: String
    /// The most characters a prefix can have.
    public let commandPrefixMaxLength: Int

    public init(settings: GuildSettings, channels: [ChannelOption] = [], roles: [RoleOption] = [],
                platform: Platform? = nil, defaultCommandPrefix: String = "", effectiveCommandPrefix: String = "",
                commandPrefixMaxLength: Int = GuildSettings.defaultCommandPrefixMaxLength) {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.platform = platform
        self.defaultCommandPrefix = defaultCommandPrefix
        self.effectiveCommandPrefix = effectiveCommandPrefix
        self.commandPrefixMaxLength = commandPrefixMaxLength
    }

    /// Whether the server has a command prefix to set: only Fluxer servers do (Discord uses slash
    /// commands).
    public var hasCommandPrefix: Bool { platform == .fluxer && settings.commandPrefix != nil }

    private enum CodingKeys: String, CodingKey {
        case channels, roles, platform, defaultCommandPrefix, effectiveCommandPrefix, commandPrefixMaxLength
    }

    /// The settings sit at the top level of the answer, next to the lists.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var settings = try GuildSettings(from: decoder)
        let platform = try c.decodeIfPresent(Platform.self, forKey: .platform)
        // The answer carries commandPrefix on every server; only Fluxer's counts.
        if platform != .fluxer { settings.commandPrefix = nil }
        self.settings = settings
        self.platform = platform
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        defaultCommandPrefix = try c.decode(forKey: .defaultCommandPrefix, or: "")
        effectiveCommandPrefix = try c.decode(forKey: .effectiveCommandPrefix, or: "")
        commandPrefixMaxLength = try c.decode(
            forKey: .commandPrefixMaxLength, or: GuildSettings.defaultCommandPrefixMaxLength)
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

    /// Whether the draft differs from what the server has (a prefix's surrounding spaces do not
    /// count, they are not sent).
    public var hasChanges: Bool { draft != nil && draft?.normalised != saved?.normalised }

    /// Why the draft cannot be saved yet (a bad command prefix), or nil.
    public var draftProblem: String? {
        draft?.commandPrefixProblem(max: page?.commandPrefixMaxLength ?? GuildSettings.defaultCommandPrefixMaxLength)
    }

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
        guard let draft = draft?.normalised, hasChanges else { return true }
        guard !isSaving else { return false }
        if let problem = draftProblem {
            saveError = problem
            return false
        }
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
        self.draft = draft
        saveCount += 1
        await load()
        return true
    }

    /// Throws the unsaved edits away.
    public func discardChanges() {
        draft = saved
    }
}
