import Foundation
@testable import SyloKit

/// A Postal Pigeon that lives in memory: registers devices, makes and revokes handles, and can be
/// told to fail or to forget. Answers the Pigeon endpoints through ``StubClients``, so the tests
/// also see which manage key each call carried.
final class FakePigeon: @unchecked Sendable {
    // @unchecked: all state is only touched while holding `lock`.
    private let lock = NSLock()
    private var counter = 0
    private var devices: [String: String] = [:]  // device id -> manage key
    private var handles: [String: [String: String]] = [:]  // device id -> handle id -> tag
    private var log: [String] = []
    private var environments: [PigeonEnvironment] = []
    private var failures: [String: (error: NetworkError, remaining: Int)] = [:]

    let clients: StubClients

    init() {
        let box = Box()
        clients = StubClients { endpoint in
            guard let fake = box.fake else { throw NetworkError.notFound }
            return try fake.answer(endpoint)
        }
        box.fake = self
    }

    /// The stub needs the fake it answers for before the fake exists.
    private final class Box: @unchecked Sendable {
        // @unchecked: set once, right after `init`, before any call.
        weak var fake: FakePigeon?
    }

    /// A client for the official Pigeon whose calls this fake answers.
    var client: PigeonClient {
        PigeonClient { [clients] key in clients.make(PigeonRelay.official, key) }
    }

    // MARK: What the tests look at

    /// The calls so far, by name: `register`, `update`, `remove`, `create`, `revoke:<handle id>`, `list`.
    var calls: [String] { lock.withLock { log } }

    /// The environment of each device registered.
    var registeredEnvironments: [PigeonEnvironment] { lock.withLock { environments } }

    func count(_ call: String) -> Int { calls.filter { $0 == call }.count }

    func knowsDevice(_ id: String) -> Bool { lock.withLock { devices[id] != nil } }

    /// The handle ids Pigeon has for `device`.
    func handleIds(of device: String) -> Set<String> {
        lock.withLock { Set(handles[device]?.keys.map { $0 } ?? []) }
    }

    var deviceIds: [String] { lock.withLock { devices.keys.sorted() } }

    /// The tag of a handle.
    func tag(of handleId: String, device: String) -> String? {
        lock.withLock { handles[device]?[handleId] }
    }

    // MARK: What the tests change

    /// Fails the next `times` calls of `operation` with `error` (all of them by default).
    func fail(_ operation: String, with error: NetworkError, times: Int = .max) {
        lock.withLock { failures[operation] = (error, times) }
    }

    func stopFailing(_ operation: String) {
        lock.withLock { failures[operation] = nil }
    }

    /// Pigeon loses every device and handle (a restored backup, a deleted record).
    func forgetEverything() {
        lock.withLock {
            devices = [:]
            handles = [:]
        }
    }

    /// Pigeon loses one handle.
    func dropHandle(_ handleId: String, device: String) {
        lock.withLock { _ = handles[device]?.removeValue(forKey: handleId) }
    }

    /// A handle Pigeon has that no registry knows (a step failed earlier).
    func addOrphan(device: String, handleId: String = "orphan") {
        lock.withLock { handles[device, default: [:]][handleId] = "tag" }
    }

    // MARK: Answers

    private func record(_ call: String, operation: String) throws {
        log.append(call)
        if let failure = failures[operation], failure.remaining > 0 {
            if failure.remaining != .max { failures[operation] = (failure.error, failure.remaining - 1) }
            throw failure.error
        }
    }

    fileprivate func answer(_ endpoint: any APIEndpoint) throws -> Any {
        try lock.withLock { () throws -> Any in
            switch endpoint {
            case let register as PigeonEndpoints.RegisterDevice:
                try record("register", operation: "register")
                environments.append(register.environment)
                counter += 1
                let id = "hrd_device\(counter)"
                devices[id] = "hrm_key\(counter)"
                handles[id] = [:]
                return PigeonRegistration(deviceId: id, manageKey: "hrm_key\(counter)")
            case let update as PigeonEndpoints.UpdateDevice:
                try record("update", operation: "update")
                guard devices[update.deviceId] != nil else { throw NetworkError.notFound }
                return EmptyResponse()
            case let remove as PigeonEndpoints.RemoveDevice:
                try record("remove", operation: "remove")
                devices[remove.deviceId] = nil
                handles[remove.deviceId] = nil
                return EmptyResponse()
            case let create as PigeonEndpoints.CreateHandle:
                try record("create", operation: "create")
                guard devices[create.deviceId] != nil else { throw NetworkError.notFound }
                counter += 1
                let id = "handle\(counter)"
                handles[create.deviceId, default: [:]][id] = create.tag
                return PigeonHandle(handleId: id, handle: "hrh_secret\(counter)")
            case let revoke as PigeonEndpoints.RevokeHandle:
                try record("revoke:\(revoke.handleId)", operation: "revoke")
                guard devices[revoke.deviceId] != nil else { throw NetworkError.notFound }
                handles[revoke.deviceId]?[revoke.handleId] = nil
                return EmptyResponse()
            case let list as PigeonEndpoints.ListHandles:
                try record("list", operation: "list")
                guard devices[list.deviceId] != nil else { throw NetworkError.notFound }
                let infos = (handles[list.deviceId] ?? [:]).sorted { $0.key < $1.key }
                    .map { PigeonHandleInfo(handleId: $0.key, tag: $0.value) }
                return PigeonEndpoints.ListHandles.HandleList(handles: infos)
            default:
                throw NetworkError.notFound
            }
        }
    }
}

/// The Sylo server's side of a push registration: whether it has a handle for this sign-in, and
/// which handles it was given.
final class FakeSyloPush: @unchecked Sendable {
    // @unchecked: all state is only touched while holding `lock`.
    private let lock = NSLock()
    private var handles: [String] = []
    private var enabled = false
    private var failure: (any Error)?

    /// The handles the server was given, oldest first.
    var handlesGiven: [String] { lock.withLock { handles } }

    /// What `GET /api/mobile/push` says about `enabled`.
    var hasHandle: Bool { lock.withLock { enabled } }

    /// The server lost its handle (a new sign-in has none).
    func lose() { lock.withLock { enabled = false } }

    /// Makes the server refuse the next registrations with `error` (nil: accept again).
    func fail(with error: (any Error)?) { lock.withLock { failure = error } }

    func register(_ handle: String) throws {
        try lock.withLock {
            if let failure { throw failure }
            handles.append(handle)
            enabled = true
        }
    }
}
