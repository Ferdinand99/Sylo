import Foundation
import Testing
@testable import SyloKit

/// Counts what a @Sendable stub sees.
private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func next() -> Int { lock.withLock { count += 1; return count } }
}

/// A small file in the temporary folder, removed by the caller.
private func makeFile(_ name: String = "backup.db", bytes: Int = 1_000) throws -> URL {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("sylo-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let url = folder.appendingPathComponent(name)
    try Data(repeating: 0x53, count: bytes).write(to: url)
    return url
}

// MARK: - The questions

@Suite("Operator confirmations")
struct OperatorConfirmationTests {
    @Test("A restore asks in the dashboard's words and wants the backup's name")
    func restore() {
        let ask = OperatorConfirmation.restore(backup: "sylo-manual-2026-01-01.db")
        #expect(ask.title == "Restore the database?")
        #expect(ask.message.hasPrefix(
            "All current data is replaced with sylo-manual-2026-01-01.db and the bot restarts. A prerestore snapshot is taken first."))
        #expect(ask.confirmTitle == "Restore and Restart")
        #expect(ask.word == "sylo-manual-2026-01-01.db")
    }

    @Test("A restore warns clearly that it replaces every server's data and may sign this device out")
    func restoreWarns() {
        let message = OperatorConfirmation.restore(backup: "sylo-1.db").message
        #expect(message.contains("every server"))
        #expect(message.contains("signed out"))
        #expect(message.contains("replaced"))
    }

    @Test("An import says it only stores the file, as the dashboard does")
    func importFile() {
        let ask = OperatorConfirmation.importFile(name: "old.db")
        #expect(ask.title == "Import this backup file?")
        #expect(ask.message.hasPrefix("old.db is stored as a snapshot. Nothing is restored until you press Restore on its row."))
        #expect(ask.word == "IMPORT")
    }

    @Test("Deleting a backup and clearing the announcement")
    func others() {
        let delete = OperatorConfirmation.deleteBackup(name: "sylo-1.db")
        #expect(delete.title == "Delete this backup?")
        #expect(delete.message == "sylo-1.db is removed from the backups folder for good.")
        #expect(delete.word == "DELETE")
        let clear = OperatorConfirmation.clearAnnouncement
        #expect(clear.title == "Clear the live announcement?")
        #expect(clear.message == "It disappears from every dashboard page for everyone straight away.")
        #expect(clear.word == "CLEAR")
    }

    @Test("Only the exact word is accepted: case, spaces and an empty name all fail")
    func exactOnly() {
        #expect(OperatorConfirmation.deleteBackup(name: "a.db").accepts("DELETE"))
        #expect(!OperatorConfirmation.deleteBackup(name: "a.db").accepts("delete"))
        #expect(!OperatorConfirmation.deleteBackup(name: "a.db").accepts("DELETE "))
        #expect(!OperatorConfirmation.deleteBackup(name: "a.db").accepts(""))
        #expect(OperatorConfirmation.restore(backup: "sylo-1.db").accepts("sylo-1.db"))
        #expect(!OperatorConfirmation.restore(backup: "sylo-1.db").accepts("SYLO-1.DB"))
        #expect(!OperatorConfirmation.restore(backup: "").accepts(""))
    }
}

// MARK: - Wire

@Suite("Backup endpoints")
struct BackupEndpointTests {
    @Test("Each call goes to its health route")
    func routes() {
        #expect(Endpoints.CreateBackup().path == "/api/v2/health/backups")
        #expect(Endpoints.CreateBackup().method == .post)
        #expect(Endpoints.DeleteBackup(name: "sylo-1.db").path == "/api/v2/health/backups/sylo-1.db/delete")
        #expect(Endpoints.DeleteBackup(name: "sylo-1.db").method == .post)
        #expect(Endpoints.RestoreBackup(name: "sylo-1.db").path == "/api/v2/health/backups/sylo-1.db/restore")
        #expect(Endpoints.RestoreBackup(name: "sylo-1.db").method == .post)
        #expect(Endpoints.DownloadBackup(name: "sylo-1.db").path == "/api/v2/health/backups/sylo-1.db")
        #expect(Endpoints.DownloadBackup(name: "sylo-1.db").method == .get)
        #expect(Endpoints.SendDevLogErrorTest().path == "/api/v2/health/dev-log-error-test")
        #expect(Endpoints.SendDevLogErrorTest().method == .post)
    }

