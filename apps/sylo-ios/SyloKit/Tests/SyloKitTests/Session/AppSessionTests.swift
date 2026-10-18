import Foundation
import Testing
@testable import SyloKit

@MainActor
@Suite("App session")
struct AppSessionTests {
    let server = try! ServerURL("https://sylo.example.com")
    let tokens = InMemoryTokenStore()
    let preference = MemoryServerPreference()
    let clients = StubClients { endpoint in
        switch endpoint {
        case is Endpoints.ServerInfo: return ServerInfo()
        case is Endpoints.SignOut: return EmptyResponse()
        default: throw NetworkError.notFound
        }
    }

    func makeSession() -> AppSession {
        AppSession(tokens: tokens, preference: preference, deviceName: "iPhone — Sylo app",
                   makeClient: { [clients] in clients.make($0, $1) })
    }

    var key: String { server.description }
    let liveToken = StoredToken(token: "sylo_live", expiresAt: Date().addingTimeInterval(86_400))
    let grant = TokenGrant(token: "sylo_new", expiresAt: Date().addingTimeInterval(86_400),
                           account: SignedInAccount(name: "ferdi", platforms: [.discord]))

    /// What the sign-in sheet returns when the person allows: the start URL's state, and a code.
    static func allow(_ startURL: URL) throws -> URL {
        let state = URLComponents(url: startURL, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "state" }?.value ?? ""
        return URL(string: "sylo://auth?code=the-code&state=\(state)")!
    }

    func signedIn() throws -> AppSession {
        preference.server = server
        try tokens.save(liveToken, for: key)
        let session = makeSession()
        session.start()
        return session
    }

    // MARK: - Starting

    @Test("with no saved server it asks for one")
    func startsWithoutServer() {
        let session = makeSession()
        session.start()
        #expect(session.phase == .choosingServer)
    }

    @Test("with a saved server and a live token it is signed in")
    func startsSignedIn() throws {
        let session = try signedIn()
        #expect(session.phase == .signedIn(server))
    }

    @Test("with a saved server and no token it shows sign-in for that server")
    func startsSignedOut() {
        preference.server = server
        let session = makeSession()
        session.start()
        #expect(session.phase == .signIn(server))
    }

    @Test("an expired token is removed and the person signs in again")
    func startsWithExpiredToken() throws {
        preference.server = server
        try tokens.save(StoredToken(token: "sylo_old", expiresAt: Date(timeIntervalSince1970: 0)), for: key)
        let session = makeSession()
        session.start()
        #expect(session.phase == .signIn(server))
        #expect(try tokens.token(for: key) == nil)
    }

    // MARK: - Choosing a server

    @Test("a Sylo that can sign in is remembered and shows sign-in")
    func choosesServer() async {
        let session = makeSession()
        session.start()
        await session.chooseServer("sylo.example.com")
        #expect(session.phase == .signIn(server))
        #expect(session.serverInfo == ServerInfo())
        #expect(session.errorMessage == nil)
        #expect(preference.server == server)
    }

    @Test("an address that can't be parsed explains why and stays put")
    func rejectsBadAddress() async {
        let session = makeSession()
        session.start()
        await session.chooseServer("   ")
        #expect(session.phase == .choosingServer)
        #expect(session.errorMessage == ServerURLError.empty.userMessage)
        #expect(clients.calls.isEmpty)
    }

    @Test("a server without the app API is too old, and is not remembered")
    func rejectsOldServer() async {
        clients.setHandler { _ in throw NetworkError.notFound }
        let session = makeSession()
        session.start()
        await session.chooseServer("sylo.example.com")
        #expect(session.phase == .choosingServer)
        #expect(session.errorMessage == ServerCheck.tooOld.userMessage)
        #expect(preference.server == nil)
    }

    @Test("a Sylo without a login says so")
    func rejectsOpenMode() async {
        clients.setHandler { _ in ServerInfo(isLoginEnabled: false, loginProviders: []) }
        let session = makeSession()
        session.start()
        await session.chooseServer("sylo.example.com")
        #expect(session.phase == .choosingServer)
        #expect(session.errorMessage == ServerCheck.noLogin.userMessage)
    }

    @Test("the info call goes out without a token")
    func infoWithoutToken() async {
        let session = makeSession()
        session.start()
        await session.chooseServer("sylo.example.com")
        #expect(clients.calls.map(\.token) == [nil])
    }

    // MARK: - Signing in

    @Test("signing in trades the code, keeps the token and signs in")
    func signsIn() async throws {
        preference.server = server
        let session = makeSession()
        session.start()
        let grant = self.grant
        clients.setHandler { endpoint in
            guard let exchange = endpoint as? Endpoints.ExchangeCode else { return ServerInfo() }
            #expect(exchange.code == "the-code")
            #expect(exchange.verifier.count == 43)
            #expect(exchange.deviceName == "iPhone — Sylo app")
            return grant
        }
        var opened: URL?
        await session.signIn(with: .fluxer) { url in
            opened = url
            return try Self.allow(url)
        }
        #expect(opened?.path == "/auth/mobile/start")
        #expect(opened?.query?.contains("platform=fluxer") == true)
        #expect(session.phase == .signedIn(server))
        #expect(session.account == grant.account)
        #expect(session.errorMessage == nil)
        #expect(try tokens.token(for: key) == StoredToken(token: "sylo_new", expiresAt: grant.expiresAt))
    }

