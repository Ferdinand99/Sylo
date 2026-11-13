import Foundation
import Testing
@testable import SyloKit

/// A small file in the temporary folder, removed by the caller.
private func makeFile(bytes: Int = 1_000) throws -> URL {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("sylo-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let url = folder.appendingPathComponent("backup.db")
    try Data(repeating: 0x53, count: bytes).write(to: url)
    return url
}

// MARK: - Restore: evidence of a restart

@Suite("Restore evidence")
struct RestoreEvidenceTests {
    nonisolated static let oldUptime = 2 * 86_400 + 3 * 3_600 + 10 * 60

    @Test("The server's uptime text reads as seconds")
    func uptimeParsing() {
        func seconds(_ text: String?) -> Int? { HealthReport(isReady: true, uptime: text).uptimeSeconds }
        #expect(seconds("3d 04h 12m") == 3 * 86_400 + 4 * 3_600 + 12 * 60)
        #expect(seconds("04h 12m") == 4 * 3_600 + 12 * 60)
        #expect(seconds("05m 12s") == 312)
        #expect(seconds("00m 04s") == 4)
        #expect(seconds(nil) == nil)
        #expect(seconds("") == nil)
        #expect(seconds("soon") == nil)
        #expect(seconds("12x") == nil)
    }

    @Test("An answer is from a restarted process when its uptime is lower than the old one's could be")
    func uptimeEvidence() {
        let old = HealthReport(isReady: true, uptime: "2d 03h 10m")
        let fresh = HealthReport(isReady: true, uptime: "00m 04s")
        #expect(BackupsModel.hasRestarted(fresh, before: Self.oldUptime, elapsed: .seconds(5), sawDown: false))
        #expect(!BackupsModel.hasRestarted(old, before: Self.oldUptime, elapsed: .seconds(5), sawDown: false))
        // A blip of the phone's connection with the old process still answering is not a restart.
        #expect(!BackupsModel.hasRestarted(old, before: Self.oldUptime, elapsed: .seconds(5), sawDown: true))
    }

    @Test("Without uptimes only a failed poll counts, and a young server is told by it too")
    func fallbacks() {
        let bare = HealthReport(isReady: true)
        #expect(BackupsModel.hasRestarted(bare, before: nil, elapsed: .zero, sawDown: true))
        #expect(!BackupsModel.hasRestarted(bare, before: nil, elapsed: .zero, sawDown: false))
        let young = HealthReport(isReady: true, uptime: "03s")
        #expect(BackupsModel.hasRestarted(young, before: 20, elapsed: .seconds(5), sawDown: true))
        #expect(!BackupsModel.hasRestarted(young, before: 20, elapsed: .seconds(5), sawDown: false))
    }

    @Test("Only the ways a restarting server fails count, not the phone being offline")
    func restartErrors() {
        #expect(BackupsModel.looksLikeARestart(.unreachable))
        #expect(BackupsModel.looksLikeARestart(.timeout))
        #expect(BackupsModel.looksLikeARestart(.server(status: 502)))
        #expect(!BackupsModel.looksLikeARestart(.offline))
        #expect(!BackupsModel.looksLikeARestart(.cancelled))
        #expect(!BackupsModel.looksLikeARestart(.notFound))
    }
}

@MainActor
@Suite("Restore wait")
struct RestoreWaitTests {
    nonisolated static let backups = [HealthReport.Backup(name: "sylo-1.db", size: "12 MB", age: "3h ago")]
    nonisolated static func report(_ uptime: String?) -> HealthReport {
        HealthReport(isReady: true, uptime: uptime, backups: backups)
    }

    nonisolated static let snapshotFailure = DevLogEntry(
        id: 6, level: .error, scope: "db",
        message: "Pre-restore snapshot failed \u{2014} aborting restore: disk full", date: Date(timeIntervalSince1970: 9))
    nonisolated static let oldEntry = DevLogEntry(
        id: 5, level: .error, scope: "web", message: "something else", date: Date(timeIntervalSince1970: 1))

    /// A server whose health answers come from `health` once the restore was accepted, and whose dev log
    /// shows `logAfter` after it.
    nonisolated static func clients(
        restored: LockedFlag, health: @escaping @Sendable () throws -> HealthReport,
        logAfter: [DevLogEntry] = [oldEntry]
    ) -> StubClients {
        StubClients { endpoint in
            switch endpoint {
            case is Endpoints.RestoreBackup:
                restored.value = true
                return OKResponse()
            case is Endpoints.Health:
                if restored.value { return try health() }
                return report("2d 03h 10m")
            case is Endpoints.DevLog:
                return DevLogPage(entries: restored.value ? logAfter : [oldEntry])
            default: throw NetworkError.notFound
            }
        }
    }

    private func makeModel(_ clients: StubClients, giveUpAfter: Duration = .milliseconds(400)) -> BackupsModel {
        BackupsModel(
            session: makeSignedInSession(clients: clients), firstPoll: .zero, pollEvery: .milliseconds(2),
            giveUpAfter: giveUpAfter)
    }

    @Test("The old process keeps answering: no success is claimed, and the wait ends with a clear message")
    func oldProcessKeepsAnswering() async {
        let restored = LockedFlag()
        let model = makeModel(Self.clients(restored: restored, health: { Self.report("2d 03h 10m") }))
        await model.load()
        _ = await model.restore("sylo-1.db", typed: "sylo-1.db")
        #expect(model.restoring == nil)
        #expect(model.notice == nil)
        #expect(model.actionError
            == "Couldn't confirm the restore: Sylo never restarted, so the restore may not have run. Check Health and the dev log.")
    }

    @Test("A restart is seen by a lower uptime, even when no poll ever failed")
    func restartSeenByUptime() async {
        let restored = LockedFlag()
        let model = makeModel(Self.clients(restored: restored, health: { Self.report("00m 04s") }))
        await model.load()
        #expect(await model.restore("sylo-1.db", typed: "sylo-1.db"))
        #expect(model.restoring == nil)
        #expect(model.notice == "Restored from sylo-1.db. Sylo is back.")
        #expect(model.actionError == nil)
    }

    @Test("A restart is seen by a failed poll when the server gives no uptime")
    func restartSeenByFailure() async {
        let restored = LockedFlag()
        let asks = LockedFlag()
        let model = makeModel(Self.clients(restored: restored, health: {
            if !asks.value {
                asks.value = true
                throw NetworkError.unreachable
            }
            return Self.report(nil)
        }))
        await model.load()
        _ = await model.restore("sylo-1.db", typed: "sylo-1.db")
        // The pre-restore read had an uptime but the answers after it have none: only the failed poll counts.
        #expect(model.notice == "Restored from sylo-1.db. Sylo is back.")
    }

    @Test("One failed poll while the same old process answers is not a restart")
    func blipIsNotARestart() async {
        let restored = LockedFlag()
        let asks = LockedFlag()
        let model = makeModel(Self.clients(restored: restored, health: {
            if !asks.value {
                asks.value = true
                throw NetworkError.unreachable
            }
            return Self.report("2d 03h 10m")
        }))
        await model.load()
        _ = await model.restore("sylo-1.db", typed: "sylo-1.db")
        #expect(model.notice == nil)
        #expect(model.actionError
            == "Couldn't confirm the restore: Sylo went away but did not come back with a restarted process. Check Health and the dev log.")
    }

    @Test("The phone going offline does not count as the server restarting")
    func offlineIsNotARestart() async {
        let restored = LockedFlag()
        let asks = LockedFlag()
        let model = makeModel(Self.clients(restored: restored, health: {
            if !asks.value {
                asks.value = true
                throw NetworkError.offline
            }
            return Self.report(nil)
        }))
        await model.load()
        _ = await model.restore("sylo-1.db", typed: "sylo-1.db")
        #expect(model.notice == nil)
        #expect(model.actionError?.hasPrefix("Couldn't confirm the restore: Sylo never restarted") == true)
    }

    @Test("A failed snapshot is reported at once, from the dev log, and nothing claims a restore")
    func snapshotFailure() async {
        let restored = LockedFlag()
        let model = makeModel(
            Self.clients(
                restored: restored, health: { Self.report("2d 03h 10m") },
                logAfter: [Self.snapshotFailure, Self.oldEntry]),
            giveUpAfter: .seconds(30))
        await model.load()
        _ = await model.restore("sylo-1.db", typed: "sylo-1.db")
        #expect(model.restoring == nil)
        #expect(model.notice == nil)
        #expect(model.actionError
            == "The server could not take a snapshot of the current database first, so it did not restore anything. Check the dev log.")
    }

    @Test("A snapshot error from before the restore is not blamed on it")
    func oldSnapshotErrorIsIgnored() async {
        let restored = LockedFlag()
        let stale = DevLogEntry(
            id: 5, level: .error, scope: "db", message: "Pre-restore snapshot failed \u{2014} aborting restore: old",
            date: Date(timeIntervalSince1970: 1))
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.RestoreBackup:
                restored.value = true
                return OKResponse()
            case is Endpoints.Health: return Self.report("2d 03h 10m")
            case is Endpoints.DevLog: return DevLogPage(entries: [stale])
            default: throw NetworkError.notFound
            }
        }
        let model = makeModel(clients)
        await model.load()
        _ = await model.restore("sylo-1.db", typed: "sylo-1.db")
        #expect(model.actionError?.hasPrefix("Couldn't confirm the restore: Sylo never restarted") == true)
    }
}

