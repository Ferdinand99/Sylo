import Foundation
import Observation

// Database backups, for the operators of a Sylo server (web-v2/src/pages/Health.jsx, the "Database &
// backups" part; `/api/v2/health/backups*`, `requireOwner`): list, create, delete, download, restore
// and import. A backup holds the personal data of every server, so a downloaded file is only ever kept
// in the temporary folder (``DownloadedFile``) and shown through Quick Look or the share sheet.

/// What the server takes for a backup import.
public enum BackupLimits {
    /// `POST /api/v2/health/backups/import` reads a raw body of at most 128 MB (`raw({limit: '128mb'})`),
    /// far over the 2 MB of a picture, so it has its own limit.
    public static let maxImportBytes: Int64 = 128 * 1024 * 1024
    /// An import is sent as the raw bytes, not as JSON: a JSON body is cut at 256 kB before the route
    /// sees it.
    public static let importContentType = "application/octet-stream"
}

/// `{name}`, the answer to creating or importing a backup.
public struct BackupNameAnswer: Decodable, Sendable, Equatable {
    public let name: String

    public init(name: String) { self.name = name }
}

extension Endpoints {
    /// `POST /api/v2/health/backups`: takes a backup now and answers its name.
    public struct CreateBackup: APIEndpoint {
        public typealias Response = BackupNameAnswer
        public init() {}
        public var path: String { "/api/v2/health/backups" }
        public var method: HTTPMethod { .post }
    }

    /// `POST /api/v2/health/backups/:name/delete`.
    public struct DeleteBackup: APIEndpoint {
        public typealias Response = OKResponse
        public let name: String
        public init(name: String) { self.name = name }
        public var path: String { "/api/v2/health/backups/\(name.encodedPathSegment)/delete" }
        public var method: HTTPMethod { .post }
    }

    /// `POST /api/v2/health/backups/:name/restore`: replaces the live database with the backup and
    /// restarts the bot (the server answers first, then exits).
    public struct RestoreBackup: APIEndpoint {
        public typealias Response = OKResponse
        public let name: String
        public init(name: String) { self.name = name }
        public var path: String { "/api/v2/health/backups/\(name.encodedPathSegment)/restore" }
        public var method: HTTPMethod { .post }
    }

    /// `POST /api/v2/health/backups/import`: a raw body, sent as `application/octet-stream` and streamed
    /// from the file on disk (never read into memory). The server stores it as a snapshot and answers its
    /// name; nothing is restored.
    public struct ImportBackup: APIEndpoint {
        public typealias Response = BackupNameAnswer
        public let fileURL: URL
        public init(fileURL: URL) { self.fileURL = fileURL }
        public var path: String { "/api/v2/health/backups/import" }
        public var method: HTTPMethod { .post }
        public var uploadFile: UploadFile? {
            UploadFile(fileURL: fileURL, contentType: BackupLimits.importContentType, maxBytes: BackupLimits.maxImportBytes)
        }
    }

    /// `GET /api/v2/health/backups/:name`: the backup file, as a download (up to
    /// ``URLSessionAPIClient/largeDownloadBytes``).
    public struct DownloadBackup: APIEndpoint {
        public typealias Response = EmptyResponse
        public let name: String
        public init(name: String) { self.name = name }
        public var path: String { "/api/v2/health/backups/\(name.encodedPathSegment)" }
        public var isLargeDownload: Bool { true }
    }
}

/// The Backups screen: the list, and creating, deleting and restoring.
@MainActor
@Observable
public final class BackupsModel {
    public private(set) var report: HealthReport?
    public private(set) var isLoading = false
    /// A create, delete or restore request is on its way.
    public private(set) var isWorking = false
    /// The server said this account is not an operator (403): nothing is shown.
    public private(set) var isRefused = false
    /// The name of the backup being restored, from the server's yes until Sylo answers again.
    public private(set) var restoring: String?
    /// Why the list could not be loaded.
    public var errorMessage: String?
    /// Why the last change did not go through.
    public var actionError: String?
    /// What the last change did ("Backup created: sylo-1.db"), shown until the next one.
    public var notice: String?

    private let session: AppSession
    private let firstPoll: Duration
    private let pollEvery: Duration
    private let giveUpAfter: Duration

