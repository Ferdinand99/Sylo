import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Sends ``APIEndpoint`` calls to one Sylo server. A protocol so app models can be tested with a
/// stub instead of a network.
public protocol APIClient: Sendable {
    /// Sends the call and decodes its answer. Throws ``NetworkError`` only.
    func send<E: APIEndpoint>(_ endpoint: E) async throws -> E.Response
}

/// The ``APIClient`` for a real server, over `URLSession`.
///
/// Sends JSON with `Authorization: Bearer` only where the endpoint needs it, never follows a
/// redirect (the token must not go to another host), stores no cookies and no cache, and retries
/// only `GET`s, at most twice, on transient failures. It never logs a request or an answer.
public final class URLSessionAPIClient: APIClient {
    /// 0.5 s, then 1 s.
    static let defaultRetryDelays: [Duration] = [.milliseconds(500), .seconds(1)]

    public let server: ServerURL
    private let token: @Sendable () async -> String?
    private let session: URLSession
    private let ownsSession: Bool
    private let decoder: JSONDecoder
    private let retryDelays: [Duration]
    private let maxResponseBytes: Int?

    /// - Parameters:
    ///   - session: nil for the default session (``defaultConfiguration()``, redirects refused).
    ///   - retryDelays: how long to wait before each retry of a `GET` (nil: 0.5 s, then 1 s); empty for none.
    ///   - maxResponseBytes: refuse an answer longer than this (nil: no limit). The body is read
    ///     as it arrives and dropped at the limit, so a huge answer never sits in memory.
    ///   - token: the current app token, asked for once per call; nil when signed out.
    public convenience init(
        server: ServerURL, session: URLSession? = nil, decoder: JSONDecoder = JSONDecoder(),
        retryDelays: [Duration]? = nil, maxResponseBytes: Int? = nil,
        token: @escaping @Sendable () async -> String?
    ) {
        self.init(server: server, session: session, decoder: decoder, retryDelays: retryDelays ?? Self.defaultRetryDelays,
                  maxResponseBytes: maxResponseBytes, token: token)
    }

    init(
        server: ServerURL, session: URLSession?, decoder: JSONDecoder, retryDelays: [Duration],
        maxResponseBytes: Int?, token: @escaping @Sendable () async -> String?
    ) {
        self.server = server
        self.session = session ?? URLSession(
            configuration: Self.defaultConfiguration(), delegate: RefuseRedirects(), delegateQueue: nil)
        self.ownsSession = session == nil
        self.decoder = decoder
        self.retryDelays = retryDelays
        self.maxResponseBytes = maxResponseBytes
        self.token = token
    }

    deinit {
        if ownsSession { session.finishTasksAndInvalidate() }
    }

    /// Ephemeral, 20 s per request, fails at once when offline, no cookies, no cache.
    public static func defaultConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        #if !canImport(FoundationNetworking)
        // Read-only (and always false) in swift-corelibs-foundation.
        configuration.waitsForConnectivity = false
        #endif
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return configuration
    }

    public func send<E: APIEndpoint>(_ endpoint: E) async throws -> E.Response {
        let request = try await makeRequest(for: endpoint)
        var attempt = 0
        while true {
            do {
                return try await perform(request, as: E.Response.self)
            } catch {
                guard endpoint.method == .get, error.isRetryable, attempt < retryDelays.count else { throw error }
                do {
                    try await Task.sleep(for: retryDelays[attempt])
                } catch {
                    throw NetworkError.cancelled
                }
                attempt += 1
            }
        }
    }

    // MARK: - Request and answer

    private func makeRequest<E: APIEndpoint>(for endpoint: E) async throws(NetworkError) -> URLRequest {
        var request = URLRequest(url: server.url(for: endpoint.path, query: endpoint.query))
        request.httpMethod = endpoint.method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body = endpoint.body {
            do {
                request.httpBody = try JSONEncoder().encode(body)
            } catch {
                throw .encoding(String(describing: error))
            }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if endpoint.requiresAuth, let token = await token(), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if Task.isCancelled { throw .cancelled }
        return request
    }

    private func perform<Response: Decodable>(_ request: URLRequest, as type: Response.Type) async throws(NetworkError) -> Response {
        let data: Data
        let response: URLResponse
        do {
            #if canImport(FoundationNetworking)
            (data, response) = try await session.data(for: request)
            #else
            // Per task too, so a session passed in by the app never follows a redirect either.
            if let limit = maxResponseBytes {
                (data, response) = try await load(request, limit: limit)
            } else {
                (data, response) = try await session.data(for: request, delegate: RefuseRedirects())
            }
            #endif
        } catch {
            throw NetworkError(error)
        }
        guard let http = response as? HTTPURLResponse else { throw .notASyloServer }
        let isJSON = Self.isJSON(data, contentType: Self.header("Content-Type", in: http))

        guard (200..<300).contains(http.statusCode) else {
            throw NetworkError.from(status: http.statusCode, body: data, isJSON: isJSON)
        }
        if let empty = EmptyResponse() as? Response { return empty }
        guard isJSON else { throw .notASyloServer }
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw NetworkError(error)
        }
    }

    #if !canImport(FoundationNetworking)
    /// The answer, read as it arrives and given up on at `limit` bytes (a declared length over it
    /// is refused before any byte is read).
    private func load(_ request: URLRequest, limit: Int) async throws -> (Data, URLResponse) {
        let (bytes, response) = try await session.bytes(for: request, delegate: RefuseRedirects())
        guard response.expectedContentLength <= Int64(limit) else { throw NetworkError.notASyloServer }
        var data = Data()
        for try await byte in bytes {
            data.append(byte)
            guard data.count <= limit else { throw NetworkError.notASyloServer }
        }
        return (data, response)
    }
    #endif

    private static func header(_ name: String, in response: HTTPURLResponse) -> String? {
        for (key, value) in response.allHeaderFields {
            if let key = key as? String, key.caseInsensitiveCompare(name) == .orderedSame {
                return value as? String
            }
        }
        return nil
    }

    /// JSON by its `Content-Type`, or by its first character when there is none; never a page
    /// starting with `<`, whatever it claims to be.
    static func isJSON(_ data: Data, contentType: String?) -> Bool {
        let first = data.first { !Self.whitespace.contains($0) }
        if first == UInt8(ascii: "<") { return false }
        if let contentType, !contentType.isEmpty { return contentType.lowercased().contains("json") }
        return first == UInt8(ascii: "{") || first == UInt8(ascii: "[")
    }

    private static let whitespace: Set<UInt8> = [0x20, 0x09, 0x0A, 0x0D]
}

/// Refuses every redirect: the API never redirects, and following one would send the
/// `Authorization` header to wherever it points. The 3xx answer becomes ``NetworkError/notASyloServer``.
final class RefuseRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    #if canImport(FoundationNetworking)
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
    #else
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
    #endif
}
