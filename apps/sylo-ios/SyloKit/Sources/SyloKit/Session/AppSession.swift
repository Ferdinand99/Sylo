import Foundation
import Observation

/// Which Sylo server the app talks to and whether it is signed in there. The one place that owns
/// the token: every signed-in call goes through ``send(_:)``, so a 401 anywhere signs the app out
/// of that server here, once.
@MainActor
@Observable
public final class AppSession {
    public enum Phase: Equatable, Sendable {
        /// Before ``start()``.
        case starting
        /// No server yet (first launch), or the person asked to use another one.
        case choosingServer
        /// A Sylo server is chosen; the person is not signed in to it.
        case signIn(ServerURL)
        case signedIn(ServerURL)
    }

    public typealias ClientFactory = (ServerURL, _ token: String?) -> any APIClient

    public private(set) var phase: Phase = .starting
    /// The chosen server's `/api/mobile/info`, once loaded; drives the sign-in buttons.
    public private(set) var serverInfo: ServerInfo?
    /// Who signed in, from this launch's sign-in; nil after a restart.
    public private(set) var account: SignedInAccount?
    /// A sign-in or server check is running.
    public private(set) var isBusy = false
    /// Something the person tried did not work; shown, then cleared by the view.
    public var errorMessage: String?
    /// Why the app is back at sign-in when the person didn't sign out (a revoked token).
    public var notice: String?

    /// Bumped on every sign-in and sign-out, so an answer for an older token cannot sign out a
    /// newer one.
    private(set) var generation = 0
    private var client: (any APIClient)?

    private let tokens: any TokenStore
    private let preference: any ServerPreference
    private let deviceName: String
    private let makeClient: ClientFactory

    /// - Parameters:
    ///   - deviceName: Sent with the sign-in, shown in the account's device list.
    ///   - makeClient: Builds the client for a server, with the token or nil.
    public init(
        tokens: any TokenStore, preference: any ServerPreference, deviceName: String,
        makeClient: @escaping ClientFactory
    ) {
        self.tokens = tokens
        self.preference = preference
        self.deviceName = deviceName
        self.makeClient = makeClient
    }

    /// The server in use, whether signed in or not.
    public var server: ServerURL? {
        switch phase {
        case .signIn(let server), .signedIn(let server): server
        case .starting, .choosingServer: nil
        }
    }

    /// The address last used, to fill in the server field.
    public var rememberedAddress: String? { preference.server?.description }

    // MARK: - Starting

    /// Picks up where the last launch left off: signed in when a live token is kept for the
    /// remembered server, else that server's sign-in, else the server choice.
    public func start() {
        guard phase == .starting else { return }
        guard let server = preference.server else {
            phase = .choosingServer
            return
        }
        do {
            if let stored = try tokens.token(for: key(server)) {
                if !stored.isExpired() {
                    enterSignedIn(server, token: stored.token)
                    return
                }
                try? tokens.delete(for: key(server))
            }
        } catch {
            errorMessage = Self.unreadableSignIn
        }
        phase = .signIn(server)
    }

    // MARK: - Choosing a server

    /// Checks the address and, when it is a Sylo the app can sign in to, remembers it and moves
    /// to sign-in. Otherwise explains what is wrong and stays on the server choice.
    public func chooseServer(_ address: String) async {
        guard !isBusy else { return }
        errorMessage = nil
        notice = nil
        let server: ServerURL
        do throws(ServerURLError) {
            server = try ServerURL(address)
        } catch {
            errorMessage = error.userMessage
            return
        }

        isBusy = true
        defer { isBusy = false }
        let (check, info) = await self.check(server)
        guard check == .ready, let info else {
            errorMessage = check.userMessage
            return
        }
        preference.server = server
        serverInfo = info
        phase = .signIn(server)
    }

    /// Loads the chosen server's info for the sign-in screen when it isn't loaded yet (after a
    /// restart or a sign-out).
    public func loadServerInfo() async {
        guard case .signIn(let server) = phase, serverInfo == nil, !isBusy else { return }
        errorMessage = nil
        isBusy = true
        defer { isBusy = false }
        let (check, info) = await self.check(server)
        guard phase == .signIn(server) else { return }
        if check == .ready {
            serverInfo = info
        } else {
            errorMessage = check.userMessage
        }
    }

    /// Back to the server choice, from sign-in.
    public func changeServer() {
        guard case .signIn = phase else { return }
        serverInfo = nil
        errorMessage = nil
        notice = nil
        phase = .choosingServer
    }

    // MARK: - Signing in and out

