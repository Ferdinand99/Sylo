import Foundation
import Testing
@testable import SyloKit

@Suite("Postal Pigeon client")
struct PigeonClientTests {
    private func json(_ endpoint: some APIEndpoint) throws -> [String: String] {
        guard let body = endpoint.body else { return [:] }
        return try JSONDecoder().decode([String: String].self, from: JSONEncoder().encode(body))
    }

    @Test("The calls go to the paths and methods Pigeon documents")
    func endpoints() throws {
        let register = PigeonEndpoints.RegisterDevice(environment: .sandbox, token: "ab01")
        #expect(register.path == "/v1/devices")
        #expect(register.method == .post)
        #expect(!register.requiresAuth)
        #expect(try json(register) == ["app": "sylo", "environment": "sandbox", "token": "ab01"])

        let update = PigeonEndpoints.UpdateDevice(deviceId: "hrd_1", token: "ff", environment: .production)
        #expect(update.path == "/v1/devices/hrd_1")
        #expect(update.method == .put)
        #expect(update.requiresAuth)
        #expect(try json(update) == ["token": "ff", "environment": "production"])
        // A keep-alive sends nothing to change.
        let keepAlive = PigeonEndpoints.UpdateDevice(deviceId: "hrd_1", token: nil, environment: nil)
        #expect(try json(keepAlive) == [:])

        let remove = PigeonEndpoints.RemoveDevice(deviceId: "hrd_1")
        #expect(remove.path == "/v1/devices/hrd_1")
        #expect(remove.method == .delete)

        let create = PigeonEndpoints.CreateHandle(deviceId: "hrd_1", tag: "t")
        #expect(create.path == "/v1/devices/hrd_1/handles")
        #expect(create.method == .post)
        #expect(try json(create) == ["tag": "t"])

        let revoke = PigeonEndpoints.RevokeHandle(deviceId: "hrd_1", handleId: "h1")
        #expect(revoke.path == "/v1/devices/hrd_1/handles/h1")
        #expect(revoke.method == .delete)

        let list = PigeonEndpoints.ListHandles(deviceId: "hrd_1")
        #expect(list.path == "/v1/devices/hrd_1/handles")
        #expect(list.method == .get)
    }

