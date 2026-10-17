// The Keychain exists only on Apple platforms; elsewhere this file is empty.
#if canImport(Security)
import Foundation
import Security
import Testing
@testable import SyloKit

/// Whether this process can write such an item to a Keychain at all (a locked keychain on a build
/// machine cannot). Probed once with its own throwaway item, with the attributes the store uses but
/// without the code under test.
private let keychainAvailable: Bool = {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "SyloKitTests.probe.\(UUID().uuidString)",
        kSecAttrAccount as String: "probe",
        kSecAttrSynchronizable as String: false,
    ]
    var attributes = query
    attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    attributes[kSecValueData as String] = Data("probe".utf8)
    let added = SecItemAdd(attributes as CFDictionary, nil)
    _ = SecItemDelete(query as CFDictionary)
    return added == errSecSuccess
}()

/// A store with a service name no other test uses, emptied again when the test is done.
private func withStore(_ body: (KeychainTokenStore, String) throws -> Void) throws {
    let service = "SyloKitTests.\(UUID().uuidString)"
    let store = KeychainTokenStore(service: service)
    defer {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        _ = SecItemDelete(query as CFDictionary)
    }
    try body(store, service)
}

private let origin = "https://app.sylobot.com"
private let first = StoredToken(token: "sylo_first_token_value", expiresAt: Date(timeIntervalSince1970: 1_800_000_000))
private let second = StoredToken(token: "sylo_second_token_value", expiresAt: Date(timeIntervalSince1970: 1_900_000_000.5))

@Suite("Keychain token store", .serialized, .enabled(if: keychainAvailable, "needs a writable Keychain"))
struct KeychainTokenStoreTests {
    @Test("nothing stored at first, and deleting nothing is fine")
    func empty() throws {
        try withStore { store, _ in
            #expect(try store.token(for: origin) == nil)
            try store.delete(for: origin)
        }
    }

    @Test("save, read, replace and delete")
    func roundTrip() throws {
        try withStore { store, _ in
            try store.save(first, for: origin)
            #expect(try store.token(for: origin) == first)
            try store.save(second, for: origin)
            #expect(try store.token(for: origin) == second)
            try store.delete(for: origin)
            #expect(try store.token(for: origin) == nil)
        }
    }

    @Test("origins and services are kept apart")
    func separation() throws {
        try withStore { store, _ in
            try withStore { otherService, _ in
                try store.save(first, for: origin)
                try store.save(second, for: "http://192.168.1.5:3000")
                #expect(try store.token(for: origin) == first)
                #expect(try store.token(for: "http://192.168.1.5:3000") == second)
                #expect(try otherService.token(for: origin) == nil)
            }
        }
    }

    @Test("stored on this device only, readable after first unlock, never synced")
    func attributes() throws {
        try withStore { store, service in
            try store.save(first, for: origin)
            try store.save(second, for: origin) // the update path keeps the attributes too
            var query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: origin,
                kSecReturnAttributes as String: true,
                kSecMatchLimit as String: kSecMatchLimitAll,
            ]
            #if !os(macOS)
            query[kSecAttrSynchronizable as String] = kSecAttrSynchronizableAny // a synced copy too
            #endif
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            #expect(status == errSecSuccess)
            let items = try #require(result as? [[String: Any]])
            #expect(items.count == 1)
            let item = try #require(items.first)
            let accessible = item[kSecAttrAccessible as String] as? String
            #if os(macOS)
            // A macOS test run may use the file-based login keychain, which has no accessibility
            // classes; when the attribute is there, it must be the right one.
            if let accessible {
                #expect(accessible == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
            }
            #else
            #expect(accessible == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
            #endif
            let synchronizable = item[kSecAttrSynchronizable as String] as? Bool ?? false
            #expect(!synchronizable)
        }
    }

    @Test("an item that is not a stored token is an error, not a silent sign-out")
    func unreadable() throws {
        try withStore { store, service in
            let item: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: origin,
                kSecValueData as String: Data("not json".utf8),
            ]
            let status = SecItemAdd(item as CFDictionary, nil)
            #expect(status == errSecSuccess)
            #expect(throws: TokenStoreError.invalidItemData) {
                try store.token(for: origin)
            }
            try store.save(first, for: origin) // saving over it repairs it
            #expect(try store.token(for: origin) == first)
        }
    }
}
#endif
