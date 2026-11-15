import Foundation
#if canImport(Security)
import Security
#endif

/// A sign-out the server could not be told about. The app deletes its token at once, so the signed-out
/// account cannot be used from this device, but the server may still hold a push registration for the
/// device (and the token's row). This keeps what is needed to take both down later: the server's own address,
/// the token it issued, and whether it pushes. It is used for nothing else, is only ever sent to that one
/// server, and is dropped when the server answers (success, 401 or 404), after 30 days, or after 20 tries.
public struct PendingRevocation: Codable, Sendable, Equatable, Identifiable {
    public let id: UUID
    public let server: ServerURL
    /// The bearer token to revoke. Never shown or logged.
    public let token: String
    public let created: Date
    /// Whether the server announced push, so `DELETE /api/mobile/push` is worth sending.
    public let hadPush: Bool
    public var attempts: Int

    public static let maxAge: TimeInterval = 30 * 24 * 3600
    public static let maxAttempts = 20
    /// The most kept at once (one per server and sign-in); the oldest go first.
    public static let maxKept = 8

    public init(
        id: UUID = UUID(), server: ServerURL, token: String, created: Date = Date(), hadPush: Bool, attempts: Int = 0
    ) {
        self.id = id
        self.server = server
        self.token = token
        self.created = created
        self.hadPush = hadPush
        self.attempts = attempts
    }

    /// Too old or tried too often: given up on.
    public func isStale(now: Date = Date()) -> Bool {
        now.timeIntervalSince(created) > Self.maxAge || attempts >= Self.maxAttempts
    }
}

extension PendingRevocation: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String { "PendingRevocation(server: \(server), attempts: \(attempts))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: ["server": server, "attempts": attempts]) }
}

/// Where pending revocations are kept between launches: an app-only Keychain item in the app.
public protocol PendingRevocationStore: Sendable {
    func load() throws -> [PendingRevocation]
    func save(_ items: [PendingRevocation]) throws
}

/// For tests and previews.
public final class InMemoryPendingRevocationStore: PendingRevocationStore, @unchecked Sendable {
    // @unchecked: `items` is only read or written while holding `lock`.
    private let lock = NSLock()
    private var items: [PendingRevocation]

    public init(_ items: [PendingRevocation] = []) { self.items = items }

    public func load() throws -> [PendingRevocation] { lock.withLock { items } }
    public func save(_ items: [PendingRevocation]) throws { lock.withLock { self.items = items } }
}

#if canImport(Security)
/// One generic-password item holding the list, readable after the first unlock, on this device only (no
/// iCloud Keychain, not in a restored backup). Apart from the app tokens (own service name).
///
/// With `accessGroup` set to the app-only group (the second `keychain-access-groups` entry, which the
/// notification extension does not have) the extension cannot read it. With `accessGroup` nil the item lands in
/// the process's default group, which the extension shares: the app passes nil when that group cannot be told
/// (a build without signing, a Keychain that cannot be opened yet; see ``SyloAppStorage/pigeonKeychainGroup()``).
/// The extension never calls this store either way, so nothing in it asks for the item.
public struct KeychainPendingRevocationStore: PendingRevocationStore {
    public let service: String
    public let accessGroup: String?
    private let account = "pending"

    public init(service: String = "net.opland.sylo.pending-revocation", accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    public func load() throws -> [PendingRevocation] {
        var query = itemQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else { throw TokenStoreError.keychain(status) }
        guard let data = result as? Data else { throw TokenStoreError.invalidItemData }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        // An item this version cannot read is not worth keeping.
        return (try? decoder.decode([PendingRevocation].self, from: data)) ?? []
    }

    public func save(_ items: [PendingRevocation]) throws {
        if items.isEmpty {
            let status = SecItemDelete(itemQuery() as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw TokenStoreError.keychain(status) }
            return
        }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(items) else { throw TokenStoreError.invalidItemData }
        let changes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updated = SecItemUpdate(itemQuery() as CFDictionary, changes as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw TokenStoreError.keychain(updated) }
        let added = SecItemAdd(itemQuery().merging(changes) { _, new in new } as CFDictionary, nil)
        guard added == errSecSuccess else { throw TokenStoreError.keychain(added) }
    }

    private func itemQuery() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
}
#endif
