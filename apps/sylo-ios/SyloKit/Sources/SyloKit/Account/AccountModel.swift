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

    private var revoking: Set<String> = []
    private let session: AppSession

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

    /// The platforms that can be added through the app: not yet connected, with their login on, and
    /// only when the server can start a connect for the app (``ServerFeature/appConnect``).
    public func connectablePlatforms(serverInfo: ServerInfo?) -> [PlatformConnection] {
        guard serverInfo?.supports(.appConnect) == true else { return [] }
        return (account?.platforms ?? []).filter { !$0.isConnected && $0.connectPath != nil }
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            account = try await session.send(Endpoints.Account())
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
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
            _ = try ConnectCallback.platform(from: callback, expected: connection.platform)
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
        case .wrongCallback, .invalidServerURL: "Connecting didn't finish. Try again."
        case .serverError(let code): Self.connectFailure(code)
        }
    }

    /// The words for the error code Sylo puts on `sylo://connected`.
    static func connectFailure(_ code: String) -> String {
        switch code {
        case "expired": "That took too long. Try again."
        case "identity_linked": "That login already belongs to another Sylo account."
        case "platform_already_linked": "This account already has a login on that platform."
        case "account_gone": "This Sylo account no longer exists."
        default: "The platform couldn't be connected. Try again."
        }
    }

    private static func connectMessage(for error: NetworkError) -> String {
        switch error {
        case .notFound: "This Sylo server can't connect a platform from the app. Use its web dashboard."
        case .http(status: 409): "That platform is already connected."
        case .badRequest: "This Sylo server can't connect that platform."
        default: error.userMessage
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
