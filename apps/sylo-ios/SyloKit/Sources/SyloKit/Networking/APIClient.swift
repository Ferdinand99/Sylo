import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Sends ``APIEndpoint`` calls to one Sylo server. A protocol so app models can be tested with a
/// stub instead of a network.
public protocol APIClient: Sendable {
    /// Sends the call and decodes its answer. Throws ``NetworkError`` only.
    func send<E: APIEndpoint>(_ endpoint: E) async throws -> E.Response

    /// Sends the call and keeps its answer as a file, whatever it is (CSV, JSON, HTML, a picture):
    /// the answer is not checked for JSON and not decoded, and is written to disk as it arrives. An
    /// error status still throws the same ``NetworkError`` as ``send(_:)``; an answer over the
    /// download limit throws ``NetworkError/tooLarge``. The endpoint's `Response` is not read, so it
    /// must be ``EmptyResponse`` (see ``Endpoints/Resource``). Throws ``NetworkError`` only.
    ///
    /// A client that downloads must implement this: the default answer is a 404, which is only right
    /// for a client that has no files at all (a stub).
    func download<E: APIEndpoint>(_ endpoint: E) async throws -> DownloadedFile where E.Response == EmptyResponse

    /// Sends the call like ``send(_:)``, and reports how much of an ``APIEndpoint/uploadFile`` has gone
    /// out: `progress(bytesSent, bytesExpected)`, called on a background queue. Cancelling the task stops
    /// the transfer. A call without an upload file is a plain `send`, and a client that does not report
    /// progress (a stub) answers like `send` too.
    func upload<E: APIEndpoint>(
        _ endpoint: E, progress: (@Sendable (Int64, Int64) -> Void)?
    ) async throws -> E.Response
}

extension APIClient {
    public func upload<E: APIEndpoint>(
        _ endpoint: E, progress: (@Sendable (Int64, Int64) -> Void)?
    ) async throws -> E.Response {
        try await send(endpoint)
    }

    /// A client that cannot download answers like a server that has no such file.
    public func download<E: APIEndpoint>(_ endpoint: E) async throws -> DownloadedFile where E.Response == EmptyResponse {
        throw NetworkError.notFound
    }
}

/// The ``APIClient`` for a real server, over `URLSession`.
///
/// Sends JSON with `Authorization: Bearer` only where the endpoint needs it, never follows a
/// redirect (the token must not go to another host), stores no cookies and no cache, and retries
/// only `GET`s, at most twice, on transient failures. It never logs a request or an answer.
public final class URLSessionAPIClient: APIClient {
    /// 0.5 s, then 1 s.
    static let defaultRetryDelays: [Duration] = [.milliseconds(500), .seconds(1)]
    /// The longest download kept (an application export or a ticket transcript is far smaller).
    public static let defaultMaxDownloadBytes = 32 * 1024 * 1024
    /// The longest download kept for an endpoint that says ``APIEndpoint/isLargeDownload`` (a database
    /// backup is bigger than any export).
    public static let largeDownloadBytes = 512 * 1024 * 1024
    /// A request with a file body waits this long for the server to answer after the last byte (a
    /// backup is checked before the answer), instead of the usual 20 s.
    static let uploadTimeout: TimeInterval = 120

    public let server: ServerURL
    private let token: @Sendable () async -> String?
    private let session: URLSession
    private let ownsSession: Bool
    private let decoder: JSONDecoder
    private let retryDelays: [Duration]
    private let maxResponseBytes: Int?
    private let maxDownloadBytes: Int
    private let downloadDirectory: URL?

    /// - Parameters:
    ///   - session: nil for the default session (``defaultConfiguration()``, redirects refused).
    ///   - retryDelays: how long to wait before each retry of a `GET` (nil: 0.5 s, then 1 s); empty for none.
    ///   - maxResponseBytes: refuse an answer longer than this (nil: no limit). The body is read
    ///     as it arrives and dropped at the limit, so a huge answer never sits in memory.
    ///   - maxDownloadBytes: refuse a ``download(_:)`` longer than this.
    ///   - downloadDirectory: where downloads are written, each in a folder of its own (nil: the
    ///     system's temporary folder).
    ///   - token: the current app token, asked for once per call; nil when signed out.
    public convenience init(
        server: ServerURL, session: URLSession? = nil, decoder: JSONDecoder = JSONDecoder(),
        retryDelays: [Duration]? = nil, maxResponseBytes: Int? = nil,
        maxDownloadBytes: Int = URLSessionAPIClient.defaultMaxDownloadBytes, downloadDirectory: URL? = nil,
        token: @escaping @Sendable () async -> String?
    ) {
        self.init(server: server, session: session, decoder: decoder, retryDelays: retryDelays ?? Self.defaultRetryDelays,
                  maxResponseBytes: maxResponseBytes, maxDownloadBytes: maxDownloadBytes,
                  downloadDirectory: downloadDirectory, token: token)
    }

