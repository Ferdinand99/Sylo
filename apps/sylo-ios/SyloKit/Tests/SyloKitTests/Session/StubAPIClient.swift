import Foundation
@testable import SyloKit

/// Makes ``APIClient``s that answer from one shared handler, and records every call they send
/// with the server and token the client was made with.
final class StubClients: @unchecked Sendable {
    // @unchecked: `handler` and `sent` are only touched while holding `lock`.
    struct Call {
        let endpoint: any APIEndpoint
        let server: ServerURL
        let token: String?
    }

    typealias Handler = @Sendable (any APIEndpoint) throws -> Any

    private let lock = NSLock()
    private var handler: Handler
    private var sent: [Call] = []
    private var progressSteps: [(sent: Int64, total: Int64)] = []
    private var holdsUploads = false

    init(handler: @escaping Handler) {
        self.handler = handler
    }

    var calls: [Call] { lock.withLock { sent } }

    /// What an upload reports through its progress closure before it is answered.
    func setUploadProgress(_ steps: [(sent: Int64, total: Int64)]) {
        lock.withLock { progressSteps = steps }
    }

    /// Makes every upload wait (until its task is cancelled) instead of answering.
    func holdUploads(_ hold: Bool) {
        lock.withLock { holdsUploads = hold }
    }

    fileprivate var uploadBehaviour: (steps: [(sent: Int64, total: Int64)], holds: Bool) {
        lock.withLock { (steps: progressSteps, holds: holdsUploads) }
    }

    func setHandler(_ handler: @escaping Handler) {
        lock.withLock { self.handler = handler }
    }

    func make(_ server: ServerURL, _ token: String?) -> any APIClient {
        Client(owner: self, server: server, token: token)
    }

    fileprivate func answer(_ endpoint: any APIEndpoint, server: ServerURL, token: String?) throws -> Any {
        let handler = lock.withLock {
            sent.append(Call(endpoint: endpoint, server: server, token: token))
            return self.handler
        }
        return try handler(endpoint)
    }

    private struct Client: APIClient {
        let owner: StubClients
        let server: ServerURL
        let token: String?

        func send<E: APIEndpoint>(_ endpoint: E) async throws -> E.Response {
            do {
                guard let response = try owner.answer(endpoint, server: server, token: token) as? E.Response else {
                    throw NetworkError.decoding("stub answered \(E.self) with the wrong type")
                }
                return response
            } catch {
                throw NetworkError(error)
            }
        }

        /// An upload reports the steps it was given, may wait to be cancelled, then is answered like a send.
        func upload<E: APIEndpoint>(
            _ endpoint: E, progress: (@Sendable (Int64, Int64) -> Void)?
        ) async throws -> E.Response {
            let behaviour = owner.uploadBehaviour
            for step in behaviour.steps { progress?(step.sent, step.total) }
            if behaviour.holds {
                do {
                    try await Task.sleep(for: .seconds(60))
                } catch {
                    throw NetworkError.cancelled
                }
            }
            return try await send(endpoint)
        }

        /// A download is answered with a ``DownloadedFile`` (or thrown error) from the handler.
        func download<E: APIEndpoint>(_ endpoint: E) async throws -> DownloadedFile where E.Response == EmptyResponse {
            do {
                guard let file = try owner.answer(endpoint, server: server, token: token) as? DownloadedFile else {
                    throw NetworkError.decoding("stub answered \(E.self) with something that is not a file")
                }
                return file
            } catch {
                throw NetworkError(error)
            }
        }
    }
}

/// A ``ServerPreference`` in memory.
final class MemoryServerPreference: ServerPreference {
    var server: ServerURL?
    init(_ server: ServerURL? = nil) { self.server = server }
}

/// A session signed in to `server` whose calls are answered by `clients`.
@MainActor
func makeSignedInSession(
    clients: StubClients, server: ServerURL = try! ServerURL("https://sylo.example.com")
) -> AppSession {
    let tokens = InMemoryTokenStore(tokens: [
        server.description: StoredToken(token: "sylo_live", expiresAt: Date().addingTimeInterval(86_400)),
    ])
    let session = AppSession(
        tokens: tokens, preference: MemoryServerPreference(server), deviceName: "Test",
        makeClient: { [clients] in clients.make($0, $1) })
    session.start()
    return session
}
