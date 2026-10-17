import Foundation

/// The app token from `POST /api/mobile/token`, and who it signs in as.
///
/// Printing or dumping it never shows the token, so it cannot end up in a log by accident.
public struct TokenGrant: Decodable, Sendable, Equatable {
    /// `sylo_…`, sent as `Authorization: Bearer`. Store it in the Keychain, never log it.
    public let token: String
    /// When the token stops working if unused; each use moves it forward (90 days, sliding).
    public let expiresAt: Date
    public let account: SignedInAccount

    public init(token: String, expiresAt: Date, account: SignedInAccount) {
        self.token = token
        self.expiresAt = expiresAt
        self.account = account
    }

    private enum CodingKeys: String, CodingKey { case token, expiresAt, account }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        token = try c.decode(String.self, forKey: .token)
        expiresAt = try c.decodeEpochMilliseconds(forKey: .expiresAt)
        account = try c.decode(SignedInAccount.self, forKey: .account)
    }
}

extension TokenGrant: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String { "TokenGrant(token: <redacted>, expiresAt: \(expiresAt), account: \(account.name))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: ["token": "<redacted>", "expiresAt": expiresAt, "account": account])
    }
}

/// The account a token belongs to, as the token answer describes it.
public struct SignedInAccount: Decodable, Sendable, Equatable {
    public let name: String
    public let avatarURL: URL?
    /// The platforms connected to this account.
    public let platforms: [Platform]
    /// One of the instance's operators (`OWNER_IDS` / `FLUXER_OWNER_IDS`).
    public let isOwner: Bool

    public init(name: String, avatarURL: URL? = nil, platforms: [Platform], isOwner: Bool = false) {
        self.name = name
        self.avatarURL = avatarURL
        self.platforms = platforms
        self.isOwner = isOwner
    }

    private enum CodingKeys: String, CodingKey { case name, avatar, platforms, owner }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        avatarURL = try c.decodeURLIfPresent(forKey: .avatar)
        platforms = try c.decodeIfPresent([Platform].self, forKey: .platforms) ?? []
        isOwner = try c.decodeIfPresent(Bool.self, forKey: .owner) ?? false
    }
}
