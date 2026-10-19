import Foundation
import Testing
@testable import SyloKit

@MainActor
@Suite("Notification settings model")
struct NotificationSettingsModelTests {
    nonisolated static let pushInfo = ServerInfo(features: [.appLogin, .liveAccess, .push])
    nonisolated static let oldInfo = ServerInfo(features: [.appLogin, .liveAccess])
    nonisolated static let relayInfo = ServerInfo(
        features: [.appLogin, .liveAccess, .push], pushRelay: URL(string: "https://app.sylobot.com/"))
    nonisolated static let untrustedInfo = ServerInfo(
        features: [.appLogin, .liveAccess, .push], pushRelay: URL(string: "https://relay.example.com"))
    nonisolated static let instance = try! ServerURL("https://sylo.example.com")
    nonisolated static let settings = PushSettingsInfo(isEnabled: true, mutedServers: ["2"])

    /// Answers like a Sylo that can push (or not, with `info`), muting with `mute` (default: the
    /// server agrees and lists what is muted).
    static func clients(
        info: ServerInfo = pushInfo,
        mute: @escaping @Sendable (Endpoints.MutePushForServer) throws -> PushMuteResult = { set in
            var muted = Set(settings.mutedServers)
            if set.muted { muted.insert(set.server) } else { muted.remove(set.server) }
            return PushMuteResult(mutedServers: muted.sorted { $0.rawValue < $1.rawValue })
        }
    ) -> StubClients {
        StubClients { endpoint in
            switch endpoint {
            case is Endpoints.ServerInfo: return info
            case is Endpoints.PushSettings: return Self.settings
            case is Endpoints.RegisterPush: return OKResponse()
            case is Endpoints.RegisterWithRelay: return PushRelayRegistration(relayToken: "relay-1")
            case is Endpoints.UnregisterPush: return EmptyResponse()
            case let set as Endpoints.MutePushForServer: return try mute(set)
            default: throw NetworkError.notFound
            }
        }
    }

    func loadedModel(_ clients: StubClients) async -> NotificationSettingsModel {
        let model = NotificationSettingsModel(session: makeSignedInSession(clients: clients))
        await model.load()
        return model
    }

    func calls<E: APIEndpoint>(_ type: E.Type, in clients: StubClients) -> [E] {
        clients.calls.compactMap { $0.endpoint as? E }
    }

    @Test("signed in without the server's info, it asks the server whether it can push")
    func checksAvailability() async {
        let clients = Self.clients()
        let model = NotificationSettingsModel(session: makeSignedInSession(clients: clients))
        #expect(!model.isAvailable)
        #expect(!model.hasLoadedAvailability)
        await model.loadAvailability()
        #expect(model.isAvailable)
        #expect(model.hasLoadedAvailability)

        await model.loadAvailability()
        #expect(calls(Endpoints.ServerInfo.self, in: clients).count == 1)
    }

    @Test("the server's info it fetched is there for the rest of Settings, such as What's New")
    func sharesServerInfo() async {
        let info = ServerInfo(version: "4.6.0", features: [.appLogin, .liveAccess, .changelog])
        let model = NotificationSettingsModel(session: makeSignedInSession(clients: Self.clients(info: info)))
        #expect(model.serverInfo == nil)
        await model.loadAvailability()
        #expect(model.serverInfo == info)
        #expect(model.serverInfo?.supports(.changelog) == true)
    }

    @Test("signed out, there is nothing to check")
    func signedOutIsQuiet() async {
        let clients = Self.clients()
        let session = makeSignedInSession(clients: clients)
        await session.signOut()
        let model = NotificationSettingsModel(session: session)
        await model.load()
        #expect(!model.isAvailable)
        #expect(model.errorMessage == nil)
        #expect(calls(Endpoints.PushSettings.self, in: clients).isEmpty)
    }

