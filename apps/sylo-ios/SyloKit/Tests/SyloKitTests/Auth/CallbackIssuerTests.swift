import Foundation
import Testing
@testable import SyloKit

@Suite("Callback issuer")
struct CallbackIssuerTests {
    private let state = "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg"
    private let server = "https://app.sylobot.com"
    private let clients = StubClients { _ in throw NetworkError.notFound }

    private func code(_ callback: String, server: String? = nil) throws -> String {
        try SignInRequest.authorizationCode(
            from: URL(string: callback)!, expectedState: state, serverOrigin: server ?? self.server)
    }

    @Test("Origins are compared in one spelling: case, default port and path do not matter")
    func normalisesOrigins() {
        let same = [
            "https://app.sylobot.com", "https://APP.SyloBot.com", "https://app.sylobot.com:443",
            "https://app.sylobot.com/", "https://app.sylobot.com/some/path?x=1#frag", "HTTPS://app.sylobot.com",
        ]
        for text in same { #expect(CallbackIssuer.origin(of: text) == "https://app.sylobot.com", "\(text)") }
        #expect(CallbackIssuer.origin(of: "http://example.com:80") == "http://example.com")
        #expect(CallbackIssuer.origin(of: "https://example.com:8443/x") == "https://example.com:8443")
        #expect(CallbackIssuer.origin(of: "https://example.com:80") == "https://example.com:80")
        #expect(CallbackIssuer.origin(of: "http://[::1]:3000") == "http://[::1]:3000")
    }

    @Test("Anything that is not a plain http(s) address has no origin", arguments: [
        "", "not a url", "ftp://example.com", "sylo://auth", "javascript:alert(1)", "https://", "https:///x",
        "https://user@example.com", "https://user:pw@example.com", "https://app.sylobot.com@evil.example",
        "https://exa mple.com", "https://example.com%0A", "https://exa%6Dple.com", "https://example.com\\@evil.com",
    ])
    func noOrigin(text: String) {
        #expect(CallbackIssuer.origin(of: text) == nil)
    }

    @Test("A matching issuer is accepted, whatever its case, default port or path")
    func matching() throws {
        for iss in ["https://app.sylobot.com", "https://APP.sylobot.com", "https://app.sylobot.com:443",
                    "https://app.sylobot.com/", "https://app.sylobot.com/path", "https%3A%2F%2Fapp.sylobot.com"] {
            #expect(try code("sylo://auth?code=c&state=\(state)&iss=\(iss)") == "c", "\(iss)")
        }
        #expect(try code("sylo://auth?code=c&state=\(state)&iss=https://example.com", server: "https://example.com") == "c")
        #expect(try code(
            "sylo://auth?code=c&state=\(state)&iss=http://192.168.1.20:3000", server: "http://192.168.1.20:3000") == "c")
    }

    @Test("No issuer is accepted, as before")
    func absent() throws {
        #expect(try code("sylo://auth?code=c&state=\(state)") == "c")
        #expect(try code("sylo://auth?code=c&state=\(state)", server: "https://example.com:8443") == "c")
    }

    @Test("Another server as issuer is refused, with what it claimed")
    func mismatching() {
        func outcome(_ iss: String) -> SignInError? {
            do {
                _ = try code("sylo://auth?code=c&state=\(state)&iss=\(iss)")
                return nil
            } catch {
                return error as? SignInError
            }
        }
        #expect(outcome("https://evil.example") == .issuerMismatch("https://evil.example"))
        #expect(outcome("https://EVIL.example:8443/x") == .issuerMismatch("https://evil.example:8443"))
        #expect(outcome("https://app.sylobot.com.evil.example") == .issuerMismatch("https://app.sylobot.com.evil.example"))
        // Another port, or http for the same host, is another origin.
        #expect(outcome("https://app.sylobot.com:8443") == .issuerMismatch("https://app.sylobot.com:8443"))
        #expect(outcome("http://app.sylobot.com") == .issuerMismatch("http://app.sylobot.com"))
    }

    @Test("An issuer with a user name, one that is empty or unreadable, and a second one are refused")
    func oddIssuers() {
        let unknown = SignInError.issuerMismatch(CallbackIssuer.unknownAddress)
        func outcome(_ query: String) -> SignInError? {
            do {
                _ = try code("sylo://auth?code=c&state=\(state)&\(query)")
                return nil
            } catch {
                return error as? SignInError
            }
        }
        // A user name never makes the host read as the chosen server, and is never shown.
        #expect(outcome("iss=https://app.sylobot.com@evil.example") == unknown)
        #expect(outcome("iss=https://evil.example@app.sylobot.com") == unknown)
        #expect(outcome("iss=https://user:pw@app.sylobot.com") == unknown)
        #expect(outcome("iss=") == unknown)
        #expect(outcome("iss") == unknown)
        #expect(outcome("iss=app.sylobot.com") == unknown)
        #expect(outcome("iss=javascript:alert(1)") == unknown)
        #expect(outcome("iss=https://app.sylobot.com&iss=https://app.sylobot.com") == unknown)
        #expect(outcome("iss=https://app.sylobot.com&iss=https://evil.example") == unknown)
    }

    @Test("With no server to compare to, any issuer is refused")
    func noServer() {
        #expect(throws: SignInError.issuerMismatch("https://app.sylobot.com")) {
            try SignInRequest.authorizationCode(
                from: URL(string: "sylo://auth?code=c&state=\(state)&iss=https://app.sylobot.com")!,
                expectedState: state, serverOrigin: nil)
        }
    }

    @Test("The state is checked before the issuer, and the issuer before the code or an error")
    func order() {
        #expect(throws: SignInError.stateMismatch) {
            try code("sylo://auth?code=c&state=other&iss=https://evil.example")
        }
        #expect(throws: SignInError.issuerMismatch("https://evil.example")) {
            try code("sylo://auth?error=server_error&state=\(state)&iss=https://evil.example")
        }
        #expect(throws: SignInError.cancelled) {
            try code("sylo://auth?error=access_denied&state=\(state)&iss=https://app.sylobot.com")
        }
    }

    @Test("A request compares the issuer with the address it was made for")
    func viaRequest() throws {
        let request = try SignInRequest(server: URL(string: "https://Example.com:443/sylo/")!, platform: nil)
        let callback = "sylo://auth?code=c&state=\(request.state)"
        #expect(try request.authorizationCode(from: URL(string: callback)!) == "c")
        #expect(try request.authorizationCode(from: URL(string: callback + "&iss=https://example.com")!) == "c")
        #expect(throws: SignInError.issuerMismatch("https://app.sylobot.com")) {
            try request.authorizationCode(from: URL(string: callback + "&iss=https://app.sylobot.com")!)
        }
    }

    @Test("The message names the other server and what to do")
    @MainActor
    func message() async throws {
        let chosen = try ServerURL("https://app.sylobot.com")
        let clients = self.clients
        let session = AppSession(
            tokens: InMemoryTokenStore(), preference: MemoryServerPreference(chosen),
            deviceName: "Test", makeClient: { clients.make($0, $1) })
        session.start()
        await session.signIn(with: nil) { url in
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "state" }?.value ?? ""
            return URL(string: "sylo://auth?code=c&state=\(state)&iss=https://evil.example")!
        }
        let expected = "This sign-in came from a different server (https://evil.example), "
            + "but you chose https://app.sylobot.com. Sign in again, or add the server with that address."
        #expect(session.errorMessage == expected)
        #expect(session.phase == .signIn(chosen))
        // The code was not redeemed anywhere.
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.ExchangeCode })
    }
}

