import Foundation

extension ServerFeature {
    /// The server can add a platform to the account through the app (`POST /api/mobile/connect/:platform`
    /// and the one-time code it returns). Older servers only connect from their web page, so the app
    /// offers no Connect button there.
    public static let appConnect = ServerFeature(rawValue: "app-connect")
}

/// The answer of `POST /api/mobile/connect/:platform`: a one-time code (valid for about a minute,
/// good once) that the system sign-in sheet trades for a short browser session on the server,
/// which then starts the platform's own login.
public struct ConnectGrant: Decodable, Sendable, Equatable {
    public let code: String

    public init(code: String) { self.code = code }

    private enum CodingKeys: String, CodingKey { case code }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = try c.decode(String.self, forKey: .code)
    }
}

/// Why connecting a platform did not finish.
public enum ConnectError: Error, Equatable, Sendable {
    /// The person closed the sheet or declined on the platform's page. Not something to alert about.
    case cancelled
    /// The sheet returned a URL that is not `sylo://connected`, or one for another platform.
    case wrongCallback
    /// The server redirected back with an error (its `error` value).
    case serverError(String)
    /// The address this server would open is not usable.
    case invalidServerURL
}

/// The callback of a connect: `sylo://connected?platform=discord`, or `sylo://connected?error=…`.
public enum ConnectCallback {
    public static let callbackScheme = "sylo"
    static let callbackHost = "connected"

    /// Checks the URL the sign-in sheet returned and returns the platform that was connected.
    /// - Parameter expected: The platform the person asked to connect; a callback naming another one
    ///   is refused. A callback that names none is accepted as this one.
    public static func platform(from url: URL, expected: Platform) throws(ConnectError) -> Platform {
        guard
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            components.scheme?.lowercased() == callbackScheme,
            components.host?.lowercased() == callbackHost,
            components.user == nil, components.password == nil, components.port == nil,
            components.percentEncodedPath.isEmpty || components.percentEncodedPath == "/"
        else { throw .wrongCallback }

        let items = components.queryItems ?? []
        if let error = items.first(where: { $0.name == "error" })?.value, !error.isEmpty {
            throw error == "access_denied" ? .cancelled : .serverError(error)
        }
        guard let named = items.first(where: { $0.name == "platform" })?.value, !named.isEmpty else {
            return expected
        }
        let platform = Platform(rawValue: named)
        guard platform == expected else { throw .wrongCallback }
        return platform
    }
}

extension Endpoints {
    /// `POST /api/v2/account/disconnect/:platform`: removes a platform login from the account (409
    /// for the only sign-in).
    public struct DisconnectPlatform: APIEndpoint {
        public typealias Response = OKResponse
        public let platform: Platform
        public init(platform: Platform) { self.platform = platform }
        public var path: String { "/api/v2/account/disconnect/\(platform.rawValue.encodedPathSegment)" }
        public var method: HTTPMethod { .post }
    }

    /// `POST /api/mobile/connect/:platform`: asks the server for a one-time code to connect a
    /// platform to this account. Only servers that announce ``ServerFeature/appConnect`` have it.
    public struct StartConnect: APIEndpoint {
        public typealias Response = ConnectGrant
        public let platform: Platform
        public init(platform: Platform) { self.platform = platform }
        public var path: String { "/api/mobile/connect/\(platform.rawValue.encodedPathSegment)" }
        public var method: HTTPMethod { .post }
    }
}

extension ServerURL {
    /// The page the sign-in sheet opens to start a connect: `/auth/mobile/connect?code=…`.
    public func connectURL(code: String) -> URL {
        url(for: "auth/mobile/connect", query: [URLQueryItem(name: "code", value: code)])
    }
}

// MARK: - Add Sylo to a server

/// One "add Sylo to a server" link, from `GET /api/v2/invites`: the platform's own authorise page.
public struct ServerInvite: Decodable, Sendable, Hashable, Identifiable {
    public let platform: Platform
    public let label: String
    public let url: URL

    public var id: Platform { platform }

    public init(platform: Platform, label: String, url: URL) {
        self.platform = platform
        self.label = label
        self.url = url
    }

    private enum CodingKeys: String, CodingKey { case platform, label, url }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        platform = try c.decode(Platform.self, forKey: .platform)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? platform.displayName
        let text = try c.decode(String.self, forKey: .url)
        // Only a web link: the app opens it in the browser, so nothing else may be in it.
        guard let url = URL(string: text), url.scheme?.lowercased() == "https", url.host?.isEmpty == false else {
            throw DecodingError.dataCorruptedError(forKey: .url, in: c, debugDescription: "Not an https link")
        }
        self.url = url
    }
}

/// The answer of `GET /api/v2/invites`.
public struct ServerInviteList: Decodable, Sendable, Equatable {
    public let invites: [ServerInvite]

    public init(invites: [ServerInvite]) { self.invites = invites }

    private enum CodingKeys: String, CodingKey { case invites }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        invites = try c.decodeLossyArray(of: ServerInvite.self, forKey: .invites)
    }
}

extension Endpoints {
    /// `GET /api/v2/invites`: where to add Sylo to a server, one link per platform it runs on.
    public struct Invites: APIEndpoint {
        public typealias Response = ServerInviteList
        public init() {}
        public var path: String { "/api/v2/invites" }
    }
}
