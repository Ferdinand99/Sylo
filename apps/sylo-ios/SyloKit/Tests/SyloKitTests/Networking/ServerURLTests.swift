import Foundation
import Testing
@testable import SyloKit

@Suite("ServerURL")
struct ServerURLTests {
    @Test("Normalises what a person types", arguments: [
        ("example.com", "https://example.com"),
        ("  example.com  \n", "https://example.com"),
        ("https://example.com/", "https://example.com"),
        ("HTTPS://Example.COM", "https://example.com"),
        ("https://example.com/sylo/", "https://example.com/sylo"),
        ("example.com/sylo//", "https://example.com/sylo"),
        ("https://example.com:8443", "https://example.com:8443"),
        ("https://example.com:443/", "https://example.com"),
        ("https://user:secret@example.com/sylo?x=1#top", "https://example.com/sylo"),
        ("sylo.example.com:3000", "https://sylo.example.com:3000"),
        ("localhost:3000", "https://localhost:3000"),
        ("http://localhost:3000", "http://localhost:3000"),
        ("http://127.0.0.1:3000/", "http://127.0.0.1:3000"),
        ("http://tower.local:3000", "http://tower.local:3000"),
        ("http://10.0.0.5", "http://10.0.0.5"),
        ("http://172.16.0.1", "http://172.16.0.1"),
        ("http://172.31.255.255", "http://172.31.255.255"),
        ("http://192.168.1.20:3000/sylo", "http://192.168.1.20:3000/sylo"),
        ("http://192.168.1.20:80", "http://192.168.1.20"),
    ])
    func normalises(input: String, expected: String) throws {
        let server = try ServerURL(input)
        #expect(server.baseURL.absoluteString == expected)
        #expect(server.description == expected)
    }

    @Test("Rejects input that is not a usable server address", arguments: [
        ("", ServerURLError.empty),
        ("   ", ServerURLError.empty),
        ("ftp://example.com", ServerURLError.unsupportedScheme("ftp")),
        ("sylo://auth", ServerURLError.unsupportedScheme("sylo")),
        ("http://example.com", ServerURLError.insecureHTTP),
        ("http://172.32.0.1", ServerURLError.insecureHTTP),
        ("http://192.169.1.1", ServerURLError.insecureHTTP),
        ("http://11.0.0.1", ServerURLError.insecureHTTP),
        ("http://example.local.evil.com", ServerURLError.insecureHTTP),
        ("https://", ServerURLError.invalid),
        ("https://exa mple.com", ServerURLError.invalid),
        ("https://:3000", ServerURLError.invalid),
        ("https://exa%20mple.com", ServerURLError.invalid),
        ("https://example.com\\@evil.com", ServerURLError.invalid),
    ])
    func rejects(input: String, expected: ServerURLError) {
        #expect(throws: expected) { try ServerURL(input) }
    }

    @Test("Every error has a message for people")
    func errorMessages() {
        let errors: [ServerURLError] = [.empty, .invalid, .unsupportedScheme("ftp"), .insecureHTTP]
        for error in errors {
            #expect(!error.userMessage.isEmpty)
        }
    }

    @Test("Origin is scheme, host and port without the sub-path")
    func origin() throws {
        #expect(try ServerURL("https://example.com/sylo").origin == "https://example.com")
        #expect(try ServerURL("example.com:8443/sylo").origin == "https://example.com:8443")
        #expect(try ServerURL("http://192.168.1.20:3000").origin == "http://192.168.1.20:3000")
        #expect(try ServerURL("HTTPS://Example.com").origin == "https://example.com")
    }

    @Test("Joins paths with and without a sub-path")
    func joinsPaths() throws {
        let root = try ServerURL("https://example.com")
        let sub = try ServerURL("https://example.com/sylo/")
        #expect(root.url(for: "/api/mobile/info").absoluteString == "https://example.com/api/mobile/info")
        #expect(root.url(for: "api/mobile/info").absoluteString == "https://example.com/api/mobile/info")
        #expect(sub.url(for: "/api/mobile/info").absoluteString == "https://example.com/sylo/api/mobile/info")
        #expect(sub.url(for: "api/v2/guilds").absoluteString == "https://example.com/sylo/api/v2/guilds")
    }

    @Test("Keeps an encoded fluxer: id encoded in the path")
    func encodedPath() throws {
        let sub = try ServerURL("https://example.com/sylo")
        let id = ServerID("fluxer:123456789012345678")
        let url = sub.url(for: "/api/v2/guilds/\(id.pathComponent)/overview")
        #expect(url.absoluteString == "https://example.com/sylo/api/v2/guilds/fluxer%3A123456789012345678/overview")
    }

    @Test("Adds query items, and none when empty")
    func query() throws {
        let server = try ServerURL("https://example.com/sylo")
        let url = server.url(for: "/auth/mobile/start", query: [
            URLQueryItem(name: "state", value: "abc123xyz"),
            URLQueryItem(name: "platform", value: "fluxer"),
        ])
        #expect(url.absoluteString == "https://example.com/sylo/auth/mobile/start?state=abc123xyz&platform=fluxer")
        #expect(!server.url(for: "/api/mobile/info").absoluteString.contains("?"))
    }

    @Test("Encodes as its address and decodes by validating again")
    func codable() throws {
        let server = try ServerURL("example.com/sylo")
        let data = try JSONEncoder().encode(server)
        #expect(try JSONDecoder().decode(String.self, from: data) == "https://example.com/sylo")
        #expect(try JSONDecoder().decode(ServerURL.self, from: data) == server)
        let bad = Data("\"http://example.com\"".utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(ServerURL.self, from: bad) }
    }

    @Test("The hosted Sylo is app.sylobot.com")
    func hosted() {
        #expect(ServerURL.hosted.baseURL.absoluteString == "https://app.sylobot.com")
    }
}
