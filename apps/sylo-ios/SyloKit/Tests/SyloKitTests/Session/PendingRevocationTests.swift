import Foundation
import Testing
@testable import SyloKit

/// Records what the device controller asked iOS for, and how many server calls had gone out by then.
@MainActor
final class FakeRegistrar: RemoteNotificationRegistrar {
    private(set) var registerCalls = 0
    private(set) var unregisterCalls = 0
    private(set) var callsBeforeRegister: [Int] = []
    var clients: StubClients?

    func register() {
        registerCalls += 1
        callsBeforeRegister.append(clients?.calls.count ?? 0)
    }

    func unregister() { unregisterCalls += 1 }
}

@MainActor
@Suite("Pending revocations")
struct PendingRevocationTests {
    private let server = try! ServerURL("https://sylo.example.com")
    private let other = try! ServerURL("https://other.example.com")
    private let pushInfo = ServerInfo(features: [.appLogin, .push])

    /// A Sylo that answers the push and token calls with `answer`.
    private func clients(
        info: ServerInfo? = nil, _ answer: @escaping @Sendable (any APIEndpoint) throws -> Void
    ) -> StubClients {
        let info = info ?? pushInfo
        return StubClients { endpoint in
            if endpoint is Endpoints.ServerInfo { return info }
            try answer(endpoint)
            return EmptyResponse()
        }
    }

    private func session(
        _ clients: StubClients, store: InMemoryPendingRevocationStore, on chosen: ServerURL? = nil,
        token: String? = "sylo_live"
    ) -> AppSession {
        let address = chosen ?? server
        var saved: [String: StoredToken] = [:]
        if let token { saved[address.description] = StoredToken(token: token, expiresAt: Date().addingTimeInterval(86_400)) }
        let session = AppSession(
            tokens: InMemoryTokenStore(tokens: saved), preference: MemoryServerPreference(address), deviceName: "Test",
            pendingRevocations: store, makeClient: { clients.make($0, $1) })
        session.start()
        return session
    }

    private func item(
        _ on: ServerURL? = nil, token: String = "sylo_old", hadPush: Bool = true, attempts: Int = 0,
        age: TimeInterval = 60
    ) -> PendingRevocation {
        PendingRevocation(
            server: on ?? server, token: token, created: Date().addingTimeInterval(-age), hadPush: hadPush,
            attempts: attempts)
    }

    private func names(_ clients: StubClients) -> [String] {
        clients.calls.compactMap { call -> String? in
            switch call.endpoint {
            case is Endpoints.UnregisterPush: "unregister"
            case is Endpoints.SignOut: "signout"
            default: nil
            }
        }
    }

    // MARK: Stored

    @Test("A sign-out the server cannot be told about keeps the server, the token and whether it pushes")
    func storedOffline() async throws {
        let stub = clients { _ in throw NetworkError.offline }
        let store = InMemoryPendingRevocationStore()
        let signedIn = session(stub, store: store)
        _ = await signedIn.serverFeatures()
        await signedIn.signOut()

        #expect(signedIn.phase == .signIn(server))
        let kept = try store.load()
        #expect(kept.count == 1)
        #expect(kept.first?.server == server)
        #expect(kept.first?.token == "sylo_live")
        #expect(kept.first?.hadPush == true)
        #expect(kept.first?.attempts == 1)
        #expect(signedIn.hasPendingRevocations)
        // The token is never in a description.
        #expect(!String(describing: kept[0]).contains("sylo_live"))
        #expect(!String(reflecting: kept[0]).contains("sylo_live"))
    }

    @Test("A server error is kept for later too, but a sign-out that worked leaves nothing")
    func storedOnErrorNotOnSuccess() async throws {
        let failing = clients { _ in throw NetworkError.server(status: 503) }
        let failStore = InMemoryPendingRevocationStore()
        let first = session(failing, store: failStore)
        await first.signOut()
        #expect(try failStore.load().count == 1)

        let working = clients { _ in }
        let workStore = InMemoryPendingRevocationStore()
        let second = session(working, store: workStore)
        _ = await second.serverFeatures()
        await second.signOut()
        #expect(try workStore.load().isEmpty)
        #expect(!second.hasPendingRevocations)
        #expect(names(working) == ["unregister", "signout"])
    }

    @Test("Only the newest few are kept, one per server and token")
    func bounded() async throws {
        let store = InMemoryPendingRevocationStore((0..<PendingRevocation.maxKept).map { item(token: "t\($0)") })
        let stub = clients { _ in throw NetworkError.offline }
        let signedIn = session(stub, store: store)
        await signedIn.signOut()
        let kept = try store.load()
        #expect(kept.count == PendingRevocation.maxKept)
        #expect(kept.last?.token == "sylo_live")
        #expect(kept.first?.token == "t1")
    }

