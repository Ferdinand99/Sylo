import Foundation
@testable import SyloKit

/// Makes ``APIClient``s that answer from one shared handler, and records every call they send
/// with the token the client was made with.
final class StubClients: @unchecked Sendable {
    // @unchecked: `handler` and `sent` are only touched while holding `lock`.
    struct Call {
        let endpoint: any APIEndpoint
        let token: String?
    }

    typealias Handler = @Sendable (any APIEndpoint) throws -> Any

    private let lock = NSLock()
    private var handler: Handler
    private var sent: [Call] = []

    init(handler: @escaping Handler) {
        self.handler = handler
    }

    var calls: [Call] { lock.withLock { sent } }

    func setHandler(_ handler: @escaping Handler) {
        lock.withLock { self.handler = handler }
    }

    func make(_ server: ServerURL, _ token: String?) -> any APIClient {
        Client(owner: self, token: token)
    }

    fileprivate func answer(_ endpoint: any APIEndpoint, token: String?) throws -> Any {
        let handler = lock.withLock {
            sent.append(Call(endpoint: endpoint, token: token))
            return self.handler
        }
        return try handler(endpoint)
    }

    private struct Client: APIClient {
        let owner: StubClients
        let token: String?

        func send<E: APIEndpoint>(_ endpoint: E) async throws -> E.Response {
            do {
                guard let response = try owner.answer(endpoint, token: token) as? E.Response else {
                    throw NetworkError.decoding("stub answered \(E.self) with the wrong type")
                }
                return response
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