// MARK: - Import and the sign-in

@MainActor
@Suite("Backup import and the sign-in")
struct BackupImportSignInTests {
    @Test("An upload ends when the sign-in changes, and nothing of it is left")
    func signInChangeEndsTheUpload() async throws {
        let file = try makeFile()
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.SignOut { return EmptyResponse() }
            if endpoint is Endpoints.ImportBackup { return BackupNameAnswer(name: "sylo-imported-1.db") }
            throw NetworkError.notFound
        }
        clients.setUploadProgress([(sent: 500, total: 1_000)])
        clients.holdUploads(true)
        let session = makeSignedInSession(clients: clients)
        let model = BackupImportModel(session: session)
        #expect(model.start(fileURL: file, typed: "IMPORT"))
        for _ in 0..<400 where model.bytesSent < 500 { try? await Task.sleep(for: .milliseconds(5)) }
        #expect(model.isUploading)

        await session.signOut()
        for _ in 0..<400 where model.isUploading { try? await Task.sleep(for: .milliseconds(5)) }
        #expect(model.phase == .idle)
        #expect(model.bytesSent == 0)
        #expect(model.bytesTotal == 0)
    }

    @Test("An answer that arrives for an older sign-in is not shown as this account's")
    func lateAnswerIsDropped() async throws {
        let file = try makeFile()
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let gate = TestGate()
        let session = makeGatedAnswerSession(gate: gate) { endpoint in
            if endpoint is Endpoints.SignOut { return EmptyResponse() }
            return BackupNameAnswer(name: "sylo-imported-1.db")
        }
        let model = BackupImportModel(session: session)
        #expect(model.start(fileURL: file, typed: "IMPORT"))
        await waitForArrival(gate)
        let signingOut = Task { await session.signOut() }
        try? await Task.sleep(for: .milliseconds(50))
        gate.open()
        await signingOut.value
        await model.waitUntilFinished()
        for _ in 0..<400 where model.isUploading { try? await Task.sleep(for: .milliseconds(5)) }
        #expect(model.phase == .idle)
    }
}

