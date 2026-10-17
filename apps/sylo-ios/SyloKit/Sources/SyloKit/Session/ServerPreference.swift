import Foundation

/// The Sylo server the app last signed in to (or chose), remembered between launches.
public protocol ServerPreference: AnyObject {
    var server: ServerURL? { get set }
}

/// Keeps the server address in `UserDefaults` (privacy manifest reason CA92.1: the app's own
/// settings). Only the address is stored here; the token lives in the Keychain.
public final class UserDefaultsServerPreference: ServerPreference {
    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = "serverAddress") {
        self.defaults = defaults
        self.key = key
    }

    public var server: ServerURL? {
        get { defaults.string(forKey: key).flatMap { try? ServerURL($0) } }
        set { defaults.set(newValue?.description, forKey: key) }
    }
}