    @Test("cancelling the sign-in sheet is not an error")
    func cancelIsQuiet() async {
        preference.server = server
        let session = makeSession()
        session.start()
        await session.signIn(with: nil) { _ in throw SignInError.cancelled }
        #expect(session.phase == .signIn(server))
        #expect(session.errorMessage == nil)
    }

    @Test("a callback from another sign-in is refused")
    func refusesForeignCallback() async {
        preference.server = server
        let session = makeSession()
        session.start()
        await session.signIn(with: nil) { _ in URL(string: "sylo://auth?code=x&state=someone-else")! }
        #expect(session.phase == .signIn(server))
        #expect(session.errorMessage != nil)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.ExchangeCode })
    }

    @Test("a code the server refuses explains itself")
    func refusedCode() async {
        preference.server = server
        clients.setHandler { _ in throw NetworkError.badRequest(message: "invalid_grant") }
        let session = makeSession()
        session.start()
        await session.signIn(with: nil) { try Self.allow($0) }
        #expect(session.phase == .signIn(server))
        #expect(session.errorMessage == NetworkError.badRequest(message: "invalid_grant").userMessage)
    }

    // MARK: - Signed in

    @Test("calls go out with the token")
    func sendsToken() async throws {
        let session = try signedIn()
        _ = try await session.send(Endpoints.ServerInfo())
        #expect(clients.calls.last?.token == "sylo_live")
    }

    @Test("a 401 signs the app out of this server, once, with a notice")
    func unauthorizedSignsOut() async throws {
        let session = try signedIn()
        clients.setHandler { _ in throw NetworkError.unauthorized }
        await #expect(throws: NetworkError.unauthorized) {
            try await session.send(Endpoints.Servers())
        }
        #expect(session.phase == .signIn(server))
        #expect(session.notice == NetworkError.unauthorized.userMessage)
        #expect(try tokens.token(for: key) == nil)
    }

    @Test("a 401 from before a new sign-in does not sign the new one out")
    func staleUnauthorizedIsIgnored() async throws {
        let session = try signedIn()
        clients.setHandler { _ in throw NetworkError.unauthorized }
        await #expect(throws: NetworkError.unauthorized) {
            try await session.send(Endpoints.Servers())
        }
        let grant = self.grant
        clients.setHandler { $0 is Endpoints.ExchangeCode ? grant as Any : ServerInfo() as Any }
        await session.signIn(with: nil) { try Self.allow($0) }
        #expect(session.phase == .signedIn(server))

        // An answer that was already on its way for the old token arrives now.
        session.handleUnauthorized(generation: 0)
        #expect(session.phase == .signedIn(server))
    }

    @Test("other errors leave the session alone")
    func otherErrorsKeepSession() async throws {
        let session = try signedIn()
        clients.setHandler { _ in throw NetworkError.offline }
        await #expect(throws: NetworkError.offline) {
            try await session.send(Endpoints.Servers())
        }
        #expect(session.phase == .signedIn(server))
    }

    @Test("signing out revokes the token on the server and forgets it here")
    func signsOut() async throws {
        let session = try signedIn()
        await session.signOut()
        #expect(clients.calls.last?.endpoint is Endpoints.SignOut)
        #expect(clients.calls.last?.token == "sylo_live")
        #expect(session.phase == .signIn(server))
        #expect(session.notice == nil)
        #expect(try tokens.token(for: key) == nil)
    }

    @Test("signing out works offline too")
    func signsOutOffline() async throws {
        let session = try signedIn()
        clients.setHandler { _ in throw NetworkError.offline }
        await session.signOut()
        #expect(session.phase == .signIn(server))
        #expect(try tokens.token(for: key) == nil)
    }

    @Test("deleting the account asks the server, then forgets the token here without a sign-out call")
    func deletesAccount() async throws {
        let session = try signedIn()
        clients.setHandler { _ in OKResponse() }
        try await session.deleteAccount()
        let delete = try #require(clients.calls.last?.endpoint as? Endpoints.DeleteAccount)
        #expect(delete.path == "/api/v2/account/delete")
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.SignOut }, "the token is already gone on the server")
        #expect(session.phase == .signIn(server))
        #expect(try tokens.token(for: key) == nil)
    }

    @Test("a failed account deletion keeps the person signed in")
    func failedAccountDeletion() async throws {
        let session = try signedIn()
        clients.setHandler { _ in throw NetworkError.offline }
        await #expect(throws: NetworkError.offline) { try await session.deleteAccount() }
        #expect(session.phase == .signedIn(server))
        #expect(try tokens.token(for: key) != nil)
    }

    @Test("sign-in loads the server's info after a restart, and a retry clears the old error")
    func loadsServerInfo() async {
        preference.server = server
        clients.setHandler { _ in throw NetworkError.offline }
        let session = makeSession()
        session.start()
        await session.loadServerInfo()
        #expect(session.serverInfo == nil)
        #expect(session.errorMessage == NetworkError.offline.userMessage)

        clients.setHandler { _ in ServerInfo() }
        await session.loadServerInfo()
        #expect(session.serverInfo == ServerInfo())
        #expect(session.errorMessage == nil)
    }

    @Test("a different server can be chosen from sign-in")
    func changesServer() {
        preference.server = server
        let session = makeSession()
        session.start()
        session.changeServer()
        #expect(session.phase == .choosingServer)
    }
}
