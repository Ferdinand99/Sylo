import Foundation

/// Keeps one Pigeon handle per Sylo server: made at Pigeon, given to the server, remembered in the
/// ``PushRegistry``; and taken down again the other way round.
///
/// - Setting up: the device is registered (or its token updated) at Pigeon, then a tag, then
///   Pigeon's handle, then the server's registration. The registry entry is written before the
///   server is told, so a push that arrives at once can already be tied to the server. If the
///   server says no, the entry and Pigeon's handle go again at once (Pigeon allows 32 handles per
///   device and 10 new ones an hour).
/// - Taking down: the entry goes first, then Pigeon's handle (that stops the pushes). The server
///   forgets a handle it is told is gone, and drops it with its token when the person signs out.
/// - Nothing here loops. A failure is thrown; the caller decides when to try again (next launch).
///
/// One call runs at a time: the others wait for it, so two calls never make two handles.
public actor PushHandleManager {
    /// Gives the server the new handle (`POST /api/mobile/push`).
    public typealias RegisterAtServer = @Sendable (_ handle: String) async throws -> Void
    /// Whether the server still has a handle for this sign-in (`GET /api/mobile/push`, `enabled`).
    public typealias ServerHasHandle = @Sendable () async throws -> Bool

    private let relay: PigeonClient
    private let registrar: PigeonRegistrar
    private let registry: PushRegistry
    private let makeTag: @Sendable () -> String
    private let now: @Sendable () -> Date

    private var isBusy = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    public init(relay: PigeonClient, registrar: PigeonRegistrar, registry: PushRegistry) {
        self.init(
            relay: relay, registrar: registrar, registry: registry, makeTag: { PushTag.generate() },
            now: { Date() })
    }

    init(
        relay: PigeonClient, registrar: PigeonRegistrar, registry: PushRegistry,
        makeTag: @escaping @Sendable () -> String, now: @escaping @Sendable () -> Date
    ) {
        self.relay = relay
        self.registrar = registrar
        self.registry = registry
        self.makeTag = makeTag
        self.now = now
    }

    // MARK: Setting up

    /// Makes sure `server` has a handle that Pigeon and the server know. With one already (made for
    /// this Pigeon device, still at Pigeon, and still at the server) nothing more is sent than the
    /// device's own daily keep-alive.
    ///
    /// - Parameters:
    ///   - deviceToken: The APNs token iOS gave the app.
    ///   - serverHasHandle: Only asked when the registry has an entry for the server. False (a new
    ///     sign-in has no handle on the server) takes the old handle down and makes a new one.
    ///   - registerAtServer: Gives the server the handle. Anything it throws takes the new handle
    ///     down again and is rethrown.
    /// - Throws: ``PigeonError``, or what the closures throw.
    public func setUp(
        server: ServerURL, deviceToken: Data, serverHasHandle: ServerHasHandle,
        registerAtServer: RegisterAtServer
    ) async throws {
        await beginTurn()
        defer { endTurn() }

        var registration = try await registrar.apply(token: deviceToken)
        do {
            try await ensure(
                server, registration: registration, serverHasHandle: serverHasHandle,
                registerAtServer: registerAtServer)
        } catch PigeonError.gone, PigeonError.invalidCredentials {
            // Pigeon forgot the device between the two calls: register it again, once.
            registrar.reregister()
            registration = try await registrar.apply(token: deviceToken)
            try await ensure(
                server, registration: registration, serverHasHandle: serverHasHandle,
                registerAtServer: registerAtServer)
        }
    }

    private func ensure(
        _ server: ServerURL, registration: PigeonRegistration,
        serverHasHandle: ServerHasHandle, registerAtServer: RegisterAtServer
    ) async throws {
        try await tidy(keeping: server, registration: registration)

        if let entry = registry.entry(forServer: server) {
            if try await serverHasHandle() { return }
            // The server lost it (a new sign-in): take the old one down and make a new one.
            try? registry.remove(server: server)
            await revokeAtRelay(entry.relayHandleId, registration: registration)
        }

        let tag = makeTag()
        let handle = try await relay.createHandle(registration, tag: tag)
        let entry = PushEntry(
            tag: tag, server: server, relayDeviceId: registration.deviceId, relayHandleId: handle.handleId,
            created: now())
        do {
            try registry.save(entry)
        } catch {
            // Without the entry a push could not be tied to a server.
            await revokeAtRelay(handle.handleId, registration: registration)
            throw PigeonError.unexpected
        }
        do {
            try await registerAtServer(handle.handle)
        } catch {
            // The server will not have it: do not leave the handle at Pigeon.
            try? registry.remove(server: server)
            await revokeAtRelay(handle.handleId, registration: registration)
            throw error
        }
    }

    /// Brings the registry and Pigeon in line, for one set-up:
    /// - an entry for another server (the person signed out of it) is taken down;
    /// - an entry that belongs to an earlier Pigeon device, or that Pigeon no longer has, is dropped,
    ///   so the server gets a fresh handle;
    /// - a handle at Pigeon that the registry does not know (a step failed earlier) is revoked.
    ///
    /// Failing to list the handles only means no cleaning this time; `gone` and `invalidCredentials`
    /// are thrown, since the device then has to be registered again.
    private func tidy(keeping server: ServerURL, registration: PigeonRegistration) async throws {
        var live: Set<String>?
        do {
            live = Set(try await relay.listHandles(registration).map(\.handleId))
        } catch PigeonError.gone {
            throw PigeonError.gone
        } catch PigeonError.invalidCredentials {
            throw PigeonError.invalidCredentials
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            live = nil
        }

        for entry in registry.entries() {
            if entry.server != server {
                try? registry.remove(server: entry.server)
                if entry.relayDeviceId == registration.deviceId {
                    await revokeAtRelay(entry.relayHandleId, registration: registration)
                }
            } else if entry.relayDeviceId != registration.deviceId
                || (live.map { !$0.contains(entry.relayHandleId) } ?? false)
            {
                try? registry.remove(server: entry.server)
            }
        }

        if let live {
            let known = Set(registry.entries().map(\.relayHandleId))
            for handleId in live.subtracting(known) {
                await revokeAtRelay(handleId, registration: registration)
            }
        }
    }

    // MARK: Taking down

    /// Push is off for this server, or the person signed out of it: its entry and its handle at
    /// Pigeon go. Nothing is sent to the server: telling it (`DELETE /api/mobile/push`) is the
    /// caller's, and when the person signed out, the server dropped the handle with the token.
    public func release(server: ServerURL) async {
        await beginTurn()
        defer { endTurn() }
        guard let entry = registry.entry(forServer: server) else { return }
        try? registry.remove(server: server)
        await takeDown(entry)
    }

    /// Every server's handle goes except `server`'s: the person is signed out, or signed in to
    /// another server.
    public func releaseAll(except server: ServerURL?) async {
        await beginTurn()
        defer { endTurn() }
        for entry in registry.entries() where entry.server != server {
            try? registry.remove(server: entry.server)
            await takeDown(entry)
        }
    }

    private func takeDown(_ entry: PushEntry) async {
        // A handle of another Pigeon device died with that device.
        guard let registration = registrar.storedRegistration(), registration.deviceId == entry.relayDeviceId else {
            return
        }
        await revokeAtRelay(entry.relayHandleId, registration: registration)
    }

    private func revokeAtRelay(_ handleId: String, registration: PigeonRegistration) async {
        try? await relay.revokeHandle(registration, handleId: handleId)
    }

    // MARK: One at a time

    /// Waits until no other call is running. The next waiting call is handed the turn directly
    /// (`isBusy` stays true), so a call that arrives in between cannot jump the queue.
    private func beginTurn() async {
        if isBusy {
            await withCheckedContinuation { waiting.append($0) }
        } else {
            isBusy = true
        }
    }

    private func endTurn() {
        if waiting.isEmpty {
            isBusy = false
        } else {
            waiting.removeFirst().resume()
        }
    }
}
