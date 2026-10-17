import Foundation
#if canImport(Security)
import Security
#endif

/// The app token for one Sylo server, as kept between launches. Its description never shows the
/// token.
public struct StoredToken: Codable, Sendable, Equatable {
    /// The bearer token (`sylo_…`).
    public let token: String
    /// When the server stops accepting it, unless it is used before then (the expiry slides).
    public let expiresAt: Date

    public init(token: String, expiresAt: Date) {
        self.token = token
        self.expiresAt = expiresAt
    }

    /// Whether the server no longer accepts the token at `now`.
    public func isExpired(now: Date = Date()) -> Bool {
        now >= expiresAt
    }
}

extension StoredToken: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String { "StoredToken(expiresAt: \(expiresAt))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: ["expiresAt": expiresAt]) }
}

/// Where the app keeps its token for each server, keyed by the server's origin
/// (`scheme://host[:port]`). A protocol so models and previews can use ``InMemoryTokenStore``.
public protocol TokenStore: Sendable {
    /// The token saved for `origin`, or nil when there is none.
    func token(for origin: String) throws -> StoredToken?
    /// Saves `token` for `origin`, replacing any token saved before.
    func save(_ token: StoredToken, for origin: String) throws
    /// Removes the token for `origin`; nothing happens when there is none.
    func delete(for origin: String) throws
}

/// Why a token store could not read or write.
public enum TokenStoreError: Error, Equatable, Sendable {
    #if canImport(Security)
    /// The Keychain answered with this status.
    case keychain(OSStatus)
    #endif
    /// The stored item is not a token this version of the app can read. Saving a new token
    /// replaces it.
    case invalidItemData
}

/// A token store in memory only, for tests and previews.
public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    // @unchecked: `tokens` is only read or written while holding `lock`.
    private let lock = NSLock()
    private var tokens: [String: StoredToken]

    public init(tokens: [String: StoredToken] = [:]) {
        self.tokens = tokens
    }

    public func token(for origin: String) throws -> StoredToken? {
        lock.withLock { tokens[origin] }
    }

    public func save(_ token: StoredToken, for origin: String) throws {
        lock.withLock { tokens[origin] = token }
    }

    public func delete(for origin: String) throws {
        lock.withLock { tokens[origin] = nil }
    }
}
