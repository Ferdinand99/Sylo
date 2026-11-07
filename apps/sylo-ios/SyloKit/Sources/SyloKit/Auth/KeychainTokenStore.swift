#if canImport(Security)
import Foundation
import Security

/// Keeps app tokens in the Keychain: one generic-password item per server key, readable after
/// the first unlock, on this device only (no iCloud Keychain sync, not in a backup restored to
/// another device). Every Keychain failure is thrown, never swallowed, so a failed save is not
/// mistaken for being signed out.
public struct KeychainTokenStore: TokenStore {
    private let service: String
    private let accessGroup: String?

    /// - Parameters:
    ///   - service: The Keychain service for all of the app's tokens (the app's bundle id).
    ///   - accessGroup: The Keychain access group of the items, with the team prefix resolved. Nil
    ///     (the default) is the process's default group: the first entry of its
    ///     `keychain-access-groups` entitlement, which is the same one for the app and its
    ///     notification extension, so both see the same items.
    public init(service: String, accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    public func token(for origin: String) throws -> StoredToken? {
        var query = itemQuery(for: origin)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw TokenStoreError.keychain(status) }
        guard let data = result as? Data else { throw TokenStoreError.invalidItemData }
        do {
            return try JSONDecoder().decode(StoredToken.self, from: data)
        } catch {
            throw TokenStoreError.invalidItemData
        }
    }

    public func save(_ token: StoredToken, for origin: String) throws {
        let data: Data
        do {
            data = try JSONEncoder().encode(token)
        } catch {
            throw TokenStoreError.invalidItemData
        }
        let query = itemQuery(for: origin)
        let changes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let updated = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw TokenStoreError.keychain(updated) }

        let item = query.merging(changes) { _, new in new }
        let added = SecItemAdd(item as CFDictionary, nil)
        guard added == errSecSuccess else { throw TokenStoreError.keychain(added) }
    }

    public func delete(for origin: String) throws {
        let status = SecItemDelete(itemQuery(for: origin) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw TokenStoreError.keychain(status)
        }
    }

    /// The attributes that identify the item for `origin`.
    func itemQuery(for origin: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: origin,
            kSecAttrSynchronizable as String: false,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
}
#endif
