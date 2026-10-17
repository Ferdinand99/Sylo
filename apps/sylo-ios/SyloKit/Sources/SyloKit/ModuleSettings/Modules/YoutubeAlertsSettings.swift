import Foundation

// YouTube alerts (src/modules/youtubeAlerts.js, normaliseYoutubeConfig; web form
// web-v2/src/moduleForms/YoutubeAlerts.jsx): announce new uploads and going live. A channel is
// typed as a URL or @handle (`input`) that the server resolves on save; the stored config has
// `onVideo`/`onLive`, the save body has `notify` instead.

/// The YouTube alerts settings page.
public struct YoutubeAlertsPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "youtube-alerts"

    public let settings: YoutubeAlertsSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// The messages used when an alert's own message is empty.
    public let defaultVideoMessage: String
    public let defaultLiveMessage: String

    public init(settings: YoutubeAlertsSettings, channels: [ChannelOption] = [], roles: [RoleOption] = [],
                defaultVideoMessage: String = "", defaultLiveMessage: String = "") {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.defaultVideoMessage = defaultVideoMessage
        self.defaultLiveMessage = defaultLiveMessage
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles, defaultVideoMessage, defaultLiveMessage
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: YoutubeAlertsSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        defaultVideoMessage = try c.decode(forKey: .defaultVideoMessage, or: "")
        defaultLiveMessage = try c.decode(forKey: .defaultLiveMessage, or: "")
    }
}

/// What a channel is announced for.
public enum YoutubeAlertsNotify: String, Codable, Sendable, CaseIterable {
    case both, video, live

    public init(from decoder: any Decoder) throws {
        self = YoutubeAlertsNotify(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .both
    }

    /// The choice the stored `onVideo`/`onLive` flags stand for (the web form's `notifyOf`).
    public init(onVideo: Bool, onLive: Bool) {
        if onVideo && onLive {
            self = .both
        } else if onLive {
            self = .live
        } else {
            self = .video
        }
    }
}

/// What happens to the went-live message when the livestream ends.
public enum YoutubeAlertsEndAction: String, Codable, Sendable, CaseIterable {
    case delete, edit, keep

    public init(from decoder: any Decoder) throws {
        self = YoutubeAlertsEndAction(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .delete
    }
}

public struct YoutubeAlertsSettings: Codable, Sendable, Equatable {
    public var alerts: [Alert]

    public init(alerts: [Alert] = []) {
        self.alerts = alerts
    }

    /// The server keeps at most this many channels.
    public static let maxAlerts = 50
    public static let maxMessageLength = 1500

    /// One YouTube channel to announce. The server drops rows it can't resolve or that have no
    /// Discord channel.
    public struct Alert: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let id: UUID
        /// What the person typed: a channel URL or @handle. Starts as "@name" for a resolved
        /// channel, the way the web form fills it in.
        public var input: String
        /// The resolved channel id (`UC…`), sent back so an unchanged row needn't be resolved again.
        public let ytChannelId: String
        /// The resolved channel's name.
        public let name: String
        public var discordChannelId: String
        /// The role to ping, or "" for none.
        public var roleId: String
        public var notify: YoutubeAlertsNotify
        /// Applies to the went-live post only.
        public var onEnd: YoutubeAlertsEndAction
        /// Empty means the server's default message.
        public var videoMessage: String
        public var liveMessage: String

        public init(input: String? = nil, ytChannelId: String = "", name: String = "",
                    discordChannelId: String = "", roleId: String = "", notify: YoutubeAlertsNotify = .video,
                    onEnd: YoutubeAlertsEndAction = .delete, videoMessage: String = "", liveMessage: String = "") {
            id = UUID()
            self.input = input ?? (ytChannelId.isEmpty ? "" : "@\(name.isEmpty ? ytChannelId : name)")
            self.ytChannelId = ytChannelId
            self.name = name
            self.discordChannelId = discordChannelId
            self.roleId = roleId
            self.notify = notify
            self.onEnd = onEnd
            self.videoMessage = videoMessage
            self.liveMessage = liveMessage
        }

        private enum CodingKeys: String, CodingKey {
            case input, ytChannelId, name, discordChannelId, roleId, notify, onEnd, videoMessage, liveMessage
            // Stored config only.
            case onVideo, onLive
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                ytChannelId: try c.decode(forKey: .ytChannelId, or: ""),
                name: try c.decode(forKey: .name, or: ""),
                discordChannelId: try c.decode(forKey: .discordChannelId, or: ""),
                roleId: try c.decode(forKey: .roleId, or: ""),
                notify: YoutubeAlertsNotify(onVideo: try c.decode(forKey: .onVideo, or: true),
                                            onLive: try c.decode(forKey: .onLive, or: false)),
                onEnd: try c.decode(forKey: .onEnd, or: .delete),
                videoMessage: try c.decode(forKey: .videoMessage, or: ""),
                liveMessage: try c.decode(forKey: .liveMessage, or: ""))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(input, forKey: .input)
            try c.encode(ytChannelId, forKey: .ytChannelId)
            try c.encode(name, forKey: .name)
            try c.encode(discordChannelId, forKey: .discordChannelId)
            try c.encode(roleId, forKey: .roleId)
            try c.encode(notify, forKey: .notify)
            try c.encode(onEnd, forKey: .onEnd)
            try c.encode(videoMessage, forKey: .videoMessage)
            try c.encode(liveMessage, forKey: .liveMessage)
        }
    }

    private enum CodingKeys: String, CodingKey { case alerts }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        alerts = try c.decode(forKey: .alerts, or: [])
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(alerts, forKey: .alerts)
    }
}
