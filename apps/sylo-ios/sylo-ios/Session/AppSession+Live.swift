import SyloKit
import UIKit

extension AppSession {
    /// The session the app runs with: tokens in the Keychain, the server address in
    /// `UserDefaults`, and real network clients.
    static func live() -> AppSession {
        let device = UIDevice.current
        return AppSession(
            // The same Keychain items the notification extension reads (shared access group).
            tokens: SyloAppStorage.makeTokenStore(),
            preference: UserDefaultsServerPreference(),
            // UIDevice.name is generic since iOS 16, so name the model: "iPhone — Sylo app".
            deviceName: SignInRequest.deviceName(model: device.model, systemName: device.systemName),
            // Sign-outs the server could not be told about. Kept in the app-only Keychain group, which the extension
            // does not have; where that group cannot be told (a build without signing) it falls back to the default
            // group, which the extension shares but never reads this item from.
            pendingRevocations: KeychainPendingRevocationStore(accessGroup: SyloAppStorage.pigeonKeychainGroup()),
            makeClient: { server, token in
                URLSessionAPIClient(server: server, token: { token })
            }
        )
    }
}
