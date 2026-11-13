import Foundation
import Testing
@testable import SyloKit

@Suite("The server's text in network errors")
struct NetworkErrorMessageTests {
    private func error(_ status: Int, _ body: String, json: Bool = true) -> NetworkError {
        NetworkError.from(status: status, body: Data(body.utf8), isJSON: json)
    }

    @Test("A JSON error text is kept for 400, 403, 404, 409, 413 and 502, and is what the person reads", arguments: [
        (400, #"{"error":"Pick a form first."}"#, "Pick a form first."),
        (403, #"{"error":"You do not manage this server."}"#, "You do not manage this server."),
        (404, #"{"error":"Unknown or unavailable server"}"#, "Unknown or unavailable server"),
        (409, #"{"error":"This application was already decided."}"#, "This application was already decided."),
        (413, #"{"error":"That picture is over 2 MB."}"#, "That picture is over 2 MB."),
        (502, #"{"error":"Sylo could not post the panel."}"#, "Sylo could not post the panel."),
        (418, #"{"error":"I am a teapot"}"#, "I am a teapot"),
    ])
    func keepsText(status: Int, body: String, expected: String) {
        let failure = error(status, body)
        #expect(failure.serverMessage == expected)
        #expect(failure.userMessage == expected)
    }

    @Test("The cases other code matches on are still the same cases")
    func casesUnchanged() {
        #expect(error(403, #"{"error":"No"}"#) == .forbidden)
        #expect(error(404, #"{"error":"Gone"}"#) == .notFound)
        #expect(error(409, #"{"error":"Done"}"#) == .http(status: 409))
        #expect(error(502, #"{"error":"Bad"}"#) == .server(status: 502))
        #expect(error(413, #"{"error":"Big"}"#) == .tooLarge)
        #expect(error(400, #"{"error":"Bad input"}"#) == .badRequest(message: "Bad input"))

        // Matching, with and without the text.
        if case .server(let status) = error(502, #"{"error":"Bad"}"#) {
            #expect(status == 502)
            #expect(status.code == 502)
            #expect(status.message == "Bad")
        } else {
            Issue.record("expected .server")
        }
        switch error(404, #"{"error":"Gone"}"#) {
        case .notFound: break
        default: Issue.record("expected .notFound")
        }
        switch error(409, #"{"error":"Done"}"#) {
        case .http(status: 409): break
        default: Issue.record("expected .http(status: 409)")
        }
    }

    @Test("Without text the generic words stay")
    func genericFallback() {
        #expect(error(403, "{}").userMessage == NetworkError.forbidden.userMessage)
        #expect(error(403, "{}").serverMessage == nil)
        #expect(error(404, "").serverMessage == nil)
        #expect(error(409, #"{"error":"   "}"#).userMessage == "Something went wrong (error 409). Try again.")
        #expect(error(502, "{}").userMessage == "The server ran into a problem. Try again in a moment.")
        #expect(NetworkError.forbidden.userMessage == "You don't have access to this. Ask the server's owner if you think you should.")
        #expect(NetworkError.notFound.userMessage == "That's no longer there. Refresh and try again.")
        #expect(NetworkError.http(status: 409).userMessage == "Something went wrong (error 409). Try again.")
    }

    @Test("A body that is not JSON gives no text, whatever it says")
    func nonJSON() {
        let html = "<html><body>Bad gateway</body></html>"
        #expect(error(502, html, json: false).serverMessage == nil)
        #expect(error(502, html, json: false) == .server(status: 502))
        #expect(error(404, "Not found", json: false).serverMessage == nil)
        #expect(error(409, "Conflict", json: false).userMessage == "Something went wrong (error 409). Try again.")
        // A proxy's HTML in place of a 403 is still "not a Sylo server".
        #expect(error(403, html, json: false) == .notASyloServer)
        // JSON that is not an error object, or text sent as a number.
        #expect(error(404, "[1,2]").serverMessage == nil)
        #expect(error(404, "not json at all").serverMessage == nil)
        #expect(error(404, #"{"error":{"code":5}}"#).serverMessage == nil)
    }

    @Test("`message` is read when there is no `error`, and an error object does not hide it")
    func messageKey() {
        #expect(error(409, #"{"message":"Already there."}"#).serverMessage == "Already there.")
        #expect(error(409, #"{"error":{"code":5},"message":"Fallback text"}"#).serverMessage == "Fallback text")
        #expect(error(409, #"{"error":"First","message":"Second"}"#).serverMessage == "First")
    }

    @Test("Text is trimmed and cut at 500 characters")
    func trimmed() {
        #expect(error(409, #"{"error":"  spaced \n"}"#).serverMessage == "spaced")
        let long = String(repeating: "x", count: 900)
        #expect(error(409, "{\"error\":\"\(long)\"}").serverMessage?.count == 500)
    }

    @Test("Equality ignores the text, the number of a status is its code")
    func equality() {
        #expect(NetworkError.forbidden(message: "a") == NetworkError.forbidden(message: "b"))
        #expect(NetworkError.notFound(message: "a") == .notFound)
        #expect(NetworkError.http(status: HTTPStatus(409, message: "a")) == .http(status: 409))
        #expect(NetworkError.http(status: 409) != .http(status: 410))
        #expect(NetworkError.http(status: 409) != .server(status: 409))
        #expect(NetworkError.badRequest(message: "a") != .badRequest(message: "b"))
        #expect(NetworkError.forbidden != .notFound)
        #expect(HTTPStatus(500) < HTTPStatus(503))
        #expect(HTTPStatus(409, message: "x").description == "409")
        #expect(Set([HTTPStatus(409, message: "x"), 409]).count == 1)
    }

    @Test("The text survives the real client, for 403, 404, 409 and 502")
    func throughTheClient() async throws {
        // Through the session stub: a thrown error keeps its text all the way to the screen.
        let thrown = NetworkError.from(status: 409, body: Data(#"{"error":"Already decided."}"#.utf8), isJSON: true)
        #expect(NetworkError(thrown).userMessage == "Already decided.")
        #expect(NetworkError(thrown) == .http(status: 409))
    }

    @Test("Retrying still looks at the status number")
    func retryable() {
        #expect(NetworkError.server(status: 503).isRetryable)
        #expect(error(502, #"{"error":"Bad"}"#).isRetryable)
        #expect(!NetworkError.server(status: 500).isRetryable)
        #expect(!error(409, #"{"error":"x"}"#).isRetryable)
    }
}

extension APIClientTests {
    @Test("Error texts from the server reach the thrown error on the wire", arguments: [
        (403, #"{"error":"You do not manage this server."}"#),
        (404, #"{"error":"Unknown or unavailable server"}"#),
        (409, #"{"error":"This application was already decided."}"#),
        (502, #"{"error":"Sylo could not post the panel."}"#),
    ])
    func errorTextOnTheWire(status: Int, body: String) async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(status, body)])
        let client = URLSessionAPIClient(
            server: try ServerURL("https://example.com"), session: MockURLProtocol.session(), decoder: JSONDecoder(),
            retryDelays: [], token: { "sylo_secret" })
        do {
            _ = try await client.send(Endpoints.Servers())
            Issue.record("expected a failure")
        } catch {
            let failure = NetworkError(error)
            let expected = body.replacingOccurrences(of: #"{"error":""#, with: "").replacingOccurrences(of: #""}"#, with: "")
            #expect(failure.userMessage == expected)
        }
    }
}
