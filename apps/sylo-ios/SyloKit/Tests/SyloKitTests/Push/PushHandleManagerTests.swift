import Foundation
import Testing
@testable import SyloKit

/// A manager over a fake Pigeon, a fake Sylo server and a registry in a temporary file.
struct PushHarness: Sendable {
    let pigeon = FakePigeon()
    let sylo = FakeSyloPush()
    let store = InMemoryPigeonStore()
    let registry: PushRegistry
    let manager: PushHandleManager
    let server = try! ServerURL("https://sylo.example.com")
    private let file: URL

    init() {
        file = FileManager.default.temporaryDirectory
            .appendingPathComponent("SyloKitTests-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("push-tags.json")
        registry = PushRegistry(fileURL: file)
        manager = PushHandleManager(
            relay: pigeon.client,
            registrar: PigeonRegistrar(client: pigeon.client, store: store, environment: .sandbox),
            registry: registry)
    }

    /// Removes the registry's folder again.
    func cleanUp() {
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }

    func setUp(
        _ server: ServerURL? = nil, token: Data = Data([1, 2, 3])
    ) async throws {
        let sylo = self.sylo
        try await manager.setUp(
            server: server ?? self.server, deviceToken: token,
            serverHasHandle: { sylo.hasHandle },
            registerAtServer: { handle in try sylo.register(handle) })
    }

    /// The Pigeon device this device registered as.
    var deviceId: String? { pigeon.deviceIds.last }
}

@Suite("Push handles")
struct PushHandleManagerTests {
    @Test("Setting up registers the device, makes a handle with a tag and gives it to the server")
    func firstSetUp() async throws {
        let h = PushHarness()
        defer { h.cleanUp() }
        try await h.setUp()

        #expect(h.pigeon.count("register") == 1)
        #expect(h.pigeon.count("create") == 1)
        let given = try #require(h.sylo.handlesGiven.first)
        #expect(given.hasPrefix("hrh_"))
        #expect(h.sylo.handlesGiven.count == 1)

        let entry = try #require(h.registry.entry(forServer: h.server))
        let device = try #require(h.deviceId)
        #expect(entry.relayDeviceId == device)
        #expect(PushTag.isWellFormed(entry.tag))
        #expect(h.pigeon.tag(of: entry.relayHandleId, device: device) == entry.tag)
        #expect(h.registry.entry(forTag: entry.tag) == entry)
    }

    @Test("A server that has its handle is left alone the next time")
    func secondSetUp() async throws {
        let h = PushHarness()
        defer { h.cleanUp() }
        try await h.setUp()
        let entry = try #require(h.registry.entry(forServer: h.server))
        try await h.setUp()

        #expect(h.pigeon.count("create") == 1)
        #expect(h.sylo.handlesGiven.count == 1)
        #expect(h.registry.entry(forServer: h.server) == entry)
        #expect(h.pigeon.count("register") == 1)
    }

    @Test("A server that lost its handle (a new sign-in) gets a new one, and the old one is revoked")
    func serverLostIt() async throws {
        let h = PushHarness()
        defer { h.cleanUp() }
        try await h.setUp()
        let old = try #require(h.registry.entry(forServer: h.server))
        h.sylo.lose()
        try await h.setUp()

        let new = try #require(h.registry.entry(forServer: h.server))
        #expect(new.tag != old.tag)
        #expect(new.relayHandleId != old.relayHandleId)
        #expect(h.pigeon.count("revoke:\(old.relayHandleId)") == 1)
        #expect(h.sylo.handlesGiven.count == 2)
        #expect(h.registry.entries().count == 1)
        #expect(h.pigeon.handleIds(of: try #require(h.deviceId)) == [new.relayHandleId])
    }

