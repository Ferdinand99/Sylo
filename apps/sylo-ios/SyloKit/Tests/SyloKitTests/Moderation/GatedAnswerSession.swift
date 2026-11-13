import Foundation
@testable import SyloKit

/// Holds calls until a test lets them go, so a second action can be asked for while the first one
/// runs. Waiting uses sleeps, never a blocked thread, so parallel tests cannot starve each other.
final class TestGate: @unchecked Sendable {
    private let lock = NSLock()
    private var opened = false
    private var started = 0

    var isOpen: Bool { lock.withLock { opened } }
    /// How many calls have reached the gate.
    var arrivals: Int { lock.withLock { started } }
    func open() { lock.withLock { opened = true } }
    func arrive() { lock.withLock { started += 1 } }
}

/// A client that waits at the gate, then answers from `answer`.
struct GatedAnswerClient: APIClient {
    let gate: TestGate
    let answer: @Sendable (any APIEndpoint) throws -> Any

    func send<E: APIEndpoint>(_ endpoint: E) async throws -> E.Response {
        gate.arrive()
        while !gate.isOpen { try await Task.sleep(for: .milliseconds(5)) }
        guard let response = try answer(endpoint) as? E.Response else {
            throw NetworkError.decoding("gated client answered \(E.self) with the wrong type")
        }
        return response
    }
}

@MainActor
func makeGatedAnswerSession(gate: TestGate, answer: @escaping @Sendable (any APIEndpoint) throws -> Any) -> AppSession {
    let server = try! ServerURL("https://sylo.example.com")
    let tokens = InMemoryTokenStore(tokens: [
        server.description: StoredToken(token: "sylo_live", expiresAt: Date().addingTimeInterval(86_400)),
    ])
    let session = AppSession(
        tokens: tokens, preference: MemoryServerPreference(server), deviceName: "Test",
        makeClient: { _, _ in GatedAnswerClient(gate: gate, answer: answer) })
    session.start()
    return session
}

/// Waits until a call has reached the gate.
@MainActor
func waitForArrival(_ gate: TestGate) async {
    for _ in 0..<2000 where gate.arrivals == 0 { try? await Task.sleep(for: .milliseconds(5)) }
}
