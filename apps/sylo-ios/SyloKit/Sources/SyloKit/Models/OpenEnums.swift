import Foundation

// String values from the server that the app switches on. Each keeps a value it does not know as
// `.other(raw)`, so a newer server adding one never breaks decoding.

/// A chat platform Sylo runs on.
public enum Platform: Hashable, Sendable, RawRepresentable, Codable {
    case discord
    case fluxer
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "discord": self = .discord
        case "fluxer": self = .fluxer
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .discord: "discord"
        case .fluxer: "fluxer"
        case .other(let raw): raw
        }
    }

    /// The platform's name as shown to people.
    public var displayName: String {
        switch self {
        case .discord: "Discord"
        case .fluxer: "Fluxer"
        case .other(let raw): raw
        }
    }
}

/// Something a server's app API supports (`features` in `GET /api/mobile/info`).
public struct ServerFeature: RawRepresentable, Hashable, Sendable, Codable {
    /// Signing in to the app (version 1 of the app API).
    public static let appLogin = ServerFeature(rawValue: "app-login")
    /// Server rights are checked live on every app request.
    public static let liveAccess = ServerFeature(rawValue: "live-access")
    /// The server can send ticket notifications to the app (`/api/mobile/push`).
    public static let push = ServerFeature(rawValue: "push")
    /// The server sends notifications through Postal Pigeon (`pigeon` in the info names it): the
    /// app registers there itself and gives the server only a handle. The push carries no text;
    /// the app fetches it (`/api/mobile/push/events/:ref`).
    public static let pushPigeon = ServerFeature(rawValue: "push-pigeon")
    /// The server's release notes are in the app API (`/api/v2/changelog`).
    public static let changelog = ServerFeature(rawValue: "changelog")

    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }
}

/// What a card on the server overview is: a module with a toggle, or a link to another page.
public enum OverviewCardKind: Hashable, Sendable, RawRepresentable, Codable {
    case module
    /// The Settings, Commands and Embed messages cards (`kind: "link"` on the server).
    case link
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "module": self = .module
        case "link": self = .link
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .module: "module"
        case .link: "link"
        case .other(let raw): raw
        }
    }
}

/// A card's overall state.
public enum ModuleStatus: Hashable, Sendable, RawRepresentable, Codable {
    case on
    case off
    /// Enabled or not, it cannot run: the bot lacks a privileged intent it needs.
    case blocked
    /// Not a module, a link to another page.
    case link
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "on": self = .on
        case "off": self = .off
        case "blocked": self = .blocked
        case "link": self = .link
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .on: "on"
        case .off: "off"
        case .blocked: "blocked"
        case .link: "link"
        case .other(let raw): raw
        }
    }
}

/// How one status line on a card reads: set up, not set up, or just information.
public enum StatusLineState: Hashable, Sendable, RawRepresentable, Codable {
    case on
    case off
    case neutral
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "on": self = .on
        case "off": self = .off
        case "neutral": self = .neutral
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .on: "on"
        case .off: "off"
        case .neutral: "neutral"
        case .other(let raw): raw
        }
    }
}