    @Test("A server that refuses the handle: nothing is left at Pigeon or in the registry")
    func serverRefuses() async throws {
        let h = PushHarness()
        defer { h.cleanUp() }
        h.sylo.fail(with: NetworkError.badRequest(message: "invalid_push_token"))
        do {
            try await h.setUp()
            Issue.record("did not throw")
        } catch {
            #expect(error as? NetworkError == .badRequest(message: "invalid_push_token"))
        }
        #expect(h.registry.entries().isEmpty)
        #expect(h.pigeon.handleIds(of: try #require(h.deviceId)).isEmpty)
        #expect(h.pigeon.count("create") == 1)
        #expect(h.sylo.handlesGiven.isEmpty)

        // Later it takes it.
        h.sylo.fail(with: nil)
        try await h.setUp()
        #expect(h.registry.entry(forServer: h.server) != nil)
    }

    @Test("The tag is in the registry before the server is told, so an early push can be tied to it")
    func entryComesFirst() async throws {
        let h = PushHarness()
        defer { h.cleanUp() }
        let registry = h.registry
        let server = h.server
        let seen = Seen()
        try await h.manager.setUp(
            server: server, deviceToken: Data([1]), serverHasHandle: { false },
            registerAtServer: { _ in seen.set(registry.entry(forServer: server) != nil) })
        #expect(seen.value == true)
    }

    @Test("Pigeon's limits and trouble are errors, and leave nothing behind")
    func pigeonFails() async throws {
        let cases: [(NetworkError, PigeonError)] = [
            (.rateLimited, .rateLimited),
            (.http(status: 409), .limitReached),
            (.server(status: 503), .unavailable),
            (.offline, .unavailable),
        ]
        for (failure, expected) in cases {
            let h = PushHarness()
            defer { h.cleanUp() }
            h.pigeon.fail("create", with: failure)
            do {
                try await h.setUp()
                Issue.record("\(failure) did not throw")
            } catch let error as PigeonError {
                #expect(error == expected, "\(failure)")
            }
            #expect(h.registry.entries().isEmpty, "\(failure)")
            #expect(h.sylo.handlesGiven.isEmpty, "\(failure)")
            #expect(h.pigeon.count("create") == 1, "\(failure)")
        }
    }

    @Test("A device Pigeon forgot is registered again once, and every handle is made new")
    func deviceForgotten() async throws {
        let h = PushHarness()
        defer { h.cleanUp() }
        try await h.setUp()
        let old = try #require(h.registry.entry(forServer: h.server))
        h.pigeon.forgetEverything()
        // The new device's handle is not at the server yet either (it is a new one).
        try await h.setUp()

        #expect(h.pigeon.count("register") == 2)
        let new = try #require(h.registry.entry(forServer: h.server))
        #expect(new.relayDeviceId != old.relayDeviceId)
        #expect(new.relayDeviceId == h.deviceId)
        #expect(h.sylo.handlesGiven.count == 2)
        #expect(h.registry.entries().count == 1)
    }

    @Test("It does not loop: a Pigeon that keeps saying gone is tried twice, then it is an error")
    func noLoop() async throws {
        let h = PushHarness()
        defer { h.cleanUp() }
        h.pigeon.fail("create", with: .notFound)
        await #expect(throws: PigeonError.gone) { try await h.setUp() }
        #expect(h.pigeon.count("register") == 2)
        #expect(h.pigeon.count("create") == 2)
        #expect(h.registry.entries().isEmpty)
    }

    @Test("A handle Pigeon no longer has is replaced, and one nobody knows is revoked")
    func tidying() async throws {
        let h = PushHarness()
        defer { h.cleanUp() }
        try await h.setUp()
        let device = try #require(h.deviceId)
        let lost = try #require(h.registry.entry(forServer: h.server))
        h.pigeon.dropHandle(lost.relayHandleId, device: device)
        h.pigeon.addOrphan(device: device)
        try await h.setUp()

        let new = try #require(h.registry.entry(forServer: h.server))
        #expect(new.relayHandleId != lost.relayHandleId)
        #expect(h.pigeon.count("revoke:orphan") == 1)
        #expect(h.pigeon.handleIds(of: device) == [new.relayHandleId])
        // The server still said it had a handle; Pigeon is what knew better.
        #expect(h.sylo.handlesGiven.count == 2)
    }

