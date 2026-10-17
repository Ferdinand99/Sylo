import Foundation

/// The login a sign-in goes straight to (`platform` on `/auth/mobile/start`). Without one, the
/// server picks its only login or shows its chooser.
public enum SignInPlatform: String, Sendable, Codable, CaseIterable {
    case discord
    case fluxer
}

/// Why a sign-in did not produce a code.
public enum SignInError: Error, Equatable, Sendable {
    /// The server address is not an http(s) URL with a host.
    case invalidServerURL
    /// The person pressed Cancel on the server's confirmation page. Not something to alert about.
    case cancelled
    /// The callback's `state` is missing or not the one this sign-in sent: it did not come from
    /// this sign-in, so its code must not be used.
    case stateMismatch
    /// The sheet returned a URL that is not `sylo://auth`.
    case wrongCallback
    /// The callback has no code (or more than one).
    case missingCode
    /// The server sent back an error other than Cancel (its `error` value).
    case serverError(String)
}

/// One app sign-in: the URL to open in the sign-in sheet, and what it needs to check and redeem the
/// callback (docs/mobile-app.md, "How sign-in works"). Make a new one for every attempt. Its
/// description shows neither the verifier nor the state.
public struct SignInRequest: Sendable {
    /// The URL scheme the sign-in sheet waits for (`sylo://auth?…`).
    public static let callbackScheme = "sylo"
    static let callbackHost = "auth"

    /// `<server>/auth/mobile/start?challenge=…&state=…[&platform=…]`, for the sign-in sheet.
    public let startURL: URL
    /// The verifier goes with the code to `POST /api/mobile/token`.
    public let pkce: PKCE
    /// The value the callback must carry back unchanged.
    public let state: String
    public let platform: SignInPlatform?

    /// A sign-in with a new PKCE pair and state.
    /// - Parameter server: The Sylo server's base URL, which may include a sub-path.
    public init(server: URL, platform: SignInPlatform?) throws(SignInError) {
        try self.init(server: server, platform: platform, pkce: .generate(), state: Self.makeState())
    }

    init(server: URL, platform: SignInPlatform?, pkce: PKCE, state: String) throws(SignInError) {
        guard
            var components = URLComponents(url: server, resolvingAgainstBaseURL: true),
            let scheme = components.scheme?.lowercased(), scheme == "https" || scheme == "http",
            let host = components.host, !host.isEmpty
        else { throw .invalidServerURL }

        var basePath = components.percentEncodedPath
        while basePath.hasSuffix("/") {
            basePath.removeLast()
        }
        components.percentEncodedPath = basePath + "/auth/mobile/start"
        var parameters = [("challenge", pkce.challenge), ("state", state)]
        if let platform {
            parameters.append(("platform", platform.rawValue))
        }
        components.percentEncodedQuery = parameters
            .map { "\(Self.percentEncoded($0))=\(Self.percentEncoded($1))" }
            .joined(separator: "&")
        components.fragment = nil
        guard let startURL = components.url else { throw .invalidServerURL }

        self.startURL = startURL
        self.pkce = pkce
        self.state = state
        self.platform = platform
    }

    /// The code from the URL the sign-in sheet returned, after checking it carries this
    /// sign-in's state.
    public func authorizationCode(from callbackURL: URL) throws(SignInError) -> String {
        try Self.authorizationCode(from: callbackURL, expectedState: state)
    }

    /// The code from `sylo://auth?code=…&state=…`. The state is checked first (compared byte for
    /// byte), so nothing from a callback this sign-in did not start is trusted, an error included.
    public static func authorizationCode(
        from callbackURL: URL,
        expectedState: String
    ) throws(SignInError) -> String {
        guard
            let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
            components.scheme?.lowercased() == callbackScheme,
            components.host?.lowercased() == callbackHost,
            components.user == nil, components.password == nil, components.port == nil,
            components.percentEncodedPath.isEmpty || components.percentEncodedPath == "/"
        else { throw .wrongCallback }

        let parameters = formDecoded(components.percentEncodedQuery ?? "")
        guard
            let state = parameters["state"], state.count == 1,
            !expectedState.isEmpty, state[0].utf8.elementsEqual(expectedState.utf8)
        else { throw .stateMismatch }

        if let error = parameters["error"]?.first {
            throw error == "access_denied" ? .cancelled : .serverError(error)
        }
        guard let code = parameters["code"], code.count == 1, !code[0].isEmpty else {
            throw .missingCode
        }
        return code[0]
    }

    /// A new random `state`: 43 characters of base64url (32 random bytes).
    static func makeState() -> String {
        base64URLEncoded(secureRandomBytes(count: 32))
    }

    // Only RFC 3986's unreserved characters stay as they are, so nothing in a value can be read as
    // a separator by the server's query parser.
    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    )

    private static func percentEncoded(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
    }

    /// A query decoded the way the server's `URLSearchParams` encoded it (`+` is a space). Each name
    /// maps to all its values, in order; a pair that is not valid percent-encoding is left out.
    private static func formDecoded(_ query: String) -> [String: [String]] {
        var result: [String: [String]] = [:]
        for pair in query.split(separator: "&", omittingEmptySubsequences: true) {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let decode = { (part: Substring) in
                part.replacingOccurrences(of: "+", with: " ").removingPercentEncoding
            }
            guard let name = decode(parts[0]), let value = parts.count > 1 ? decode(parts[1]) : "" else {
                continue
            }
            result[name, default: []].append(value)
        }
        return result
    }
}

extension SignInRequest: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String {
        "SignInRequest(platform: \(platform?.rawValue ?? "any"))"
    }

    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

extension SignInRequest {
    /// The server keeps at most this many characters (Unicode scalars) of a device name.
    static let maxDeviceNameLength = 100

    /// The name sent as `deviceName` with the code, shown on the account's list of signed-in
    /// devices: "iPhone — Sylo app". `UIDevice.current.name` is generic since iOS 16, so the app
    /// passes `UIDevice.current.model` and `systemName`; the system name is used when the model is
    /// blank. Never longer than the server keeps, and never cut inside a character.
    public static func deviceName(model: String, systemName: String) -> String {
        let suffix = "Sylo app"
        let separator = " — "
        let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        let device = trimmedModel.isEmpty
            ? systemName.trimmingCharacters(in: .whitespacesAndNewlines)
            : trimmedModel

        let budget = maxDeviceNameLength - (separator + suffix).unicodeScalars.count
        var kept = ""
        var used = 0
        for character in device {
            used += character.unicodeScalars.count
            guard used <= budget else { break }
            kept.append(character)
        }
        kept = kept.trimmingCharacters(in: .whitespacesAndNewlines)
        return kept.isEmpty ? suffix : kept + separator + suffix
    }
}
