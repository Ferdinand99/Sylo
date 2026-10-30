#if canImport(Security)
import Foundation

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
}

extension PushHandleManager {
    /// The manager the app uses: the official Pigeon, the registration in the Keychain (only the
    /// app opens it) and the tag registry in the App Group container.
    public static func live(environment: PushEnvironment) -> PushHandleManager {
        PushHandleManager(
            relay: PigeonClient.live(),
            registrar: PigeonRegistrar(
                client: PigeonClient.live(), store: KeychainPigeonStore(), environment: PigeonEnvironment(environment)),
            registry: PushRegistry(fileURL: SyloAppStorage.pushRegistryFile))
    }
}
#endif