    /// - Parameters:
    ///   - firstPoll: How long to wait after a restore before asking whether Sylo is back (it exits a
    ///     moment after it answers).
    ///   - pollEvery: The time between asking.
    ///   - giveUpAfter: How long to wait for Sylo to come back before saying so.
    public init(
        session: AppSession, firstPoll: Duration = .seconds(3), pollEvery: Duration = .seconds(2),
        giveUpAfter: Duration = .seconds(300)
    ) {
        self.session = session
        self.firstPoll = firstPoll
        self.pollEvery = pollEvery
        self.giveUpAfter = giveUpAfter
    }

    public var backups: [HealthReport.Backup] { report?.backups ?? [] }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        let generation = session.generation
        do {
            let loaded = try await session.send(Endpoints.Health())
            guard session.generation == generation else { return }
            report = loaded
            isRefused = false
            errorMessage = nil
        } catch {
            guard session.generation == generation else { return }
            if let text = describe(error) { errorMessage = text }
            if isRefused { report = nil }
        }
    }

    /// Takes a backup now.
    @discardableResult
    public func create() async -> Bool {
        await change { generation in
            let made = try await self.session.send(Endpoints.CreateBackup())
            guard self.session.generation == generation else { return }
            self.notice = "Backup created: \(made.name)"
        }
    }

    /// Deletes a backup for good. `typed` is what the person typed to confirm
    /// (``OperatorConfirmation/deleteBackup(name:)``); nothing is sent without it.
    @discardableResult
    public func delete(_ name: String, typed: String) async -> Bool {
        guard confirmed(.deleteBackup(name: name), typed) else { return false }
        return await change { generation in
            _ = try await self.session.send(Endpoints.DeleteBackup(name: name))
            guard self.session.generation == generation else { return }
            self.notice = "Deleted \(name)."
        }
    }

    /// Replaces the live database with a backup and restarts the bot, then waits until Sylo answers
    /// again. `typed` is what the person typed to confirm (``OperatorConfirmation/restore(backup:)``);
    /// nothing is sent without it. A restore may also sign this device out (the backup holds the sign-ins
    /// it had), which the session handles like any other 401.
    /// - Returns: Whether the server took the restore.
    @discardableResult
    public func restore(_ name: String, typed: String) async -> Bool {
        guard confirmed(.restore(backup: name), typed) else { return false }
        // Where the old process stands, to tell it from a restarted one afterwards.
        let before = await uptimeBeforeRestore()
        let logBaseline = await newestErrorID()
        let started = await change { generation in
            _ = try await self.session.send(Endpoints.RestoreBackup(name: name))
            guard self.session.generation == generation else { return }
            self.restoring = name
        }
        guard started, restoring == name else { return started }
        await waitForRestart(from: name, before: before, logBaseline: logBaseline)
        return true
    }

    // MARK: - Helpers

    private func confirmed(_ confirmation: OperatorConfirmation, _ typed: String) -> Bool {
        guard confirmation.accepts(typed) else {
            actionError = "Type \(confirmation.word) to confirm."
            return false
        }
        return true
    }

    private func change(_ call: @MainActor (_ generation: Int) async throws -> Void) async -> Bool {
        guard !isWorking, restoring == nil, !isRefused else { return false }
        isWorking = true
        defer { isWorking = false }
        actionError = nil
        notice = nil
        let generation = session.generation
        do {
            try await call(generation)
        } catch {
            guard session.generation == generation else { return false }
            actionError = describe(error)
            return false
        }
        guard session.generation == generation else { return false }
        if restoring == nil { await load() }
        return true
    }

    /// Waits until the server has really restarted, like the dashboard does with its poll, but without
    /// believing the first answer: while the restore runs (the snapshot of the current database, a
    /// `pg_restore`) the old process still answers `GET /health`, and if the snapshot fails the server
    /// never restarts at all. Success needs evidence of a restart:
    /// - the uptime is lower than the old process's could be (both known), or
    /// - when an uptime is missing, a poll failed the way a restarting server fails (refused, timed out,
    ///   a proxy's 5xx) before it answered again.
    ///
    /// Otherwise it keeps asking until `giveUpAfter`, stops early when the dev log says the snapshot
    /// failed, and ends with a message that says the restore could not be confirmed. A refused token
    /// ends the wait too: the restore went back to a database that does not know this sign-in, and the
    /// session has already signed the app out.
    private func waitForRestart(from name: String, before: UptimeReading?, logBaseline: Int?) async {
        let generation = session.generation
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: giveUpAfter)
        var sawDown = false
        do {
            try await Task.sleep(for: firstPoll)
            while clock.now < deadline {
                guard session.generation == generation else { restoring = nil; return }
                do {
                    let loaded = try await session.send(Endpoints.Health())
                    guard session.generation == generation else { restoring = nil; return }
                    let elapsed = before.map { clock.now - $0.at } ?? .zero
                    if Self.hasRestarted(loaded, before: before?.seconds, elapsed: elapsed, sawDown: sawDown) {
                        report = loaded
                        restoring = nil
                        notice = "Restored from \(name). Sylo is back."
                        return
                    }
                    // Still the old process: say so at once when the server gave up on the restore.
                    if await snapshotFailed(after: logBaseline) {
                        restoring = nil
                        actionError = "The server could not take a snapshot of the current database first, so it did not restore anything. Check the dev log."
                        return
                    }
                } catch {
                    let error = NetworkError(error)
                    if error == .unauthorized { restoring = nil; return }
                    if Self.looksLikeARestart(error) { sawDown = true }
                }
                try await Task.sleep(for: pollEvery)
            }
        } catch {
            // Cancelled: stop waiting.
            restoring = nil
            return
        }
        restoring = nil
        actionError = sawDown
            ? "Couldn't confirm the restore: Sylo went away but did not come back with a restarted process. Check Health and the dev log."
            : "Couldn't confirm the restore: Sylo never restarted, so the restore may not have run. Check Health and the dev log."
    }

    /// An answer is from a restarted process when its uptime is lower than the old process's could be by
    /// now. With either uptime missing, a failed poll before the answer counts instead. A server that was
    /// young when the restore began (under three minutes) cannot be told apart by uptime, so a failed poll
    /// counts there too.
    nonisolated static func hasRestarted(_ report: HealthReport, before: Int?, elapsed: Duration, sawDown: Bool) -> Bool {
        guard let before, let now = report.uptimeSeconds else { return sawDown }
        let expectedIfUnchanged = before + Int(elapsed.components.seconds)
        // Uptimes over an hour have a one-minute granularity.
        if now + 60 < expectedIfUnchanged { return true }
        return sawDown && expectedIfUnchanged < 180
    }

    /// Whether a failed poll is how a restarting server fails, and not the phone losing its connection.
    nonisolated static func looksLikeARestart(_ error: NetworkError) -> Bool {
        switch error {
        case .unreachable, .timeout, .server: true
        default: false
        }
    }

    /// Where the old process stood before the restore: its uptime, and when that was read.
    struct UptimeReading {
        let seconds: Int
        let at: ContinuousClock.Instant
    }

    private func uptimeBeforeRestore() async -> UptimeReading? {
        guard let fresh = try? await session.send(Endpoints.Health()), let seconds = fresh.uptimeSeconds else { return nil }
        return UptimeReading(seconds: seconds, at: ContinuousClock().now)
    }

    /// The newest error in the dev log now, 0 for an empty log, nil when the log cannot be read (then a
    /// failed snapshot cannot be told from the log).
    private func newestErrorID() async -> Int? {
        guard let page = try? await session.send(Endpoints.DevLog(errorsOnly: true, limit: 20)) else { return nil }
        return page.entries.map(\.id).max() ?? 0
    }

    /// Whether the dev log has a new error saying the snapshot before the restore failed (the server
    /// then returns without restoring or restarting).
    private func snapshotFailed(after baseline: Int?) async -> Bool {
        guard let baseline, let page = try? await session.send(Endpoints.DevLog(errorsOnly: true, limit: 20)) else {
            return false
        }
        return page.entries.contains {
            $0.id > baseline && $0.message.localizedCaseInsensitiveContains("pre-restore snapshot failed")
        }
    }

    private func describe(_ error: any Error) -> String? {
        let error = NetworkError(error)
        if error == .cancelled || error == .unauthorized { return nil }
        if OperatorOnly.isRefusal(error) {
            isRefused = true
            return OperatorOnly.refusal
        }
        return error.userMessage
    }
}

