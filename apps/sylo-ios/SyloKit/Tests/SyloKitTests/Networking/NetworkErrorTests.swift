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
        let retryable: [NetworkError] = [.timeout, .offline, .unreachable, .server(status: 502), .server(status: 503), .server(status: 504)]
        let final: [NetworkError] = [
            .unauthorized, .forbidden, .notFound, .badRequest(message: nil), .rateLimited, .server(status: 500),
            .http(status: 409), .notASyloServer, .cancelled, .decoding("x"), .invalidURL, .secureConnectionFailed,
            .transport(code: -1),
        ]
        for error in retryable { #expect(error.isRetryable, "\(error)") }
        for error in final { #expect(!error.isRetryable, "\(error)") }
    }

    @Test("Every error has a short message for people")
    func messages() {
        let all: [NetworkError] = [
            .unauthorized, .forbidden, .notFound, .badRequest(message: "x"), .badRequest(message: "invalid_grant"),
            .rateLimited, .server(status: 500), .http(status: 409), .notASyloServer, .timeout, .offline,
            .unreachable, .secureConnectionFailed, .cancelled, .decoding("x"), .invalidURL, .transport(code: -1),
        ]
        for error in all {
            #expect(!error.userMessage.isEmpty)
            #expect(error.userMessage.count < 120, "\(error): \(error.userMessage)")
        }
        #expect(NetworkError.unreachable.userMessage == "Can't reach this server. Check the address and your connection.")
        #expect(NetworkError.badRequest(message: "invalid_grant").userMessage != NetworkError.badRequest(message: nil).userMessage)
    }
}