    @Test("Not being able to list the handles only means no tidying")
    func listFails() async throws {
        let h = PushHarness()
        defer { h.cleanUp() }
        h.pigeon.fail("list", with: .server(status: 503))
        try await h.setUp()
        #expect(h.registry.entry(forServer: h.server) != nil)
        #expect(h.sylo.handlesGiven.count == 1)
    }

    @Test("Another server's handle is taken down when this one is set up")
    func otherServer() async throws {
        let h = PushHarness()
        defer { h.cleanUp() }
        let other = try ServerURL("https://other.example.com")
        try await h.setUp(other)
        let first = try #require(h.registry.entry(forServer: other))
        try await h.setUp()

        #expect(h.registry.entry(forServer: other) == nil)
        #expect(h.registry.entry(forServer: h.server) != nil)
        #expect(h.pigeon.count("revoke:\(first.relayHandleId)") == 1)
        #expect(h.registry.entries().count == 1)
    }

    @Test("Taking a server down removes its entry and revokes its handle, and nothing else")
    func release() async throws {
        let h = PushHarness()
        defer { h.cleanUp() }
        try await h.setUp()
        let entry = try #require(h.registry.entry(forServer: h.server))
        await h.manager.release(server: try ServerURL("https://unknown.example.com"))
        #expect(h.registry.entries().count == 1)

        await h.manager.release(server: h.server)
        #expect(h.registry.entries().isEmpty)
        #expect(h.pigeon.count("revoke:\(entry.relayHandleId)") == 1)
        #expect(h.pigeon.handleIds(of: try #require(h.deviceId)).isEmpty)

        // Twice is fine.
        await h.manager.release(server: h.server)
        #expect(h.pigeon.count("revoke:\(entry.relayHandleId)") == 1)
    }

    @Test("Releasing all but one keeps that server's handle")
    func releaseAll() async throws {
        let h = PushHarness()
        defer { h.cleanUp() }
        try await h.setUp()
        let entry = try #require(h.registry.entry(forServer: h.server))

        await h.manager.releaseAll(except: h.server)
        #expect(h.registry.entry(forServer: h.server) == entry)
        #expect(h.pigeon.count("revoke:\(entry.relayHandleId)") == 0)

        await h.manager.releaseAll(except: try ServerURL("https://other.example.com"))
        #expect(h.registry.entries().isEmpty)
        #expect(h.pigeon.count("revoke:\(entry.relayHandleId)") == 1)

        try await h.setUp()
        await h.manager.releaseAll(except: nil)
        #expect(h.registry.entries().isEmpty)
    }

    @Test("A handle is gone from the registry even when Pigeon can't be reached to revoke it")
    func releaseOffline() async throws {
        let h = PushHarness()
        defer { h.cleanUp() }
        try await h.setUp()
        h.pigeon.fail("revoke", with: .offline)
        await h.manager.release(server: h.server)
        #expect(h.registry.entries().isEmpty)
    }

    @Test("Two set-ups at once make one handle")
    func oneAtATime() async throws {
        let h = PushHarness()
        defer { h.cleanUp() }
        async let first: Void = h.setUp()
        async let second: Void = h.setUp()
        try await first
        try await second
        #expect(h.pigeon.count("create") == 1)
        #expect(h.pigeon.count("register") == 1)
        #expect(h.sylo.handlesGiven.count == 1)
    }

    @Test("Nothing secret is ever in what the registry keeps")
    func nothingSecret() async throws {
        let h = PushHarness()
        defer { h.cleanUp() }
        try await h.setUp()
        let given = try #require(h.sylo.handlesGiven.first)
        let key = try #require(try h.store.load()?.registration.manageKey)
        let text = String(decoding: try JSONEncoder().encode(h.registry.entries()), as: UTF8.self)
        #expect(!text.contains(given))
        #expect(!text.contains(key))
    }
}

/// A flag a `@Sendable` closure can set.
final class Seen: @unchecked Sendable {
    // @unchecked: `stored` is only touched while holding `lock`.
    private let lock = NSLock()
    private var stored: Bool?
    var value: Bool? { lock.withLock { stored } }
    func set(_ value: Bool) { lock.withLock { stored = value } }
}