    @Test("loading reads whether notifications are on and which servers are muted")
    func loads() async {
        let model = await loadedModel(Self.clients())
        #expect(model.isAvailable)
        #expect(model.hasLoaded)
        #expect(model.isEnabled)
        #expect(model.mutedServers == ["2"])
        #expect(model.isMuted("2"))
        #expect(!model.isMuted("1"))
        #expect(model.errorMessage == nil)
    }

    @Test("a server that can't push is never asked for push settings")
    func unavailableServer() async {
        let clients = Self.clients(info: Self.oldInfo)
        let model = await loadedModel(clients)
        #expect(!model.isAvailable)
        #expect(model.hasLoadedAvailability)
        #expect(!model.isEnabled)
        #expect(calls(Endpoints.PushSettings.self, in: clients).isEmpty)
        #expect(await model.register(deviceToken: Data([1, 2]), environment: .production) == false)
        #expect(calls(Endpoints.RegisterPush.self, in: clients).isEmpty)
    }

    @Test("a failed load explains, and a later load clears it")
    func failedLoad() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.ServerInfo { return Self.pushInfo }
            throw NetworkError.offline
        }
        let model = await loadedModel(clients)
        #expect(model.errorMessage == NetworkError.offline.userMessage)
        #expect(!model.hasLoaded)

        clients.setHandler { endpoint in
            if endpoint is Endpoints.ServerInfo { return Self.pushInfo }
            return Self.settings
        }
        await model.load()
        #expect(model.errorMessage == nil)
        #expect(model.isEnabled)
    }

    @Test("a sign-out or a cancelled load says nothing")
    func quietErrors() async {
        for error in [NetworkError.unauthorized, .cancelled] {
            let clients = StubClients { endpoint in
                if endpoint is Endpoints.ServerInfo { return Self.pushInfo }
                throw error
            }
            let model = await loadedModel(clients)
            #expect(model.errorMessage == nil, "\(error)")
        }
    }

    @Test("registering sends the token in lowercase hex with the environment, and turns it on")
    func registers() async throws {
        let clients = Self.clients()
        let model = NotificationSettingsModel(session: makeSignedInSession(clients: clients))
        let ok = await model.register(deviceToken: Data([0xAB, 0x01, 0xFF]), environment: .development)
        #expect(ok)
        #expect(model.isEnabled)
        let sent = try #require(calls(Endpoints.RegisterPush.self, in: clients).first)
        #expect(sent.deviceToken == "ab01ff")
        #expect(sent.relayToken == nil)
        #expect(sent.environment == .development)
        #expect(clients.calls.last?.token == "sylo_live")
        #expect(clients.calls.last?.server == Self.instance)
        #expect(calls(Endpoints.RegisterWithRelay.self, in: clients).isEmpty)
    }

    @Test("through the official relay: the relay gets the device token, the Sylo server only the relay token")
    func registersThroughRelay() async throws {
        let clients = Self.clients(info: Self.relayInfo)
        let model = NotificationSettingsModel(session: makeSignedInSession(clients: clients))
        await model.loadAvailability()
        #expect(model.isAvailable)
        #expect(model.unavailableReason == nil)

        let ok = await model.register(deviceToken: Data([0xAB, 0x01, 0xFF]), environment: .production)
        #expect(ok)
        #expect(model.isEnabled)

        let registrations = clients.calls.filter { $0.endpoint is Endpoints.RegisterWithRelay || $0.endpoint is Endpoints.RegisterPush }
        try #require(registrations.count == 2)
        let relayCall = registrations[0]
        let relay = try #require(relayCall.endpoint as? Endpoints.RegisterWithRelay)
        #expect(relayCall.server == PushRelay.official)
        #expect(relayCall.token == nil)
        #expect(!relay.requiresAuth)
        #expect(relay.deviceToken == "ab01ff")
        #expect(relay.environment == .production)
        #expect(relay.instance == Self.instance)

        let instanceCall = registrations[1]
        let register = try #require(instanceCall.endpoint as? Endpoints.RegisterPush)
        #expect(instanceCall.server == Self.instance)
        #expect(instanceCall.token == "sylo_live")
        #expect(register.relayToken == "relay-1")
        #expect(register.deviceToken == nil)
        #expect(register.environment == .production)

        // The Sylo server never sees the device token.
        for call in clients.calls where call.server == Self.instance {
            #expect(!(call.endpoint is Endpoints.RegisterWithRelay))
            #expect((call.endpoint as? Endpoints.RegisterPush)?.deviceToken == nil)
        }
    }

    @Test("a relay other than the official one means no notifications for that server")
    func untrustedRelay() async {
        let clients = Self.clients(info: Self.untrustedInfo)
        let model = await loadedModel(clients)
        #expect(!model.isAvailable)
        #expect(model.hasLoadedAvailability)
        #expect(model.unavailableReason == NotificationSettingsModel.untrustedRelayMessage)
        #expect(await model.register(deviceToken: Data([1]), environment: .production) == false)
        #expect(calls(Endpoints.RegisterWithRelay.self, in: clients).isEmpty)
        #expect(calls(Endpoints.RegisterPush.self, in: clients).isEmpty)
        #expect(calls(Endpoints.PushSettings.self, in: clients).isEmpty)
    }

    @Test("a server without push has no reason to explain beyond not being available")
    func noReasonWithoutRelay() async {
        let model = await loadedModel(Self.clients(info: Self.oldInfo))
        #expect(model.unavailableReason == nil)
        let direct = await loadedModel(Self.clients())
        #expect(direct.unavailableReason == nil)
    }

    @Test("when the relay refuses, nothing reaches the Sylo server and it explains")
    func relayFails() async {
        let cases: [(NetworkError, String)] = [
            (.badRequest(message: "invalid_request"), NotificationSettingsModel.invalidTokenMessage),
            (.rateLimited, NetworkError.rateLimited.userMessage),
            (.offline, NetworkError.offline.userMessage),
        ]
        for (error, message) in cases {
            let clients = StubClients { endpoint in
                switch endpoint {
                case is Endpoints.ServerInfo: return Self.relayInfo
                case is Endpoints.RegisterWithRelay: throw error
                default: return OKResponse()
                }
            }
            let model = NotificationSettingsModel(session: makeSignedInSession(clients: clients))
            #expect(await model.register(deviceToken: Data([1]), environment: .production) == false)
            #expect(!model.isEnabled)
            #expect(model.errorMessage == message, "\(error)")
            #expect(calls(Endpoints.RegisterPush.self, in: clients).isEmpty, "\(error)")
        }
    }

    @Test("when the Sylo server wants the other kind of token, it explains and checks the server again next time")
    func modeChanged() async {
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.ServerInfo: return Self.pushInfo
            case is Endpoints.RegisterPush: throw NetworkError.badRequest(message: "relay_token_required")
            default: return OKResponse()
            }
        }
        let model = NotificationSettingsModel(session: makeSignedInSession(clients: clients))
        #expect(await model.register(deviceToken: Data([1]), environment: .production) == false)
        #expect(model.errorMessage == NotificationSettingsModel.modeChangedMessage)

        clients.setHandler { endpoint in
            switch endpoint {
            case is Endpoints.ServerInfo: return Self.relayInfo
            case is Endpoints.RegisterWithRelay: return PushRelayRegistration(relayToken: "relay-2")
            default: return OKResponse()
            }
        }
        #expect(await model.register(deviceToken: Data([1]), environment: .production))
        #expect(calls(Endpoints.ServerInfo.self, in: clients).count == 2)
        #expect(calls(Endpoints.RegisterPush.self, in: clients).last?.relayToken == "relay-2")
    }

    @Test("a refused token or a server without a push key explains and stays off")
    func registerFails() async {
        let cases: [(NetworkError, String)] = [
            (.badRequest(message: "invalid_push_token"), NotificationSettingsModel.invalidTokenMessage),
            (.server(status: 503), NotificationSettingsModel.unavailableMessage),
            (.offline, NetworkError.offline.userMessage),
        ]
        for (error, message) in cases {
            let clients = StubClients { endpoint in
                if endpoint is Endpoints.ServerInfo { return Self.pushInfo }
                throw error
            }
            let model = NotificationSettingsModel(session: makeSignedInSession(clients: clients))
            #expect(await model.register(deviceToken: Data([1]), environment: .production) == false)
            #expect(!model.isEnabled)
            #expect(model.errorMessage == message, "\(error)")
        }
    }

    @Test("turning off asks the server and shows off")
    func unregisters() async {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        #expect(await model.unregister())
        #expect(!model.isEnabled)
        #expect(calls(Endpoints.UnregisterPush.self, in: clients).count == 1)
    }

    @Test("a failed turn-off stays on and explains")
    func unregisterFails() async {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        clients.setHandler { _ in throw NetworkError.offline }
        #expect(await model.unregister() == false)
        #expect(model.isEnabled)
        #expect(model.errorMessage == NetworkError.offline.userMessage)
    }

    @Test("muting shows at once, then keeps what the server says")
    func mutes() async throws {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        let task = try #require(model.setMuted("1", true))
        #expect(model.isMuted("1"))
        #expect(model.isPending("1"))
        await task.value
        #expect(model.mutedServers == ["1", "2"])
        #expect(!model.isPending("1"))
        let sent = try #require(calls(Endpoints.MutePushForServer.self, in: clients).last)
        #expect(sent.server == "1")
        #expect(sent.muted)

        let unmute = try #require(model.setMuted("2", false))
        #expect(!model.isMuted("2"))
        await unmute.value
        #expect(!model.isMuted("2"))
        #expect(!(calls(Endpoints.MutePushForServer.self, in: clients).last?.muted ?? true))
    }

    @Test("the server's answer wins over what was asked")
    func serverWins() async {
        let model = await loadedModel(Self.clients { _ in PushMuteResult(mutedServers: []) })
        await model.setMuted("1", true)?.value
        #expect(model.mutedServers.isEmpty)
    }

    @Test("a failed mute goes back and explains; a sign-out goes back quietly")
    func rollsBack() async {
        let model = await loadedModel(Self.clients { _ in throw NetworkError.offline })
        await model.setMuted("1", true)?.value
        #expect(!model.isMuted("1"))
        #expect(model.errorMessage == NetworkError.offline.userMessage)

        let quiet = await loadedModel(Self.clients { _ in throw NetworkError.unauthorized })
        await quiet.setMuted("2", false)?.value
        #expect(quiet.isMuted("2"))
        #expect(quiet.errorMessage == nil)
    }

    @Test("a second switch of a server on its way, or a switch to how it already is, is ignored")
    func ignoresWhilePending() async {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        let first = model.setMuted("1", true)
        #expect(model.setMuted("1", false) == nil)
        #expect(model.setMuted("2", true) == nil)
        await first?.value
        #expect(calls(Endpoints.MutePushForServer.self, in: clients).count == 1)
    }

    @Test("starting a new switch clears the last error")
    func clearsError() async {
        let clients = Self.clients { _ in throw NetworkError.offline }
        let model = await loadedModel(clients)
        await model.setMuted("1", true)?.value
        #expect(model.errorMessage != nil)
        clients.setHandler { endpoint in
            if let set = endpoint as? Endpoints.MutePushForServer {
                return PushMuteResult(mutedServers: set.muted ? [set.server] : [])
            }
            return Self.settings
        }
        await model.setMuted("1", true)?.value
        #expect(model.errorMessage == nil)
        #expect(model.isMuted("1"))
    }
}