@MainActor
@Suite("Sign-in and connect with an issuer")
struct IssuerFlowTests {
    private let server = try! ServerURL("https://sylo.example.com")
    private let clients = StubClients { endpoint in
        switch endpoint {
        case is Endpoints.ServerInfo: return ServerInfo()
        default: throw NetworkError.notFound
        }
    }
    private let grant = TokenGrant(
        token: "sylo_new", expiresAt: Date().addingTimeInterval(86_400),
        account: SignedInAccount(name: "ferdi", platforms: [.discord]))

    private func signIn(_ extra: String, tokens: InMemoryTokenStore = InMemoryTokenStore()) async -> AppSession {
        let clients = self.clients
        let session = AppSession(
            tokens: tokens, preference: MemoryServerPreference(server), deviceName: "Test",
            makeClient: { clients.make($0, $1) })
        session.start()
        let grant = self.grant
        clients.setHandler { endpoint in
            if endpoint is Endpoints.ExchangeCode { return grant }
            return ServerInfo()
        }
        await session.signIn(with: nil) { url in
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "state" }?.value ?? ""
            return URL(string: "sylo://auth?code=the-code&state=\(state)\(extra)")!
        }
        return session
    }

    @Test("Sign-in: a matching issuer signs in, an absent one too")
    func signInAccepted() async {
        for extra in ["&iss=https://sylo.example.com", "&iss=HTTPS://SYLO.example.com:443/", ""] {
            let signedIn = await signIn(extra)
            #expect(signedIn.phase == .signedIn(server), "\(extra)")
            #expect(signedIn.errorMessage == nil)
        }
    }

    @Test("Sign-in: another server's issuer redeems nothing and keeps no token")
    func signInRefused() async throws {
        let tokens = InMemoryTokenStore()
        let refused = await signIn("&iss=https://other.example.com", tokens: tokens)
        #expect(refused.phase == .signIn(server))
        #expect(refused.errorMessage?.contains("different server (https://other.example.com)") == true)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.ExchangeCode })
        #expect(try tokens.token(for: server.description) == nil)
    }

    @Test("Sign-in: http against https (a proxy that drops TLS) is refused and both origins are shown")
    func signInHttpAgainstHttps() async throws {
        let tokens = InMemoryTokenStore()
        let refused = await signIn("&iss=http://sylo.example.com", tokens: tokens)
        #expect(refused.phase == .signIn(server))
        let expected = "This sign-in came from a different server (http://sylo.example.com), "
            + "but you chose https://sylo.example.com. Sign in again, or add the server with that address."
        #expect(refused.errorMessage == expected)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.ExchangeCode })
        #expect(try tokens.token(for: server.description) == nil)
    }

    @Test("Sign-in: a callback with more than one issuer is refused, even when they agree")
    func signInRepeatedIssuer() async {
        let refused = await signIn("&iss=https://sylo.example.com&iss=https://sylo.example.com")
        #expect(refused.phase == .signIn(server))
        #expect(refused.errorMessage?.contains("but you chose https://sylo.example.com") == true)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.ExchangeCode })
    }

    @Test("Connect: http against https is refused and both origins are shown; so is a repeated issuer")
    func connectHttpAndRepeated() async {
        for extra in ["&iss=http://sylo.example.com", "&iss=https://sylo.example.com&iss=https://sylo.example.com"] {
            let clients = AccountConnectModelTests.clients()
            let model = AccountModel(session: makeSignedInSession(clients: clients))
            await model.load()
            let connected = await model.connect(AccountModelTests.fluxer) { _ in
                URL(string: "sylo://connected?result=r-1&platform=fluxer\(extra)")!
            }
            #expect(!connected, "\(extra)")
            #expect(model.platformError?.contains("but you chose https://sylo.example.com") == true, "\(extra)")
            #expect(!clients.calls.contains { $0.endpoint is Endpoints.CompleteConnect }, "\(extra)")
        }
    }

    @Test("Connect: a matching or absent issuer completes the link")
    func connectAccepted() async {
        for extra in ["&iss=https://sylo.example.com", "&iss=https://SYLO.example.com:443", ""] {
            let clients = AccountConnectModelTests.clients()
            let model = AccountModel(session: makeSignedInSession(clients: clients))
            await model.load()
            let connected = await model.connect(AccountModelTests.fluxer) { _ in
                URL(string: "sylo://connected?result=r-1&platform=fluxer\(extra)")!
            }
            #expect(connected, "\(extra)")
            #expect(clients.calls.contains { $0.endpoint is Endpoints.CompleteConnect })
        }
    }

    @Test("Connect: another server's issuer sends nothing and explains")
    func connectRefused() async {
        for extra in ["&iss=https://other.example.com", "&iss=https://user@sylo.example.com", "&iss=", "&iss=a&iss=b"] {
            let clients = AccountConnectModelTests.clients()
            let model = AccountModel(session: makeSignedInSession(clients: clients))
            await model.load()
            let connected = await model.connect(AccountModelTests.fluxer) { _ in
                URL(string: "sylo://connected?result=r-1&platform=fluxer\(extra)")!
            }
            #expect(!connected, "\(extra)")
            #expect(model.platformError?.contains("different server") == true, "\(extra)")
            #expect(!clients.calls.contains { $0.endpoint is Endpoints.CompleteConnect }, "\(extra)")
        }
        let clients = AccountConnectModelTests.clients()
        let model = AccountModel(session: makeSignedInSession(clients: clients))
        await model.load()
        _ = await model.connect(AccountModelTests.fluxer) { _ in
            URL(string: "sylo://connected?result=r-1&platform=fluxer&iss=https://other.example.com")!
        }
        let expected = "This connection came from a different server (https://other.example.com), "
            + "but you chose https://sylo.example.com. Try again, or add the server with that address."
        #expect(model.platformError == expected)
    }
}

