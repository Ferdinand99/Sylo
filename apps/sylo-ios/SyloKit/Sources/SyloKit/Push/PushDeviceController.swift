import Foundation

/// How the app asks iOS for, or gives up, remote notifications. The app implements it with
/// `UIApplication`; tests record the calls.
@MainActor
public protocol RemoteNotificationRegistrar {
    func register()
    func unregister()
}

/// What the app does with iOS and its device token around sign-in and sign-out, kept out of UIKit so it is
/// tested: signing out unregisters from iOS and forgets the token and what was registered; a token that
/// arrives while signed out is ignored; the app only asks iOS for a token while signed in, and only after
/// the servers of earlier sign-outs that could not be reached were told once more
/// (``AppSession/revokePending(within:)``), so a stale registration cannot deliver again under the new one.
@MainActor
public final class PushDeviceController {
    public var state = PushDeviceState()
    private let session: AppSession
    private let registrar: any RemoteNotificationRegistrar

    public init(session: AppSession, registrar: any RemoteNotificationRegistrar) {
        self.session = session
        self.registrar = registrar
    }

    /// The session's phase changed (or the app started): signed out gives up notifications on this device
    /// (whether or not the server could be told); anything else asks for a new registration.
    public func phaseChanged() {
        switch session.phase {
        case .signIn, .choosingServer:
            registrar.unregister()
            state.signedOut()
        case .starting, .signedIn:
            state.forgetRegistration()
        }
    }

    /// iOS gave the app a device token.
    /// - Returns: Whether it was kept: a token that arrives after a sign-out is not stored or sent.
    @discardableResult
    public func received(deviceToken: Data) -> Bool {
        guard case .signedIn = session.phase else { return false }
        state.received(deviceToken: deviceToken)
        return true
    }

    /// Asks iOS for a device token, when signed in, after the pending revocations were replayed.
    public func requestDeviceToken() async {
        guard case .signedIn = session.phase else { return }
        await session.revokePending()
        // Signed out while waiting: nothing to register.
        guard case .signedIn = session.phase else { return }
        registrar.register()
    }
}
