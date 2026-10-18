import Foundation
import Observation

/// Ticket notifications for the signed-in Sylo server: whether that server can send them, whether
/// they are on for this device, and which chat servers are muted. Registers this device: with the
/// server directly when it has its own APNs key, else with the official relay first, so the
/// server only ever gets the relay's token.
///
/// The notification permission itself is the app's (it needs UIKit); this is what the Sylo
/// server knows.
@MainActor
@Observable
public final class NotificationSettingsModel {
    /// Notifications are on for this sign-in (the server has this device's token).
    public private(set) var isEnabled = false
    public private(set) var mutedServers: Set<ServerID> = []
    /// Which of Sylo's own errors and warnings this device hears about; nil for anyone who is not
    /// an operator of the signed-in server.
    public private(set) var devLog: DevLogNotificationLevel?
    /// Whether the push settings were loaded at least once for the signed-in server.
    public private(set) var hasLoaded = false
    public private(set) var isLoading = false
    /// Why the last load, registration or switch did not work.
    public var errorMessage: String?

    /// `/api/mobile/info` fetched here, when the session didn't have it (signed in at launch).
    private var fetchedInfo: ServerInfo?
    private var fetchedFor: ServerURL?
    /// The server ``isEnabled`` and ``mutedServers`` were loaded for.
    private var loadedFor: ServerURL?
    private var pending: Set<ServerID> = []
    private let session: AppSession

    public init(session: AppSession) {
        self.session = session
    }

    /// Whether the signed-in server can send notifications: `push` in its features, and no relay
    /// or the official one. False until that is known (``hasLoadedAvailability``).
    public var isAvailable: Bool {
        guard let info, info.supports(.push) else { return false }
        return info.pushRelay.map(PushRelay.isOfficial) ?? true
    }

    /// Why a server that can push gets no notifications on this device (a relay other than the
    /// official one); nil otherwise.
    public var unavailableReason: String? {
        guard let info, info.supports(.push), let relay = info.pushRelay, !PushRelay.isOfficial(relay) else {
            return nil
        }
        return Self.untrustedRelayMessage
    }

    /// Whether ``isAvailable`` is known.
    public var hasLoadedAvailability: Bool { info != nil }

    public func isMuted(_ server: ServerID) -> Bool { mutedServers.contains(server) }

    /// Whether a mute or unmute of this server is on its way to the server.
    public func isPending(_ server: ServerID) -> Bool { pending.contains(server) }

    // MARK: - Loading

    /// Asks the signed-in server whether it can push, unless that is known already.
    public func loadAvailability() async {
        guard info == nil, case .signedIn(let server) = session.phase else { return }
        do {
            let info = try await session.send(Endpoints.ServerInfo())
            guard session.server == server else { return }
            fetchedInfo = info
            fetchedFor = server
        } catch {
            show(error)
        }
    }

    /// Loads whether notifications are on and which servers are muted. A server that can't push
    /// is never asked.
    public func load() async {
        guard case .signedIn(let server) = session.phase else { return }
        if loadedFor != server {
            loadedFor = server
            isEnabled = false
            mutedServers = []
            devLog = nil
            hasLoaded = false
        }
        isLoading = true
        defer { isLoading = false }
        await loadAvailability()
        guard isAvailable else {
            if hasLoadedAvailability { errorMessage = nil }
            return
        }
        do {
            let settings = try await session.send(Endpoints.PushSettings())
            isEnabled = settings.isEnabled
            mutedServers = Set(settings.mutedServers)
            devLog = settings.devLog
            hasLoaded = true
            errorMessage = nil
        } catch {
            show(error)
        }
    }

    // MARK: - Turning on and off

