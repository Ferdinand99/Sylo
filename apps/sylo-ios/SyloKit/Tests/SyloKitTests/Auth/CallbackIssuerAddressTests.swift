import Foundation
import Testing
@testable import SyloKit

@Suite("Callback issuer: addresses")
struct CallbackIssuerAddressTests {
    private let state = "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg"

    private func code(iss: String, server: String) throws -> String {
        let encoded = iss.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? iss
        return try SignInRequest.authorizationCode(
            from: URL(string: "sylo://auth?code=c&state=\(state)&iss=\(encoded)")!, expectedState: state, serverOrigin: server)
    }

    @Test("An IPv6 address typed two ways is one address")
    func ipv6() throws {
        #expect(CallbackIssuer.origin(of: "https://[2001:db8:0:0::1]:8443") == "https://[2001:db8::1]:8443")
        #expect(CallbackIssuer.origin(of: "https://[2001:0DB8::0001]") == "https://[2001:db8::1]")
        #expect(CallbackIssuer.origin(of: "http://[::1]:3000") == "http://[::1]:3000")
        // The chosen origin, typed uncompressed, matches the compressed form a server sends.
        #expect(try code(iss: "https://[2001:db8::1]:8443", server: "https://[2001:db8:0:0::1]:8443") == "c")
        #expect(try code(iss: "https://[2001:db8:0:0:0:0:0:1]:8443", server: "https://[2001:db8::1]:8443") == "c")
        // Another address, or another port, still does not match.
        #expect(throws: SignInError.issuerMismatch("https://[2001:db8::2]:8443")) {
            try code(iss: "https://[2001:db8::2]:8443", server: "https://[2001:db8::1]:8443")
        }
        #expect(throws: SignInError.issuerMismatch("https://[2001:db8::1]")) {
            try code(iss: "https://[2001:db8::1]", server: "https://[2001:db8::1]:8443")
        }
    }

    @Test("A punycode host matches itself, and not another host")
    func punycode() throws {
        #expect(try code(iss: "https://xn--bcher-kva.example", server: "https://xn--bcher-kva.example") == "c")
        #expect(try code(iss: "https://XN--BCHER-KVA.example:443/", server: "https://xn--bcher-kva.example") == "c")
        #expect(throws: SignInError.issuerMismatch("https://xn--bcher-kva.example")) {
            try code(iss: "https://xn--bcher-kva.example", server: "https://xn--mnchen-3ya.example")
        }
    }

    @Test("A very long server path does not make every issuer unreadable")
    func longPath() throws {
        let path = String(repeating: "a/", count: 200)
        let request = try SignInRequest(server: URL(string: "https://example.com/\(path)")!, platform: nil)
        #expect(request.serverOrigin == "https://example.com")
        let callback = "sylo://auth?code=c&state=\(request.state)&iss=https://example.com"
        #expect(try request.authorizationCode(from: URL(string: callback)!) == "c")
    }

    @Test("The sign-in request and the connect flow name the chosen origin the same way")
    func oneNormaliser() throws {
        for address in ["https://Example.com:443/sylo/", "http://192.168.1.20:3000", "https://example.com:8443/sylo",
                        "http://[::1]:3000", "https://[2001:db8:0:0::1]:8443", "http://LOCALHOST:80"] {
            let server = try ServerURL(address)
            let request = try SignInRequest(server: server.baseURL, platform: nil)
            #expect(request.serverOrigin == server.origin, "\(address)")
            #expect(CallbackIssuer.origin(of: server.origin) == CallbackIssuer.origin(of: server.baseURL.absoluteString))
        }
    }
}

@MainActor
@Suite("Issuer flows from other server addresses")
struct IssuerFlowAddressTests {
    private let grant = TokenGrant(
        token: "sylo_new", expiresAt: Date().addingTimeInterval(86_400),
        account: SignedInAccount(name: "ferdi", platforms: [.discord]))

    private static func encoded(_ iss: String?) -> String {
        iss.map { "&iss=" + ($0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? $0) } ?? ""
    }

    private func signIn(server: ServerURL, iss: String?) async -> (AppSession, StubClients) {
        let clients = StubClients { _ in ServerInfo() }
        let grant = self.grant
        clients.setHandler { endpoint in
            if endpoint is Endpoints.ExchangeCode { return grant }
            return ServerInfo()
        }
        let session = AppSession(
            tokens: InMemoryTokenStore(), preference: MemoryServerPreference(server), deviceName: "Test",
            makeClient: { clients.make($0, $1) })
        session.start()
        await session.signIn(with: nil) { url in
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "state" }?.value ?? ""
            return URL(string: "sylo://auth?code=the-code&state=\(state)\(Self.encoded(iss))")!
        }
        return (session, clients)
    }

    private func connect(server: ServerURL, iss: String?) async -> (Bool, AccountModel, StubClients) {
        let clients = AccountConnectModelTests.clients()
        let model = AccountModel(session: makeSignedInSession(clients: clients, server: server))
        await model.load()
        let connected = await model.connect(AccountModelTests.fluxer) { _ in
            URL(string: "sylo://connected?result=r-1&platform=fluxer\(Self.encoded(iss))")!
        }
        return (connected, model, clients)
    }

    @Test("A LAN server over http: its own origin signs in and connects; https for the same host does not")
    func lanHttp() async throws {
        let server = try ServerURL("http://192.168.1.20:3000")
        let (accepted, _) = await signIn(server: server, iss: "http://192.168.1.20:3000")
        #expect(accepted.phase == .signedIn(server))
        let (refused, clients) = await signIn(server: server, iss: "https://192.168.1.20:3000")
        #expect(refused.phase == .signIn(server))
        #expect(refused.errorMessage?.contains("(https://192.168.1.20:3000), but you chose http://192.168.1.20:3000") == true)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.ExchangeCode })

        let (connected, _, _) = await connect(server: server, iss: "http://192.168.1.20:3000")
        #expect(connected)
        let (rejected, model, connectClients) = await connect(server: server, iss: "http://192.168.1.20")
        #expect(!rejected)
        #expect(model.platformError?.contains("but you chose http://192.168.1.20:3000") == true)
        #expect(!connectClients.calls.contains { $0.endpoint is Endpoints.CompleteConnect })
    }

    @Test("A server on a non-default port with a sub-path: the origin has the port and no path")
    func nonDefaultPort() async throws {
        let server = try ServerURL("https://example.com:8443/sylo")
        let (accepted, _) = await signIn(server: server, iss: "https://example.com:8443")
        #expect(accepted.phase == .signedIn(server))
        let (alsoAccepted, _) = await signIn(server: server, iss: "https://EXAMPLE.com:8443/sylo/")
        #expect(alsoAccepted.phase == .signedIn(server))
        let (refused, _) = await signIn(server: server, iss: "https://example.com")
        #expect(refused.phase == .signIn(server))
        #expect(refused.errorMessage?.contains("but you chose https://example.com:8443.") == true)

        let (connected, _, _) = await connect(server: server, iss: "https://example.com:8443")
        #expect(connected)
        let (rejected, _, clients) = await connect(server: server, iss: "https://example.com")
        #expect(!rejected)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.CompleteConnect })
    }

    @Test("A server with an IPv6 address typed uncompressed accepts the compressed issuer")
    func ipv6Server() async throws {
        let server = try ServerURL("https://[2001:db8:0:0::1]:8443")
        let (accepted, _) = await signIn(server: server, iss: "https://[2001:db8::1]:8443")
        #expect(accepted.phase == .signedIn(server))
        let (connected, _, _) = await connect(server: server, iss: "https://[2001:db8::1]:8443")
        #expect(connected)
    }
}
