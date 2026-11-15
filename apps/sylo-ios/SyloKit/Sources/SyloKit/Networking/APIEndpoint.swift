import Foundation

/// The HTTP methods the Sylo API uses. Only `GET` is ever retried.
public enum HTTPMethod: String, Sendable {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case patch = "PATCH"
    case delete = "DELETE"
}

/// One call to the Sylo API: where it goes, what it sends and what it answers, so the client
/// stays generic and each call is a small value that can be tested on its own.
public protocol APIEndpoint: Sendable {
    associatedtype Response: Decodable & Sendable

    /// The path below the server address, percent-encoded (ids as encoded path segments).
    var path: String { get }
    var method: HTTPMethod { get }
    var query: [URLQueryItem] { get }
    /// The query exactly as it is to be sent, already percent-encoded; replaces ``query`` when set.
    /// For a link the server wrote (``Endpoints/Resource``); nil for every other call. It must come
    /// from a parsed `URL`: invalid percent-encoding is not checked here.
    var percentEncodedQuery: String? { get }
    /// For ``APIClient/download(_:)``: refuse an answer longer than this, checked against the declared
    /// length before any byte is read. Never above the client's own limit. nil: the client's limit.
    var maxDownloadBytes: Int? { get }
    /// Sent as JSON; nil sends no body and no `Content-Type`.
    var body: (any Encodable & Sendable)? { get }
    /// Sent as it is with its own `Content-Type` (a multipart form), instead of ``body``: when both
    /// are set, this one wins and ``body`` is ignored. nil for every JSON call.
    var rawBody: RawBody? { get }
    /// A file on disk sent as the body, streamed from the disk (``UploadFile``); wins over ``rawBody`` and
    /// ``body``. nil for every other call.
    var uploadFile: UploadFile? { get }
    /// For ``APIClient/download(_:)``: this answer may be as long as ``URLSessionAPIClient/largeDownloadBytes``
    /// instead of the client's usual limit (a database backup). False for every other download.
    var isLargeDownload: Bool { get }
    /// Whether the app token goes along. False only before sign-in (info, code exchange).
    var requiresAuth: Bool { get }
}

extension APIEndpoint {
    public var method: HTTPMethod { .get }
    public var query: [URLQueryItem] { [] }
    public var percentEncodedQuery: String? { nil }
    public var maxDownloadBytes: Int? { nil }
    public var body: (any Encodable & Sendable)? { nil }
    public var rawBody: RawBody? { nil }
    public var uploadFile: UploadFile? { nil }
    public var isLargeDownload: Bool { false }
    public var requiresAuth: Bool { true }
}

/// The answer of a call that returns nothing worth reading (`204 No Content`); any body is ignored.
public struct EmptyResponse: Decodable, Sendable, Equatable {
    public init() {}
    public init(from decoder: any Decoder) throws {}
}
