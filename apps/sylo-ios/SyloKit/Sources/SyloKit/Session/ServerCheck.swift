/// Whether the app can sign in to a server, from its `GET /api/mobile/info` answer or from why
/// that call failed.
public enum ServerCheck: Equatable, Sendable {
    case ready
    /// The address answered, but not like a Sylo server.
    case notSylo
    /// A Sylo in open mode (no Discord or Fluxer login set up): nobody to sign in as.
    case noLogin
    /// A Sylo from before the app API (no info endpoint, an older API version, or no app login).
    case tooOld
    /// A Sylo whose app API is newer than this build of the app speaks.
    case needsNewerApp
    /// The check itself failed (offline, unreachable, …); trying again may work.
    case failed(NetworkError)

    public init(_ info: ServerInfo) {
        if !info.isSylo {
            self = .notSylo
        } else if info.apiVersion < supportedAPIVersion || !info.supports(.appLogin) {
            self = .tooOld
        } else if info.apiVersion > supportedAPIVersion {
            self = .needsNewerApp
        } else if !info.isLoginEnabled || info.loginProviders.isEmpty {
            self = .noLogin
        } else {
            self = .ready
        }
    }

    public init(_ error: NetworkError) {
        switch error {
        // A Sylo from before the app API has no /api/mobile/info.
        case .notFound: self = .tooOld
        case .notASyloServer, .decoding: self = .notSylo
        default: self = .failed(error)
        }
    }

    /// What to tell the person, or nil when the server is ready.
    public var userMessage: String? {
        switch self {
        case .ready: nil
        case .notSylo: NetworkError.notASyloServer.userMessage
        case .noLogin: "This Sylo server has no sign-in set up. Its owner needs to turn on Discord or Fluxer login."
        case .tooOld: "This Sylo server is too old for the app. Ask its owner to update Sylo."
        case .needsNewerApp: "This Sylo server needs a newer version of the app. Update the app and try again."
        case .failed(let error): error.userMessage
        }
    }
}
