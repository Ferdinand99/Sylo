import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import SyloKit

/// A signed-in GET used only to look at headers.
private struct ProbeGet: APIEndpoint {
    typealias Response = OKResponse
    var path = "/api/v2/probe"
    var requiresAuth = true
}

/// A POST with a body.
private struct ProbePost: APIEndpoint {
    struct Body: Encodable, Sendable { let enabled: Bool }
    typealias Response = OKResponse
    var path = "/api/v2/probe"
    var method: HTTPMethod = .post
    var body: (any Encodable & Sendable)? = Body(enabled: true)
}

@Suite("URLSessionAPIClient", .serialized)
struct APIClientTests {
    private let mock = MockURLProtocol.state

    private func client(
        _ server: String = "https://example.com/sylo", token: String? = "sylo_secret"
    ) throws -> URLSessionAPIClient {
        URLSessionAPIClient(
            server: try ServerURL(server), session: MockURLProtocol.session(), decoder: JSONDecoder(),
            retryDelays: [.zero, .zero], token: { token })
    }

    // MARK: Requests

    @Test("A signed-in GET sends Accept and Bearer, no Content-Type, to the joined URL")
    func signedInGet() async throws {
        mock.reset([.json(200, Fixtures.servers)])
        let list = try await client().send(Endpoints.Servers())
        #expect(list.servers.count == 3)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds")
        #expect(request.method == "GET")
        #expect(request.header("Accept") == "application/json")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
        #expect(request.header("Content-Type") == nil)
        #expect(request.header("Cookie") == nil)
        #expect(request.body == nil || request.body?.isEmpty == true)
    }

    @Test("A public endpoint never sends the token")
    func publicEndpoint() async throws {
        mock.reset([.json(200, Fixtures.info)])
        let info = try await client().send(Endpoints.ServerInfo())
        #expect(info.isSylo)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/mobile/info")
        #expect(request.header("Authorization") == nil)
    }

    @Test("No token, no Authorization header")
    func noToken() async throws {
        mock.reset([.json(200, Fixtures.ok)])
        _ = try await client(token: nil).send(ProbeGet())
        #expect(mock.requests.first?.header("Authorization") == nil)
    }

    @Test("A POST with a body sends it as JSON with Content-Type")
    func postWithBody() async throws {
        mock.reset([.json(200, Fixtures.toggle)])
        let result = try await client("https://example.com").send(
            Endpoints.SetModule(server: "fluxer:223456789012345678", module: "welcome", enabled: true))
        #expect(result.isEnabled)
        let request = try #require(mock.requests.first)
        #expect(request.method == "POST")
        #expect(request.url.absoluteString == "https://example.com/api/v2/guilds/fluxer%3A223456789012345678/modules/welcome")
        #expect(request.header("Content-Type") == "application/json")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
        let body = try #require(request.body)
        #expect(try JSONDecoder().decode([String: Bool].self, from: body) == ["enabled": true])
    }

    @Test("The code exchange decodes the token grant")
    func exchange() async throws {
        mock.reset([.json(200, Fixtures.token)])
        let grant = try await client(token: nil).send(Endpoints.ExchangeCode(code: "c", verifier: "v", deviceName: "iPhone"))
        #expect(grant.account.name == "ferdi")
        let request = try #require(mock.requests.first)
        #expect(request.header("Authorization") == nil)
        let body = try #require(request.body)
        #expect(try JSONDecoder().decode([String: String].self, from: body) == ["code": "c", "verifier": "v", "deviceName": "iPhone"])
    }

    @Test("Sign out answers 204 with no body")
    func signOut() async throws {
        mock.reset([.response(status: 204, headers: [:])])
        let result = try await client().send(Endpoints.SignOut())
        #expect(result == EmptyResponse())
        #expect(mock.requests.first?.method == "DELETE")
        #expect(mock.requests.first?.header("Authorization") == "Bearer sylo_secret")
    }

    // MARK: Status codes and bodies