    @Test("The answers decode, and printing hides the secrets")
    func decodes() throws {
        let registration = try JSONDecoder().decode(
            PigeonRegistration.self, from: Data(#"{"device_id": "hrd_a", "manage_key": "hrm_secret"}"#.utf8))
        #expect(registration == PigeonRegistration(deviceId: "hrd_a", manageKey: "hrm_secret"))
        #expect(!"\(registration)".contains("hrm_secret"))
        #expect(!String(reflecting: registration).contains("hrm_secret"))

        let handle = try JSONDecoder().decode(
            PigeonHandle.self, from: Data(#"{"handle_id": "h1", "handle": "hrh_secret"}"#.utf8))
        #expect(handle == PigeonHandle(handleId: "h1", handle: "hrh_secret"))
        #expect(!"\(handle)".contains("hrh_secret"))

        let list = try JSONDecoder().decode(
            PigeonEndpoints.ListHandles.HandleList.self,
            from: Data(#"{"handles": [{"handle_id": "h1", "tag": "t"}, {"handle_id": "h2"}]}"#.utf8))
        #expect(list.handles == [PigeonHandleInfo(handleId: "h1", tag: "t"), PigeonHandleInfo(handleId: "h2", tag: nil)])
    }

    @Test("Only the Hedgerow Pigeon is official, however its address is spelled")
    func official() throws {
        #expect(PigeonRelay.official.description == "https://pigeon.hedgerow.tools")
        #expect(PigeonRelay.isOfficial(try #require(URL(string: "https://pigeon.hedgerow.tools"))))
        #expect(PigeonRelay.isOfficial(try #require(URL(string: "https://PIGEON.hedgerow.tools/"))))
        #expect(PigeonRelay.isOfficial(try #require(URL(string: "https://pigeon.hedgerow.tools:443"))))
        #expect(!PigeonRelay.isOfficial(try #require(URL(string: "http://pigeon.hedgerow.tools"))))
        #expect(!PigeonRelay.isOfficial(try #require(URL(string: "https://pigeon.hedgerow.tools/x"))))
        #expect(!PigeonRelay.isOfficial(try #require(URL(string: "https://pigeon.hedgerow.tools.evil.example"))))
        #expect(!PigeonRelay.isOfficial(try #require(URL(string: "https://app.sylobot.com"))))
    }

    @Test("A debug build is Pigeon's sandbox")
    func environments() {
        #expect(PigeonEnvironment(.development) == .sandbox)
        #expect(PigeonEnvironment(.production) == .production)
    }

    @Test("Registering sends the token in hex without a key, to the official Pigeon")
    func registers() async throws {
        let fake = FakePigeon()
        let registration = try await fake.client.register(environment: .sandbox, token: Data([0xAB, 0x01]))
        #expect(registration.deviceId == "hrd_device1")
        #expect(fake.registeredEnvironments == [.sandbox])
        let call = try #require(fake.clients.calls.first)
        #expect(call.server == PigeonRelay.official)
        #expect(call.token == nil)
        let sent = try #require(call.endpoint as? PigeonEndpoints.RegisterDevice)
        #expect(sent.token == "ab01")
    }

    @Test("Every later call carries the manage key, and only that")
    func manageKey() async throws {
        let fake = FakePigeon()
        let client = fake.client
        let registration = try await client.register(environment: .production, token: Data([1]))
        try await client.update(registration)
        let handle = try await client.createHandle(registration, tag: PushTag.generate())
        _ = try await client.listHandles(registration)
        try await client.revokeHandle(registration, handleId: handle.handleId)
        try await client.remove(registration)

        let later = fake.clients.calls.dropFirst()
        #expect(later.count == 5)
        for call in later {
            #expect(call.token == registration.manageKey)
            #expect(call.server == PigeonRelay.official)
        }
    }

    @Test("A device Pigeon doesn't know is gone, except when removing it or revoking a handle")
    func gone() async throws {
        let fake = FakePigeon()
        let client = fake.client
        let stranger = PigeonRegistration(deviceId: "hrd_nobody", manageKey: "hrm_nobody")
        await #expect(throws: PigeonError.gone) { try await client.update(stranger) }
        await #expect(throws: PigeonError.gone) { try await client.createHandle(stranger, tag: PushTag.generate()) }
        await #expect(throws: PigeonError.gone) { try await client.listHandles(stranger) }
        try await client.remove(stranger)
        try await client.revokeHandle(stranger, handleId: "h1")
    }

    @Test("What went wrong becomes what the app does about it")
    func errorMapping() async throws {
        let cases: [(NetworkError, PigeonError)] = [
            (.unauthorized, .invalidCredentials),
            (.notFound, .gone),
            (.rateLimited, .rateLimited),
            (.http(status: 409), .limitReached),
            (.server(status: 503), .unavailable),
            (.offline, .unavailable),
            (.timeout, .unavailable),
            (.unreachable, .unavailable),
            (.forbidden, .unexpected),
            (.badRequest(message: nil), .unexpected),
            (.notASyloServer, .unexpected),
            (.decoding("x"), .unexpected),
        ]
        for (failure, expected) in cases {
            let fake = FakePigeon()
            let client = fake.client
            let registration = try await client.register(environment: .sandbox, token: Data([1]))
            fake.fail("create", with: failure)
            do {
                _ = try await client.createHandle(registration, tag: PushTag.generate())
                Issue.record("\(failure) did not throw")
            } catch let error as PigeonError {
                #expect(error == expected, "\(failure)")
            } catch {
                Issue.record("\(failure) threw \(error)")
            }
        }
    }

    @Test("A cancelled call stays a cancellation")
    func cancelled() async throws {
        let fake = FakePigeon()
        let client = fake.client
        let registration = try await client.register(environment: .sandbox, token: Data([1]))
        fake.fail("create", with: .cancelled)
        do {
            _ = try await client.createHandle(registration, tag: PushTag.generate())
            Issue.record("did not throw")
        } catch is CancellationError {
        } catch {
            Issue.record("threw \(error)")
        }
    }

    @Test("Nothing that can't go in a path is sent")
    func wellFormed() async throws {
        let fake = FakePigeon()
        let client = fake.client
        let odd = PigeonRegistration(deviceId: "hrd_../x", manageKey: "hrm_ok")
        await #expect(throws: PigeonError.unexpected) { try await client.update(odd) }
        await #expect(throws: PigeonError.unexpected) { try await client.listHandles(odd) }
        let fine = PigeonRegistration(deviceId: "hrd_ok", manageKey: "hrm_ok")
        await #expect(throws: PigeonError.unexpected) { try await client.createHandle(fine, tag: "short") }
        await #expect(throws: PigeonError.unexpected) { try await client.revokeHandle(fine, handleId: "a/b") }
        #expect(fake.clients.calls.isEmpty)

        #expect(PigeonClient.isWellFormedID("hrd_abc-DEF_123", prefix: "hrd_"))
        #expect(!PigeonClient.isWellFormedID("hrd_", prefix: "hrd_"))
        #expect(!PigeonClient.isWellFormedID("hrm_abc", prefix: "hrd_"))
        #expect(!PigeonClient.isWellFormedID("hrd_a b", prefix: "hrd_"))
        #expect(!PigeonClient.isWellFormedID("hrd_" + String(repeating: "a", count: 200), prefix: "hrd_"))
    }

    @Test("An answer with ids that can't be trusted in a path is refused")
    func refusesOddAnswers() async throws {
        let odd = StubClients { endpoint in
            switch endpoint {
            case is PigeonEndpoints.RegisterDevice: return PigeonRegistration(deviceId: "hrd_a/../b", manageKey: "hrm_k")
            case is PigeonEndpoints.CreateHandle: return PigeonHandle(handleId: "h1", handle: "not-a-handle")
            default: throw NetworkError.notFound
            }
        }
        let client = PigeonClient { key in odd.make(PigeonRelay.official, key) }
        await #expect(throws: PigeonError.unexpected) {
            try await client.register(environment: .sandbox, token: Data([1]))
        }
        let registration = PigeonRegistration(deviceId: "hrd_ok", manageKey: "hrm_ok")
        await #expect(throws: PigeonError.unexpected) {
            try await client.createHandle(registration, tag: PushTag.generate())
        }
    }
}

@Suite("Postal Pigeon registration")
struct PigeonRegistrarTests {
    /// A clock the test moves.
    final class TestClock: @unchecked Sendable {
        // @unchecked: `date` is only touched while holding `lock`.
        private let lock = NSLock()
        private var date = Date(timeIntervalSince1970: 1_800_000_000)
        var now: Date { lock.withLock { date } }
        func advance(hours: Double) { lock.withLock { date = date.addingTimeInterval(hours * 3600) } }
    }

    /// A store that cannot keep anything.
    struct FullStore: PigeonStore {
        func load() throws -> PigeonRecord? { nil }
        func save(_ record: PigeonRecord) throws { throw TokenStoreError.invalidItemData }
        func clear() throws {}
    }

    private func makeRegistrar(
        _ fake: FakePigeon, store: any PigeonStore = InMemoryPigeonStore(), clock: TestClock = TestClock()
    ) -> PigeonRegistrar {
        PigeonRegistrar(client: fake.client, store: store, environment: .sandbox, now: { clock.now })
    }

    @Test("The first token registers the device and keeps the ids")
    func first() async throws {
        let fake = FakePigeon()
        let store = InMemoryPigeonStore()
        let registration = try await makeRegistrar(fake, store: store).apply(token: Data([0xAB]))
        #expect(fake.calls == ["register"])
        let record = try #require(try store.load())
        #expect(record.registration == registration)
        #expect(record.token == "ab")
    }

    @Test("The same token again, within a day, sends nothing")
    func quiet() async throws {
        let fake = FakePigeon()
        let clock = TestClock()
        let registrar = makeRegistrar(fake, clock: clock)
        let first = try await registrar.apply(token: Data([1]))
        clock.advance(hours: 23)
        let second = try await registrar.apply(token: Data([1]))
        #expect(first == second)
        #expect(fake.calls == ["register"])
    }

    @Test("A day later it is a keep-alive, and the day starts over")
    func keepAlive() async throws {
        let fake = FakePigeon()
        let clock = TestClock()
        let registrar = makeRegistrar(fake, clock: clock)
        try await registrar.apply(token: Data([1]))
        clock.advance(hours: 25)
        try await registrar.apply(token: Data([1]))
        try await registrar.apply(token: Data([1]))
        #expect(fake.calls == ["register", "update"])
    }

    @Test("A new token is sent to Pigeon at once and the device keeps its ids")
    func newToken() async throws {
        let fake = FakePigeon()
        let store = InMemoryPigeonStore()
        let registrar = makeRegistrar(fake, store: store)
        let first = try await registrar.apply(token: Data([1]))
        let second = try await registrar.apply(token: Data([2]))
        #expect(first == second)
        #expect(fake.calls == ["register", "update"])
        #expect(try store.load()?.token == "02")
    }

    @Test("A device Pigeon forgot, or a refused key, registers again once")
    func forgotten() async throws {
        for failure in [NetworkError.notFound, .unauthorized] {
            let fake = FakePigeon()
            let clock = TestClock()
            let registrar = makeRegistrar(fake, clock: clock)
            let first = try await registrar.apply(token: Data([1]))
            clock.advance(hours: 25)
            fake.fail("update", with: failure)
            let second = try await registrar.apply(token: Data([1]))
            #expect(first != second, "\(failure)")
            #expect(fake.calls == ["register", "update", "register"], "\(failure)")
        }
    }

    @Test("A busy Pigeon is an error, not a reason to register a second device")
    func busy() async throws {
        let fake = FakePigeon()
        let clock = TestClock()
        let registrar = makeRegistrar(fake, clock: clock)
        try await registrar.apply(token: Data([1]))
        clock.advance(hours: 25)
        fake.fail("update", with: .server(status: 503))
        await #expect(throws: PigeonError.unavailable) { try await registrar.apply(token: Data([1])) }
        #expect(fake.count("register") == 1)
    }

    @Test("Without a place to keep the key the new device is removed again")
    func cannotKeep() async throws {
        let fake = FakePigeon()
        let registrar = makeRegistrar(fake, store: FullStore())
        await #expect(throws: TokenStoreError.invalidItemData) { try await registrar.apply(token: Data([1])) }
        #expect(fake.calls == ["register", "remove"])
        #expect(fake.deviceIds.isEmpty)
    }

    @Test("Forgetting the registration makes the next token register a new device")
    func reregister() async throws {
        let fake = FakePigeon()
        let registrar = makeRegistrar(fake)
        let first = try await registrar.apply(token: Data([1]))
        #expect(registrar.storedDeviceId() == first.deviceId)
        registrar.reregister()
        #expect(registrar.storedDeviceId() == nil)
        let second = try await registrar.apply(token: Data([1]))
        #expect(first != second)
    }

    @Test("A time in the future (the clock was set back) counts as due")
    func clockSetBack() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(!PigeonRegistrar.needsKeepAlive(lastSent: now.addingTimeInterval(-3600), now: now))
        #expect(PigeonRegistrar.needsKeepAlive(lastSent: now.addingTimeInterval(-24 * 3600), now: now))
        #expect(PigeonRegistrar.needsKeepAlive(lastSent: now.addingTimeInterval(3600), now: now))
    }
}