    init(
        server: ServerURL, session: URLSession?, decoder: JSONDecoder, retryDelays: [Duration],
        maxResponseBytes: Int?, maxDownloadBytes: Int, downloadDirectory: URL?,
        token: @escaping @Sendable () async -> String?
    ) {
        self.server = server
        self.session = session ?? URLSession(
            configuration: Self.defaultConfiguration(), delegate: RefuseRedirects(), delegateQueue: nil)
        self.ownsSession = session == nil
        self.decoder = decoder
        self.retryDelays = retryDelays
        self.maxResponseBytes = maxResponseBytes
        self.maxDownloadBytes = maxDownloadBytes
        self.downloadDirectory = downloadDirectory
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
        if endpoint.uploadFile != nil { return try await upload(endpoint, progress: nil) }
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

    /// Sends an ``APIEndpoint/uploadFile`` straight from the disk (the file is never read into memory)
    /// as `POST`/`PUT` with its own `Content-Type`, never retried, and decodes the JSON answer.
    /// A file longer than the endpoint's limit is refused with ``NetworkError/tooLarge`` before anything
    /// is sent; one that cannot be read is a ``NetworkError/transport(code:)`` error.
    public func upload<E: APIEndpoint>(
        _ endpoint: E, progress: (@Sendable (Int64, Int64) -> Void)?
    ) async throws -> E.Response {
        guard let file = endpoint.uploadFile else { return try await send(endpoint) }
        try Self.checkUpload(file)
        var request = try await makeRequest(for: endpoint)
        request.timeoutInterval = Self.uploadTimeout
        let data: Data
        let response: URLResponse
        do {
            #if canImport(FoundationNetworking)
            request.httpBody = try Data(contentsOf: file.fileURL)
            (data, response) = try await session.data(for: request)
            #else
            (data, response) = try await session.upload(
                for: request, fromFile: file.fileURL, delegate: UploadDelegate(progress: progress))
            #endif
        } catch {
            throw NetworkError(error)
        }
        return try answer(data, response, as: E.Response.self)
    }

    /// The file's size on disk against the endpoint's limit.
    static func checkUpload(_ file: UploadFile) throws(NetworkError) {
        let size: Int64
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: file.fileURL.path)
            size = (attributes[.size] as? NSNumber)?.int64Value ?? -1
        } catch {
            throw .transport(code: CocoaError.fileReadNoSuchFile.rawValue)
        }
        guard size >= 0 else { throw .transport(code: CocoaError.fileReadUnknown.rawValue) }
        guard size <= file.maxBytes else { throw NetworkError.tooLarge }
    }

    public func download<E: APIEndpoint>(_ endpoint: E) async throws -> DownloadedFile where E.Response == EmptyResponse {
        let request = try await makeRequest(for: endpoint, accept: "*/*")
        let ceiling = endpoint.isLargeDownload ? Swift.max(maxDownloadBytes, Self.largeDownloadBytes) : maxDownloadBytes
        let limit = Swift.min(endpoint.maxDownloadBytes ?? ceiling, ceiling)
        var attempt = 0
        while true {
            do {
                return try await fetchFile(request, limit: limit)
            } catch {
                let error = NetworkError(error)
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

    // MARK: - Downloads

    /// How much of an error answer is read for its message.
    private static let errorBodyBytes = 16 * 1024
    private static let writeChunkBytes = 64 * 1024

    private func fetchFile(_ request: URLRequest, limit: Int) async throws -> DownloadedFile {
        #if canImport(FoundationNetworking)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw NetworkError.notASyloServer }
        try Self.checkDownloadStatus(http, errorBody: Data(data.prefix(Self.errorBodyBytes)))
        guard data.count <= limit else { throw NetworkError.tooLarge }
        let (name, mime) = Self.descriptor(of: http)
        return try DownloadedFile.write(data, filename: name, mimeType: mime)
        #else
        let (bytes, response) = try await session.bytes(for: request, delegate: RefuseRedirects())
        guard let http = response as? HTTPURLResponse else { throw NetworkError.notASyloServer }
        if !(200..<300).contains(http.statusCode) {
            // An error answer is a short JSON message.
            var body = Data()
            for try await byte in bytes {
                body.append(byte)
                if body.count >= Self.errorBodyBytes { break }
            }
            try Self.checkDownloadStatus(http, errorBody: body)
        }
        // Too long by its own account: stop the transfer before any byte is read or written.
        guard response.expectedContentLength <= Int64(limit) else {
            bytes.task.cancel()
            throw NetworkError.tooLarge
        }

        let (filename, mimeType) = Self.descriptor(of: http)
        let destination = try DownloadedFile.makeDestination(filename: filename, in: downloadDirectory)
        let folder = destination.deletingLastPathComponent()
        do {
            guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
                throw NetworkError.transport(code: CocoaError.fileWriteUnknown.rawValue)
            }
            let handle = try FileHandle(forWritingTo: destination)
            var total = 0
            var chunk = Data()
            chunk.reserveCapacity(Self.writeChunkBytes)
            do {
                for try await byte in bytes {
                    total += 1
                    guard total <= limit else {
                        bytes.task.cancel()
                        throw NetworkError.tooLarge
                    }
                    chunk.append(byte)
                    if chunk.count >= Self.writeChunkBytes {
                        try handle.write(contentsOf: chunk)
                        chunk.removeAll(keepingCapacity: true)
                    }
                }
                if !chunk.isEmpty { try handle.write(contentsOf: chunk) }
                try handle.close()
            } catch {
                try? handle.close()
                throw error
            }
            return DownloadedFile(fileURL: destination, filename: filename, mimeType: mimeType, byteCount: total)
        } catch {
            try? FileManager.default.removeItem(at: folder)
            throw error
        }
        #endif
    }

    /// Throws what a non-success status means; returns for a success.
    private static func checkDownloadStatus(_ http: HTTPURLResponse, errorBody: Data) throws {
        guard !(200..<300).contains(http.statusCode) else { return }
        let isJSON = Self.isJSON(errorBody, contentType: Self.header("Content-Type", in: http))
        throw NetworkError.from(status: http.statusCode, body: errorBody, isJSON: isJSON)
    }

    /// The file name (from `Content-Disposition`, else by type) and the media type of a download.
    private static func descriptor(of http: HTTPURLResponse) -> (filename: String, mimeType: String) {
        var mime = "application/octet-stream"
        if let type = Self.header("Content-Type", in: http) {
            let bare = type.split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
            if !bare.isEmpty { mime = bare }
        }
        let name = ContentDisposition.filename(from: Self.header("Content-Disposition", in: http))
            ?? DownloadedFile.fallbackFilename(mimeType: mime)
        return (name, mime)
    }

    // MARK: - Request and answer

    private func makeRequest<E: APIEndpoint>(
        for endpoint: E, accept: String = "application/json"
    ) async throws(NetworkError) -> URLRequest {
        var request = URLRequest(url: server.url(for: endpoint.path, query: endpoint.query, percentEncodedQuery: endpoint.percentEncodedQuery))
        request.httpMethod = endpoint.method.rawValue
        request.setValue(accept, forHTTPHeaderField: "Accept")
        if let file = endpoint.uploadFile {
            // The body itself is streamed from the file by `upload(_:progress:)`.
            request.setValue(file.contentType, forHTTPHeaderField: "Content-Type")
        } else if let raw = endpoint.rawBody {
            request.httpBody = raw.data
            request.setValue(raw.contentType, forHTTPHeaderField: "Content-Type")
        } else if let body = endpoint.body {
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
        return try answer(data, response, as: type)
    }

    /// What a finished call means: the decoded JSON for a success, the matching ``NetworkError`` for
    /// anything else.
    private func answer<Response: Decodable>(
        _ data: Data, _ response: URLResponse, as type: Response.Type
    ) throws(NetworkError) -> Response {
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

/// Reports an upload's progress and refuses every redirect, like ``RefuseRedirects``, for the one task
/// of a file upload.
final class UploadDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    private let progress: (@Sendable (Int64, Int64) -> Void)?

    init(progress: (@Sendable (Int64, Int64) -> Void)?) {
        self.progress = progress
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64, totalBytesExpectedToSend: Int64
    ) {
        progress?(totalBytesSent, totalBytesExpectedToSend)
    }

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
