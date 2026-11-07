import Foundation

/// The address of a Sylo server, checked and normalised once, so every request and the Keychain
/// entry for it agree on one spelling of it.
///
/// Built from what a person types: `https://` is added when no scheme is given, plain `http://` is
/// only accepted on the local network, and credentials, query, fragment and trailing slashes are
/// dropped. A sub-path (`https://example.com/sylo`) is kept.
public struct ServerURL: Hashable, Sendable, CustomStringConvertible {
    /// The hosted Sylo.
    public static let hosted = ServerURL(trusted: "https", host: "app.sylobot.com", port: nil, path: "")
    /// The Hedgerow notification service (Postal Pigeon), the only one the app registers with.
    public static let pigeon = ServerURL(trusted: "https", host: "pigeon.hedgerow.tools", port: nil, path: "")

    /// The normalised address, without a trailing slash.
    public let baseURL: URL

    private let scheme: String
    private let host: String
    private let port: Int?
    private let path: String

    /// Checks and normalises an address as a person typed it.
    public init(_ input: String) throws(ServerURLError) {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw .empty }
        // URL parsers disagree on whether `\` ends the host; never let one guess.
        guard !trimmed.contains("\\") else { throw .invalid }
        let withScheme = trimmed.contains("://") ? trimmed : "https://" + trimmed
        guard let components = URLComponents(string: withScheme), let rawScheme = components.scheme else {
            throw .invalid
        }
        let scheme = rawScheme.lowercased()
        guard scheme == "https" || scheme == "http" else { throw .unsupportedScheme(scheme) }
        guard let rawHost = components.encodedHost, !rawHost.isEmpty else { throw .invalid }
        let host = rawHost.lowercased()
        // Newer Apple Foundation percent-encodes a space instead of failing; a host never needs it.
        guard Self.isPlausibleHost(host) else { throw .invalid }
        if scheme == "http", !Self.isLocalNetwork(host) { throw .insecureHTTP }

        var port = components.port
        if (scheme == "https" && port == 443) || (scheme == "http" && port == 80) { port = nil }
        var path = components.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }

        guard let url = Self.makeURL(scheme: scheme, host: host, port: port, path: path) else { throw .invalid }
        self.scheme = scheme
        self.host = host
        self.port = port
        self.path = path
        self.baseURL = url
    }

    private init(trusted scheme: String, host: String, port: Int?, path: String) {
        self.scheme = scheme
        self.host = host
        self.port = port
        self.path = path
        // Only used for constants spelled out in this file, which always form a URL.
        self.baseURL = Self.makeURL(scheme: scheme, host: host, port: port, path: path)
            ?? URL(fileURLWithPath: "/")
    }

    /// Scheme, host and port (`https://example.com:8443`), without the sub-path: one Keychain
    /// account per server.
    public var origin: String {
        "\(scheme)://\(host)" + (port.map { ":\($0)" } ?? "")
    }

    public var description: String { baseURL.absoluteString }

    /// How the app names the server: "Sylo" for the hosted one, else host, port and sub-path
    /// (`example.com:8443/sylo`).
    public var displayName: String {
        if self == .hosted { return "Sylo" }
        return host + (port.map { ":\($0)" } ?? "") + (path.removingPercentEncoding ?? path)
    }

    /// The URL for an API path below this server, keeping any sub-path. `path` is percent-encoded
    /// already (use encoded path segments for ids); a leading slash is optional.
    public func url(for path: String, query: [URLQueryItem] = []) -> URL {
        var relative = Substring(path)
        while relative.hasPrefix("/") { relative.removeFirst() }
        let safe = String(relative).addingPercentEncoding(withAllowedCharacters: Self.encodedPathAllowed)
            ?? String(relative)
        var components = URLComponents()
        components.scheme = scheme
        components.encodedHost = host
        components.port = port
        components.percentEncodedPath = self.path + "/" + safe
        if !query.isEmpty { components.queryItems = query }
        return components.url ?? baseURL
    }

    // MARK: - Helpers

    /// Path characters plus `%`, so an already encoded path passes through unchanged.
    private static let encodedPathAllowed: CharacterSet = {
        var set = CharacterSet.urlPathAllowed
        set.insert("%")
        return set
    }()

    private static func makeURL(scheme: String, host: String, port: Int?, path: String) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.encodedHost = host
        components.port = port
        components.percentEncodedPath = path
        return components.url
    }

    /// A DNS name or IPv4 address (letters, digits, `-`, `_`, `.`), or a bracketed IPv6 address.
    private static func isPlausibleHost(_ host: String) -> Bool {
        if host.hasPrefix("[") {
            return host.hasSuffix("]") && host.count > 2
                && host.dropFirst().dropLast().allSatisfy { $0.isHexDigit || $0 == ":" || $0 == "." }
        }
        return host.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || "-_.".contains($0) }
    }

    /// Hosts where plain http is acceptable: this machine, mDNS names and private IPv4 ranges.
    static func isLocalNetwork(_ host: String) -> Bool {
        if host == "localhost" || host.hasSuffix(".local") { return true }
        if host == "[::1]" || host == "::1" { return true }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        var octets: [Int] = []
        for part in parts {
            guard !part.isEmpty, part.count <= 3, part.allSatisfy(\.isASCIIDigit),
                  let value = Int(part), value <= 255 else { return false }
            octets.append(value)
        }
        switch (octets[0], octets[1]) {
        case (127, _), (10, _), (192, 168): return true
        case (172, 16...31): return true
        default: return false
        }
    }
}

extension ServerURL: Codable {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let string = try container.decode(String.self)
        do {
            try self.init(string)
        } catch {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "Not a valid Sylo server address: \(error)")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(baseURL.absoluteString)
    }
}

/// Why an address cannot be used as a Sylo server.
public enum ServerURLError: Error, Sendable, Equatable {
    case empty
    case invalid
    case unsupportedScheme(String)
    /// Plain `http://` to a host outside the local network, which would send the token unencrypted.
    case insecureHTTP

    /// A short sentence for the person, saying what to do.
    public var userMessage: String {
        switch self {
        case .empty: "Enter the address of your Sylo server."
        case .invalid: "That isn't a valid server address. Check it and try again."
        case .unsupportedScheme: "Use an address that starts with https://."
        case .insecureHTTP: "Use https:// for this address. Plain http:// only works on your own network."
        }
    }
}

private extension Character {
    var isASCIIDigit: Bool { isASCII && isNumber }
}

extension String {
    /// This string as one path segment: everything but unreserved characters percent-encoded, so an
    /// id like `fluxer:123` cannot change the path's meaning.
    var encodedPathSegment: String {
        addingPercentEncoding(withAllowedCharacters: .unreservedURLCharacters) ?? self
    }
}

extension CharacterSet {
    /// RFC 3986 unreserved characters.
    static let unreservedURLCharacters = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
}
