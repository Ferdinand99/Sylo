import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

@Suite("Connecting a platform")
struct AccountConnectTests {
    @Test("The feature is announced as app-connect")
    func feature() throws {
        #expect(ServerFeature.appConnect.rawValue == "app-connect")
        let info = try decode(ServerInfo.self, #"{"name":"Sylo","features":["app-login","app-connect"]}"#)
        #expect(info.supports(.appConnect))
        let older = try decode(ServerInfo.self, #"{"name":"Sylo","features":["app-login","live-access"]}"#)
        #expect(!older.supports(.appConnect))
    }

    @Test("A connect callback names the platform that was connected")
    func callback() throws {
        #expect(try ConnectCallback.platform(from: URL(string: "sylo://connected?platform=discord")!, expected: .discord) == .discord)
        // A server that names no platform means the one that was asked for.
        #expect(try ConnectCallback.platform(from: URL(string: "sylo://connected")!, expected: .fluxer) == .fluxer)
        #expect(try ConnectCallback.platform(from: URL(string: "SYLO://Connected/?platform=fluxer")!, expected: .fluxer) == .fluxer)
    }

    @Test("A callback for another platform, another page or another scheme is refused")
    func wrongCallbacks() {
        func outcome(_ text: String, expected: Platform = .discord) -> ConnectError? {
            do {
                _ = try ConnectCallback.platform(from: URL(string: text)!, expected: expected)
                return nil
            } catch {
                return error as? ConnectError
            }
        }
        #expect(outcome("sylo://connected?platform=fluxer") == .wrongCallback)
        #expect(outcome("sylo://auth?code=abc&state=xyz") == .wrongCallback)
        #expect(outcome("https://evil.example/connected?platform=discord") == .wrongCallback)
        #expect(outcome("sylo://connected/extra?platform=discord") == .wrongCallback)
        #expect(outcome("sylo://user@connected?platform=discord") == .wrongCallback)
    }

    @Test("A callback with an error is a refusal; declining on the platform is a cancel")
    func errors() {
        func outcome(_ text: String) -> ConnectError? {
            do {
                _ = try ConnectCallback.platform(from: URL(string: text)!, expected: .discord)
                return nil
            } catch {
                return error as? ConnectError
            }
        }
        #expect(outcome("sylo://connected?error=access_denied") == .cancelled)
        #expect(outcome("sylo://connected?error=already_linked&platform=discord") == .serverError("already_linked"))
    }

    @Test("The page that starts a connect carries the one-time code")
    func connectURL() throws {
        let server = try ServerURL("https://sylo.example.com/sylo")
        #expect(server.connectURL(code: "abc123").absoluteString == "https://sylo.example.com/sylo/auth/mobile/connect?code=abc123")
        // A code with odd characters stays one value.
        let odd = server.connectURL(code: "a&b=c")
        #expect(URLComponents(url: odd, resolvingAgainstBaseURL: false)?.queryItems == [URLQueryItem(name: "code", value: "a&b=c")])
    }

    @Test("The calls go where the server expects")
    func endpoints() {
        let disconnect = Endpoints.DisconnectPlatform(platform: .discord)
        #expect(disconnect.path == "/api/v2/account/disconnect/discord")
        #expect(disconnect.method == .post)
        let start = Endpoints.StartConnect(platform: .fluxer)
        #expect(start.path == "/api/mobile/connect/fluxer")
        #expect(start.method == .post)
        #expect(Endpoints.Invites().path == "/api/v2/invites")
    }

    @Test("Invite links read, and only https links are kept")
    func invites() throws {
        let list = try decode(
            ServerInviteList.self,
            #"""
            {"invites":[
              {"platform":"discord","label":"Discord","url":"https://discord.com/oauth2/authorize?client_id=1"},
              {"platform":"fluxer","label":"Fluxer","url":"javascript:alert(1)"},
              {"platform":"other","url":"http://plain.example/invite"},
              {"platform":"fluxer","url":"https://web.fluxer.example/oauth2/authorize?client_id=2"}]}
            """#)
        #expect(list.invites.map(\.platform) == [.discord, .fluxer])
        #expect(list.invites[1].label == "Fluxer")
        #expect(list.invites[0].url.host == "discord.com")
    }
}

@MainActor
@Suite("Account connect model")
struct AccountConnectModelTests {
    nonisolated static let connectInfo = ServerInfo(features: [.appLogin, .liveAccess, .appConnect])

    /// Answers the account, and starts connects with `start`; disconnects with `disconnect`.
    static func clients(
        start: @escaping @Sendable (Endpoints.StartConnect) throws -> ConnectGrant = { _ in ConnectGrant(code: "c1") },
        disconnect: @escaping @Sendable (Endpoints.DisconnectPlatform) throws -> OKResponse = { _ in OKResponse() }
    ) -> StubClients {
        StubClients { endpoint in
            switch endpoint {
            case let call as Endpoints.StartConnect: return try start(call)
            case let call as Endpoints.DisconnectPlatform: return try disconnect(call)
            default: return AccountModelTests.account
            }
        }
    }

    func loadedModel(_ clients: StubClients) async -> AccountModel {
        let model = AccountModel(session: makeSignedInSession(clients: clients))
        await model.load()
        return model
    }

    func accountLoads(_ clients: StubClients) -> Int {
        clients.calls.filter { $0.endpoint is Endpoints.Account }.count
    }

    @Test("Only a server with app-connect offers platforms to connect, and only unconnected ones with a login on")
    func gating() async {
        let model = await loadedModel(Self.clients())
        #expect(model.connectablePlatforms(serverInfo: Self.connectInfo) == [AccountModelTests.fluxer])
        #expect(model.connectablePlatforms(serverInfo: ServerInfo(features: [.appLogin])).isEmpty)
        #expect(model.connectablePlatforms(serverInfo: nil).isEmpty)

        // A platform whose login is off has no connect path, so it is not offered either.
        let loginOff = PlatformConnection(platform: .fluxer, isConnected: false, connectPath: nil)
        let clients = StubClients { _ in AccountInfo(platforms: [AccountModelTests.discord, loginOff], devices: []) }
        let other = await loadedModel(clients)
        #expect(other.connectablePlatforms(serverInfo: Self.connectInfo).isEmpty)
    }

    @Test("Connecting asks for a code, opens the connect page with it, and reads the account again")
    func connects() async throws {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        var opened: [URL] = []
        let connected = await model.connect(AccountModelTests.fluxer) { url in
            opened.append(url)
            return URL(string: "sylo://connected?platform=fluxer")!
        }
        #expect(connected)
        #expect(opened.map(\.absoluteString) == ["https://sylo.example.com/auth/mobile/connect?code=c1"])
        let start = try #require(clients.calls.compactMap { $0.endpoint as? Endpoints.StartConnect }.first)
        #expect(start.platform == .fluxer)
        #expect(accountLoads(clients) == 2)
        #expect(model.platformError == nil)
        #expect(model.changingPlatform == nil)
    }

    @Test("Closing the sheet is not an error")
    func cancelled() async {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        let connected = await model.connect(AccountModelTests.fluxer) { _ in throw ConnectError.cancelled }
        #expect(!connected)
        #expect(model.platformError == nil)
        #expect(accountLoads(clients) == 1)
    }

    @Test("A callback that does not fit explains and reads nothing again")
    func wrongCallback() async {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        let connected = await model.connect(AccountModelTests.fluxer) { _ in URL(string: "sylo://auth?code=x")! }
        #expect(!connected)
        #expect(model.platformError == "Connecting didn't finish. Try again.")
        #expect(accountLoads(clients) == 1)
    }

    @Test("A server that cannot start a connect says to use the dashboard")
    func startRefused() async {
        let model = await loadedModel(Self.clients(start: { _ in throw NetworkError.notFound }))
        var opened = false
        let connected = await model.connect(AccountModelTests.fluxer) { _ in
            opened = true
            return URL(string: "sylo://connected")!
        }
        #expect(!connected)
        #expect(!opened)
        #expect(model.platformError == "This Sylo server can't connect a platform from the app. Use its web dashboard.")
    }

    @Test("An already connected platform is not connected again")
    func alreadyConnected() async {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        let connected = await model.connect(AccountModelTests.discord) { _ in URL(string: "sylo://connected")! }
        #expect(!connected)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.StartConnect })
    }

    @Test("Disconnecting sends the platform and reads the account again")
    func disconnects() async throws {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        let done = await model.disconnect(AccountModelTests.discord)
        #expect(done)
        let sent = try #require(clients.calls.compactMap { $0.endpoint as? Endpoints.DisconnectPlatform }.first)
        #expect(sent.platform == .discord)
        #expect(accountLoads(clients) == 2)
        #expect(model.platformError == nil)
    }

    @Test("The only sign-in cannot be disconnected: nothing is sent")
    func onlySignIn() async {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        let only = PlatformConnection(platform: .discord, isConnected: true, canDisconnect: false)
        #expect(await model.disconnect(only) == false)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.DisconnectPlatform })
    }

    @Test("A 409 from the server says it is the only sign-in")
    func conflict() async {
        let model = await loadedModel(Self.clients(disconnect: { _ in throw NetworkError.http(status: 409) }))
        #expect(await model.disconnect(AccountModelTests.discord) == false)
        #expect(model.platformError == "You can't disconnect your only sign-in.")
    }

    @Test("Another failure explains")
    func disconnectFails() async {
        let model = await loadedModel(Self.clients(disconnect: { _ in throw NetworkError.offline }))
        #expect(await model.disconnect(AccountModelTests.discord) == false)
        #expect(model.platformError == NetworkError.offline.userMessage)
    }

    @Test("Revoking a device keeps the account's operator flag")
    func revokeKeepsOperator() async {
        let account = AccountInfo(
            isOperator: true, platforms: [AccountModelTests.discord],
            devices: [AccountModelTests.phone, AccountModelTests.laptop])
        let model = AccountModel(session: makeSignedInSession(clients: StubClients { endpoint in
            if endpoint is Endpoints.RevokeDevice { return OKResponse() }
            return account
        }))
        await model.load()
        await model.revoke(AccountModelTests.laptop)?.value
        #expect(model.account?.isOperator == true)
    }
}

@MainActor
@Suite("Add Sylo to a server")
struct AddToServerModelTests {
    nonisolated static let list = ServerInviteList(invites: [
        ServerInvite(platform: .discord, label: "Discord", url: URL(string: "https://discord.com/oauth2/authorize?client_id=1")!),
    ])

    @Test("Loading shows the links")
    func loads() async {
        let model = AddToServerModel(session: makeSignedInSession(clients: StubClients { _ in Self.list }))
        await model.load()
        #expect(model.invites == Self.list.invites)
        #expect(model.hasLoaded)
        #expect(model.errorMessage == nil)
    }

    @Test("An older Sylo without the list shows nothing and says nothing")
    func older() async {
        let model = AddToServerModel(session: makeSignedInSession(clients: StubClients { _ in throw NetworkError.notFound }))
        await model.load()
        #expect(model.invites.isEmpty)
        #expect(model.hasLoaded)
        #expect(model.errorMessage == nil)
    }

    @Test("Another failure explains")
    func fails() async {
        let model = AddToServerModel(session: makeSignedInSession(clients: StubClients { _ in throw NetworkError.offline }))
        await model.load()
        #expect(!model.hasLoaded)
        #expect(model.errorMessage == NetworkError.offline.userMessage)
    }
}
