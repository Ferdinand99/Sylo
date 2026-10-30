import Foundation
import Observation
import SyloKit
import UIKit
// The delegate methods below take the framework's non-Sendable types onto the main actor.
@preconcurrency import UserNotifications
import os

/// Ticket notifications on this device: the permission, the APNs device token and handing it to
/// the signed-in Sylo server, banners while the app is open, and taps that open a conversation.
///
/// Made once at launch with the session and set as the notification center's delegate before
/// launch finishes, so a tap that launched the app is not lost.
@Observable
final class PushCoordinator: NSObject {
    enum Authorization: Equatable {
        case notDetermined
        case denied
        case authorized
    }

    /// What the person said to the notification prompt; read again whenever the app comes to the
    /// front (it can be changed in the Settings app).
    private(set) var authorization: Authorization
    /// A tapped ticket notification from the signed-in server, for ``MainView`` to open and clear.
    var pendingTicket: TicketNotification?
    /// A tapped dev-log notification from the signed-in server: ``MainView`` opens Settings, and
    /// Settings opens Health and clears it.
    var pendingDevLog = false
    /// Goes up whenever a ticket notification arrives while the app is open, so lists with
    /// ticket counts can reload.
    private(set) var ticketActivity = 0
    /// The ticket conversation on screen, if any: its notifications show no banner.
    @ObservationIgnored var visibleTicket: (server: ServerID, id: Int)?
    /// What the signed-in server knows: whether it can push, on or off, muted servers.
    let settings: NotificationSettingsModel

    private let session: AppSession
    @ObservationIgnored private var deviceToken: Data?
    /// The server and token last sent, so a token is sent once per sign-in.
    @ObservationIgnored private var sentToken: String?
    @ObservationIgnored private var isSending = false

    /// - Parameter pigeon: The Postal Pigeon handles for servers that send through it; nil (previews)
    ///   leaves that way out.
    init(session: AppSession, authorization: Authorization = .notDetermined, pigeon: PushHandleManager? = nil) {
        self.session = session
        self.authorization = authorization
        self.settings = NotificationSettingsModel(session: session, pigeon: pigeon)
        super.init()
    }

    /// The coordinator the app runs with: notifications through Pigeon where the server sends that way.
    static func live(session: AppSession) -> PushCoordinator {
        PushCoordinator(session: session, pigeon: PushHandleManager.live(environment: environment))
    }

    // MARK: - Permission and device token

    /// Reads the permission and, when it is given, asks iOS for the device token. Runs at every
    /// launch and return to the front, since the token can change.
    func refresh() async {
        let status = await Self.authorizationStatus()
        switch status {
        case .authorized, .provisional, .ephemeral: authorization = .authorized
        case .denied: authorization = .denied
        default: authorization = .notDetermined
        }
        if authorization == .authorized {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// Shows the system prompt (alerts, sounds and badges), then registers when allowed.
    func requestAuthorization() async {
        do {
            _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            Self.log.notice("Notification permission request failed: \(error.localizedDescription, privacy: .public)")
        }
        await refresh()
    }

    /// The device token from iOS (``AppDelegate``).
    func didRegister(deviceToken: Data) {
        self.deviceToken = deviceToken
        Task { await sendToken() }
    }

    /// A new sign-in starts without a device token on the server: send it again.
    func didSignIn() async {
        sentToken = nil
        await sendToken()
    }

    /// The person signed in, out or to another server: a Pigeon handle for a server they are no
    /// longer signed in to is taken down, and a server they just signed in to is set up again.
    func sessionChanged() async {
        sentToken = nil
        await settings.reconcileHandles()
        await sendToken()
    }

    /// Registers the device token for the signed-in server (through Pigeon, directly, or through
    /// the official relay: see ``NotificationSettingsModel/register(deviceToken:environment:)``),
    /// once per sign-in and token, unless notifications were turned off in the app for that server.
    func sendToken() async {
        guard let deviceToken, !isSending, case .signedIn(let server) = session.phase,
            !isTurnedOff(on: server)
        else { return }
        let key = "\(server.description) \(PushToken.hex(deviceToken))"
        guard sentToken != key else { return }
        isSending = true
        defer { isSending = false }
        if await settings.register(deviceToken: deviceToken, environment: Self.environment) {
            sentToken = key
        }
    }

    /// The on/off switch in Settings. Off tells the server and stays off on this device until
    /// switched on again; on sends the device token.
    func setEnabled(_ isOn: Bool) async {
        guard case .signedIn(let server) = session.phase else { return }
        let key = Self.turnedOffKey(server)
        if isOn {
            UserDefaults.standard.removeObject(forKey: key)
            sentToken = nil
            if deviceToken == nil {
                await refresh()
            } else {
                await sendToken()
            }
        } else if await settings.unregister() {
            UserDefaults.standard.set(true, forKey: key)
            sentToken = nil
        }
    }

    // MARK: - Notifications

    /// No banner for the conversation on screen; every other notification shows.
    private func presentationOptions(for ticket: TicketNotification?) -> UNNotificationPresentationOptions {
        if ticket != nil { ticketActivity += 1 }
        if let ticket, let visibleTicket, let server = session.server, ticket.matches(server),
            visibleTicket.server == ticket.guildID, visibleTicket.id == ticket.ticketID {
            return []
        }
        return [.banner, .list, .sound]
    }

    /// A tap on a ticket notification from the server the app is signed in to.
    private func handleTap(on ticket: TicketNotification) {
        guard case .signedIn(let server) = session.phase, ticket.matches(server) else { return }
        pendingTicket = ticket
    }

    /// A tap on a dev-log notification from the server the app is signed in to.
    private func handleTap(on devLog: DevLogNotification) {
        guard case .signedIn(let server) = session.phase, devLog.matches(server) else { return }
        pendingDevLog = true
    }

    // MARK: - Helpers

    private func isTurnedOff(on server: ServerURL) -> Bool {
        UserDefaults.standard.bool(forKey: Self.turnedOffKey(server))
    }

    private static func turnedOffKey(_ server: ServerURL) -> String {
        "notificationsTurnedOff:\(server.description)"
    }

    /// Debug builds get development tokens from APNs; TestFlight and the App Store production ones.
    static var environment: PushEnvironment {
        #if DEBUG
        return .development
        #else
        return .production
        #endif
    }

    /// Only the status leaves this function, so the settings object never crosses actors.
    private nonisolated static func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    private static let log = Logger(subsystem: "net.opland.sylo", category: "push")
}

// Main-actor isolated on purpose. iOS calls these through an Objective-C completion handler, and
// Swift calls that handler where the async method finishes. A nonisolated method finishes on a
// background thread, and UIKit stops the app when the tap's handler is called there (the
// TestFlight crash on tapping a ticket notification). Isolated to the main actor, the method hops
// there however iOS calls it, and the handler runs on the main thread.
extension PushCoordinator: UNUserNotificationCenterDelegate {
    @MainActor
    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        presentationOptions(for: TicketNotification(userInfo: notification.request.content.userInfo))
    }

    @MainActor
    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        let userInfo = response.notification.request.content.userInfo
        if let ticket = TicketNotification(userInfo: userInfo) {
            handleTap(on: ticket)
        } else if let devLog = DevLogNotification(userInfo: userInfo) {
            handleTap(on: devLog)
        }
    }
}
