import Foundation
import UIKit
import os

/// The few things only an app delegate hears: the APNs device token, or why there is none.
final class AppDelegate: NSObject, UIApplicationDelegate {
    /// Set by ``SyloApp`` before the app ever asks for a token.
    weak var push: PushCoordinator?

    func application(
        _ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        push?.didRegister(deviceToken: deviceToken)
    }

    /// No token (a simulator without push, no network, or no push entitlement): notifications
    /// simply stay off; nothing to show the person.
    func application(
        _ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error
    ) {
        Self.log.notice("No device token for notifications: \(error.localizedDescription, privacy: .public)")
    }

    private static let log = Logger(subsystem: "net.opland.sylo", category: "push")
}
