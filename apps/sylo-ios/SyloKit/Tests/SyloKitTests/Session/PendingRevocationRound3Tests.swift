import Foundation
import Testing
@testable import SyloKit

@MainActor
@Suite("Pending revocations: tries and waiting")
struct PendingRevocationRound3Tests {
    private let server = try! ServerURL("https://sylo.example.com")
    private let other = try! ServerURL("https://other.example.com")

    private func clients(_ answer: @escaping @Sendable (any APIEndpoint) throws -> Void) -> StubClients {
        StubClients { endpoint in
            try answer(endpoint)
            return EmptyResponse()
        }
    }

    private func session(
        _ clients: StubClients, store: InMemoryPendingRevocationStore, on chosen: ServerURL? = nil, token: String? = nil
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

    private func item(attempts: Int = 0, age: TimeInterval = 60) -> PendingRevocation {
        PendingRevocation(
            server: server, token: "sylo_old", created: Date().addingTimeInterval(-age), hadPush: true, attempts: attempts)
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

    // MARK: Only answers count as a try

    @Test("Not getting through (offline, timeout, unreachable, TLS) never uses up a try")
    func transportErrorsDoNotCount() async throws {
        let errors: [NetworkError] = [.offline, .timeout, .unreachable, .secureConnectionFailed, .transport(code: -1009)]
        for error in errors {
            let store = InMemoryPendingRevocationStore([item()])
            let stub = clients { _ in throw error }
            let relaunch = session(stub, store: store)
            for _ in 0..<(PendingRevocation.maxAttempts + 3) { await relaunch.revokePending() }
            let kept = try store.load()
            #expect(kept.count == 1, "\(error)")
            #expect(kept.first?.attempts == 0, "\(error)")
        }
    }

    @Test("An offline sign-out is still stored, with no try used")
    func offlineSignOutIsStoredWithNoTry() async throws {
        let store = InMemoryPendingRevocationStore()
        let stub = StubClients { endpoint in
            if endpoint is Endpoints.ServerInfo { return ServerInfo(features: [.appLogin, .push]) }
            throw NetworkError.offline
        }
        let signedIn = session(stub, store: store, token: "sylo_live")
        _ = await signedIn.serverFeatures()
        await signedIn.signOut()
        let kept = try store.load()
        #expect(kept.count == 1)
        #expect(kept.first?.attempts == 0)
    }

    @Test("A server answer that is an error counts, one try per replay", arguments: [
        NetworkError.server(status: 500), .server(status: 503), .badRequest(message: "no"), .rateLimited,
        .http(status: HTTPStatus(409, message: "conflict")), .forbidden,
    ])
    func answersCount(error: NetworkError) async throws {
        let store = InMemoryPendingRevocationStore([item()])
        let stub = clients { _ in throw error }
        let relaunch = session(stub, store: store)
        await relaunch.revokePending()
        #expect(try store.load().first?.attempts == 1, "\(error)")
        await relaunch.revokePending()
        #expect(try store.load().first?.attempts == 2, "\(error)")
    }

    @Test("When one call is answered with an error and the other does not get through, that is one try")
    func mixed() async throws {
        let store = InMemoryPendingRevocationStore([item()])
        let stub = clients { endpoint in
            if endpoint is Endpoints.UnregisterPush { throw NetworkError.server(status: 500) }
            throw NetworkError.offline
        }
        await session(stub, store: store).revokePending()
        #expect(try store.load().first?.attempts == 1)
    }

    @Test("An item that never got through is still dropped by age")
    func offlineItemsExpireByAge() async throws {
        let store = InMemoryPendingRevocationStore([item(age: PendingRevocation.maxAge + 60)])
        let stub = clients { _ in throw NetworkError.offline }
        await session(stub, store: store).revokePending()
        #expect(stub.calls.isEmpty)
        #expect(try store.load().isEmpty)
    }

    // MARK: Waiting for a replay

    @Test("A second caller waits for the replay that is running, and sends nothing itself")
    func secondCallerWaits() async throws {
        let store = InMemoryPendingRevocationStore([item()])
        let gate = TestGate()
        let stub = clients { _ in }
        stub.setHold { endpoint in
            guard endpoint is Endpoints.UnregisterPush || endpoint is Endpoints.SignOut else { return }
            gate.arrive()
            while !gate.isOpen { try await Task.sleep(for: .milliseconds(5)) }
        }
        let relaunch = session(stub, store: store)
        let secondDone = LockedFlag()

        let first = Task { await relaunch.revokePending() }
        await waitForArrival(gate)
        #expect(gate.arrivals == 1)
        let second = Task {
            await relaunch.revokePending()
            secondDone.value = true
        }
        try await Task.sleep(for: .milliseconds(150))
        // Still waiting: the replay has not finished, so nothing may register for notifications yet.
        #expect(!secondDone.value)

        gate.open()
        await first.value
        await second.value
        #expect(secondDone.value)
        // One replay only: two calls in all, and the item is gone.
        #expect(names(stub) == ["unregister", "signout"])
        #expect(try store.load().isEmpty)
    }

    @Test("A sign-out waits for no more than the limit, keeps the item and leaves the person signed out")
    func signOutIsLimited() async throws {
        let store = InMemoryPendingRevocationStore()
        let gate = TestGate()
        let stub = StubClients { endpoint in
            if endpoint is Endpoints.ServerInfo { return ServerInfo(features: [.appLogin, .push]) }
            return EmptyResponse()
        }
        stub.setHold { endpoint in
            guard endpoint is Endpoints.UnregisterPush || endpoint is Endpoints.SignOut else { return }
            gate.arrive()
            while !gate.isOpen { try await Task.sleep(for: .milliseconds(5)) }
        }
        let signedIn = session(stub, store: store, token: "sylo_live")
        _ = await signedIn.serverFeatures()
        signedIn.revokeTimeout = .milliseconds(150)

        await signedIn.signOut()
        #expect(signedIn.phase == .signIn(server))
        #expect(gate.arrivals == 1)
        // Given up on for now, not counted as a try, and kept for the next time.
        let kept = try store.load()
        #expect(kept.count == 1)
        #expect(kept.first?.attempts == 0)
        #expect(kept.first?.token == "sylo_live")

        // The next replay goes through.
        gate.open()
        await signedIn.revokePending()
        #expect(try store.load().isEmpty)
    }

    @Test("A sign-in that follows a slow sign-out replay does not register before the replay ended")
    func registrationWaitsForSignOutReplay() async throws {
        let store = InMemoryPendingRevocationStore()
        let gate = TestGate()
        let grant = TokenGrant(
            token: "sylo_new", expiresAt: Date().addingTimeInterval(86_400),
            account: SignedInAccount(name: "ferdi", platforms: [.discord]))
        let stub = StubClients { endpoint in
            if endpoint is Endpoints.ServerInfo { return ServerInfo(features: [.appLogin, .push]) }
            if endpoint is Endpoints.ExchangeCode { return grant }
            return EmptyResponse()
        }
        stub.setHold { endpoint in
            guard endpoint is Endpoints.UnregisterPush || endpoint is Endpoints.SignOut else { return }
            gate.arrive()
            while !gate.isOpen { try await Task.sleep(for: .milliseconds(5)) }
        }
        let signedIn = session(stub, store: store, token: "sylo_live")
        _ = await signedIn.serverFeatures()
        let registrar = FakeRegistrar()
        let controller = PushDeviceController(session: signedIn, registrar: registrar)

        // Sign out; the server is slow, so the replay is still running.
        let signOut = Task { await signedIn.signOut() }
        await waitForArrival(gate)
        // A new sign-in follows at once.
        await signedIn.signIn(with: nil) { url in
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "state" }?.value ?? ""
            return URL(string: "sylo://auth?code=c&state=\(state)")!
        }
        #expect(signedIn.phase == .signedIn(server))

        // Asking iOS for a token waits for the running replay.
        let request = Task { await controller.requestDeviceToken() }
        try await Task.sleep(for: .milliseconds(150))
        #expect(registrar.registerCalls == 0)

        gate.open()
        await signOut.value
        await request.value
        #expect(registrar.registerCalls == 1)
        #expect(try store.load().isEmpty)
    }
}