    @Test("A name is one path segment, whatever it holds")
    func nameIsEncoded() {
        #expect(Endpoints.DeleteBackup(name: "../x").path == "/api/v2/health/backups/..%2Fx/delete")
        #expect(Endpoints.DownloadBackup(name: "a b").path == "/api/v2/health/backups/a%20b")
    }

    @Test("A download may be as long as a backup; nothing else is")
    func largeDownload() {
        #expect(Endpoints.DownloadBackup(name: "sylo-1.db").isLargeDownload)
        #expect(!Endpoints.Resource(path: "/api/v2/x").isLargeDownload)
        #expect(URLSessionAPIClient.largeDownloadBytes == 512 * 1024 * 1024)
    }

    @Test("The import is a raw file body of up to 128 MB, never JSON")
    func importShape() throws {
        let url = URL(fileURLWithPath: "/tmp/backup.db")
        let endpoint = Endpoints.ImportBackup(fileURL: url)
        #expect(endpoint.path == "/api/v2/health/backups/import")
        #expect(endpoint.method == .post)
        #expect(endpoint.body == nil)
        #expect(endpoint.rawBody == nil)
        let file = try #require(endpoint.uploadFile)
        #expect(file.fileURL == url)
        #expect(file.contentType == "application/octet-stream")
        #expect(file.maxBytes == 128 * 1024 * 1024)
        #expect(BackupLimits.maxImportBytes == 134_217_728)
    }
}

// MARK: - The list

@MainActor
@Suite("Backups model")
struct BackupsModelTests {
    nonisolated static let report = HealthReport(
        isReady: true, database: HealthReport.Database(size: "12 MB"),
        backups: [HealthReport.Backup(name: "sylo-1.db", size: "12 MB", age: "3h ago")])

    nonisolated static func clients() -> StubClients {
        StubClients { endpoint in
            switch endpoint {
            case is Endpoints.Health: return report
            case is Endpoints.CreateBackup: return BackupNameAnswer(name: "sylo-2.db")
            case is Endpoints.DeleteBackup, is Endpoints.RestoreBackup: return OKResponse()
            default: throw NetworkError.notFound
            }
        }
    }

    private func makeModel(_ clients: StubClients) -> BackupsModel {
        BackupsModel(
            session: makeSignedInSession(clients: clients), firstPoll: .zero, pollEvery: .milliseconds(1),
            giveUpAfter: .seconds(5))
    }

    @Test("Loading lists the backups")
    func loads() async {
        let model = makeModel(Self.clients())
        await model.load()
        #expect(model.backups.map(\.name) == ["sylo-1.db"])
        #expect(model.report?.database?.size == "12 MB")
    }

    @Test("Creating a backup says its name and reads the list again")
    func creates() async {
        let clients = Self.clients()
        let model = makeModel(clients)
        await model.load()
        #expect(await model.create())
        #expect(model.notice == "Backup created: sylo-2.db")
        #expect(clients.calls.filter { $0.endpoint is Endpoints.Health }.count == 2)
    }