    @Test("Maps status codes to errors", arguments: [
        (401, #"{"error":"Not signed in, or the token is no longer valid."}"#, NetworkError.unauthorized),
        (403, #"{"error":"You do not manage this server."}"#, .forbidden),
        (404, #"{"error":"Unknown or unavailable server"}"#, .notFound),
        (400, #"{"error":"invalid_grant"}"#, .badRequest(message: "invalid_grant")),
        (400, "", .badRequest(message: nil)),
        (409, #"{"error":"You can't disconnect your only sign-in."}"#, .http(status: 409)),
        (500, #"{"error":"boom"}"#, .server(status: 500)),
        (418, "", .http(status: 418)),
    ])
    func statusCodes(status: Int, body: String, expected: NetworkError) async throws {
        mock.reset([.json(status, body)])
        await #expect(throws: expected) { try await client().send(ProbePost()) }
    }

    @Test("A rate limit is text/plain on the server and still .rateLimited")
    func rateLimited() async throws {
        mock.reset([.response(status: 429, headers: ["Content-Type": "text/plain"], body: Data("Too many requests".utf8))])
        await #expect(throws: NetworkError.rateLimited) { try await client().send(ProbeGet()) }
    }

    @Test("An HTML page where JSON was expected is not a Sylo server")
    func htmlOK() async throws {
        let html = Data("<!doctype html><html><body>Sign in to Pangolin</body></html>".utf8)
        mock.reset([.response(status: 200, headers: ["Content-Type": "text/html; charset=utf-8"], body: html)])
        await #expect(throws: NetworkError.notASyloServer) { try await client().send(Endpoints.ServerInfo()) }
    }

    @Test("HTML without a Content-Type is not a Sylo server either")
    func htmlNoContentType() async throws {
        mock.reset([.response(status: 200, headers: [:], body: Data("  <html></html>".utf8))])
        await #expect(throws: NetworkError.notASyloServer) { try await client().send(Endpoints.ServerInfo()) }
    }

    @Test("A proxy's HTML login page on 401 is not taken as being signed out")
    func html401() async throws {
        let html = Data("<html>Log in</html>".utf8)
        mock.reset([.response(status: 401, headers: ["Content-Type": "text/html"], body: html)])
        await #expect(throws: NetworkError.notASyloServer) { try await client().send(ProbeGet()) }
    }

    @Test("A redirect answer is not a Sylo API answer")
    func redirect() async throws {
        mock.reset([.response(status: 302, headers: ["Location": "https://login.example.com/"])])
        await #expect(throws: NetworkError.notASyloServer) { try await client().send(ProbeGet()) }
    }

    @Test("JSON of the wrong shape is a decoding error")
    func wrongShape() async throws {
        mock.reset([.json(200, #"{"guild":{"id":1}}"#)])
        await #expect {
            try await client().send(Endpoints.Overview(server: "1"))
        } throws: { error in
            guard case .decoding = error as? NetworkError else { return false }
            return true
        }
    }

    @Test("Transport failures map to NetworkError")
    func transport() async throws {
        mock.reset([.failure(.timedOut)])
        await #expect(throws: NetworkError.timeout) { try await client().send(Endpoints.SignOut()) }
        mock.reset([.failure(.cannotFindHost)])
        await #expect(throws: NetworkError.unreachable) { try await client().send(Endpoints.SignOut()) }
    }

    @Test("A cancelled task ends with .cancelled")
    func cancelled() async throws {
        mock.reset([.json(200, Fixtures.ok)])
        let client = URLSessionAPIClient(
            server: try ServerURL("https://example.com"), session: MockURLProtocol.session(), decoder: JSONDecoder(),
            retryDelays: [], token: {
                withUnsafeCurrentTask { $0?.cancel() }
                return "sylo_secret"
            })
        // The token closure runs in the task that sends, so this cancels only that child task.
        let task = Task { try await client.send(ProbeGet()) }
        await #expect(throws: NetworkError.cancelled) { try await task.value }
        #expect(mock.requests.isEmpty)
    }

    // MARK: Retries

    @Test("A GET is retried on a transient failure, at most twice")
    func retriesGet() async throws {
        mock.reset([.json(503, ""), .failure(.timedOut), .json(200, Fixtures.servers)])
        let list = try await client().send(Endpoints.Servers())
        #expect(list.servers.count == 3)
        #expect(mock.requests.count == 3)

        mock.reset([.json(503, "")])
        await #expect(throws: NetworkError.server(status: 503)) { try await client().send(Endpoints.Servers()) }
        #expect(mock.requests.count == 3)
    }

    @Test("A GET is not retried on a final error")
    func noRetryOnFinal() async throws {
        mock.reset([.json(404, #"{"error":"Unknown or unavailable server"}"#)])
        await #expect(throws: NetworkError.notFound) { try await client().send(Endpoints.Overview(server: "1")) }
        #expect(mock.requests.count == 1)
    }

    @Test("POST and DELETE are never retried")
    func noRetryOnWrites() async throws {
        mock.reset([.json(503, "")])
        await #expect(throws: NetworkError.server(status: 503)) {
            try await client().send(Endpoints.SetModule(server: "1", module: "welcome", enabled: true))
        }
        #expect(mock.requests.count == 1)

        mock.reset([.failure(.timedOut)])
        await #expect(throws: NetworkError.timeout) { try await client().send(Endpoints.SignOut()) }
        #expect(mock.requests.count == 1)
    }

    @Test("The default retry backoff is 0.5 s, then 1 s")
    func backoff() throws {
        #expect(URLSessionAPIClient.defaultRetryDelays == [.milliseconds(500), .seconds(1)])
    }

    // MARK: Session

    @Test("The default session is ephemeral, 20 s, cookie-free and does not wait for a connection")
    func defaultConfiguration() {
        let configuration = URLSessionAPIClient.defaultConfiguration()
        #expect(configuration.timeoutIntervalForRequest == 20)
        #expect(configuration.httpShouldSetCookies == false)
        #expect(configuration.httpCookieAcceptPolicy == .never)
        #expect(configuration.httpCookieStorage == nil)
        #expect(configuration.urlCache == nil)
        #if !canImport(FoundationNetworking)
        #expect(configuration.waitsForConnectivity == false)
        #endif
    }

    @Test("The default session refuses redirects, so the token never follows one")
    func refusesRedirects() async throws {
        let delegate = RefuseRedirects()
        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(with: URL(string: "https://example.com/api/v2/guilds")!)
        let response = HTTPURLResponse(
            url: URL(string: "https://example.com/api/v2/guilds")!, statusCode: 302, httpVersion: "HTTP/1.1",
            headerFields: ["Location": "https://evil.example/"])!
        let followed = Box<URLRequest?>(URLRequest(url: URL(string: "https://placeholder.invalid")!))
        delegate.urlSession(session, task: task, willPerformHTTPRedirection: response,
                            newRequest: URLRequest(url: URL(string: "https://evil.example/")!)) { followed.value = $0 }
        #expect(followed.value == nil)
        task.cancel()
        session.invalidateAndCancel()
    }

    // MARK: Limits and retries

    #if !canImport(FoundationNetworking)
    private func limited(_ bytes: Int?, retryDelays: [Duration]? = nil) throws -> URLSessionAPIClient {
        URLSessionAPIClient(
            server: try ServerURL("https://example.com"), session: MockURLProtocol.session(),
            retryDelays: retryDelays ?? [.zero, .zero], maxResponseBytes: bytes, token: { "sylo_secret" })
    }

    @Test("An answer over the limit is refused, one within it is read")
    func responseLimit() async throws {
        mock.reset([.json(200, Fixtures.ok)])
        let response = try await limited(100).send(ProbeGet())
        #expect(response == OKResponse(ok: true))

        mock.reset([.json(200, #"{"ok":true,"padding":"\#(String(repeating: "x", count: 500))"}"#)])
        await #expect(throws: NetworkError.notASyloServer) { try await limited(100).send(ProbeGet()) }

        // Without a limit it is read as before.
        mock.reset([.json(200, #"{"ok":true,"padding":"\#(String(repeating: "x", count: 500))"}"#)])
        _ = try await limited(nil).send(ProbeGet())
    }
    #endif

    @Test("A GET is tried once when no retries are asked for, and again when they are")
    func retries() async throws {
        mock.reset([.json(503, "{}")])
        await #expect(throws: NetworkError.server(status: 503)) {
            try await URLSessionAPIClient(
                server: try ServerURL("https://example.com"), session: MockURLProtocol.session(), retryDelays: [],
                token: { "sylo_secret" }
            ).send(ProbeGet())
        }
        #expect(mock.requests.count == 1)

        mock.reset([.json(503, "{}")])
        await #expect(throws: NetworkError.server(status: 503)) {
            try await URLSessionAPIClient(
                server: try ServerURL("https://example.com"), session: MockURLProtocol.session(),
                retryDelays: [.zero, .zero], token: { "sylo_secret" }
            ).send(ProbeGet())
        }
        #expect(mock.requests.count == 3)
    }
}

private final class Box<Value>: @unchecked Sendable {
    var value: Value
    init(_ value: Value) { self.value = value }
}
