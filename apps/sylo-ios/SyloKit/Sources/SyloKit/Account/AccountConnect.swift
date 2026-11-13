import Foundation

/// THE CONNECT WIRE NAMES, IN ONE PLACE. Server PR S2 (adding the other login) is still changing:
/// every path, query name, body key and error word the app uses for it is here, so a change on the
/// server is an edit to this enum and nothing else. Check them against `docs/mobile-app.md` on the
/// server before releasing.
enum ConnectWire {
    /// `POST` with the bearer token; answers `{ code }`.
    static func startPath(_ platform: String) -> String { "/api/mobile/connect/\(platform)" }
    /// `POST` with the bearer token and `{ result }`: the step that really links the platform.
    static let completePath = "/api/mobile/connect/complete"
    /// The page the browser sheet opens, with `?code=`.
    static let browserPath = "auth/mobile/connect"
    static let codeQuery = "code"
    /// The answer of the start call.
    static let codeKey = "code"
    /// The callback `sylo://connected?result=…&platform=…` (or `error=…`).
    static let callbackHost = "connected"
    static let resultQuery = "result"
    static let platformQuery = "platform"
    static let errorQuery = "error"
    static let cancelledError = "access_denied"
    /// The error words of the callback (and of a refused complete call).
    static let expiredError = "expired"
    static let identityLinkedError = "identity_linked"
    static let platformAlreadyLinkedError = "platform_already_linked"
    static let accountGoneError = "account_gone"
    static let knownErrors: Set<String> = [
        expiredError, identityLinkedError, platformAlreadyLinkedError, accountGoneError,
    ]
    /// The body key of the complete call.
    static let resultKey = "result"
    /// What the complete call says when the login already belongs to the account.
    static let alreadyLinkedWords: Set<String> = ["already-linked", "already_linked", "already_connected"]
}

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

    private struct Key: CodingKey {
        let stringValue: String
        let intValue: Int? = nil
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        guard let key = Key(stringValue: ConnectWire.codeKey) else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "No code key"))
        }
        code = try c.decode(String.self, forKey: key)
    }
}

/// Why connecting a platform did not finish.
public enum ConnectError: Error, Equatable, Sendable {
    /// The person closed the sheet or declined on the platform's page. Not something to alert about.
    case cancelled
    /// The sheet returned a URL that is not `sylo://connected`, or one for another platform.
    case wrongCallback
    /// The callback has no result to finish the link with.
    case missingResult
    /// The system sign-in sheet could not be shown or failed (not a cancel); the system's reason.
    case sheetFailed(String)
    /// The server redirected back with an error (its `error` value).
    case serverError(String)
    /// The address this server would open is not usable.
    case invalidServerURL
}

/// What a finished connect sheet hands back: the platform and the result code that
/// `POST /api/mobile/connect/complete` turns into the link. Nothing is linked before that call.
public struct ConnectResult: Sendable, Equatable {
    public let platform: Platform
    public let result: String

    public init(platform: Platform, result: String) {
        self.platform = platform
        self.result = result
    }
}

/// The callback of a connect: `sylo://connected?result=…&platform=discord`, or
/// `sylo://connected?error=…&platform=discord`.
public enum ConnectCallback {
    public static let callbackScheme = "sylo"
    static let callbackHost = ConnectWire.callbackHost

    /// Checks the URL the sign-in sheet returned and returns its result code.
    /// - Parameter expected: The platform the person asked to connect; a callback naming another one
    ///   is refused. A callback that names none is accepted as this one.
    public static func result(from url: URL, expected: Platform) throws(ConnectError) -> ConnectResult {
        guard
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            components.scheme?.lowercased() == callbackScheme,
            components.host?.lowercased() == callbackHost,
            components.user == nil, components.password == nil, components.port == nil,
            components.percentEncodedPath.isEmpty || components.percentEncodedPath == "/"
        else { throw .wrongCallback }

        let items = components.queryItems ?? []
        if let error = items.first(where: { $0.name == ConnectWire.errorQuery })?.value, !error.isEmpty {
            throw error == ConnectWire.cancelledError ? .cancelled : .serverError(error)
        }
        var platform = expected
        if let named = items.first(where: { $0.name == ConnectWire.platformQuery })?.value, !named.isEmpty {
            platform = Platform(rawValue: named)
            guard platform == expected else { throw .wrongCallback }
        }
        guard let result = items.first(where: { $0.name == ConnectWire.resultQuery })?.value, !result.isEmpty else {
            throw .missingResult
        }
        return ConnectResult(platform: platform, result: result)
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
        public var path: String { ConnectWire.startPath(platform.rawValue.encodedPathSegment) }
        public var method: HTTPMethod { .post }
    }

    /// `POST /api/mobile/connect/complete` with `{result}`: links the platform the sheet just
    /// logged in to. Only after this succeeds is the platform on the account. It can answer 409
    /// (or a 400 with `already-linked`) when the login is already linked.
    public struct CompleteConnect: APIEndpoint {
        public typealias Response = EmptyResponse
        public let result: String
        public init(result: String) { self.result = result }
        public var path: String { ConnectWire.completePath }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(result: result) }

        private struct Body: Encodable, Sendable {
            let result: String

            private struct Key: CodingKey {
                let stringValue: String
                let intValue: Int? = nil
                init?(stringValue: String) { self.stringValue = stringValue }
                init?(intValue: Int) { return nil }
            }

            func encode(to encoder: any Encoder) throws {
                var container = encoder.container(keyedBy: Key.self)
                if let key = Key(stringValue: ConnectWire.resultKey) {
                    try container.encode(result, forKey: key)
                }
            }
        }
    }
}

extension ServerURL {
    /// The page the sign-in sheet opens to start a connect: `/auth/mobile/connect?code=…`.
    public func connectURL(code: String) -> URL {
        url(for: ConnectWire.browserPath, query: [URLQueryItem(name: ConnectWire.codeQuery, value: code)])
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