    @Test("Deleting needs the typed word, and sends nothing without it")
    func deleteNeedsWord() async {
        let clients = Self.clients()
        let model = makeModel(clients)
        await model.load()
        for wrong in ["", "delete", "sylo-1.db", "DELETE "] {
            #expect(await model.delete("sylo-1.db", typed: wrong) == false)
        }
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.DeleteBackup })
        #expect(model.actionError == "Type DELETE to confirm.")

        #expect(await model.delete("sylo-1.db", typed: "DELETE"))
        #expect(model.notice == "Deleted sylo-1.db.")
        let sent = clients.calls.compactMap { $0.endpoint as? Endpoints.DeleteBackup }
        #expect(sent.map(\.name) == ["sylo-1.db"])
    }

    @Test("Restoring needs the backup's name typed, and sends nothing without it")
    func restoreNeedsName() async {
        let clients = Self.clients()
        let model = makeModel(clients)
        await model.load()
        for wrong in ["", "RESTORE", "sylo-1", "SYLO-1.DB"] {
            #expect(await model.restore("sylo-1.db", typed: wrong) == false)
        }
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.RestoreBackup })
        #expect(model.actionError == "Type sylo-1.db to confirm.")
        #expect(model.restoring == nil)
    }

    @Test("A restore waits through the restart and says when Sylo is back")
    func restoreWaits() async {
        let restored = LockedFlag()
        let asks = Counter()
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.RestoreBackup:
                restored.value = true
                return OKResponse()
            case is Endpoints.Health:
                // Down for two asks while it restarts, then up.
                if restored.value, asks.next() < 3 { throw NetworkError.unreachable }
                return Self.report
            default: throw NetworkError.notFound
            }
        }
        let model = makeModel(clients)
        await model.load()
        #expect(await model.restore("sylo-1.db", typed: "sylo-1.db"))
        #expect(model.restoring == nil)
        #expect(model.notice == "Restored from sylo-1.db. Sylo is back.")
        #expect(model.actionError == nil)
        #expect(clients.calls.filter { $0.endpoint is Endpoints.RestoreBackup }.count == 1)
        #expect(asks.next() >= 4)
    }

    @Test("Nothing else can be changed while a restore is on its way")
    func lockedWhileRestoring() async {
        let restored = LockedFlag()
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.RestoreBackup:
                restored.value = true
                return OKResponse()
            case is Endpoints.Health:
                if restored.value { throw NetworkError.unreachable }
                return Self.report
            default: throw NetworkError.notFound
            }
        }
        let model = BackupsModel(
            session: makeSignedInSession(clients: clients), firstPoll: .zero, pollEvery: .milliseconds(5),
            giveUpAfter: .seconds(30))
        await model.load()
        let restoring = Task { await model.restore("sylo-1.db", typed: "sylo-1.db") }
        for _ in 0..<400 where model.restoring == nil { try? await Task.sleep(for: .milliseconds(5)) }
        #expect(model.restoring == "sylo-1.db")
        #expect(await model.create() == false)
        #expect(await model.delete("sylo-1.db", typed: "DELETE") == false)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.CreateBackup })
        restored.value = false
        await restoring.value
        #expect(model.restoring == nil)
    }

    @Test("A restore that signs this device out ends the wait, and the session handles the 401")
    func restoreSignsOut() async throws {
        let restored = LockedFlag()
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.RestoreBackup:
                restored.value = true
                return OKResponse()
            case is Endpoints.Health:
                if restored.value { throw NetworkError.unauthorized }
                return Self.report
            default: throw NetworkError.notFound
            }
        }
        let session = makeSignedInSession(clients: clients)
        let model = BackupsModel(session: session, firstPoll: .zero, pollEvery: .milliseconds(1), giveUpAfter: .seconds(5))
        await model.load()
        _ = await model.restore("sylo-1.db", typed: "sylo-1.db")
        #expect(model.restoring == nil)
        let server = try ServerURL("https://sylo.example.com")
        #expect(session.phase == .signIn(server))
    }

    @Test("When Sylo does not come back the screen says so")
    func givesUp() async {
        let restored = LockedFlag()
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.RestoreBackup:
                restored.value = true
                return OKResponse()
            case is Endpoints.Health:
                if restored.value { throw NetworkError.unreachable }
                return Self.report
            default: throw NetworkError.notFound
            }
        }
        let model = BackupsModel(
            session: makeSignedInSession(clients: clients), firstPoll: .zero, pollEvery: .milliseconds(2),
            giveUpAfter: .milliseconds(40))
        await model.load()
        _ = await model.restore("sylo-1.db", typed: "sylo-1.db")
        #expect(model.restoring == nil)
        #expect(model.actionError == "Couldn't confirm the restore: Sylo went away but did not come back with a restarted process. Check Health and the dev log.")
        #expect(model.notice == nil)
    }

    @Test("A person who is not an operator gets the refusal, and no list")
    func refused() async {
        let clients = StubClients { _ in throw NetworkError.forbidden(message: "Restricted to Sylo's operators.") }
        let model = makeModel(clients)
        await model.load()
        #expect(model.isRefused)
        #expect(model.report == nil)
        #expect(await model.create() == false)
        #expect(clients.calls.count == 1)
    }
}

// MARK: - The import

@MainActor
@Suite("Backup import model")
struct BackupImportModelTests {
    nonisolated static func clients(answer: @escaping @Sendable () throws -> Any = { BackupNameAnswer(name: "sylo-imported-1.db") }) -> StubClients {
        StubClients { endpoint in
            if endpoint is Endpoints.ImportBackup { return try answer() }
            throw NetworkError.notFound
        }
    }

    @Test("Without the typed word nothing is sent")
    func needsWord() throws {
        let file = try makeFile()
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let clients = Self.clients()
        let model = BackupImportModel(session: makeSignedInSession(clients: clients))
        for wrong in ["", "import", "IMPORT ", "backup.db"] {
            #expect(model.start(fileURL: file, typed: wrong) == false)
        }
        #expect(model.phase == .failed("Type IMPORT to confirm."))
        #expect(clients.calls.isEmpty)
    }

