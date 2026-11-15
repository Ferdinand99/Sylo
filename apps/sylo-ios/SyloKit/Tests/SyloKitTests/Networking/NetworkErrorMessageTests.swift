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

    @Test("Text is trimmed, and cut at 300 unicode scalars")
    func trimmed() {
        #expect(error(409, #"{"error":"  Spaced out \n"}"#).serverMessage == "Spaced out")
        let long = String(repeating: "Abcde", count: 200)
        #expect(error(409, "{\"error\":\"\(long)\"}").serverMessage?.unicodeScalars.count == 300)
        // A "character" made of many combining marks still counts by scalars.
        let marks = String(repeating: "e\u{301}", count: 400)
        let cut = error(409, "{\"error\":\"\(marks)\"}").userMessage
        #expect(cut.unicodeScalars.count == 300)
    }

    @Test("A machine code is not shown; it stays available as serverCode", arguments: [
        (400, "invalid_request"), (404, "not_found"), (409, "already_connected"), (400, "taken"),
        (503, "push_unavailable"), (409, "identity_linked"), (400, "invalid_platform"), (403, "no_access2"),
    ])
    func codes(status: Int, code: String) {
        let failure = error(status, "{\"error\":\"\(code)\"}")
        #expect(failure.serverCode == code)
        #expect(failure.serverMessage == nil)
        // The person reads the app's own words for that status.
        #expect(failure.userMessage == error(status, "{}").userMessage)
    }

    @Test("Text with capitals or spaces is a message, not a code")
    func notACode() {
        for text in ["Taken", "already connected", "invalid-request", "9lives", "no_access!"] {
            let failure = error(409, "{\"error\":\"\(text)\"}")
            #expect(failure.serverCode == nil, "\(text)")
            #expect(failure.serverMessage == text, "\(text)")
        }
        #expect(error(409, "{}").serverCode == nil)
    }

    @Test("A framework's stock phrases are not shown", arguments: [
        (404, "Not found"), (500, "Internal server error"), (413, "Payload too large"), (400, "Bad Request"),
        (403, "Forbidden"), (502, "Bad gateway."), (404, "  NOT FOUND "), (503, "Service Unavailable"),
    ])
    func stockPhrases(status: Int, text: String) {
        let failure = error(status, "{\"error\":\"\(text)\"}")
        #expect(failure.serverMessage == nil)
        #expect(failure.serverCode == nil)
        #expect(failure.userMessage == error(status, "{}").userMessage)
    }

    @Test("Direction overrides, zero-width characters and line breaks are removed")
    func hostileText() {
        let failure = error(409, #"{"error":"Pay\u202Ement\nfailed\u200B!\u2066\r\u2069 Try\tagain"}"#)
        #expect(failure.serverMessage == "Payment failed!  Try again")
        #expect(failure.userMessage == "Payment failed!  Try again")
        // Nothing but invisible characters is no text.
        #expect(error(409, #"{"error":"\u200B\u202E\n"}"#).serverMessage == nil)
        #expect(error(409, #"{"error":"\u200B\u202E\n"}"#).userMessage == error(409, "{}").userMessage)
    }

    @Test("A 400 code that the app maps itself still reaches it raw")
    func badRequestKeepsCode() {
        let failure = error(400, #"{"error":"invalid_grant"}"#)
        #expect(failure == .badRequest(message: "invalid_grant"))
        #expect(failure.serverCode == "invalid_grant")
        #expect(failure.userMessage == NetworkError.badRequest(message: "invalid_grant").userMessage)
        #expect(failure.userMessage != error(400, "{}").userMessage)
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

    @Test("Mapping an error again keeps its text")
    func remapKeepsText() {
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
