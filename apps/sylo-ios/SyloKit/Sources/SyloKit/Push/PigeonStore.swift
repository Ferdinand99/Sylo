import Foundation
#if canImport(Security)
import Security
#endif

// What this device keeps about its registration with Pigeon, and the code that keeps it in step
// with the APNs token.

/// What is kept on this device about the registration: the ids, the APNs token Pigeon was last
/// given (hex), and when Pigeon last heard from this device. Kept together so they cannot
/// disagree. Only ever in the Keychain.
public struct PigeonRecord: Codable, Sendable, Equatable {
    public var registration: PigeonRegistration
    public var token: String
    public var lastSent: Date

    public init(registration: PigeonRegistration, token: String, lastSent: Date) {
        self.registration = registration
        self.token = token
        self.lastSent = lastSent
    }
}

extension PigeonRecord: CustomStringConvertible, CustomDebugStringConvertible {
    public var description: String { "PigeonRecord(\(registration), token: <hidden>, lastSent: \(lastSent))" }
    public var debugDescription: String { description }
}

public protocol PigeonStore: Sendable {
    func load() throws -> PigeonRecord?
    func save(_ record: PigeonRecord) throws
    /// Clearing what is not there is not an error.
    func clear() throws
}

/// For tests and previews.
public final class InMemoryPigeonStore: PigeonStore, @unchecked Sendable {
    // @unchecked: `record` is only read or written while holding `lock`.
    private let lock = NSLock()
    private var record: PigeonRecord?

    public init(_ record: PigeonRecord? = nil) {
        self.record = record
    }

    public func load() throws -> PigeonRecord? { lock.withLock { record } }
    public func save(_ record: PigeonRecord) throws { lock.withLock { self.record = record } }
    public func clear() throws { lock.withLock { record = nil } }
}

#if canImport(Security)
/// One generic-password item. It is readable after the first unlock, never leaves this device and
/// is never synchronised through iCloud. Kept apart from the app tokens (own service name).
///
/// Only the app opens it: the notification extension never calls this, so nothing in the
/// extension asks for the manage key.
public struct KeychainPigeonStore: PigeonStore {
    public let service: String
    public let accessGroup: String?
    private let account = "registration"

    public init(service: String = "net.opland.sylo.pigeon", accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    func itemQuery() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    public func load() throws -> PigeonRecord? {
        var request = itemQuery()
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw TokenStoreError.keychain(status) }
        // Data that is not a record (a damaged item) reads as none: the next save replaces it.
        return (result as? Data).flatMap(Self.decode)
    }

    public func save(_ record: PigeonRecord) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data: Data
        do {
            data = try encoder.encode(record)
        } catch {
            throw TokenStoreError.invalidItemData
        }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(itemQuery() as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(itemQuery().merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw TokenStoreError.keychain(status) }
    }

    public func clear() throws {
        let status = SecItemDelete(itemQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw TokenStoreError.keychain(status)
        }
    }

    private static func decode(_ data: Data) -> PigeonRecord? {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(PigeonRecord.self, from: data)
    }
}
#endif

// MARK: - Registrar

/// Keeps this device's registration with Pigeon in step with the APNs token. Calls come one at a
/// time (``PushHandleManager`` serialises them).
public struct PigeonRegistrar: Sendable {
    private let client: PigeonClient
    private let store: any PigeonStore
    private let environment: PigeonEnvironment
    private let now: @Sendable () -> Date

    public init(
        client: PigeonClient, store: any PigeonStore, environment: PigeonEnvironment,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.client = client
        self.store = store
        self.environment = environment
        self.now = now
    }

    /// The device id that is stored, if any (it is not secret).
    public func storedDeviceId() -> String? {
        (try? store.load())?.registration.deviceId
    }

    /// The registration that is stored, if any.
    func storedRegistration() -> PigeonRegistration? {
        (try? store.load())?.registration
    }

    /// Pigeon wants a `PUT` on launch, at most once a day (a device it has not heard from in 90
    /// days is deleted). A last-sent time in the future (the clock was set back) counts as due.
    static func needsKeepAlive(lastSent: Date, now: Date) -> Bool {
        let age = now.timeIntervalSince(lastSent)
        return age < 0 || age >= 24 * 3600
    }

    /// APNs gave the app `token`. With nothing stored: register. With a stored registration: `PUT`
    /// when the token changed or the daily keep-alive is due, nothing otherwise. A `404` (the record
    /// is gone) or a refused manage key means registering again, once; the new ids replace the old
    /// ones.
    @discardableResult
    public func apply(token: Data) async throws -> PigeonRegistration {
        let hex = PushToken.hex(token)
        guard let record = try store.load() else {
            return try await registerAndStore(token: token, hex: hex)
        }
        if record.token == hex, !Self.needsKeepAlive(lastSent: record.lastSent, now: now()) {
            return record.registration
        }
        do {
            try await client.update(record.registration, token: token, environment: environment)
        } catch PigeonError.gone, PigeonError.invalidCredentials {
            return try await registerAndStore(token: token, hex: hex)
        }
        try store.save(PigeonRecord(registration: record.registration, token: hex, lastSent: now()))
        return record.registration
    }

    /// Pigeon does not know this device any more, or refuses its manage key (`gone`,
    /// `invalidCredentials` on a handle call): forget the registration, so the next ``apply(token:)``
    /// registers a new device instead of waiting for the daily keep-alive to find out. Nothing is
    /// sent: a device Pigeon does not know cannot be removed, and a refused key cannot remove it.
    public func reregister() {
        try? store.clear()
    }

    private func registerAndStore(token: Data, hex: String) async throws -> PigeonRegistration {
        let registration = try await client.register(environment: environment, token: token)
        do {
            try store.save(PigeonRecord(registration: registration, token: hex, lastSent: now()))
        } catch {
            // Could not keep the manage key: do not leave a record behind that nobody can remove.
            try? await client.remove(registration)
            throw error
        }
        return registration
    }
}
