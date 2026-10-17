import Foundation
import Testing
@testable import SyloKit

private let rfcPKCE = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
private let rfcChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

private func url(_ string: String) throws -> URL {
    try #require(URL(string: string))
}

private func request(
    _ server: String,
    platform: SignInPlatform? = nil,
    state: String = "state-123_~."
) throws -> SignInRequest {
    try SignInRequest(server: url(server), platform: platform, pkce: rfcPKCE, state: state)
}

/// The decoded query of a URL, as the server's query parser sees it.
private func query(of url: URL) throws -> [String: String] {
    let items = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
    return Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
}

@Suite("Sign-in start URL")
struct SignInStartURLTests {
    @Test("challenge and state on the server's start path")
    func basic() throws {
        let start = try request("https://app.sylobot.com").startURL
        #expect(start.absoluteString
            == "https://app.sylobot.com/auth/mobile/start?challenge=\(rfcChallenge)&state=state-123_~.")
    }

    @Test("the platform when one is chosen", arguments: [SignInPlatform.discord, .fluxer])
    func platform(_ platform: SignInPlatform) throws {
        let start = try request("https://app.sylobot.com", platform: platform).startURL
        #expect(start.absoluteString.hasSuffix("&platform=\(platform.rawValue)"))
        #expect(try query(of: start)["platform"] == platform.rawValue)
    }

    @Test("no platform parameter without a platform")
    func noPlatform() throws {
        let start = try request("https://app.sylobot.com").startURL
        #expect(try query(of: start)["platform"] == nil)
    }

    @Test(
        "a sub-path, port and trailing slash are kept, a query and fragment dropped",
        arguments: [
            ("https://example.com/sylo", "https://example.com/sylo/auth/mobile/start"),
            ("https://example.com/sylo/", "https://example.com/sylo/auth/mobile/start"),
            ("https://example.com/", "https://example.com/auth/mobile/start"),
            ("http://192.168.1.5:3000", "http://192.168.1.5:3000/auth/mobile/start"),
            ("https://example.com/a/b?x=1#top", "https://example.com/a/b/auth/mobile/start"),
        ]
    )
    func paths(server: String, expected: String) throws {
        let start = try request(server).startURL
        #expect(start.absoluteString == expected + "?challenge=\(rfcChallenge)&state=state-123_~.")
    }

    @Test("values are percent-encoded so they come back unchanged")
    func encoding() throws {
        let odd = "a b&c=d+e/f?g#h%i é"
        let start = try request("https://example.com", state: odd).startURL
        #expect(try query(of: start)["state"] == odd)
        #expect(!start.absoluteString.contains(" "))
        #expect(!start.absoluteString.contains("+"))
    }

    @Test("not an http(s) server address", arguments: ["mailto:someone@example.com", "file:///tmp/x", "sylo://auth"])
    func invalidServer(server: String) throws {
        let address = try url(server)
        #expect(throws: SignInError.invalidServerURL) {
            try SignInRequest(server: address, platform: nil)
        }
    }

    @Test("the callback scheme is sylo")
    func scheme() {
        #expect(SignInRequest.callbackScheme == "sylo")
    }

    @Test("each new request has its own verifier and state")
    func fresh() throws {
        let server = try url("https://app.sylobot.com")
        let first = try SignInRequest(server: server, platform: .discord)
        let second = try SignInRequest(server: server, platform: .discord)
        #expect(first.pkce.verifier != second.pkce.verifier)
        #expect(first.state != second.state)
        #expect(try query(of: first.startURL)["challenge"] == first.pkce.challenge)
        #expect(try query(of: first.startURL)["state"] == first.state)
    }

    @Test("its description shows neither the verifier nor the state")
    func redacted() throws {
        let sample = try SignInRequest(server: url("https://app.sylobot.com"), platform: nil)
        for text in [String(describing: sample), String(reflecting: sample)] {
            #expect(!text.contains(sample.pkce.verifier))
            #expect(!text.contains(sample.state))
        }
    }
}

@Suite("Sign-in callback")
struct SignInCallbackTests {
    private let state = "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg"

