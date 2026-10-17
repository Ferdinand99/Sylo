import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Everything a call to a Sylo server can fail with, in terms the app acts on: `.unauthorized`
/// signs the person out, `.cancelled` is silent, the rest show ``userMessage``.
public enum NetworkError: Error, Sendable, Equatable {
    /// 401: the token is missing, expired or revoked. Sign in again.
    case unauthorized
    /// 403: signed in, but not allowed (not a manager of that server, or operators only).
    case forbidden
    /// 404: unknown server or module, a device already signed out, or a Sylo too old for the app.
    case notFound
    /// 400, with the server's `error` field (`invalid_grant` for a failed code exchange).
    case badRequest(message: String?)
    /// 429: too many requests from this address.
    case rateLimited
    /// 5xx.
    case server(status: Int)
    /// Any other status the app does not handle on its own (for example 409).
    case http(status: Int)
    /// An HTML page, a redirect or other non-JSON where Sylo would answer JSON: a wrong address,
    /// or a proxy login in front of the API paths.
    case notASyloServer
    case timeout
    case offline
    /// The host could not be found or refused the connection.
    case unreachable
    /// TLS failed: a bad, expired or untrusted certificate.
    case secureConnectionFailed
    case cancelled
    /// JSON that does not have the expected shape.
    case decoding(String)
    /// The request body could not be encoded (a bug in the app).
    case encoding(String)
    case invalidURL
    /// Another `URLError`, by its code.
    case transport(code: Int)

    /// Maps any error from a request to a `NetworkError`.
    public init(_ error: any Error) {
        switch error {
        case let error as NetworkError: self = error
        case is CancellationError: self = .cancelled
        case let error as URLError: self = Self.from(error.code)
        case let error as DecodingError: self = .decoding(Self.describe(error))
        default: self = .transport(code: (error as NSError).code)
        }
    }

    /// Whether trying the same idempotent request again soon might work.
    public var isRetryable: Bool {
        switch self {
        case .timeout, .offline, .unreachable: true
        case .server(let status): [502, 503, 504].contains(status)
        default: false
        }
    }

    /// A short sentence for the person: what happened and what to do.
    public var userMessage: String {
        switch self {
        case .unauthorized: "You've been signed out. Sign in again to continue."
        case .forbidden: "You don't have access to this. Ask the server's owner if you think you should."
        case .notFound: "That's no longer there. Refresh and try again."
        case .badRequest(let message) where message == "invalid_grant":
            "Sign-in didn't finish. Try signing in again."
        case .badRequest: "The server couldn't do that. Refresh and try again."
        case .rateLimited: "Too many requests. Wait a minute, then try again."
        case .server: "The server ran into a problem. Try again in a moment."
        case .http(let status): "Something went wrong (error \(status)). Try again."
        case .notASyloServer: "This address doesn't answer like a Sylo server. Check the address."
        case .timeout: "The server took too long to answer. Try again."
        case .offline: "You're offline. Check your connection and try again."
        case .unreachable: "Can't reach this server. Check the address and your connection."
        case .secureConnectionFailed: "Can't connect securely to this server. Check its HTTPS certificate."
        case .cancelled: "Cancelled."
        case .decoding: "The server sent an answer this app doesn't understand. Update the app."
        case .encoding: "Something went wrong in the app. Try again."
        case .invalidURL: "That server address isn't valid. Check it and try again."
        case .transport: "Can't connect to this server right now. Try again."
        }
    }

    // MARK: - Mapping

    private static func from(_ code: URLError.Code) -> NetworkError {
        switch code {
        case .timedOut: .timeout
        case .notConnectedToInternet, .networkConnectionLost: .offline
        case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed: .unreachable
        case .cancelled: .cancelled
        case .badURL, .unsupportedURL: .invalidURL
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
             .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot, .clientCertificateRejected,
             .clientCertificateRequired:
            .secureConnectionFailed
        case .badServerResponse, .cannotParseResponse, .cannotDecodeContentData, .cannotDecodeRawData,
             .httpTooManyRedirects, .redirectToNonExistentLocation:
            .notASyloServer
        default: .transport(code: code.rawValue)
        }
    }

    /// The status of an HTTP answer that is not a success, as an error.
    static func from(status: Int, body: Data, isJSON: Bool) -> NetworkError {
        // Sylo answers 401 and 403 as JSON; an HTML page is a proxy's login in the way, not a sign-out.
        if status == 401 || status == 403, !body.isEmpty, !isJSON { return .notASyloServer }
        switch status {
        case 300..<400: return .notASyloServer
        case 401: return .unauthorized
        case 403: return .forbidden
        case 400: return .badRequest(message: isJSON ? serverMessage(in: body) : nil)
        case 404: return .notFound
        case 429: return .rateLimited
        case 500..<600: return .server(status: status)
        default: return .http(status: status)
        }
    }

    private struct ErrorBody: Decodable { let error: String? }

    private static func serverMessage(in body: Data) -> String? {
        (try? JSONDecoder().decode(ErrorBody.self, from: body))?.error
    }

    private static func describe(_ error: DecodingError) -> String {
        let context: DecodingError.Context
        var path: [any CodingKey]
        switch error {
        case let .keyNotFound(key, c): context = c; path = c.codingPath + [key]
        case let .typeMismatch(_, c), let .valueNotFound(_, c), let .dataCorrupted(c): context = c; path = c.codingPath
        @unknown default: return String(describing: error)
        }
        let where_ = path.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: ".")
        return where_.isEmpty ? context.debugDescription : "\(where_): \(context.debugDescription)"
    }
}
