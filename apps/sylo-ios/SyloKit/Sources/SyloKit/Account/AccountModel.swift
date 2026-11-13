import Foundation
import Observation

/// The account page: connected platforms, the devices signed in to the app, and signing the
/// other devices out.
@MainActor
@Observable
public final class AccountModel {
    public private(set) var account: AccountInfo?
    public private(set) var isLoading = false
    /// Why the account could not be loaded.
    public var errorMessage: String?
    /// Why the last revoke did not go through (the device is back in the list).
    public var revokeError: String?
    /// Whether the account deletion is on its way to the server.
    public private(set) var isDeleting = false
    /// Why deleting the account did not go through.
    public var deleteError: String?
    /// The platform being disconnected or connected right now, so its row can show it.
    public private(set) var changingPlatform: Platform?
    /// Why the last disconnect or connect did not go through.
    public var platformError: String?

    /// The Sylo's `/api/mobile/info`, read just now. nil until it was read, and when the read failed
    /// (the screen then falls back to what the session cached). Read again every time the screen
    /// opens, so a server upgraded since sign-in offers "Connect" without a relaunch.
    public private(set) var freshServerInfo: ServerInfo?

    private var revoking: Set<String> = []
    private let session: AppSession
    /// The sign-in (``AppSession/generation``) the loaded ``account`` belongs to.
    private var accountGeneration = -1

    public init(session: AppSession) {
        self.session = session
    }

    /// This device first, then the others by most recent use.
    public var devices: [SignedInDevice] {
        (account?.devices ?? []).sorted { a, b in
            if a.isCurrent != b.isCurrent { return a.isCurrent }
            return a.lastUsedAt > b.lastUsedAt
        }
    }

    /// Only connected platforms, in the server's order.
    public var connectedPlatforms: [PlatformConnection] {
        (account?.platforms ?? []).filter(\.isConnected)
    }

    /// The platforms the account does not have yet (whose login is on), in the server's order.
    public var unconnectedPlatforms: [PlatformConnection] {
        (account?.platforms ?? []).filter { !$0.isConnected }
    }

    /// The platforms that can be added through the app: not yet connected, with their login on, and
    /// only when the server can start a connect for the app (``ServerFeature/appConnect``).
    public func connectablePlatforms(serverInfo: ServerInfo?) -> [PlatformConnection] {
        guard serverInfo?.supports(.appConnect) == true else { return [] }
        return (account?.platforms ?? []).filter { !$0.isConnected && $0.connectPath != nil }
    }

    /// Whether this person runs the Sylo server (an operator), as the server said for the sign-in that
    /// is live now. False until the account is loaded, and false again at once when the sign-in changes
    /// (another account, a new token): what an earlier account was told never counts for a later one.
    /// Only a gate for what the app shows; the server checks every operator call itself.
    public var isOperator: Bool {
        account?.isOperator == true && accountGeneration == session.generation
    }

    /// Whether the account page was read for the sign-in that is live now. False before the first read
    /// and again as soon as the sign-in changes, until the next read; a screen that depends on who is
    /// signed in shows a loading state, not a verdict, while this is false.
    public var hasLoadedForSignIn: Bool {
        account != nil && accountGeneration == session.generation
    }