// MARK: - Progress

@MainActor
private final class RelayValues {
    var values: [Int64] = []
}

@MainActor
@Suite("Progress")
struct ProgressTests {
    @Test("Updates from many threads in any order reach the main actor in order, ending at the newest")
    func relayIsMonotonic() async {
        let seen = RelayValues()
        let relay = ProgressRelay { sent, _ in seen.values.append(sent) }
        let values = (1...500).map { Int64($0) }.shuffled()
        await withTaskGroup(of: Void.self) { group in
            for value in values {
                group.addTask { relay.report(value, 500) }
            }
        }
        for _ in 0..<400 where seen.values.last != 500 { try? await Task.sleep(for: .milliseconds(5)) }
        #expect(seen.values.last == 500)
        #expect(seen.values == seen.values.sorted())
        #expect(seen.values.count <= 500)
    }

    @Test("A download reports its progress, and Cancel stops it without an error")
    func downloadProgressAndCancel() async throws {
        let clients = StubClients { _ in try DownloadedFile.write(Data([1]), filename: "x.db", mimeType: "application/octet-stream") }
        clients.setUploadProgress([(sent: 50, total: 100)])
        clients.holdUploads(true)
        let model = FileDownloadModel(session: makeSignedInSession(clients: clients))
        let running = Task { await model.download(Endpoints.DownloadBackup(name: "sylo-1.db")) }
        for _ in 0..<400 where model.bytesReceived < 50 { try? await Task.sleep(for: .milliseconds(5)) }
        #expect(model.isDownloading)
        #expect(model.bytesReceived == 50)
        #expect(model.fraction == 0.5)

        model.cancel()
        let delivered = await running.value
        #expect(!delivered)
        #expect(!model.isDownloading)
        #expect(model.file == nil)
        #expect(model.errorMessage == nil)
    }

