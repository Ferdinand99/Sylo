import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Everything a call to a Sylo server can fail with, in terms the app acts on: `.unauthorized`
/// signs the person out, `.cancelled` is silent, the rest show ``userMessage``.
public enum NetworkError: Error, Sendable, Equatable {
    /// 401: the token is missing, expired or revoked. Sign in again.
    case unauthorized
    /// 403: signed in, but not allowed (not a manager of that server, or operators only), with the
    /// server's text when it sent one. Write the case without a message as ``forbidden``.
    case forbidden(message: String?)
    /// 404: unknown server or module, a device already signed out, or a Sylo too old for the app,
    /// with the server's text when it sent one. Write the case without a message as ``notFound``.
    case notFound(message: String?)
    /// 400, with the server's `error` field (`invalid_grant` for a failed code exchange).
    case badRequest(message: String?)
    /// 429: too many requests from this address.
    case rateLimited
    /// 413, or a download that is longer than the app is willing to keep, with the server's text
    /// when it sent one. Write the case without a message as ``tooLarge``.
    case tooLarge(message: String?)
    /// 5xx. The status compares and matches as a number (`.server(status: 502)`); the server's text,
    /// when there was one, travels inside it (see ``serverMessage``).
    case server(status: HTTPStatus)
    /// Any other status the app does not handle on its own (for example 409), matched like
    /// ``server(status:)``.
    case http(status: HTTPStatus)
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

    // The cases that carry the server's text can still be written, compared and matched without it:
    // `throw NetworkError.forbidden`, `error == .notFound` and `case .forbidden:` all work, and two
    // errors are equal whatever text they carry.
    public static var forbidden: NetworkError { .forbidden(message: nil) }
    public static var notFound: NetworkError { .notFound(message: nil) }
    public static var tooLarge: NetworkError { .tooLarge(message: nil) }

    public static func == (lhs: NetworkError, rhs: NetworkError) -> Bool {
        switch (lhs, rhs) {
        case (.unauthorized, .unauthorized), (.forbidden, .forbidden), (.notFound, .notFound),
             (.rateLimited, .rateLimited), (.tooLarge, .tooLarge), (.notASyloServer, .notASyloServer),
             (.timeout, .timeout), (.offline, .offline), (.unreachable, .unreachable),
             (.secureConnectionFailed, .secureConnectionFailed), (.cancelled, .cancelled),
             (.invalidURL, .invalidURL):
            return true
        case let (.badRequest(a), .badRequest(b)): return a == b
        case let (.server(a), .server(b)): return a == b
        case let (.http(a), .http(b)): return a == b
        case let (.decoding(a), .decoding(b)): return a == b
        case let (.encoding(a), .encoding(b)): return a == b
        case let (.transport(a), .transport(b)): return a == b
        default: return false
        }
    }

    /// What the server said about a failed call (its JSON `error` or `message` text), or nil when it
    /// said nothing or the answer was not JSON.
    public var serverMessage: String? {
        switch self {
        case .badRequest(let message), .forbidden(let message), .notFound(let message), .tooLarge(let message):
            return message
        case .server(let status), .http(let status):
            return status.message
        default:
            return nil
        }
    }

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
        case .server(let status): [502, 503, 504].contains(status.code)
        default: false
        }
    }

    /// A short sentence for the person: what happened and what to do.
    public var userMessage: String {
        // The server's own words say more than ours; `invalid_grant` is a code, not words.
        if let text = serverMessage, !text.isEmpty, text != "invalid_grant" { return text }
        switch self {
        case .unauthorized: "You've been signed out. Sign in again to continue."
        case .forbidden: "You don't have access to this. Ask the server's owner if you think you should."
        case .notFound: "That's no longer there. Refresh and try again."
        case .badRequest(let message) where message == "invalid_grant":
            "Sign-in didn't finish. Try signing in again."
        case .badRequest: "The server couldn't do that. Refresh and try again."
        case .rateLimited: "Too many requests. Wait a minute, then try again."
        case .tooLarge: "That file is too large."
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
        let message = isJSON ? serverMessage(in: body) : nil
        switch status {
        case 300..<400: return .notASyloServer
        case 401: return .unauthorized
        case 403: return .forbidden(message: message)
        case 400: return .badRequest(message: message)
        case 404: return .notFound(message: message)
        case 413: return .tooLarge(message: message)
        case 429: return .rateLimited
        case 500..<600: return .server(status: HTTPStatus(status, message: message))
        default: return .http(status: HTTPStatus(status, message: message))
        }
    }

    private struct ErrorBody: Decodable {
        let error: String?
        let message: String?

        private enum CodingKeys: String, CodingKey { case error, message }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            // A key that is not text (an error object) is not a message; it must not lose the other.
            error = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? nil
            message = (try? c.decodeIfPresent(String.self, forKey: .message)) ?? nil
        }
    }

    /// The `error` (or else `message`) text of a JSON error answer: trimmed, never empty, cut at 500
    /// characters.
    private static func serverMessage(in body: Data) -> String? {
        guard let parsed = try? JSONDecoder().decode(ErrorBody.self, from: body) else { return nil }
        for candidate in [parsed.error, parsed.message] {
            let text = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !text.isEmpty { return String(text.prefix(500)) }
        }
        return nil
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

/// An HTTP status that also carries what the server said about it. It reads as a number: it is
/// written with an integer literal (`.http(status: 409)`), compares equal to another status with the
/// same code whatever text each carries, and prints as the code.
public struct HTTPStatus: Sendable, Hashable, Comparable, ExpressibleByIntegerLiteral, CustomStringConvertible {
    public let code: Int
    /// The server's JSON `error` or `message` text, nil when there was none. Not part of equality.
    public let message: String?

    public init(_ code: Int, message: String? = nil) {
        self.code = code
        self.message = message
    }

    public init(integerLiteral value: Int) {
        self.init(value)
    }

    public static func == (lhs: HTTPStatus, rhs: HTTPStatus) -> Bool { lhs.code == rhs.code }
    public static func < (lhs: HTTPStatus, rhs: HTTPStatus) -> Bool { lhs.code < rhs.code }
    public func hash(into hasher: inout Hasher) { hasher.combine(code) }
    public var description: String { String(code) }
}
