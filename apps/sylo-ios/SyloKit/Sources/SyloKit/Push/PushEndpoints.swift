import Foundation

/// Which APNs environment a device token belongs to: `development` for builds run from Xcode,
/// `production` for TestFlight and the App Store.
public enum PushEnvironment: String, Sendable, Codable, Hashable {
    case development
    case production
}

/// The only notification relay the app registers with: the hosted Sylo, which holds the app's
/// APNs key. A Sylo server naming any other relay gets no notifications.
public enum PushRelay {
    public static let official = ServerURL.hosted

    /// Whether `url` is the official relay, compared as normalised server addresses.
    public static func isOfficial(_ url: URL) -> Bool {
        (try? ServerURL(url.absoluteString)) == official
    }
}

// The push notification calls. Notifications are tied to this device's app token, so signing out
// or revoking the device ends them at once.
extension Endpoints {
    /// `POST /api/mobile/push`: turns ticket notifications on for this sign-in, with this device's
    /// APNs token (a server with its own APNs key) or the relay's token for it (a server that
    /// sends through the relay, which then never sees the device token). 400 `invalid_push_token`
    /// when the token is refused, `relay_token_required` / `device_token_required` for the wrong
    /// kind; 503 `push_unavailable` when the server can't send notifications.
    public struct RegisterPush: APIEndpoint {
        public typealias Response = OKResponse
        /// The device token in lowercase hex (``PushToken/hex(_:)``), when sent directly.
        public let deviceToken: String?
        /// The relay's token for this device, when the server sends through the relay.
        public let relayToken: String?
        public let environment: PushEnvironment

        public init(deviceToken: String, environment: PushEnvironment) {
            self.deviceToken = deviceToken
            self.relayToken = nil
            self.environment = environment
        }

        public init(relayToken: String, environment: PushEnvironment) {
            self.deviceToken = nil
            self.relayToken = relayToken
            self.environment = environment
        }

        public var path: String { "/api/mobile/push" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            Body(deviceToken: deviceToken, relayToken: relayToken, environment: environment)
        }

        /// Only the token given is sent (nil fields are left out).
        private struct Body: Encodable, Sendable {
            let deviceToken: String?
            let relayToken: String?
            let environment: PushEnvironment
        }
    }

    /// `POST <relay>/api/push-relay/v1/register`: registers this device with the notification
    /// relay for one Sylo server. Sent to the relay without any token. 400 `invalid_request`,
    /// 429 when rate limited.
    public struct RegisterWithRelay: APIEndpoint {
        public typealias Response = PushRelayRegistration
        /// The device token in lowercase hex.
        public let deviceToken: String
        public let environment: PushEnvironment
        /// The Sylo server allowed to send to this device.
        public let instance: ServerURL

        public init(deviceToken: String, environment: PushEnvironment, instance: ServerURL) {
            self.deviceToken = deviceToken
            self.environment = environment
            self.instance = instance
        }

        public var path: String { "/api/push-relay/v1/register" }
        public var method: HTTPMethod { .post }
        public var requiresAuth: Bool { false }
        public var body: (any Encodable & Sendable)? {
            Body(deviceToken: deviceToken, environment: environment, instance: instance.description)
        }

        private struct Body: Encodable, Sendable {
            let deviceToken: String
            let environment: PushEnvironment
            let instance: String
        }
    }

    /// `DELETE /api/mobile/push`: turns notifications off for this sign-in.
    public struct UnregisterPush: APIEndpoint {
        public typealias Response = EmptyResponse
        public var path: String { "/api/mobile/push" }
        public var method: HTTPMethod { .delete }
        public init() {}
    }

    /// `GET /api/mobile/push`: whether notifications are on for this sign-in, and the muted servers.
    public struct PushSettings: APIEndpoint {
        public typealias Response = PushSettingsInfo
        public var path: String { "/api/mobile/push" }
        public init() {}
    }

    /// `PUT /api/mobile/push/servers/:id`: mutes or unmutes one server's ticket notifications.
    public struct MutePushForServer: APIEndpoint {
        public typealias Response = PushMuteResult
        public let server: ServerID
        public let muted: Bool

        public init(server: ServerID, muted: Bool) {
            self.server = server
            self.muted = muted
        }

        public var path: String { "/api/mobile/push/servers/\(server.pathComponent)" }
        public var method: HTTPMethod { .put }
        public var body: (any Encodable & Sendable)? { Body(muted: muted) }

        private struct Body: Encodable, Sendable { let muted: Bool }
    }
}

/// What `GET /api/mobile/push` says. Missing fields read as off and nothing muted.
public struct PushSettingsInfo: Decodable, Sendable, Equatable {
    public let isEnabled: Bool
    public let mutedServers: [ServerID]
    /// Which dev-log events this device is notified about; only an operator gets it.
    public let devLog: DevLogNotificationLevel?

    public init(isEnabled: Bool, mutedServers: [ServerID] = [], devLog: DevLogNotificationLevel? = nil) {
        self.isEnabled = isEnabled
        self.mutedServers = mutedServers
        self.devLog = devLog
    }

    private enum CodingKeys: String, CodingKey { case enabled, mutedServers, devLog }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isEnabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        mutedServers = try c.decodeIfPresent([ServerID].self, forKey: .mutedServers) ?? []
        devLog = try? c.decodeIfPresent(DevLogNotificationLevel.self, forKey: .devLog)
    }
}

/// The relay's answer to a registration: the token the Sylo server sends with.
public struct PushRelayRegistration: Decodable, Sendable, Equatable {
    public let relayToken: String

    public init(relayToken: String) { self.relayToken = relayToken }
}

/// The muted servers after a mute or unmute.
public struct PushMuteResult: Decodable, Sendable, Equatable {
    public let mutedServers: [ServerID]

    public init(mutedServers: [ServerID]) { self.mutedServers = mutedServers }

    private enum CodingKeys: String, CodingKey { case mutedServers }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mutedServers = try c.decodeIfPresent([ServerID].self, forKey: .mutedServers) ?? []
    }
}
