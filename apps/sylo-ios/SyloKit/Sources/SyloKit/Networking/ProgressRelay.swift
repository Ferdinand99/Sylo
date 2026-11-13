import Foundation

/// Passes a transfer's progress, reported from a background queue, to the main actor: one hop at a time
/// however fast the updates come, always the newest value, and never a value lower than one already
/// passed on (a late callback cannot move a progress bar backwards).
final class ProgressRelay: @unchecked Sendable {
    // @unchecked: `latest` and `isScheduled` are only touched while holding `lock`.
    private let lock = NSLock()
    private var latest: (sent: Int64, total: Int64)?
    private var isScheduled = false
    private let apply: @MainActor @Sendable (Int64, Int64) -> Void

    init(apply: @escaping @MainActor @Sendable (Int64, Int64) -> Void) {
        self.apply = apply
    }

    /// Called from any thread with the bytes done so far and the total (0 when not known).
    func report(_ sent: Int64, _ total: Int64) {
        let mustSchedule: Bool = lock.withLock {
            if let current = latest, sent < current.sent { return false }
            latest = (sent, total)
            if isScheduled { return false }
            isScheduled = true
            return true
        }
        guard mustSchedule else { return }
        Task { @MainActor in
            let value: (sent: Int64, total: Int64)? = self.lock.withLock {
                self.isScheduled = false
                return self.latest
            }
            if let value { self.apply(value.sent, value.total) }
        }
    }
}
