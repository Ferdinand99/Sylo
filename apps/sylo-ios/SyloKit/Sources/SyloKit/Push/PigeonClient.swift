import Foundation

// Postal Pigeon: the push relay. The app registers this device's APNs token with it and keeps the
// device id and the manage key it gets back. Each Sylo server gets its own handle there, which the
// app then gives to that server (``Endpoints/RegisterPush``). The push itself carries no text: the
// app fetches that from the server (``NotificationRewriter``).
//
// The calls go through the same ``APIClient`` as the Sylo calls (https only, no redirect, no
// cookies, no cache, nothing logged), with the manage key as the bearer token.

/// `sandbox` for builds run from Xcode, `production` for TestFlight and the App Store.
public enum PigeonEnvironment: String, Sendable, Equatable, Codable {
    case sandbox
    case production

    /// The app's `development` builds are Pigeon's `sandbox`.
    public init(_ environment: PushEnvironment) {
        switch environment {
        case .development: self = .sandbox
        case .production: self = .production
        }
    }
}

/// The only Pigeon the app registers with: the Hedgerow one. A Sylo server naming any other gets no
/// notifications through it, or it could be handed the device's handles.
public enum PigeonRelay {
    public static let official = ServerURL.pigeon

    /// Whether `url` is the official Pigeon, compared as normalised server addresses.
    public static func isOfficial(_ url: URL) -> Bool {
        (try? ServerURL(url.absoluteString)) == official
    }

    /// The app name Pigeon knows Sylo by.
    static let app = "sylo"
}

/// What Pigeon hands out when a device registers. `deviceId` (`hrd_…`) is not secret; `manageKey`
/// (`hrm_…`) is, and is never logged or shown.
public struct PigeonRegistration: Codable, Sendable, Equatable {
    public let deviceId: String
    public let manageKey: String

    public init(deviceId: String, manageKey: String) {
        self.deviceId = deviceId
        self.manageKey = manageKey
    }

    enum CodingKeys: String, CodingKey {
        case deviceId = "device_id"
        case manageKey = "manage_key"
    }
}

// Printing a registration (a log line, a test failure) shows the device id only.
extension PigeonRegistration: CustomStringConvertible, CustomDebugStringConvertible {
    public var description: String { "PigeonRegistration(deviceId: \(deviceId), manageKey: <hidden>)" }
    public var debugDescription: String { description }
}

/// What Pigeon hands out for a new handle. `handle` (`hrh_…`) is what a server needs to push to this
/// device; it is given to that one server and never kept, logged or shown. `handleId` is not secret.
public struct PigeonHandle: Decodable, Sendable, Equatable {
    public let handleId: String
    public let handle: String

    public init(handleId: String, handle: String) {
        self.handleId = handleId
        self.handle = handle
    }

    enum CodingKeys: String, CodingKey {
        case handleId = "handle_id"
        case handle
    }
}

extension PigeonHandle: CustomStringConvertible, CustomDebugStringConvertible {
    public var description: String { "PigeonHandle(handleId: \(handleId), handle: <hidden>)" }
    public var debugDescription: String { description }
}

/// One entry of Pigeon's list of a device's handles (never their secrets).
public struct PigeonHandleInfo: Decodable, Sendable, Equatable {
    public let handleId: String
    public let tag: String?

    public init(handleId: String, tag: String?) {
        self.handleId = handleId
        self.tag = tag
    }

    enum CodingKeys: String, CodingKey {
        case handleId = "handle_id"
        case tag
    }
}

public enum PigeonError: Error, Equatable, Sendable {
    /// `404`: Pigeon has no such device any more. Register again.
    case gone
    /// `429`: too many calls (10 new handles an hour).
    case rateLimited
    /// `5xx`, or no connection: try again later.
    case unavailable
    /// `401`: the manage key was refused.
    case invalidCredentials
    /// `409`: the device already has the most handles it may have.
    case limitReached
    /// Anything else: an answer the app does not understand, or an id that cannot be put in a URL.
    case unexpected
}

