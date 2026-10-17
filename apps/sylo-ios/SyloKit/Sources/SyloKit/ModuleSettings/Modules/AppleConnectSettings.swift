import Foundation

// App Store Connect alerts (src/modules/appleConnect.js, normaliseAppleConfig; web form
// web-v2/src/moduleForms/AppleConnect.jsx): what happens to the owner's apps on Apple's side,
// posted in a channel. Owner-only: the server answers everyone else with 403, which shows as the
// screen's load error.

/// The App Store Connect settings page.
public struct AppleConnectPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "apple-connect"

    public let settings: AppleConnectSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// Whether the bot has an App Store Connect API key; without one no alert fires (the
    /// settings can still be edited).
    public let appleEnabled: Bool

    public init(settings: AppleConnectSettings, channels: [ChannelOption] = [], roles: [RoleOption] = [],
                appleEnabled: Bool = true) {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.appleEnabled = appleEnabled
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles, appleEnabled
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: AppleConnectSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        appleEnabled = try c.decode(forKey: .appleEnabled, or: true)
    }
}

/// One alert kind: on or off, and its own channel ("" = the main channel).
public struct AppleConnectAlert: Encodable, Sendable, Equatable {
    public var enabled: Bool
    public var channelId: String

    public init(enabled: Bool = true, channelId: String = "") {
        self.enabled = enabled
        self.channelId = channelId
    }
}

/// New customer reviews, only up to `maxStars` stars.
public struct AppleConnectReviewsAlert: Encodable, Sendable, Equatable {
    public var enabled: Bool
    public var channelId: String
    public var maxStars: Int

    public init(enabled: Bool = true, channelId: String = "", maxStars: Int = 5) {
        self.enabled = enabled
        self.channelId = channelId
        self.maxStars = maxStars
    }

    public static let starsRange = 1...5
}

/// Certificates and profiles expiring, from `days` days before (and at 7 and 1 days).
public struct AppleConnectExpiryAlert: Encodable, Sendable, Equatable {
    public var enabled: Bool
    public var channelId: String
    public var days: Int

    public init(enabled: Bool = true, channelId: String = "", days: Int = 30) {
        self.enabled = enabled
        self.channelId = channelId
        self.days = days
    }

    public static let daysRange = 1...365
}

public struct AppleConnectSettings: Codable, Sendable, Equatable {
    /// Used by every alert without its own channel.
    public var channelId: String
    /// Pinged with the alerts ("" = nobody).
    public var roleId: String
    /// App Store Connect app ids as typed: one per line (or separated by spaces or commas);
    /// empty means all apps. Sent as `apps`.
    public var appsText: String
    public var events: Events

    public init(channelId: String = "", roleId: String = "", apps: [String] = [], events: Events = Events()) {
        self.channelId = channelId
        self.roleId = roleId
        self.appsText = apps.joined(separator: "\n")
        self.events = events
    }

    /// The app ids in `appsText`.
    public var apps: [String] {
        appsText.split(whereSeparator: { $0.isWhitespace || $0 == "," }).map(String.init)
    }

    /// The server keeps at most this many app ids.
    public static let maxApps = 20

    public struct Events: Codable, Sendable, Equatable {
        /// An App Store version changing state (waiting for review, in review, rejected, …).
        public var versionState: AppleConnectAlert
        /// Builds finished or failed processing.
        public var build: AppleConnectAlert
        /// TestFlight review started, approved or rejected.
        public var betaReview: AppleConnectAlert
        public var reviews: AppleConnectReviewsAlert
        /// TestFlight feedback and crashes.
        public var feedback: AppleConnectAlert
        public var expiry: AppleConnectExpiryAlert
        /// Not on the web form yet (off by default); kept as stored and sent back unchanged.
        public var sales: AppleConnectAlert

        public init(versionState: AppleConnectAlert = AppleConnectAlert(),
                    build: AppleConnectAlert = AppleConnectAlert(),
                    betaReview: AppleConnectAlert = AppleConnectAlert(),
                    reviews: AppleConnectReviewsAlert = AppleConnectReviewsAlert(),
                    feedback: AppleConnectAlert = AppleConnectAlert(),
                    expiry: AppleConnectExpiryAlert = AppleConnectExpiryAlert(),
                    sales: AppleConnectAlert = AppleConnectAlert(enabled: false)) {
            self.versionState = versionState
            self.build = build
            self.betaReview = betaReview
            self.reviews = reviews
            self.feedback = feedback
            self.expiry = expiry
            self.sales = sales
        }

        private enum CodingKeys: String, CodingKey {
            case versionState, build, betaReview, reviews, feedback, expiry, sales
        }

        private enum AlertKeys: String, CodingKey { case enabled, channelId, maxStars, days }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            /// An alert kind's `enabled` and `channelId`, plus its container for the extras. A
            /// plain boolean (the older shape) is the `enabled` flag alone.
            func alert(_ key: CodingKeys, enabledDefault: Bool = true) throws
                -> (enabled: Bool, channelId: String, extras: KeyedDecodingContainer<AlertKeys>?) {
                guard c.contains(key), try !c.decodeNil(forKey: key) else { return (enabledDefault, "", nil) }
                if let flag = try? c.decode(Bool.self, forKey: key) { return (flag, "", nil) }
                let n = try c.nestedContainer(keyedBy: AlertKeys.self, forKey: key)
                return (try n.decode(forKey: .enabled, or: enabledDefault), try n.decode(forKey: .channelId, or: ""), n)
            }
            func plain(_ key: CodingKeys, enabledDefault: Bool = true) throws -> AppleConnectAlert {
                let a = try alert(key, enabledDefault: enabledDefault)
                return AppleConnectAlert(enabled: a.enabled, channelId: a.channelId)
            }
            versionState = try plain(.versionState)
            build = try plain(.build)
            betaReview = try plain(.betaReview)
            feedback = try plain(.feedback)
            sales = try plain(.sales, enabledDefault: false)
            let r = try alert(.reviews)
            reviews = AppleConnectReviewsAlert(enabled: r.enabled, channelId: r.channelId,
                                               maxStars: try r.extras?.decode(forKey: .maxStars, or: 5) ?? 5)
            let e = try alert(.expiry)
            expiry = AppleConnectExpiryAlert(enabled: e.enabled, channelId: e.channelId,
                                             days: try e.extras?.decode(forKey: .days, or: 30) ?? 30)
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(versionState, forKey: .versionState)
            try c.encode(build, forKey: .build)
            try c.encode(betaReview, forKey: .betaReview)
            try c.encode(reviews, forKey: .reviews)
            try c.encode(feedback, forKey: .feedback)
            try c.encode(expiry, forKey: .expiry)
            try c.encode(sales, forKey: .sales)
        }
    }

    private enum CodingKeys: String, CodingKey { case channelId, roleId, apps, events }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            channelId: try c.decode(forKey: .channelId, or: ""),
            roleId: try c.decode(forKey: .roleId, or: ""),
            apps: try c.decode(forKey: .apps, or: []),
            events: try c.decode(forKey: .events, or: Events()))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(channelId, forKey: .channelId)
        try c.encode(roleId, forKey: .roleId)
        try c.encode(apps, forKey: .apps)
        try c.encode(events, forKey: .events)
    }
}
