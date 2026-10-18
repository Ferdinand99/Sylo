import Foundation

/// Every call the app makes, one small value per call (see docs/mobile-app.md).
public enum Endpoints {
    /// `GET /api/mobile/info`: whether an address is a Sylo and whether the app can sign in there.
    public struct ServerInfo: APIEndpoint {
        public typealias Response = SyloKit.ServerInfo
        public var path: String { "/api/mobile/info" }
        public var requiresAuth: Bool { false }
        public init() {}
    }

    /// `POST /api/mobile/token`: trades the sign-in sheet's one-time code for an app token.
    public struct ExchangeCode: APIEndpoint {
        public typealias Response = TokenGrant
        public let code: String
        public let verifier: String
        /// Shown in the account's device list; the server uses "Sylo app" when nil.
        public let deviceName: String?

        public init(code: String, verifier: String, deviceName: String?) {
            self.code = code
            self.verifier = verifier
            self.deviceName = deviceName
        }

        public var path: String { "/api/mobile/token" }
        public var method: HTTPMethod { .post }
        public var requiresAuth: Bool { false }
        public var body: (any Encodable & Sendable)? {
            Body(code: code, verifier: verifier, deviceName: deviceName)
        }

        private struct Body: Encodable, Sendable {
            let code: String
            let verifier: String
            let deviceName: String?
        }
    }

    /// `DELETE /api/mobile/token`: signs this device out; the token stops working at once.
    public struct SignOut: APIEndpoint {
        public typealias Response = EmptyResponse
        public var path: String { "/api/mobile/token" }
        public var method: HTTPMethod { .delete }
        public init() {}
    }

    /// `GET /api/v2/guilds`: the servers the person manages.
    public struct Servers: APIEndpoint {
        public typealias Response = ServerList
        public var path: String { "/api/v2/guilds" }
        public init() {}
    }

    /// `GET /api/v2/guilds/:id/overview`: a server's header and module cards.
    public struct Overview: APIEndpoint {
        public typealias Response = ServerOverview
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/overview" }
    }

    /// `POST /api/v2/guilds/:id/modules/:module`: switches a module on or off.
    public struct SetModule: APIEndpoint {
        public typealias Response = ModuleToggleResult
        public let server: ServerID
        public let module: ModuleID
        public let enabled: Bool

        public init(server: ServerID, module: ModuleID, enabled: Bool) {
            self.server = server
            self.module = module
            self.enabled = enabled
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/\(module.pathComponent)" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(enabled: enabled) }

        private struct Body: Encodable, Sendable { let enabled: Bool }
    }

    /// `GET /api/v2/account`: connected platforms and signed-in devices.
    public struct Account: APIEndpoint {
        public typealias Response = AccountInfo
        public var path: String { "/api/v2/account" }
        public init() {}
    }

    /// `POST /api/v2/account/devices/:id/revoke`: signs another device out (404 if already gone).
    public struct RevokeDevice: APIEndpoint {
        public typealias Response = OKResponse
        public let id: String
        public init(id: String) { self.id = id }
        public var path: String { "/api/v2/account/devices/\(id.encodedPathSegment)/revoke" }
        public var method: HTTPMethod { .post }
    }

    /// `POST /api/v2/account/delete` with `{confirm: true}`: deletes the Sylo account on this
    /// server — its sign-ins, sessions and every app token, this one included.
    public struct DeleteAccount: APIEndpoint {
        public typealias Response = OKResponse
        public init() {}
        public var path: String { "/api/v2/account/delete" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body() }

        private struct Body: Encodable, Sendable { let confirm = true }
    }
}
