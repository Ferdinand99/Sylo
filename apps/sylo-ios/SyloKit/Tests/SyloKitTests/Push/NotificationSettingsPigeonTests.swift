import Foundation
import Testing
@testable import SyloKit

/// A Sylo server, a Pigeon and a handle manager over them, for the settings model.
struct PigeonRig: Sendable {
    let pigeon = FakePigeon()
    let sylo = FakeSyloPush()
    let clients: StubClients
    let registry: PushRegistry
    let manager: PushHandleManager
    private let folder: URL

    init(info: ServerInfo) {
        folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("SyloKitTests-\(UUID().uuidString)", isDirectory: true)
        registry = PushRegistry(fileURL: folder.appendingPathComponent("push-tags.json"))
        manager = PushHandleManager(
            relay: pigeon.client,
            registrar: PigeonRegistrar(client: pigeon.client, store: InMemoryPigeonStore(), environment: .sandbox),
            registry: registry)
        let sylo = self.sylo
        clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.ServerInfo: return info
            case is Endpoints.PushSettings: return PushSettingsInfo(isEnabled: sylo.hasHandle)
            case let register as Endpoints.RegisterPush:
                if let handle = register.pigeonHandle { try sylo.register(handle) }
                return OKResponse()
            case is Endpoints.UnregisterPush:
                sylo.lose()
                return EmptyResponse()
            default:
                throw NetworkError.notFound
            }
        }
    }

    func cleanUp() {
        try? FileManager.default.removeItem(at: folder)
    }

    /// What the Sylo server was sent when push was turned on.
    var registrations: [Endpoints.RegisterPush] {
        clients.calls.compactMap { $0.endpoint as? Endpoints.RegisterPush }
    }
}

@MainActor
@Suite("Notification settings through Pigeon")
struct NotificationSettingsPigeonTests {
    nonisolated static let official = URL(string: "https://pigeon.hedgerow.tools")
    nonisolated static let stranger = URL(string: "https://pigeon.example.com")
    nonisolated static let pigeonInfo = ServerInfo(features: [.appLogin, .liveAccess, .pushPigeon], pigeon: official)
    nonisolated static let bothInfo = ServerInfo(
        features: [.appLogin, .liveAccess, .push, .pushPigeon], pigeon: official)
    nonisolated static let strangerInfo = ServerInfo(
        features: [.appLogin, .liveAccess, .pushPigeon], pigeon: stranger)
    nonisolated static let strangerWithPushInfo = ServerInfo(
        features: [.appLogin, .liveAccess, .push, .pushPigeon], pigeon: stranger)
    nonisolated static let instance = try! ServerURL("https://sylo.example.com")

    private func makeModel(
        _ rig: PigeonRig, usingPigeon: Bool = true
    ) -> (NotificationSettingsModel, AppSession) {
        let session = makeSignedInSession(clients: rig.clients)
        return (NotificationSettingsModel(session: session, pigeon: usingPigeon ? rig.manager : nil), session)
    }

    // MARK: Turning on