@Suite("Connect callback issuer")
struct ConnectCallbackIssuerTests {
    private func result(_ query: String, origin: String? = "https://sylo.example.com") throws -> ConnectResult {
        try ConnectCallback.result(
            from: URL(string: "sylo://connected?\(query)")!, expected: .fluxer, serverOrigin: origin)
    }

    @Test("Matching and absent issuers are accepted; host case and the default port are normalised")
    func accepted() throws {
        #expect(try result("result=r&platform=fluxer").result == "r")
        #expect(try result("result=r&iss=https://sylo.example.com").result == "r")
        #expect(try result("result=r&iss=https://SYLO.Example.com:443").result == "r")
        #expect(try result("result=r&iss=https://sylo.example.com/with/path").result == "r")
        #expect(try result("result=r&iss=https%3A%2F%2Fsylo.example.com").result == "r")
        #expect(try result("result=r&iss=https://example.com:8443", origin: "https://example.com:8443").result == "r")
    }

    @Test("Another server, userinfo, empty, repeated or unreadable issuers are refused")
    func refused() {
        func outcome(_ query: String, origin: String? = "https://sylo.example.com") -> ConnectError? {
            do {
                _ = try result(query, origin: origin)
                return nil
            } catch {
                return error as? ConnectError
            }
        }
        let unknown = ConnectError.issuerMismatch(CallbackIssuer.unknownAddress)
        #expect(outcome("result=r&iss=https://evil.example") == .issuerMismatch("https://evil.example"))
        #expect(outcome("result=r&iss=https://sylo.example.com:8443") == .issuerMismatch("https://sylo.example.com:8443"))
        #expect(outcome("result=r&iss=https://sylo.example.com@evil.example") == unknown)
        #expect(outcome("result=r&iss=https://user@sylo.example.com") == unknown)
        #expect(outcome("result=r&iss=") == unknown)
        #expect(outcome("result=r&iss") == unknown)
        #expect(outcome("result=r&iss=sylo.example.com") == unknown)
        #expect(outcome("result=r&iss=https://sylo.example.com&iss=https://sylo.example.com") == unknown)
        #expect(outcome("result=r&iss=https://sylo.example.com", origin: nil) == .issuerMismatch("https://sylo.example.com"))
    }

    @Test("The issuer is checked before an error is believed")
    func beforeErrors() {
        #expect(throws: ConnectError.issuerMismatch("https://evil.example")) {
            try result("error=expired&iss=https://evil.example")
        }
        #expect(throws: ConnectError.cancelled) {
            try result("error=access-denied&iss=https://sylo.example.com")
        }
    }
}
