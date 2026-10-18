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

    /// Puts a device back at its old position, unless a reload already brought it back.
    private func restore(_ device: SignedInDevice, at index: Int) {
        guard var devices = account?.devices, !devices.contains(where: { $0.id == device.id }) else { return }
        devices.insert(device, at: min(index, devices.count))
        setDevices(devices)
    }

    private func setDevices(_ devices: [SignedInDevice]) {
        guard let account else { return }
        self.account = AccountInfo(isOpen: account.isOpen, platforms: account.platforms, devices: devices)
    }
}
