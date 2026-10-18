import Foundation

/// The signed-in person's account page, from `GET /api/v2/account`: connected platforms and the
/// devices signed in to the Sylo app.
public struct AccountInfo: Decodable, Sendable, Equatable {
    /// An open-mode server (no login); the app never gets a token there, so this stays false.
    public let isOpen: Bool
    /// Runs this Sylo (OWNER_IDS / FLUXER_OWNER_IDS): gets the Health page and dev-log notifications.
    public let isOperator: Bool
    public let platforms: [PlatformConnection]
    /// Signed-in app devices, most recently used first.
    public let devices: [SignedInDevice]

    public init(
        isOpen: Bool = false, isOperator: Bool = false, platforms: [PlatformConnection], devices: [SignedInDevice]
    ) {
        self.isOpen = isOpen
        self.isOperator = isOperator
        self.platforms = platforms
        self.devices = devices
    }

    private enum CodingKeys: String, CodingKey { case open, isOperator = "operator", platforms, devices }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isOpen = try c.decodeIfPresent(Bool.self, forKey: .open) ?? false
        isOperator = try c.decodeIfPresent(Bool.self, forKey: .isOperator) ?? false
        platforms = try c.decodeLossyArray(of: PlatformConnection.self, forKey: .platforms)
        devices = try c.decodeLossyArray(of: SignedInDevice.self, forKey: .devices)
    }
}

/// A platform login the account has connected, or could connect.
public struct PlatformConnection: Decodable, Sendable, Hashable, Identifiable {
    public let platform: Platform
    /// The platform's name as the server labels it ("Discord").
    public let label: String
    public let isConnected: Bool
    public let username: String?
    /// How many servers that login reported at sign-in.
    public let serverCount: Int
    /// Where the web dashboard connects this platform; nil when connected or its login is off.
    public let connectPath: String?
    /// False for the account's only sign-in.
    public let canDisconnect: Bool

    public var id: Platform { platform }

    public init(
        platform: Platform, label: String? = nil, isConnected: Bool, username: String? = nil,
        serverCount: Int = 0, connectPath: String? = nil, canDisconnect: Bool = false
    ) {
        self.platform = platform
        self.label = label ?? platform.displayName
        self.isConnected = isConnected
        self.username = username
        self.serverCount = serverCount
        self.connectPath = connectPath
        self.canDisconnect = canDisconnect
    }

    private enum CodingKeys: String, CodingKey {
        case platform, label, connected, username, guildCount, connectHref, canDisconnect
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        platform = try c.decode(Platform.self, forKey: .platform)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? platform.displayName
        isConnected = try c.decodeIfPresent(Bool.self, forKey: .connected) ?? false
        username = try c.decodeIfPresent(String.self, forKey: .username)
        serverCount = try c.decodeIfPresent(Int.self, forKey: .guildCount) ?? 0
        connectPath = try c.decodeIfPresent(String.self, forKey: .connectHref)
        canDisconnect = try c.decodeIfPresent(Bool.self, forKey: .canDisconnect) ?? false
    }
}

/// A device signed in to the Sylo app, as the account page lists it (never with its token).
public struct SignedInDevice: Decodable, Sendable, Hashable, Identifiable {
    /// The id to revoke it with.
    public let id: String
    /// The name the app sent at sign-in, cleaned by the server.
    public let name: String
    public let createdAt: Date
    public let lastUsedAt: Date
    /// The device making this request: label it "This device".
    public let isCurrent: Bool

    public init(id: String, name: String, createdAt: Date, lastUsedAt: Date, isCurrent: Bool = false) {
        self.id = id
        self.name = name
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
        self.isCurrent = isCurrent
    }

    private enum CodingKeys: String, CodingKey { case id, deviceName, createdAt, lastUsedAt, current }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .deviceName) ?? ""
        createdAt = try c.decodeEpochMilliseconds(forKey: .createdAt)
        lastUsedAt = try c.decodeEpochMillisecondsIfPresent(forKey: .lastUsedAt) ?? createdAt
        isCurrent = try c.decodeIfPresent(Bool.self, forKey: .current) ?? false
    }
}

/// `{ "ok": true }`, the answer to actions that return nothing else (revoking a device).
public struct OKResponse: Decodable, Sendable, Equatable {
    public let ok: Bool

    public init(ok: Bool = true) { self.ok = ok }

    private enum CodingKeys: String, CodingKey { case ok }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false
    }
}