    // MARK: Replayed

    @Test("The next launch tells the server, with the stored token, and the item is gone")
    func replayed() async throws {
        let store = InMemoryPendingRevocationStore()
        let offline = LockedFlag()
        offline.value = true
        let first = clients { _ in if offline.value { throw NetworkError.offline } }
        let before = session(first, store: store)
        _ = await before.serverFeatures()
        await before.signOut()
        #expect(try store.load().count == 1)

        // A later launch: signed out, same store, the server is back.
        offline.value = false
        let later = clients { _ in }
        let relaunch = session(later, store: store, token: nil)
        #expect(relaunch.phase == .signIn(server))
        await relaunch.revokePending()
        #expect(names(later) == ["unregister", "signout"])
        for call in later.calls {
            #expect(call.server == server)
            #expect(call.token == "sylo_live")
        }
        #expect(try store.load().isEmpty)
        // Nothing left to send.
        await relaunch.revokePending()
        #expect(names(later) == ["unregister", "signout"])
    }

    @Test("A server without push is only asked to revoke the token")
    func noPush() async throws {
        let store = InMemoryPendingRevocationStore([item(hadPush: false)])
        let stub = clients { _ in }
        await session(stub, store: store, token: nil).revokePending()
        #expect(names(stub) == ["signout"])
        #expect(try store.load().isEmpty)
    }

    @Test("Replayed before the device registers for notifications again")
    func beforeRegistering() async throws {
        let store = InMemoryPendingRevocationStore([item(server, token: "sylo_old")])
        let stub = clients { _ in }
        let signedIn = session(stub, store: store, on: other, token: "sylo_new")
        let registrar = FakeRegistrar()
        registrar.clients = stub
        let controller = PushDeviceController(session: signedIn, registrar: registrar)
        await controller.requestDeviceToken()
        #expect(registrar.registerCalls == 1)
        // Both revocation calls had gone out when iOS was asked for a token.
        #expect(registrar.callsBeforeRegister == [2])
        #expect(try store.load().isEmpty)
    }

    @Test("A server that cannot be reached does not hold the registration up for long, and is tried again later")
    func unreachableDoesNotBlock() async throws {
        let store = InMemoryPendingRevocationStore([item()])
        let stub = clients { _ in throw NetworkError.offline }
        let signedIn = session(stub, store: store, on: other, token: "sylo_new")
        let registrar = FakeRegistrar()
        let controller = PushDeviceController(session: signedIn, registrar: registrar)
        await controller.requestDeviceToken()
        #expect(registrar.registerCalls == 1)
        let kept = try store.load()
        #expect(kept.count == 1)
        #expect(kept[0].attempts == 1)
    }

    // MARK: Cleared

    @Test("A 401 means the token is already dead: cleared, and no token call follows")
    func clearedOn401() async throws {
        let store = InMemoryPendingRevocationStore([item()])
        let stub = clients { _ in throw NetworkError.unauthorized }
        await session(stub, store: store, token: nil).revokePending()
        #expect(try store.load().isEmpty)
        #expect(names(stub) == ["unregister"])
    }

    @Test("A 404 (a server without the route) is an answer too: cleared")
    func clearedOn404() async throws {
        let store = InMemoryPendingRevocationStore([item()])
        let stub = clients { _ in throw NetworkError.notFound(message: nil) }
        await session(stub, store: store, token: nil).revokePending()
        #expect(try store.load().isEmpty)
        #expect(names(stub) == ["unregister", "signout"])
    }

    @Test("When the push call worked but the token call did not, the item stays")
    func halfDone() async throws {
        let store = InMemoryPendingRevocationStore([item()])
        let stub = clients { endpoint in if endpoint is Endpoints.SignOut { throw NetworkError.offline } }
        await session(stub, store: store, token: nil).revokePending()
        let kept = try store.load()
        #expect(kept.count == 1)
        #expect(kept[0].attempts == 1)
    }

