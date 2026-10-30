#if canImport(Security)
import Foundation
import Security

/// Where the app and its notification extension keep what they share. The app tokens live in the
/// Keychain access group `$(AppIdentifierPrefix)net.opland.sylo`, which is the first (and only)
/// `keychain-access-groups` entry of both targets, so both reach them through the default group.
/// The tag registry lives in the App Group container. Both are in SyloKit because both targets
/// link it.
public enum SyloAppStorage {
    /// The App Group both targets have (`com.apple.security.application-groups`).
    public static let appGroup = "group.net.opland.sylo"

    /// The Keychain service of the app tokens: the app's bundle id. A constant, because the
    /// extension's own bundle id is another one.
    public static let keychainService = "net.opland.sylo"

    /// Which push tag belongs to which Sylo server (no secrets). Written by the app, read by the
    /// notification extension.
    public static var pushRegistryFile: URL {
        directory.appendingPathComponent("push-tags.json")
    }

    private static var directory: URL {
        let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            // Builds without code signing (plain simulator runs, tests) have no App Group container;
            // the process's own Application Support folder keeps them working. A signed build
            // never gets here.
            ?? URL.applicationSupportDirectory
        return base.appendingPathComponent("Sylo", isDirectory: true)
    }

    /// The app's token store, as the app and the extension both open it.
    public static func makeTokenStore() -> KeychainTokenStore {
        KeychainTokenStore(service: keychainService)
    }

    // MARK: - The Pigeon manage key

    /// The Keychain group of the Pigeon registration: the app's second `keychain-access-groups`
    /// entry (`$(AppIdentifierPrefix)net.opland.sylo.pigeon`), which the extension does not have, so
    /// the extension can never read the manage key.
    static let pigeonKeychainGroupName = "net.opland.sylo.pigeon"

    /// The team-prefixed name of that group, found from the group the app's items go to by
    /// default (the first entry of its entitlement, `TEAM.net.opland.sylo`). Nil where that can't
    /// be told (a build without signing, a Keychain that can't be opened yet): the registration
    /// then goes to the default group.
    public static func pigeonKeychainGroup() -> String? {
        defaultKeychainGroup().flatMap(pigeonKeychainGroup(fromDefaultGroup:))
    }

    /// `TEAM.net.opland.sylo` gives `TEAM.net.opland.sylo.pigeon`; anything else gives nil.
    static func pigeonKeychainGroup(fromDefaultGroup group: String) -> String? {
        let own = keychainService
        guard group.hasSuffix("." + own) else { return nil }
        let prefix = group.dropLast(own.count)  // "TEAM."
        guard prefix.count > 1 else { return nil }
        return String(prefix) + pigeonKeychainGroupName
    }

    /// The group a new Keychain item of this process lands in, asked of the Keychain itself with
    /// an item that holds nothing.
    private static func defaultKeychainGroup() -> String? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "net.opland.sylo.group-probe",
            kSecAttrAccount as String: "probe",
            kSecAttrSynchronizable as String: false,
            kSecReturnAttributes as String: true,
        ]
        var result: CFTypeRef?
        var status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(query as CFDictionary, &result)
        }
        guard status == errSecSuccess, let attributes = result as? [String: Any] else { return nil }
        return attributes[kSecAttrAccessGroup as String] as? String
    }
}

extension PushHandleManager {
    /// The manager the app uses: the official Pigeon, the registration in the Keychain (in a group
    /// only the app has) and the tag registry in the App Group container.
    public static func live(environment: PushEnvironment) -> PushHandleManager {
        PushHandleManager(
            relay: PigeonClient.live(),
            registrar: PigeonRegistrar(
                client: PigeonClient.live(), store: KeychainPigeonStore(accessGroup: SyloAppStorage.pigeonKeychainGroup()),
                environment: PigeonEnvironment(environment)),
            registry: PushRegistry(fileURL: SyloAppStorage.pushRegistryFile))
    }
}
#endif