    @Test("A server that sends through the official Pigeon gets a handle, never the device token")
    func registers() async throws {
        let rig = PigeonRig(info: Self.pigeonInfo)
        defer { rig.cleanUp() }
        let (model, _) = makeModel(rig)
        await model.loadAvailability()
        #expect(model.isAvailable)
        #expect(model.unavailableReason == nil)

        let ok = await model.register(deviceToken: Data([0xAB, 0x01, 0xFF]), environment: .development)
        #expect(ok)
        #expect(model.isEnabled)
        #expect(model.errorMessage == nil)

        // Pigeon got the device, in the sandbox for a build run from Xcode.
        let device = try #require(rig.pigeon.clients.calls.first?.endpoint as? PigeonEndpoints.RegisterDevice)
        #expect(device.token == "ab01ff")
        #expect(device.environment == .sandbox)

        // The server got a handle and the app's environment, and nothing else.
        let sent = try #require(rig.registrations.first)
        #expect(rig.registrations.count == 1)
        #expect(sent.pigeonHandle?.hasPrefix("hrh_") == true)
        #expect(sent.deviceToken == nil)
        #expect(sent.relayToken == nil)
        #expect(sent.environment == .development)
        #expect(rig.clients.calls.last { $0.endpoint is Endpoints.RegisterPush }?.token == "sylo_live")

        // The calls went where they belong: the Sylo token to the Sylo server only, the manage key to Pigeon only.
        for call in rig.clients.calls { #expect(call.server == Self.instance) }
        for call in rig.pigeon.clients.calls {
            #expect(call.server == PigeonRelay.official)
            #expect(call.token != "sylo_live")
        }
        #expect(rig.registry.entry(forServer: Self.instance) != nil)
    }

    @Test("Turning it on again keeps the handle the server has")
    func keepsHandle() async {
        let rig = PigeonRig(info: Self.pigeonInfo)
        defer { rig.cleanUp() }
        let (model, _) = makeModel(rig)
        #expect(await model.register(deviceToken: Data([1]), environment: .production))
        #expect(await model.register(deviceToken: Data([1]), environment: .production))
        #expect(rig.pigeon.count("create") == 1)
        #expect(rig.sylo.handlesGiven.count == 1)
        #expect(rig.registrations.count == 1)
    }

    @Test("A new sign-in (the server has no handle) gets a new handle")
    func newSignIn() async throws {
        let rig = PigeonRig(info: Self.pigeonInfo)
        defer { rig.cleanUp() }
        let (model, _) = makeModel(rig)
        #expect(await model.register(deviceToken: Data([1]), environment: .production))
        let first = try #require(rig.registry.entry(forServer: Self.instance))
        rig.sylo.lose()
        #expect(await model.register(deviceToken: Data([1]), environment: .production))
        let second = try #require(rig.registry.entry(forServer: Self.instance))
        #expect(first.tag != second.tag)
        #expect(rig.pigeon.count("revoke:\(first.relayHandleId)") == 1)
        #expect(rig.sylo.handlesGiven.count == 2)
    }

    @Test("The server refusing the handle explains and leaves nothing at Pigeon")
    func serverRefuses() async throws {
        let rig = PigeonRig(info: Self.pigeonInfo)
        defer { rig.cleanUp() }
        let (model, _) = makeModel(rig)
        rig.sylo.fail(with: NetworkError.badRequest(message: "invalid_push_token"))
        #expect(await model.register(deviceToken: Data([1]), environment: .production) == false)
        #expect(!model.isEnabled)
        #expect(model.errorMessage == NotificationSettingsModel.invalidTokenMessage)
        #expect(rig.registry.entries().isEmpty)
        #expect(rig.pigeon.handleIds(of: try #require(rig.pigeon.deviceIds.last)).isEmpty)
    }

    @Test("A busy or limited Pigeon explains, and the server hears nothing")
    func pigeonBusy() async {
        for failure in [NetworkError.rateLimited, .http(status: 409), .server(status: 503), .offline] {
            let rig = PigeonRig(info: Self.pigeonInfo)
            defer { rig.cleanUp() }
            let (model, _) = makeModel(rig)
            rig.pigeon.fail("create", with: failure)
            #expect(await model.register(deviceToken: Data([1]), environment: .production) == false, "\(failure)")
            #expect(!model.isEnabled)
            #expect(model.errorMessage == NotificationSettingsModel.pigeonBusyMessage, "\(failure)")
            #expect(rig.registrations.isEmpty, "\(failure)")
        }
    }

    @Test("A server that now takes the other kind of token explains, and is checked again next time")
    func modeChanged() async {
        let rig = PigeonRig(info: Self.pigeonInfo)
        defer { rig.cleanUp() }
        let (model, _) = makeModel(rig)
        rig.sylo.fail(with: NetworkError.badRequest(message: "device_token_required"))
        #expect(await model.register(deviceToken: Data([1]), environment: .production) == false)
        #expect(model.errorMessage == NotificationSettingsModel.modeChangedMessage)
        #expect(rig.registry.entries().isEmpty)
    }

    // MARK: Which way

    @Test("A Pigeon that isn't the official one is never handed a handle")
    func strangerPigeon() async {
        let rig = PigeonRig(info: Self.strangerInfo)
        defer { rig.cleanUp() }
        let (model, _) = makeModel(rig)
        await model.loadAvailability()
        #expect(!model.isAvailable)
        #expect(model.hasLoadedAvailability)
        #expect(model.unavailableReason == NotificationSettingsModel.untrustedPigeonMessage)
        #expect(await model.register(deviceToken: Data([1]), environment: .production) == false)
        #expect(rig.pigeon.calls.isEmpty)
        #expect(rig.registrations.isEmpty)
    }

    @Test("A server with a stranger's Pigeon but its own APNs key is used the older way")
    func strangerPigeonWithPush() async throws {
        let rig = PigeonRig(info: Self.strangerWithPushInfo)
        defer { rig.cleanUp() }
        let (model, _) = makeModel(rig)
        await model.loadAvailability()
        #expect(model.isAvailable)
        #expect(model.unavailableReason == nil)
        #expect(await model.register(deviceToken: Data([0xAB]), environment: .production))
        let sent = try #require(rig.registrations.first)
        #expect(sent.deviceToken == "ab")
        #expect(sent.pigeonHandle == nil)
        #expect(rig.pigeon.calls.isEmpty)
    }

    @Test("A server that can do both is used through Pigeon")
    func prefersPigeon() async throws {
        let rig = PigeonRig(info: Self.bothInfo)
        defer { rig.cleanUp() }
        let (model, _) = makeModel(rig)
        #expect(await model.register(deviceToken: Data([1]), environment: .production))
        let sent = try #require(rig.registrations.first)
        #expect(sent.pigeonHandle != nil)
        #expect(sent.deviceToken == nil)
    }

    @Test("Without Pigeon in the app, the older way still works and Pigeon-only servers are unavailable")
    func withoutPigeon() async throws {
        let both = PigeonRig(info: Self.bothInfo)
        defer { both.cleanUp() }
        let (older, _) = makeModel(both, usingPigeon: false)
        #expect(await older.register(deviceToken: Data([0xAB]), environment: .production))
        #expect(both.registrations.first?.deviceToken == "ab")
        #expect(both.pigeon.calls.isEmpty)

        let only = PigeonRig(info: Self.pigeonInfo)
        defer { only.cleanUp() }
        let (none, _) = makeModel(only, usingPigeon: false)
        await none.loadAvailability()
        #expect(!none.isAvailable)
        #expect(none.unavailableReason == nil)
        #expect(await none.register(deviceToken: Data([1]), environment: .production) == false)
    }

    // MARK: Turning off

    @Test("Turning off tells the server and takes the handle down at Pigeon")
    func unregisters() async throws {
        let rig = PigeonRig(info: Self.pigeonInfo)
        defer { rig.cleanUp() }
        let (model, _) = makeModel(rig)
        #expect(await model.register(deviceToken: Data([1]), environment: .production))
        let entry = try #require(rig.registry.entry(forServer: Self.instance))

        #expect(await model.unregister())
        #expect(!model.isEnabled)
        #expect(rig.registry.entries().isEmpty)
        #expect(rig.pigeon.count("revoke:\(entry.relayHandleId)") == 1)
        #expect(rig.clients.calls.contains { $0.endpoint is Endpoints.UnregisterPush })
    }

    @Test("Signing out takes the handle down at Pigeon, and staying signed in keeps it")
    func reconciles() async throws {
        let rig = PigeonRig(info: Self.pigeonInfo)
        defer { rig.cleanUp() }
        let (model, session) = makeModel(rig)
        #expect(await model.register(deviceToken: Data([1]), environment: .production))
        let entry = try #require(rig.registry.entry(forServer: Self.instance))

        await model.reconcileHandles()
        #expect(rig.registry.entry(forServer: Self.instance) == entry)
        #expect(rig.pigeon.count("revoke:\(entry.relayHandleId)") == 0)

        await session.signOut()
        await model.reconcileHandles()
        #expect(rig.registry.entries().isEmpty)
        #expect(rig.pigeon.count("revoke:\(entry.relayHandleId)") == 1)
    }

    @Test("Without Pigeon in the app there is nothing to reconcile")
    func reconcileWithoutPigeon() async {
        let rig = PigeonRig(info: Self.bothInfo)
        defer { rig.cleanUp() }
        let (model, _) = makeModel(rig, usingPigeon: false)
        await model.reconcileHandles()
        #expect(rig.pigeon.calls.isEmpty)
    }
}