/// Importing a backup file: streams it from the disk to the server with progress, and can be
/// cancelled. The file is stored as a snapshot; nothing is restored.
@MainActor
@Observable
public final class BackupImportModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case uploading
        /// Stored as this snapshot.
        case imported(String)
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    public private(set) var bytesSent: Int64 = 0
    public private(set) var bytesTotal: Int64 = 0

    private let session: AppSession
    private var task: Task<Void, Never>?
    /// Counts the starts, so a cancelled upload's late answer cannot overwrite a newer one.
    private var attempt = 0

    public init(session: AppSession) {
        self.session = session
    }

    public var isUploading: Bool { phase == .uploading }

    /// How much has gone out, 0 to 1; nil before the first byte, when the total is not known yet.
    public var fraction: Double? {
        guard bytesTotal > 0 else { return nil }
        return min(1, Double(bytesSent) / Double(bytesTotal))
    }

    /// Starts sending the file at `fileURL` (from the disk, not read into memory). Needs the typed word
    /// (``OperatorConfirmation/importFile(name:)``) and a file within ``BackupLimits/maxImportBytes``;
    /// otherwise nothing is sent and the phase says why.
    /// - Returns: Whether the upload started.
    @discardableResult
    public func start(fileURL: URL, typed: String) -> Bool {
        guard !isUploading else { return false }
        let confirmation = OperatorConfirmation.importFile(name: fileURL.lastPathComponent)
        guard confirmation.accepts(typed) else {
            phase = .failed("Type \(confirmation.word) to confirm.")
            return false
        }
        attempt += 1
        let mine = attempt
        phase = .uploading
        bytesSent = 0
        bytesTotal = 0
        let generation = session.generation
        watchSignIn(generation: generation, attempt: mine)
        task = Task { [weak self] in
            await self?.send(fileURL, attempt: mine, generation: generation)
        }
        return true
    }

    /// Stops the upload. The server stores nothing: it only keeps a body that arrived whole.
    public func cancel() {
        guard isUploading else { return }
        attempt += 1
        task?.cancel()
        task = nil
        phase = .idle
    }

    /// Waits until the running upload has finished (for tests).
    public func waitUntilFinished() async {
        await task?.value
    }

    /// Back to the start, after the result was read.
    public func reset() {
        guard !isUploading else { return }
        phase = .idle
        bytesSent = 0
        bytesTotal = 0
    }

    private func send(_ fileURL: URL, attempt mine: Int, generation: Int) async {
        let endpoint = Endpoints.ImportBackup(fileURL: fileURL)
        // The callbacks come from a background queue: one hop at a time, newest value, never backwards.
        let relay = ProgressRelay { [weak self] sent, total in
            self?.progress(sent, total, attempt: mine)
        }
        let outcome: Phase
        do {
            let answer = try await session.upload(endpoint) { sent, total in relay.report(sent, total) }
            outcome = .imported(answer.name)
        } catch {
            let error = NetworkError(error)
            if error == .cancelled || error == .unauthorized {
                if attempt == mine, phase == .uploading { leaveUploading() }
                return
            }
            outcome = .failed(Self.message(for: error))
        }
        guard attempt == mine else { return }
        // Another sign-in took over meanwhile: the answer is not for this account, and nothing is shown.
        guard session.generation == generation else {
            leaveUploading()
            return
        }
        phase = outcome
    }

    private func progress(_ sent: Int64, _ total: Int64, attempt mine: Int) {
        guard attempt == mine, phase == .uploading, sent >= bytesSent else { return }
        bytesSent = sent
        bytesTotal = total
    }

    /// Watches for the sign-in changing while the file goes out (a sign-out, another account, a refused
    /// token): the upload belongs to the account that started it, so it is stopped.
    private func watchSignIn(generation: Int, attempt mine: Int) {
        withObservationTracking {
            _ = session.generation
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, self.attempt == mine, self.isUploading else { return }
                if self.session.generation != generation {
                    self.attempt += 1
                    self.task?.cancel()
                    self.task = nil
                    self.leaveUploading()
                } else {
                    self.watchSignIn(generation: generation, attempt: mine)
                }
            }
        }
    }

    /// Back to idle with nothing left over from the upload.
    private func leaveUploading() {
        phase = .idle
        bytesSent = 0
        bytesTotal = 0
    }

    static func message(for error: NetworkError) -> String {
        switch error {
        case .tooLarge: "The server takes backup files of up to 128 MB."
        case .rateLimited: "Too many backup operations. Wait a minute, then try again."
        case .badRequest(let message?): message
        default:
            OperatorOnly.isRefusal(error) ? OperatorOnly.refusal : error.userMessage
        }
    }
}