    /// Runs one sign-in: opens the server's sign-in page through `authenticate` (the system sign-in
    /// sheet in the app), checks the callback, trades the code for a token and keeps it.
    /// Cancelling is not an error.
    /// - Parameters:
    ///   - platform: The login to go straight to, or nil for the server's choice.
    ///   - authenticate: Opens the start URL and returns the `sylo://` callback URL; throws
    ///     ``SignInError/cancelled`` when the person closes the sheet.
    public func signIn(
        with platform: Platform?, authenticate: @MainActor (URL) async throws -> URL
    ) async {
        guard case .signIn(let server) = phase, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        errorMessage = nil
        notice = nil
        do {
            let request = try SignInRequest(
                server: server.baseURL, platform: platform.flatMap { SignInPlatform(rawValue: $0.rawValue) })
            let callback = try await authenticate(request.startURL)
            let code = try request.authorizationCode(from: callback)
            let grant = try await makeClient(server, nil).send(
                Endpoints.ExchangeCode(code: code, verifier: request.pkce.verifier, deviceName: deviceName))
            try tokens.save(StoredToken(token: grant.token, expiresAt: grant.expiresAt), for: key(server))
            guard phase == .signIn(server) else { return }
            account = grant.account
            enterSignedIn(server, token: grant.token)
        } catch SignInError.cancelled {
            // The person closed the sheet or pressed Cancel: nothing to say.
        } catch NetworkError.cancelled {
        } catch let error as SignInError {
            errorMessage = Self.message(for: error)
        } catch let error as NetworkError {
            errorMessage = error.userMessage
        } catch is TokenStoreError {
            errorMessage = Self.unsavableSignIn
        } catch {
            errorMessage = Self.unfinishedSignIn
        }
    }

    /// Signs this device out: forgets the token here at once, then asks the server to revoke it
    /// (best effort; offline, the token simply stays unused until it expires).
    public func signOut() async {
        guard case .signedIn(let server) = phase else { return }
        let client = self.client
        signOutLocally(of: server)
        _ = try? await client?.send(Endpoints.SignOut())
    }

    // MARK: - Signed-in calls

    /// Sends a call with the token. A 401 signs the app out of this server (with a ``notice``)
    /// before the error is rethrown.
    public func send<E: APIEndpoint>(_ endpoint: E) async throws -> E.Response {
        guard let client else { throw NetworkError.unauthorized }
        let generation = self.generation
        do {
            return try await client.send(endpoint)
        } catch NetworkError.unauthorized {
            handleUnauthorized(generation: generation)
            throw NetworkError.unauthorized
        }
    }

    /// Sends a call that needs no sign-in to another server (the notification relay), with a
    /// client that has no token: the Sylo server's token never goes anywhere else.
    public func send<E: APIEndpoint>(_ endpoint: E, to server: ServerURL) async throws -> E.Response {
        try await makeClient(server, nil).send(endpoint)
    }

    /// The token sent with a call started at `generation` was refused.
    func handleUnauthorized(generation: Int) {
        guard generation == self.generation, case .signedIn(let server) = phase else { return }
        signOutLocally(of: server)
        notice = NetworkError.unauthorized.userMessage
    }

    // MARK: - Helpers

    private func enterSignedIn(_ server: ServerURL, token: String) {
        generation += 1
        client = makeClient(server, token)
        phase = .signedIn(server)
    }

    private func signOutLocally(of server: ServerURL) {
        generation += 1
        try? tokens.delete(for: key(server))
        client = nil
        account = nil
        phase = .signIn(server)
    }

    private func check(_ server: ServerURL) async -> (ServerCheck, ServerInfo?) {
        do {
            let info = try await makeClient(server, nil).send(Endpoints.ServerInfo())
            return (ServerCheck(info), info)
        } catch {
            return (ServerCheck(NetworkError(error)), nil)
        }
    }

    /// The token store key: the full server address, so two Sylo servers under one domain on
    /// different paths keep separate tokens.
    private func key(_ server: ServerURL) -> String { server.description }

    private static func message(for error: SignInError) -> String {
        switch error {
        case .invalidServerURL: ServerURLError.invalid.userMessage
        case .serverError: "The server couldn't sign you in. Try again."
        case .cancelled, .stateMismatch, .wrongCallback, .missingCode: unfinishedSignIn
        }
    }

    private static let unfinishedSignIn = "Sign-in didn't finish. Try again."
    private static let unsavableSignIn = "Couldn't keep your sign-in on this device. Try again."
    private static let unreadableSignIn = "Couldn't read your sign-in on this device. Sign in again."
}