    /// The operator-only screens the app offers: all of them for an operator, none for anyone else (they
    /// are hidden, not disabled).
    public var operatorFeatures: [OperatorFeature] {
        isOperator ? OperatorFeature.allCases : []
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        let generation = session.generation
        do {
            let loaded = try await session.send(Endpoints.Account())
            // Another sign-in took over while this was on its way: its answer is not this account's.
            guard session.generation == generation else { return }
            account = loaded
            accountGeneration = generation
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    /// Reads the server's info again, for the features that gate what this screen offers
    /// (``connectablePlatforms(serverInfo:)``). A failed read keeps the last one.
    public func refreshServerInfo() async {
        let generation = session.generation
        guard let info = try? await session.send(Endpoints.ServerInfo()), session.generation == generation else { return }
        freshServerInfo = info
    }

    /// Whether signing this device out is on its way to the server.
    public func isRevoking(_ id: String) -> Bool { revoking.contains(id) }

    /// Signs another device out. The row goes at once; on failure it comes back with
    /// ``revokeError``. A 404 (already gone) counts as done.
    /// - Returns: The running revoke, or nil for this device (the app uses Sign Out for that), an
    ///   unknown id, or one already being revoked.
    @discardableResult
    public func revoke(_ device: SignedInDevice) -> Task<Void, Never>? {
        let id = device.id
        guard !revoking.contains(id), let account,
            let index = account.devices.firstIndex(where: { $0.id == id }),
            !account.devices[index].isCurrent
        else { return nil }
        let removed = account.devices[index]
        revokeError = nil
        revoking.insert(id)
        setDevices(account.devices.filter { $0.id != id })
        return Task {
            defer { revoking.remove(id) }
            do {
                _ = try await session.send(Endpoints.RevokeDevice(id: id))
            } catch {
                let error = NetworkError(error)
                if error == .notFound { return }
                restore(removed, at: index)
                if error != .cancelled, error != .unauthorized { revokeError = error.userMessage }
            }
        }
    }

    /// Deletes the Sylo account on this server. On success the app is signed out of it; on failure
    /// ``deleteError`` says why and nothing changes.
    public func deleteAccount() async {
        guard !isDeleting else { return }
        isDeleting = true
        deleteError = nil
        defer { isDeleting = false }
        do {
            try await session.deleteAccount()
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { deleteError = error.userMessage }
        }
    }

    /// Removes a platform login from the account (never the only sign-in). The server then signs
    /// out every app on the account, this one included, so on success the app goes back to sign-in
    /// with a notice; on failure ``platformError`` says why and nothing changes.
    /// - Returns: Whether the platform was disconnected.
    @discardableResult
    public func disconnect(_ connection: PlatformConnection) async -> Bool {
        guard changingPlatform == nil, connection.isConnected, connection.canDisconnect else { return false }
        changingPlatform = connection.platform
        platformError = nil
        defer { changingPlatform = nil }
        let generation = session.generation
        do {
            _ = try await session.send(Endpoints.DisconnectPlatform(platform: connection.platform))
        } catch {
            let error = NetworkError(error)
            if error == .http(status: 409) {
                platformError = "You can't disconnect your only sign-in."
            } else if error != .cancelled, error != .unauthorized {
                platformError = error.userMessage
            }
            return false
        }
        // Every app token of the account was revoked with the login: this device is signed out too.
        // Not when the session changed while the call was on its way (another sign-in took over).
        guard session.generation == generation else { return true }
        session.notice = "\(connection.label) was disconnected, which signs every device out. Sign in again to continue."
        await session.signOut()
        return true
    }

    /// Adds a platform to the account: asks the server for a one-time code, lets `authenticate`
    /// open the connect page for it (the system sign-in sheet in the app) and report where the
    /// sheet ended, then reads the account again. Cancelling is not an error.
    /// - Parameter authenticate: Opens the URL and returns the `sylo://connected` callback; throws
    ///   ``ConnectError/cancelled`` when the person closes the sheet.
    /// - Returns: Whether the platform was connected.
    @discardableResult
    public func connect(
        _ connection: PlatformConnection, authenticate: @MainActor (URL) async throws -> URL
    ) async -> Bool {
        guard changingPlatform == nil, !connection.isConnected, let server = session.server else { return false }
        changingPlatform = connection.platform
        platformError = nil
        defer { changingPlatform = nil }
        do {
            let grant = try await session.send(Endpoints.StartConnect(platform: connection.platform))
            let callback = try await authenticate(server.connectURL(code: grant.code))
            // Only the URL that this call's own sheet returned is read: a `sylo://connected` link that
            // arrives any other way is ignored (the app has no open-URL handler).
            let finished = try ConnectCallback.result(from: callback, expected: connection.platform)
            // The sheet only logged in; this call links the platform to the account.
            _ = try await session.send(Endpoints.CompleteConnect(result: finished.result))
        } catch ConnectError.cancelled {
            return false
        } catch NetworkError.cancelled {
            return false
        } catch let error as ConnectError {
            platformError = Self.message(for: error)
            return false
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { platformError = Self.connectMessage(for: error) }
            return false
        }
        await load()
        return true
    }

    private static func message(for error: ConnectError) -> String {
        switch error {
        case .cancelled: "Cancelled."
        case .wrongCallback, .missingResult, .invalidServerURL: "Connecting didn't finish. Try again."
        case .sheetFailed(let reason): "Couldn't open the sign-in sheet: \(reason)"
        case .serverError(let code): Self.connectFailure(code)
        }
    }

    /// The words for the error code Sylo puts on `sylo://connected`.
    static func connectFailure(_ code: String) -> String {
        switch code {
        case ConnectWire.invalidResponseError: "The platform's answer didn't check out. Try again."
        case ConnectWire.expiredError: "That took too long. Try again."
        case ConnectWire.providerError: "The platform had a problem. Try again in a moment."
        case ConnectWire.tokenRevokedError: "You were signed out of the app while connecting. Sign in and try again."
        case ConnectWire.identityLinkedError: "That login already belongs to another Sylo account."
        case ConnectWire.alreadyLinkedError: "This account already has a login on that platform."
        default: "The platform couldn't be connected. Try again."
        }
    }

    /// The words for what the connect calls answer: by the server's machine code when it sent one
    /// (`invalid_platform`, `already_connected` from the start call; `invalid_result`,
    /// `identity_linked`, `already_linked` from the complete call), else by the status. A code the
    /// app does not know is never shown as it came.
    static func connectMessage(for error: NetworkError) -> String {
        switch error.serverCode {
        case ConnectWire.invalidPlatformJSON: return "This Sylo server doesn't have that platform set up."
        case ConnectWire.alreadyConnectedJSON: return "This account already has a login on that platform."
        case ConnectWire.invalidResultJSON: return "The sign-in result wasn't accepted, or it had expired. Try again."
        case ConnectWire.identityLinkedJSON: return "That login already belongs to another Sylo account."
        case ConnectWire.alreadyLinkedJSON:
            return "A login on that platform was added to this account in the meantime. Refresh and check."
        default: break
        }
        switch error {
        case .notFound: return "This Sylo server is too old to connect a platform from the app. Update Sylo on the server."
        case .http(status: 409):
            return "That login can't be added: it belongs to another Sylo account, or this account already has one on that platform."
        case .badRequest: return "This Sylo server can't connect that platform."
        default: return error.userMessage
        }
    }

    /// Puts a device back at its old position, unless a reload already brought it back.
    private func restore(_ device: SignedInDevice, at index: Int) {
        guard var devices = account?.devices, !devices.contains(where: { $0.id == device.id }) else { return }
        devices.insert(device, at: min(index, devices.count))
        setDevices(devices)
    }

    private func setDevices(_ devices: [SignedInDevice]) {
        guard let account else { return }
        self.account = AccountInfo(
            isOpen: account.isOpen, isOperator: account.isOperator, platforms: account.platforms, devices: devices)
    }
}
