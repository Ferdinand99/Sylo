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

    private let session: AppSession

    public init(session: AppSession) {
        self.session = session
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
            testResult = result.ok ? .sent : .failed(result.error ?? "The test message could not be sent.")
        } catch {
            testResult = .failed(NetworkError(error).userMessage)
        }
    }

    private func show(_ error: any Error) {
        let error = NetworkError(error)
        if error == .cancelled || error == .unauthorized { return }
        errorMessage = error == .forbidden ? "Health is only for this Sylo's operators." : error.userMessage
    }
}