    @Test("The file is sent from where it is, and the answer names the snapshot")
    func imports() async throws {
        let file = try makeFile()
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let clients = Self.clients()
        let model = BackupImportModel(session: makeSignedInSession(clients: clients))
        #expect(model.start(fileURL: file, typed: "IMPORT"))
        #expect(model.isUploading)
        await model.waitUntilFinished()
        #expect(model.phase == .imported("sylo-imported-1.db"))
        let sent = try #require(clients.calls.compactMap { $0.endpoint as? Endpoints.ImportBackup }.first)
        #expect(sent.fileURL == file)
        #expect(sent.uploadFile?.maxBytes == BackupLimits.maxImportBytes)
    }

    @Test("Progress is shown while it uploads, and Cancel stops it without an error")
    func progressAndCancel() async throws {
        let file = try makeFile()
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let clients = Self.clients()
        clients.setUploadProgress([(sent: 500, total: 1_000)])
        clients.holdUploads(true)
        let model = BackupImportModel(session: makeSignedInSession(clients: clients))
        #expect(model.start(fileURL: file, typed: "IMPORT"))
        for _ in 0..<400 where model.bytesSent < 500 { try? await Task.sleep(for: .milliseconds(5)) }
        #expect(model.bytesSent == 500)
        #expect(model.bytesTotal == 1_000)
        #expect(model.fraction == 0.5)
        #expect(model.isUploading)
        // Another start while one runs does nothing.
        #expect(model.start(fileURL: file, typed: "IMPORT") == false)

        model.cancel()
        #expect(model.phase == .idle)
        try? await Task.sleep(for: .milliseconds(100))
        #expect(model.phase == .idle)
    }

    @Test("The server's reasons are shown in words", arguments: [
        (NetworkError.badRequest(message: "not a recognised Sylo backup file (SQLite snapshot or Postgres dump)"),
         "not a recognised Sylo backup file (SQLite snapshot or Postgres dump)"),
        (NetworkError.tooLarge, "The server takes backup files of up to 128 MB."),
        (NetworkError.rateLimited, "Too many backup operations. Wait a minute, then try again."),
        (NetworkError.forbidden, OperatorOnly.refusal),
        (NetworkError.offline, NetworkError.offline.userMessage),
    ])
    func failures(error: NetworkError, message: String) async throws {
        let file = try makeFile()
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let model = BackupImportModel(session: makeSignedInSession(clients: Self.clients(answer: { throw error })))
        #expect(model.start(fileURL: file, typed: "IMPORT"))
        await model.waitUntilFinished()
        #expect(model.phase == .failed(message))
    }

    @Test("A person can start again after a failure, and reset clears the result")
    func startAgain() async throws {
        let file = try makeFile()
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let attempts = Counter()
        let model = BackupImportModel(session: makeSignedInSession(clients: Self.clients(answer: {
            if attempts.next() == 1 { throw NetworkError.offline }
            return BackupNameAnswer(name: "sylo-imported-2.db")
        })))
        #expect(model.start(fileURL: file, typed: "IMPORT"))
        await model.waitUntilFinished()
        #expect(model.phase == .failed(NetworkError.offline.userMessage))
        #expect(model.start(fileURL: file, typed: "IMPORT"))
        await model.waitUntilFinished()
        #expect(model.phase == .imported("sylo-imported-2.db"))
        model.reset()
        #expect(model.phase == .idle)
        #expect(model.fraction == nil)
    }
}

// MARK: - Health's error test

@MainActor
@Suite("Dev-log error test")
struct DevLogErrorTestTests {
    @Test("The real error test is a POST and says it was logged")
    func sends() async {
        let clients = StubClients { _ in OKResponse() }
        let model = HealthModel(session: makeSignedInSession(clients: clients))
        await model.sendErrorTest()
        #expect(model.errorTestResult == .sent)
        #expect(clients.calls.last?.endpoint is Endpoints.SendDevLogErrorTest)
    }

    @Test("A person who is not an operator is told so")
    func refused() async {
        let model = HealthModel(session: makeSignedInSession(clients: StubClients { _ in throw NetworkError.forbidden }))
        await model.sendErrorTest()
        #expect(model.errorTestResult == .failed(OperatorOnly.refusal))
    }

    @Test("Another failure shows its words")
    func fails() async {
        let model = HealthModel(session: makeSignedInSession(clients: StubClients { _ in throw NetworkError.rateLimited }))
        await model.sendErrorTest()
        #expect(model.errorTestResult == .failed(NetworkError.rateLimited.userMessage))
    }
}