    /// Turns notifications on for this device: sends its APNs token to the signed-in server, or,
    /// when that server sends through the relay, registers with the official relay (without the
    /// server's token) and sends the server only the relay's token.
    /// - Returns: Whether it worked; false without asking anyone when the server can't push here.
    public func register(deviceToken: Data, environment: PushEnvironment) async -> Bool {
        await loadAvailability()
        guard isAvailable, let info, case .signedIn(let server) = session.phase else { return false }
        let hex = PushToken.hex(deviceToken)

        let endpoint: Endpoints.RegisterPush
        if info.pushRelay != nil {
            do {
                let registration = try await session.send(
                    Endpoints.RegisterWithRelay(deviceToken: hex, environment: environment, instance: server),
                    to: PushRelay.official)
                endpoint = Endpoints.RegisterPush(relayToken: registration.relayToken, environment: environment)
            } catch {
                switch NetworkError(error) {
                case .badRequest(let message) where message == "invalid_request":
                    errorMessage = Self.invalidTokenMessage
                default:
                    show(error)
                }
                return false
            }
            guard session.server == server else { return false }
        } else {
            endpoint = Endpoints.RegisterPush(deviceToken: hex, environment: environment)
        }

        do {
            _ = try await session.send(endpoint)
            isEnabled = true
            errorMessage = nil
            return true
        } catch {
            switch NetworkError(error) {
            case .badRequest(let message) where message == "invalid_push_token":
                errorMessage = Self.invalidTokenMessage
            case .badRequest(let message) where message == "relay_token_required" || message == "device_token_required":
                // The server switched between its own key and the relay: check it again next time.
                fetchedInfo = nil
                fetchedFor = nil
                errorMessage = Self.modeChangedMessage
            case .server(status: 503):
                errorMessage = Self.unavailableMessage
            default:
                show(error)
            }
            return false
        }
    }

    /// Turns notifications off for this sign-in.
    /// - Returns: Whether the server confirmed it.
    @discardableResult
    public func unregister() async -> Bool {
        do {
            _ = try await session.send(Endpoints.UnregisterPush())
            isEnabled = false
            errorMessage = nil
            return true
        } catch {
            show(error)
            return false
        }
    }

    // MARK: - Muting

    /// Mutes or unmutes one server. The switch changes at once; when the server answers it shows
    /// the server's list, and on failure it goes back with an ``errorMessage``.
    /// - Returns: The running switch, or nil when there is nothing to do (already so, or a switch
    ///   of this server is on its way).
    @discardableResult
    public func setMuted(_ server: ServerID, _ muted: Bool) -> Task<Void, Never>? {
        guard !pending.contains(server), isMuted(server) != muted else { return nil }
        errorMessage = nil
        pending.insert(server)
        apply(server, muted: muted)
        return Task {
            defer { pending.remove(server) }
            do {
                let result = try await session.send(Endpoints.MutePushForServer(server: server, muted: muted))
                // Other switches still on their way keep showing what was asked.
                var next = Set(result.mutedServers)
                for other in pending where other != server {
                    if isMuted(other) { next.insert(other) } else { next.remove(other) }
                }
                mutedServers = next
            } catch {
                apply(server, muted: !muted)
                show(error)
            }
        }
    }

    // MARK: - Dev log

    /// Chooses which dev-log events this device is notified about. Shows the choice at once and
    /// goes back, with an ``errorMessage``, when the server refuses it.
    public func setDevLog(_ level: DevLogNotificationLevel) async {
        guard let previous = devLog, previous != level else { return }
        devLog = level
        errorMessage = nil
        do {
            devLog = try await session.send(Endpoints.SetDevLogNotifications(level: level)).devLog
        } catch {
            devLog = previous
            let error = NetworkError(error)
            if error == .cancelled { return }
            errorMessage = error.userMessage
        }
    }

    // MARK: - Helpers

    private var info: ServerInfo? {
        if let info = session.serverInfo { return info }
        guard let fetchedInfo, fetchedFor == session.server else { return nil }
        return fetchedInfo
    }

    private func apply(_ server: ServerID, muted: Bool) {
        if muted { mutedServers.insert(server) } else { mutedServers.remove(server) }
    }

    /// Shows an error, except a cancelled call or a sign-out (the session shows that).
    private func show(_ error: any Error) {
        let error = NetworkError(error)
        if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
    }

    static let invalidTokenMessage = "This device couldn't be set up for notifications. Try again later."
    static let unavailableMessage = "This Sylo server can't send notifications right now. Try again later."
    static let untrustedRelayMessage = "This Sylo server uses a notification relay the app doesn't trust."
    static let modeChangedMessage = "This Sylo server changed how it sends notifications. Try again."
}
