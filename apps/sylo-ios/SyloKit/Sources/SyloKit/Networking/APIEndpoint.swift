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
    /// Sent as JSON; nil sends no body and no `Content-Type`.
    var body: (any Encodable & Sendable)? { get }
    /// Whether the app token goes along. False only before sign-in (info, code exchange).
    var requiresAuth: Bool { get }
}

extension APIEndpoint {
    public var method: HTTPMethod { .get }
    public var query: [URLQueryItem] { [] }
    public var body: (any Encodable & Sendable)? { nil }
    public var requiresAuth: Bool { true }
}

/// The answer of a call that returns nothing worth reading (`204 No Content`); any body is ignored.
public struct EmptyResponse: Decodable, Sendable, Equatable {
    public init() {}
    public init(from decoder: any Decoder) throws {}
}
