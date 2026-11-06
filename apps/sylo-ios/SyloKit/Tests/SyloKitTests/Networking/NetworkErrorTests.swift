import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import SyloKit

@Suite("NetworkError")
struct NetworkErrorTests {
    @Test("Maps URLError codes", arguments: [
        (URLError.Code.timedOut, NetworkError.timeout),
        (.notConnectedToInternet, .offline),
        (.networkConnectionLost, .offline),
        (.cannotFindHost, .unreachable),
        (.cannotConnectToHost, .unreachable),
        (.dnsLookupFailed, .unreachable),
        (.cancelled, .cancelled),
        (.badURL, .invalidURL),
        (.unsupportedURL, .invalidURL),
        (.secureConnectionFailed, .secureConnectionFailed),
        (.serverCertificateUntrusted, .secureConnectionFailed),
        (.badServerResponse, .notASyloServer),
        (.cannotDecodeContentData, .notASyloServer),
    ])
    func mapsURLErrors(code: URLError.Code, expected: NetworkError) {
        #expect(NetworkError(URLError(code)) == expected)
    }

    @Test("An unexpected URLError keeps its code")
    func otherURLError() {
        #expect(NetworkError(URLError(.resourceUnavailable)) == .transport(code: URLError.Code.resourceUnavailable.rawValue))
    }

    @Test("Task cancellation is .cancelled, and a NetworkError passes through unchanged")
    func otherErrors() {
        #expect(NetworkError(CancellationError()) == .cancelled)
        #expect(NetworkError(NetworkError.rateLimited) == .rateLimited)
        #expect(NetworkError(DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "bad"))) == .decoding("bad"))
    }

    @Test("Only transient failures are retryable")
    func retryable() {
        let retryable: [NetworkError] = [.timeout, .offline, .unreachable, .server(status: 502, message: nil), .server(status: 503, message: nil), .server(status: 504, message: nil)]
        let final: [NetworkError] = [
            .unauthorized, .forbidden(message: nil), .notFound(message: nil), .badRequest(message: nil), .rateLimited, .server(status: 500, message: nil),
            .http(status: 409, message: nil), .notASyloServer, .cancelled, .decoding("x"), .invalidURL, .secureConnectionFailed,
            .transport(code: -1),
        ]
        for error in retryable { #expect(error.isRetryable, "\(error)") }
        for error in final { #expect(!error.isRetryable, "\(error)") }
    }

    @Test("Every error has a short message for people")
    func messages() {
        let all: [NetworkError] = [
            .unauthorized, .forbidden(message: nil), .notFound(message: nil), .badRequest(message: "x"), .badRequest(message: "invalid_grant"),
            .rateLimited, .server(status: 500, message: nil), .http(status: 409, message: nil), .notASyloServer, .timeout, .offline,
            .unreachable, .secureConnectionFailed, .cancelled, .decoding("x"), .invalidURL, .transport(code: -1),
        ]
        for error in all {
            #expect(!error.userMessage.isEmpty)
            #expect(error.userMessage.count < 120, "\(error): \(error.userMessage)")
        }
        #expect(NetworkError.unreachable.userMessage == "Can't reach this server. Check the address and your connection.")
        #expect(NetworkError.badRequest(message: "invalid_grant").userMessage != NetworkError.badRequest(message: nil).userMessage)
    }
    // MARK: The server's own words

    private static func json(_ text: String) -> Data { Data(text.utf8) }

    @Test("A 403 keeps the server's reason, and detailMessage prefers it")
    func forbiddenReason() {
        let error = NetworkError.from(status: 403, body: Self.json(#"{"error":"You do not manage this server."}"#), isJSON: true)
        #expect(error == .forbidden(message: nil))
        #expect(error.serverMessage == "You do not manage this server.")
        #expect(error.detailMessage == "You do not manage this server.")
        #expect(NetworkError.forbidden(message: nil).detailMessage == NetworkError.forbidden(message: nil).userMessage)
    }

    @Test("A 404 keeps the server's reason, and detailMessage prefers it")
    func notFoundReason() {
        let error = NetworkError.from(status: 404, body: Self.json(#"{"error":"Unknown or unavailable server"}"#), isJSON: true)
        #expect(error == .notFound(message: nil))
        #expect(error.serverMessage == "Unknown or unavailable server")
        #expect(error.detailMessage == "Unknown or unavailable server")
        #expect(NetworkError.notFound(message: nil).detailMessage == NetworkError.notFound(message: nil).userMessage)
    }

    @Test("A 409 keeps the server's reason, and detailMessage prefers it")
    func conflictReason() {
        let error = NetworkError.from(status: 409, body: Self.json(#"{"error":"You can't disconnect your only sign-in."}"#), isJSON: true)
        #expect(error == .http(status: 409, message: nil))
        #expect(error.serverMessage == "You can't disconnect your only sign-in.")
        #expect(error.detailMessage == "You can't disconnect your only sign-in.")
        #expect(NetworkError.http(status: 409, message: nil).detailMessage == NetworkError.http(status: 409, message: nil).userMessage)
    }

    @Test("A 5xx keeps the server's reason, and detailMessage prefers it")
    func serverErrorReason() {
        let error = NetworkError.from(status: 500, body: Self.json(#"{"error":"Backup failed: disk full"}"#), isJSON: true)
        #expect(error == .server(status: 500, message: nil))
        #expect(error.isRetryable == false)
        #expect(error.serverMessage == "Backup failed: disk full")
        #expect(error.detailMessage == "Backup failed: disk full")
        #expect(NetworkError.server(status: 500, message: nil).detailMessage == NetworkError.server(status: 500, message: nil).userMessage)
    }

    @Test("A 400 still keeps its reason, and invalid_grant stays the sign-in text")
    func badRequestReason() {
        let error = NetworkError.from(status: 400, body: Self.json(#"{"error":"Pick a channel."}"#), isJSON: true)
        #expect(error.detailMessage == "Pick a channel.")
        let grant = NetworkError.from(status: 400, body: Self.json(#"{"error":"invalid_grant"}"#), isJSON: true)
        #expect(grant.detailMessage == grant.userMessage)
    }

    @Test("No reason without a JSON body, an error field or any text")
    func noReason() {
        for (status, body, isJSON) in [
            (403, "", true), (404, "<html>nope</html>", false), (409, "{}", true), (502, #"{"error":"  "}"#, true),
            (500, #"{"error":null}"#, true),
        ] {
            let error = NetworkError.from(status: status, body: Self.json(body), isJSON: isJSON)
            #expect(error.serverMessage == nil, "\(status) \(body)")
            #expect(error.detailMessage == error.userMessage, "\(status) \(body)")
        }
    }

    @Test("The reason does not change which error it is, but the status does")
    func equality() {
        #expect(NetworkError.http(status: 409, message: "a") == .http(status: 409, message: "b"))
        #expect(NetworkError.http(status: 409, message: "a") != .http(status: 410, message: "a"))
        #expect(NetworkError.server(status: 500, message: "a") == .server(status: 500, message: nil))
        #expect(NetworkError.forbidden(message: "a") != .notFound(message: "a"))
    }
}
