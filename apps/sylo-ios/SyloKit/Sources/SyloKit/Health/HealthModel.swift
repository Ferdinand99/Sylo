import Foundation
import Observation

/// The Health page for Sylo's operators: the server's report and its stored dev log, read only.
/// Anyone else gets a 403 from the server, shown as a message.
@MainActor
@Observable
public final class HealthModel {
    public enum TestResult: Equatable, Sendable {
        case sent
        case failed(String)
    }

    public private(set) var report: HealthReport?
    public private(set) var entries: [DevLogEntry] = []
    public private(set) var isLoading = false
    /// Errors only, or errors and warnings.
    public var errorsOnly = false
    public private(set) var isSendingTest = false
    /// The last "send a test to the dev-log channel".
    public private(set) var testResult: TestResult?
    /// Why the report or the log could not be loaded.
    public var errorMessage: String?

    /// The backup being restored, from the moment the restore is sent until Sylo answers again.
    /// While it is set the screen blocks every other action, as the dashboard does.
    public private(set) var restoringFrom: String?
    /// Why a restore could not be started.
    public var restoreError: String?

    private let session: AppSession
    private let pollInterval: Duration
    private let maxPolls: Int

    /// - Parameters:
    ///   - pollInterval: How long to wait between questions to a restarting Sylo.
    ///   - maxPolls: How many times to ask before giving up (about five minutes by default).
    public init(session: AppSession, pollInterval: Duration = .milliseconds(1500), maxPolls: Int = 200) {
        self.session = session
        self.pollInterval = pollInterval
        self.maxPolls = maxPolls
    }

    /// The report and the log, together.
    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let report = session.send(Endpoints.Health())
            async let log = session.send(Endpoints.DevLog(errorsOnly: errorsOnly))
            (self.report, entries) = try await (report, log.entries)
            errorMessage = nil
        } catch {
            show(error)
        }
    }

    /// The log again, after ``errorsOnly`` changed or to refresh it.
    public func loadLog() async {
        do {
            entries = try await session.send(Endpoints.DevLog(errorsOnly: errorsOnly)).entries
            errorMessage = nil
        } catch {
            show(error)
        }
    }

    /// Posts a test message to the dev-log channel, and says whether it arrived.
    public func sendTest() async {
        isSendingTest = true
        defer { isSendingTest = false }
        do {
            let result = try await session.send(Endpoints.SendDevLogTest())
            testResult = result.ok ? .sent : .failed(result.error ?? "Couldn't send the test message. Check the dev-log channel, then try again.")
        } catch {
            testResult = .failed(NetworkError(error).userMessage)
        }
    }

    /// Replaces the database with a backup, then waits until Sylo is back and loads the page:
    /// ``beginRestore(backup:)`` and ``waitForRestart()`` in one call.
    public func restore(backup name: String) async {
        if await beginRestore(backup: name) { await waitForRestart() }
    }

    /// Asks the server to replace the database with a backup. Sets ``restoringFrom`` from here on, so
    /// the screen blocks every other action, as the dashboard does, and ``restoreError`` when the
    /// server refused.
    /// - Returns: Whether the server accepted the restore. Sylo is restarting then: call ``waitForRestart()``.
    public func beginRestore(backup name: String) async -> Bool {
        guard restoringFrom == nil else { return false }
        restoreError = nil
        restoringFrom = name
        do {
            _ = try await session.send(Endpoints.RestoreBackup(name: name))
            return true
        } catch {
            restoringFrom = nil
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { restoreError = error.detailMessage }
            return false
        }
    }

    /// Asks `/api/v2/health` until Sylo answers again (like the dashboard), then loads the page and
    /// clears ``restoringFrom``. Any answer counts, also a refusal: Sylo is back. A 401 means the
    /// restored data does not know this device; the session has signed out already.
    public func waitForRestart() async {
        guard restoringFrom != nil else { return }
        defer { restoringFrom = nil }
        for _ in 0..<maxPolls {
            do {
                try await Task.sleep(for: pollInterval)
            } catch {
                return
            }
            do {
                _ = try await session.send(Endpoints.Health())
                await load()
                return
            } catch {
                let error = NetworkError(error)
                if error == .cancelled || error == .unauthorized { return }
                if Self.isStillDown(error) { continue }
                show(error)
                return
            }
        }
        errorMessage = "Sylo has not answered yet. Pull down to check again in a moment."
    }

    /// Whether this failure is what a restarting Sylo (or the proxy in front of it) looks like.
    private static func isStillDown(_ error: NetworkError) -> Bool {
        switch error {
        case .timeout, .offline, .unreachable, .transport, .secureConnectionFailed, .notASyloServer, .server: true
        default: false
        }
    }

    private func show(_ error: any Error) {
        let error = NetworkError(error)
        if error == .cancelled || error == .unauthorized { return }
        errorMessage = error == .forbidden(message: nil) ? "Health is only for this Sylo's operators." : error.userMessage
    }
}
