import Foundation

/// A server's id as Sylo spells it: a Discord snowflake (`123…`) or `fluxer:123…` on Fluxer.
/// Kept as a string so both platforms fit; percent-encoded whenever it goes into a path.
public struct ServerID: RawRepresentable, Hashable, Sendable, Codable, CustomStringConvertible,
    ExpressibleByStringLiteral {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    /// The id as one encoded path segment (`fluxer%3A123…`).
    var pathComponent: String { rawValue.encodedPathSegment }
}

/// A module's id (`welcome`, `auto-react`), as used in the toggle path.
public struct ModuleID: RawRepresentable, Hashable, Sendable, Codable, CustomStringConvertible,
    ExpressibleByStringLiteral {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    var pathComponent: String { rawValue.encodedPathSegment }
}
