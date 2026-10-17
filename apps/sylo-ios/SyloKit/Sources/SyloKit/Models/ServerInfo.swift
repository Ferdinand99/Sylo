import Foundation

/// What `GET /api/mobile/info` says about a server: whether it is a Sylo, whether the app can
/// sign in there, and what its app API supports.
///
/// Every field has a default, so any JSON object decodes and ``isSylo`` decides; a missing field
/// is then not a decoding error the app has to explain.
public struct ServerInfo: Decodable, Sendable, Equatable {
    public let name: String
    /// The Sylo version, for example `4.0.0`.
    public let version: String?
    /// The app API version (`supportedAPIVersion` is what this build speaks); 0 when missing.
    public let apiVersion: Int
    /// False in open mode: that server has no accounts to sign in to.
    public let isLoginEnabled: Bool
    /// The logins the sign-in sheet can offer, in the server's order.
    public let loginProviders: [Platform]
    /// The platforms the bot runs on.
    public let platforms: [Platform]
    public let features: [ServerFeature]

    /// Whether the answer came from a Sylo at all.
    public var isSylo: Bool { name == "Sylo" }

    public func supports(_ feature: ServerFeature) -> Bool { features.contains(feature) }

    public init(
        name: String = "Sylo", version: String? = nil, apiVersion: Int = supportedAPIVersion,
        isLoginEnabled: Bool = true, loginProviders: [Platform] = [.discord],
        platforms: [Platform] = [.discord], features: [ServerFeature] = [.appLogin, .liveAccess]
    ) {
        self.name = name
        self.version = version
        self.apiVersion = apiVersion
        self.isLoginEnabled = isLoginEnabled
        self.loginProviders = loginProviders
        self.platforms = platforms
        self.features = features
    }

    private enum CodingKeys: String, CodingKey {
        case name, version, apiVersion, login, loginProviders, platforms, features
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        version = try c.decodeIfPresent(String.self, forKey: .version)
        apiVersion = try c.decodeIfPresent(Int.self, forKey: .apiVersion) ?? 0
        isLoginEnabled = try c.decodeIfPresent(Bool.self, forKey: .login) ?? false
        loginProviders = try c.decodeIfPresent([Platform].self, forKey: .loginProviders) ?? []
        platforms = try c.decodeIfPresent([Platform].self, forKey: .platforms) ?? []
        features = try c.decodeIfPresent([ServerFeature].self, forKey: .features) ?? []
    }
}
