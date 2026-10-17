import Foundation

// AFK (src/modules/afk.js; the config is built in the afk routes of src/web/routes/v2Api.js; web
// form web-v2/src/moduleForms/Afk.jsx): members set `/afk [reason]`, Sylo answers mentions of
// them and clears the status when they next post.

/// The AFK settings page.
public struct AfkPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "afk"

    public let settings: AfkSettings
    public let channels: [ChannelOption]

    public init(settings: AfkSettings, channels: [ChannelOption] = []) {
        self.settings = settings
        self.channels = channels
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: AfkSettings())
        channels = try c.decode(forKey: .channels, or: [])
    }
}

public struct AfkSettings: Codable, Sendable, Equatable {
    /// Prefix an AFK member's nickname with `[AFK]` (needs Manage Nicknames).
    public var setNickname: Bool
    /// Reply in the channel when an AFK member is mentioned.
    public var mentionReply: Bool
    /// Channels where AFK isn't cleared or announced.
    public var ignoreChannels: [String]

    public init(setNickname: Bool = true, mentionReply: Bool = true, ignoreChannels: [String] = []) {
        self.setNickname = setNickname
        self.mentionReply = mentionReply
        self.ignoreChannels = ignoreChannels
    }

    private enum CodingKeys: String, CodingKey { case setNickname, mentionReply, ignoreChannels }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        setNickname = try c.decode(forKey: .setNickname, or: true)
        mentionReply = try c.decode(forKey: .mentionReply, or: true)
        ignoreChannels = try c.decode(forKey: .ignoreChannels, or: [])
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(setNickname, forKey: .setNickname)
        try c.encode(mentionReply, forKey: .mentionReply)
        try c.encode(ignoreChannels, forKey: .ignoreChannels)
    }
}
