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
        let started = await change { generation in
            _ = try await self.session.send(Endpoints.RestoreBackup(name: name))
            guard self.session.generation == generation else { return }
            self.restoring = name
        }
        guard started, restoring == name else { return started }
        await waitUntilBack(from: name)
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

    /// Asks the server whether it is up again, like the dashboard does, until it answers or the wait is
    /// over. A refused token ends it too: the restore went back to a database that does not know this
    /// sign-in, and the session has already signed the app out.
    private func waitUntilBack(from name: String) async {
        let generation = session.generation
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: giveUpAfter)
        do {
            try await Task.sleep(for: firstPoll)
            while clock.now < deadline {
                guard session.generation == generation else { restoring = nil; return }
                do {
                    let loaded = try await session.send(Endpoints.Health())
                    guard session.generation == generation else { restoring = nil; return }
                    report = loaded
                    restoring = nil
                    notice = "Restored from \(name). Sylo is back."
                    return
                } catch {
                    if NetworkError(error) == .unauthorized { restoring = nil; return }
                    // Down while it restarts: ask again.
                }
                try await Task.sleep(for: pollEvery)
            }
        } catch {
            // Cancelled: stop waiting.
            restoring = nil
            return
        }
        restoring = nil
        actionError = "Sylo did not come back after the restore. Check the server."
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
        let outcome: Phase
        do {
            let answer = try await session.upload(endpoint) { [weak self] sent, total in
                Task { @MainActor in self?.progress(sent, total, attempt: mine) }
            }
            outcome = .imported(answer.name)
        } catch {
            let error = NetworkError(error)
            if error == .cancelled || error == .unauthorized {
                if attempt == mine, phase == .uploading { phase = .idle }
                return
            }
            outcome = .failed(Self.message(for: error))
        }
        guard attempt == mine, session.generation == generation else { return }
        phase = outcome
    }

    private func progress(_ sent: Int64, _ total: Int64, attempt mine: Int) {
        guard attempt == mine, phase == .uploading else { return }
        bytesSent = sent
        bytesTotal = total
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