extension PigeonError {
    /// Any error from a call as what the app does about it. A cancelled call stays a cancellation.
    /// `notFound` is what a `404` means for the call: the record for most, nothing sensible for `POST`.
    static func translate(_ error: any Error, notFound: PigeonError) -> any Error {
        if error is PigeonError || error is CancellationError { return error }
        switch NetworkError(error) {
        case .cancelled: return CancellationError()
        case .notFound: return notFound
        case .unauthorized: return PigeonError.invalidCredentials
        case .rateLimited: return PigeonError.rateLimited
        case .http(status: 409): return PigeonError.limitReached
        case .server, .offline, .timeout, .unreachable, .secureConnectionFailed, .transport:
            return PigeonError.unavailable
        default: return PigeonError.unexpected
        }
    }
}

// MARK: - Endpoints

/// The Pigeon calls, as ``APIEndpoint``s so they go through the same client as everything else.
/// `docs/api.md` of Postal Pigeon, "Devices and handles".
enum PigeonEndpoints {
    /// `POST /v1/devices`. A record for the same token is replaced by Pigeon.
    struct RegisterDevice: APIEndpoint {
        typealias Response = PigeonRegistration
        let environment: PigeonEnvironment
        let token: String

        var path: String { "/v1/devices" }
        var method: HTTPMethod { .post }
        var requiresAuth: Bool { false }
        var body: (any Encodable & Sendable)? { Body(app: PigeonRelay.app, environment: environment.rawValue, token: token) }

        private struct Body: Encodable, Sendable {
            let app: String
            let environment: String
            let token: String
        }
    }

    /// `PUT /v1/devices/{id}`: a new token, a new environment, or just a keep-alive (both nil).
    struct UpdateDevice: APIEndpoint {
        typealias Response = EmptyResponse
        let deviceId: String
        let token: String?
        let environment: PigeonEnvironment?

        var path: String { "/v1/devices/\(deviceId)" }
        var method: HTTPMethod { .put }
        var body: (any Encodable & Sendable)? { Body(token: token, environment: environment?.rawValue) }

        private struct Body: Encodable, Sendable {
            let token: String?
            let environment: String?
        }
    }

    /// `DELETE /v1/devices/{id}`.
    struct RemoveDevice: APIEndpoint {
        typealias Response = EmptyResponse
        let deviceId: String

        var path: String { "/v1/devices/\(deviceId)" }
        var method: HTTPMethod { .delete }
    }

    /// `POST /v1/devices/{id}/handles`: `tag` comes back in every push for the handle.
    struct CreateHandle: APIEndpoint {
        typealias Response = PigeonHandle
        let deviceId: String
        let tag: String

        var path: String { "/v1/devices/\(deviceId)/handles" }
        var method: HTTPMethod { .post }
        var body: (any Encodable & Sendable)? { Body(tag: tag) }

        private struct Body: Encodable, Sendable { let tag: String }
    }

    /// `DELETE /v1/devices/{id}/handles/{handle_id}`.
    struct RevokeHandle: APIEndpoint {
        typealias Response = EmptyResponse
        let deviceId: String
        let handleId: String

        var path: String { "/v1/devices/\(deviceId)/handles/\(handleId)" }
        var method: HTTPMethod { .delete }
    }

    /// `GET /v1/devices/{id}/handles`.
    struct ListHandles: APIEndpoint {
        typealias Response = HandleList
        let deviceId: String

        var path: String { "/v1/devices/\(deviceId)/handles" }

        struct HandleList: Decodable, Sendable {
            let handles: [PigeonHandleInfo]
        }
    }
}

// MARK: - Client

/// One request per call. Ids are checked before they go into a path, so nothing odd in an answer
/// can change where the next call goes.
public struct PigeonClient: Sendable {
    /// Makes the client for one call, with the manage key as bearer token (nil: no token).
    public typealias ClientFactory = @Sendable (_ manageKey: String?) -> any APIClient

    private let makeClient: ClientFactory

    public init(makeClient: @escaping ClientFactory) {
        self.makeClient = makeClient
    }

    /// The client the app uses: the official Pigeon, over `URLSession`.
    public static func live() -> PigeonClient {
        PigeonClient { manageKey in
            URLSessionAPIClient(server: PigeonRelay.official, token: { manageKey })
        }
    }

