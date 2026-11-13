import UIKit

/// Asks iOS for a little time to finish work when the app goes to the background (the system allows
/// about half a minute). An upload that is cut off in the middle sends nothing the server keeps, so when
/// the time runs out the work is stopped on purpose instead of being killed with the app.
@MainActor
final class BackgroundActivity {
    private var identifier = UIBackgroundTaskIdentifier.invalid

    /// Starts the grace period. `onExpire` runs when iOS takes the time back.
    func begin(_ name: String, onExpire: @escaping @MainActor () -> Void) {
        guard identifier == .invalid else { return }
        identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            // The system calls this on the main thread.
            MainActor.assumeIsolated {
                onExpire()
                self?.end()
            }
        }
    }

    /// Gives the time back. Safe to call when nothing is running.
    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}
