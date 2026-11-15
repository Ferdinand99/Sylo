import Foundation

/// What the app remembers about this device's notification registration while it runs: the APNs token iOS
/// gave it, and which server and token pair it last registered. Plain state with no side effects, so the
/// rules around signing out are tested without UIKit.
///
/// Signing out stops notifications on the device itself, whether or not the server can be reached: the app
/// forgets the token and what it sent, and (in the app) tells iOS to unregister for remote notifications.
/// A later sign-in then asks iOS for a token again and registers from scratch.
public struct PushDeviceState: Equatable, Sendable {
    /// The APNs token iOS gave the app; nil before iOS answers, and again after a sign-out.
    public private(set) var deviceToken: Data?
    /// The server and token last registered, so a token is sent once per sign-in.
    private var sentKey: String?

    public init(deviceToken: Data? = nil) {
        self.deviceToken = deviceToken
    }

    /// iOS gave the app a (new) device token.
    public mutating func received(deviceToken: Data) {
        self.deviceToken = deviceToken
    }

    /// Whether this token was already registered at `server` in this sign-in.
    public func hasRegistered(at server: ServerURL) -> Bool {
        guard let key = Self.key(server: server, token: deviceToken) else { return false }
        return sentKey == key
    }

    /// The registration of `token` at `server` worked.
    public mutating func registered(at server: ServerURL, token: Data) {
        sentKey = Self.key(server: server, token: token)
    }

    /// A new sign-in, or notifications switched back on: register again.
    public mutating func forgetRegistration() {
        sentKey = nil
    }

    /// The person signed out (or was signed out): nothing about the registration is kept, and the token is
    /// dropped, because iOS is told to unregister and gives a new one on the next registration.
    public mutating func signedOut() {
        deviceToken = nil
        sentKey = nil
    }

    /// Whether the app has to ask iOS for a device token (before a registration can be sent).
    public var needsDeviceToken: Bool { deviceToken == nil }

    private static func key(server: ServerURL, token: Data?) -> String? {
        token.map { "\(server.description) \(PushToken.hex($0))" }
    }
}