    /// `POST /v1/devices`.
    public func register(environment: PigeonEnvironment, token: Data) async throws -> PigeonRegistration {
        do {
            let registration = try await makeClient(nil).send(
                PigeonEndpoints.RegisterDevice(environment: environment, token: PushToken.hex(token)))
            guard Self.isWellFormedID(registration.deviceId, prefix: "hrd_"),
                Self.isWellFormedID(registration.manageKey, prefix: "hrm_")
            else { throw PigeonError.unexpected }
            return registration
        } catch {
            throw PigeonError.translate(error, notFound: .unexpected)
        }
    }

    /// `PUT /v1/devices/{id}`: a new token, a new environment, or just a keep-alive (both nil).
    /// `404` is ``PigeonError/gone``: register again.
    public func update(
        _ registration: PigeonRegistration, token: Data? = nil, environment: PigeonEnvironment? = nil
    ) async throws {
        try requireWellFormed(registration)
        do {
            _ = try await makeClient(registration.manageKey).send(
                PigeonEndpoints.UpdateDevice(
                    deviceId: registration.deviceId, token: token.map(PushToken.hex), environment: environment))
        } catch {
            throw PigeonError.translate(error, notFound: .gone)
        }
    }

    /// `DELETE /v1/devices/{id}`. A record that is already gone counts as removed.
    public func remove(_ registration: PigeonRegistration) async throws {
        try requireWellFormed(registration)
        do {
            _ = try await makeClient(registration.manageKey).send(
                PigeonEndpoints.RemoveDevice(deviceId: registration.deviceId))
        } catch {
            let error = PigeonError.translate(error, notFound: .gone)
            if let error = error as? PigeonError, error == .gone { return }
            throw error
        }
    }

    // MARK: Handles

    /// `POST /v1/devices/{id}/handles`: a new handle for one server. `404` is ``PigeonError/gone``
    /// (the device is gone: register again), `409` is ``PigeonError/limitReached``, `429` is
    /// ``PigeonError/rateLimited`` (10 new handles an hour).
    public func createHandle(_ registration: PigeonRegistration, tag: String) async throws -> PigeonHandle {
        try requireWellFormed(registration)
        guard PushTag.isWellFormed(tag) else { throw PigeonError.unexpected }
        do {
            let handle = try await makeClient(registration.manageKey).send(
                PigeonEndpoints.CreateHandle(deviceId: registration.deviceId, tag: tag))
            guard Self.isWellFormedID(handle.handleId, prefix: ""), Self.isWellFormedID(handle.handle, prefix: "hrh_")
            else { throw PigeonError.unexpected }
            return handle
        } catch {
            throw PigeonError.translate(error, notFound: .gone)
        }
    }

    /// `DELETE /v1/devices/{id}/handles/{handle_id}`. A handle that is already gone counts as revoked.
    public func revokeHandle(_ registration: PigeonRegistration, handleId: String) async throws {
        try requireWellFormed(registration)
        guard Self.isWellFormedID(handleId, prefix: "") else { throw PigeonError.unexpected }
        do {
            _ = try await makeClient(registration.manageKey).send(
                PigeonEndpoints.RevokeHandle(deviceId: registration.deviceId, handleId: handleId))
        } catch {
            let error = PigeonError.translate(error, notFound: .gone)
            if let error = error as? PigeonError, error == .gone { return }
            throw error
        }
    }

    /// `GET /v1/devices/{id}/handles`: the handles Pigeon still has for this device.
    public func listHandles(_ registration: PigeonRegistration) async throws -> [PigeonHandleInfo] {
        try requireWellFormed(registration)
        do {
            return try await makeClient(registration.manageKey).send(
                PigeonEndpoints.ListHandles(deviceId: registration.deviceId)).handles
        } catch {
            throw PigeonError.translate(error, notFound: .gone)
        }
    }

    // MARK: Plumbing

    private func requireWellFormed(_ registration: PigeonRegistration) throws {
        guard Self.isWellFormedID(registration.deviceId, prefix: "hrd_"),
            Self.isWellFormedID(registration.manageKey, prefix: "hrm_")
        else { throw PigeonError.unexpected }
    }

    /// An id or key that is safe to put in a URL path or a header: the prefix and then letters,
    /// digits, `_` and `-`.
    static func isWellFormedID(_ value: String, prefix: String) -> Bool {
        guard value.hasPrefix(prefix), value.count > prefix.count, value.count <= 128 else { return false }
        return value.utf8.allSatisfy(isURLSafe)
    }
}
