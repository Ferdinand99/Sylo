import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import SyloKit

/// A request as the mock saw it.
struct RecordedRequest: Sendable {
    let url: URL
    let method: String
    let headers: [String: String]
    let body: Data?

    func header(_ name: String) -> String? {
        headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
    }
}

/// What the mock answers, in order; the last one repeats once the list runs out.
enum MockReply: Sendable {
    case response(status: Int, headers: [String: String] = ["Content-Type": "application/json; charset=utf-8"], body: Data = Data())
    case failure(URLError.Code)

    static func json(_ status: Int, _ json: String) -> MockReply {
        .response(status: status, body: Data(json.utf8))
    }
}

/// Shared state for ``MockURLProtocol``. URLProtocol instances are made by URLSession, so the
/// state is global; a lock keeps it safe, and the suites using it are `.serialized`.
final class MockState: @unchecked Sendable {
    private let lock = NSLock()
    private var replies: [MockReply] = []
    private var recorded: [RecordedRequest] = []

    func reset(_ replies: [MockReply]) {
        lock.lock(); defer { lock.unlock() }
        self.replies = replies
        recorded = []
    }

    var requests: [RecordedRequest] {
        lock.lock(); defer { lock.unlock() }
        return recorded
    }

    func next(for request: RecordedRequest) -> MockReply {
        lock.lock(); defer { lock.unlock() }
        recorded.append(request)
        if replies.count > 1 { return replies.removeFirst() }
        return replies.first ?? .failure(.unknown)
    }
}

final class MockURLProtocol: URLProtocol {
    static let state = MockState()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let request = self.request
        let recorded = RecordedRequest(
            url: request.url!,
            method: request.httpMethod ?? "GET",
            headers: request.allHTTPHeaderFields ?? [:],
            body: request.httpBody ?? request.httpBodyStream.map(Self.read)
        )
        switch Self.state.next(for: recorded) {
        case let .response(status, headers, body):
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if !body.isEmpty { client?.urlProtocol(self, didLoad: body) }
            client?.urlProtocolDidFinishLoading(self)
        case let .failure(code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        }
    }

    override func stopLoading() {}

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }

    /// A session built like the real default one, answered by this mock.
    static func session() -> URLSession {
        let configuration = URLSessionAPIClient.defaultConfiguration()
        configuration.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}