    @Test("A finished download keeps its file and says nothing is wrong")
    func downloadFinishes() async throws {
        let clients = StubClients { _ in try DownloadedFile.write(Data([1, 2, 3]), filename: "x.db", mimeType: "application/octet-stream") }
        let model = FileDownloadModel(session: makeSignedInSession(clients: clients))
        #expect(await model.download(Endpoints.DownloadBackup(name: "sylo-1.db")))
        defer { model.clear() }
        #expect(model.file?.byteCount == 3)
        #expect(model.errorMessage == nil)
    }
}

// MARK: - The account page and the gate

@MainActor
@Suite("Operator gate states")
struct OperatorGateStateTests {
    @Test("Before the account is read nothing is decided; after it, the verdict is the account's")
    func loadedForSignIn() async {
        let isOperator = LockedFlag()
        let session = makeSignedInSession(clients: OperatorGatingTests.clients(isOperator))
        let model = AccountModel(session: session)
        #expect(!model.hasLoadedForSignIn)
        await model.load()
        #expect(model.hasLoadedForSignIn)
        #expect(!model.isOperator)
        await session.signOut()
        #expect(!model.hasLoadedForSignIn)
    }

    @Test("A failed read is an error to retry, never a verdict that the person is not an operator")
    func failedReadIsNotAVerdict() async {
        let fail = LockedFlag()
        fail.value = true
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.Account {
                if fail.value { throw NetworkError.offline }
                return OperatorGatingTests.account(isOperator: true)
            }
            throw NetworkError.notFound
        }
        let model = AccountModel(session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(!model.hasLoadedForSignIn)
        #expect(!model.isOperator)
        #expect(model.errorMessage == NetworkError.offline.userMessage)

        fail.value = false
        await model.load()
        #expect(model.hasLoadedForSignIn)
        #expect(model.isOperator)
        #expect(model.errorMessage == nil)
    }
}

// MARK: - Personalizer drafts

@MainActor
@Suite("Personalizer unsaved changes")
struct PersonalizerUnsavedTests {
    @Test("Any edited form counts as unsaved changes, so a refresh can ask before replacing them")
    func unsaved() async {
        let model = PersonalizerModel(session: makeSignedInSession(clients: PersonalizerModelTests.clients()))
        await model.load()
        #expect(!model.hasUnsavedChanges)
        model.presence.text = "typing"
        #expect(model.hasUnsavedChanges)
        await model.savePresence()
        #expect(!model.hasUnsavedChanges)
        model.identity.bannerURL = "https://example.com/b.png"
        #expect(model.hasUnsavedChanges)
        model.identity.bannerURL = ""
        model.announcement.title = "Draft"
        #expect(model.hasUnsavedChanges)
    }
}