    private func code(_ callback: String, expecting expected: String? = nil) throws -> String {
        try SignInRequest.authorizationCode(from: url(callback), expectedState: expected ?? state)
    }

    @Test("the code from sylo://auth")
    func success() throws {
        #expect(try code("sylo://auth?code=abc123&state=\(state)") == "abc123")
        #expect(try code("sylo://auth?state=\(state)&code=abc123") == "abc123")
        #expect(try code("sylo://auth/?code=abc123&state=\(state)") == "abc123")
        #expect(try code("SYLO://Auth?code=abc123&state=\(state)") == "abc123")
    }

    @Test("percent-encoding and + are decoded like the server's URLSearchParams wrote them")
    func decoding() throws {
        #expect(try code("sylo://auth?code=a%2Bb%7Ec&state=abc%7Edef", expecting: "abc~def") == "a+b~c")
        #expect(try code("sylo://auth?code=a+b&state=\(state)") == "a b")
    }

    @Test("the request checks its own state")
    func viaRequest() throws {
        let sample = try request("https://app.sylobot.com", state: state)
        #expect(try sample.authorizationCode(from: url("sylo://auth?code=xyz&state=\(state)")) == "xyz")
        #expect(throws: SignInError.stateMismatch) {
            try sample.authorizationCode(from: url("sylo://auth?code=xyz&state=other-state"))
        }
    }

    @Test("Cancel on the confirmation page")
    func cancelled() throws {
        #expect(throws: SignInError.cancelled) {
            try code("sylo://auth?error=access_denied&state=\(state)")
        }
    }

    @Test("any other error from the server")
    func serverError() throws {
        #expect(throws: SignInError.serverError("server_error")) {
            try code("sylo://auth?error=server_error&state=\(state)")
        }
        #expect(throws: SignInError.serverError("server_error")) {
            try code("sylo://auth?error=server_error&code=abc&state=\(state)")
        }
    }

    @Test(
        "a missing, different or repeated state",
        arguments: [
            "sylo://auth?code=abc",
            "sylo://auth?code=abc&state=",
            "sylo://auth?code=abc&state=wrong-state",
            "sylo://auth?code=abc&state=ZM9VYMFYYMF6CXV4CXV1EHF1DXHXDXV4CXV1EHF1DXG",
            "sylo://auth?code=abc&state=Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg&state=x",
            "sylo://auth?error=access_denied",
            "sylo://auth?error=access_denied&state=wrong-state",
            "sylo://auth",
        ]
    )
    func stateMismatch(callback: String) throws {
        #expect(throws: SignInError.stateMismatch) {
            try code(callback)
        }
    }

    @Test("states are compared exactly, not by Unicode equivalence")
    func exactComparison() throws {
        // U+00E9 against e + U+0301: equal as Swift Strings, different bytes.
        #expect(throws: SignInError.stateMismatch) {
            try code("sylo://auth?code=abc&state=caf%C3%A9-state", expecting: "cafe\u{301}-state")
        }
        #expect(throws: SignInError.stateMismatch) {
            try code("sylo://auth?code=abc&state=", expecting: "")
        }
    }

    @Test(
        "another scheme, host or path",
        arguments: [
            "https://auth?code=abc&state=Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg",
            "https://app.sylobot.com/auth?code=abc&state=Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg",
            "sylo://other?code=abc&state=Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg",
            "sylo://auth/extra?code=abc&state=Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg",
            "sylo:auth?code=abc&state=Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg",
            "sylo://user@auth?code=abc&state=Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg",
            "sylo://auth:8080?code=abc&state=Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg",
        ]
    )
    func wrongCallback(callback: String) throws {
        #expect(throws: SignInError.wrongCallback) {
            try code(callback)
        }
    }

    @Test(
        "no code, an empty one, or two",
        arguments: [
            "sylo://auth?state=Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg",
            "sylo://auth?code=&state=Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg",
            "sylo://auth?code&state=Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg",
            "sylo://auth?code=a&code=b&state=Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg",
        ]
    )
    func missingCode(callback: String) throws {
        #expect(throws: SignInError.missingCode) {
            try code(callback)
        }
    }
}