    @Test("Given up after too many tries or too long, with no call")
    func boundedRetries() async throws {
        let tooMany = item(attempts: PendingRevocation.maxAttempts)
        let tooOld = item(token: "sylo_older", age: PendingRevocation.maxAge + 60)
        let store = InMemoryPendingRevocationStore([tooMany, tooOld])
        let stub = clients { _ in }
        await session(stub, store: store, token: nil).revokePending()
        #expect(stub.calls.isEmpty)
        #expect(try store.load().isEmpty)

        // Each failed try counts, up to the limit.
        let last = InMemoryPendingRevocationStore([item(attempts: PendingRevocation.maxAttempts - 1)])
        let failing = clients { _ in throw NetworkError.offline }
        let relaunch = session(failing, store: last, token: nil)
        await relaunch.revokePending()
        #expect(try last.load().first?.attempts == PendingRevocation.maxAttempts)
        await relaunch.revokePending()
        #expect(try last.load().isEmpty)
    }

    // MARK: Not sent elsewhere

    @Test("A stored token only ever goes to the server that issued it, and nobody else's token goes there")
    func notSentElsewhere() async throws {
        let store = InMemoryPendingRevocationStore([item(server, token: "sylo_old")])
        let stub = clients { _ in }
        let signedIn = session(stub, store: store, on: other, token: "sylo_other")
        _ = await signedIn.serverFeatures()
        await signedIn.revokePending()
        let revocations = stub.calls.filter { $0.endpoint is Endpoints.UnregisterPush || $0.endpoint is Endpoints.SignOut }
        #expect(revocations.count == 2)
        for call in revocations {
            #expect(call.server == server)
            #expect(call.token == "sylo_old")
        }
        // The current sign-in's token never went to the old server, nor the old token to the current one.
        #expect(!stub.calls.contains { $0.server == server && $0.token == "sylo_other" })
        #expect(!stub.calls.contains { $0.server == other && $0.token == "sylo_old" })
    }
}

@MainActor
@Suite("Device token and iOS registration")
struct PushDeviceControllerTests {
    private let token = Data([0xAB, 0x01])

    private func make(signedIn: Bool) -> (PushDeviceController, AppSession, FakeRegistrar) {
        let stub = StubClients { _ in ServerInfo() }
        let session: AppSession
        if signedIn {
            session = makeSignedInSession(clients: stub)
        } else {
            session = AppSession(
                tokens: InMemoryTokenStore(), preference: MemoryServerPreference(try! ServerURL("https://sylo.example.com")),
                deviceName: "Test", makeClient: { stub.make($0, $1) })
            session.start()
        }
        let registrar = FakeRegistrar()
        return (PushDeviceController(session: session, registrar: registrar), session, registrar)
    }

    @Test("Signed out, the app unregisters from iOS and forgets the token")
    func signedOutUnregisters() {
        let (controller, _, registrar) = make(signedIn: false)
        controller.state.received(deviceToken: token)
        controller.phaseChanged()
        #expect(registrar.unregisterCalls == 1)
        #expect(controller.state.deviceToken == nil)
        #expect(controller.state == PushDeviceState())
    }

    @Test("Signing out of a signed-in session unregisters from iOS, and a late token is not kept")
    func signOutUnregisters() async {
        let (controller, session, registrar) = make(signedIn: true)
        controller.phaseChanged()
        #expect(registrar.unregisterCalls == 0)
        #expect(controller.received(deviceToken: token))
        #expect(controller.state.deviceToken == token)

        await session.signOut()
        controller.phaseChanged()
        #expect(registrar.unregisterCalls == 1)
        #expect(controller.state.deviceToken == nil)

        // The token iOS was still on its way with arrives after the sign-out: not stored, not sent.
        #expect(!controller.received(deviceToken: token))
        #expect(controller.state.deviceToken == nil)
        #expect(controller.state.needsDeviceToken)
    }

    @Test("The app only asks iOS for a token while signed in")
    func registersOnlyWhenSignedIn() async {
        let (signedOut, _, signedOutRegistrar) = make(signedIn: false)
        await signedOut.requestDeviceToken()
        #expect(signedOutRegistrar.registerCalls == 0)

        let (signedIn, _, registrar) = make(signedIn: true)
        await signedIn.requestDeviceToken()
        #expect(registrar.registerCalls == 1)
    }

    @Test("A later sign-in asks iOS for a token again and registers from scratch")
    func signInAfterSignOut() async {
        let (controller, session, registrar) = make(signedIn: true)
        controller.received(deviceToken: token)
        controller.state.registered(at: try! ServerURL("https://sylo.example.com"), token: token)
        await session.signOut()
        controller.phaseChanged()
        #expect(controller.state.needsDeviceToken)
        #expect(!controller.state.hasRegistered(at: try! ServerURL("https://sylo.example.com")))
        #expect(registrar.unregisterCalls == 1)
    }
}
