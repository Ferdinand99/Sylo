import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import SyloKit

// Restoring a backup (Sylo 5.3, src/db/backup.js `restoreConfirmationError`): a 5.3 server wants the snapshot's name as
// `confirm`, and `acknowledgeSql: true` for an uploaded Postgres dump (its SQL runs with the rights of the database
// role); without them an uploaded dump gets a 400. A server before 5.3 takes no body, and the app sends it none: the
// new keys go out only to a server that says it knows them (it sends `roleRisks` in the health report).

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

private func bodyJSON(_ body: (any Encodable & Sendable)?) throws -> [String: Any] {
    struct Box: Encodable {
        let value: any Encodable
        func encode(to encoder: any Encoder) throws { try value.encode(to: encoder) }
    }
    let value = try #require(body)
    let data = try JSONEncoder().encode(Box(value: value))
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

/// A count a @Sendable stub can bump.
private final class Asks: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func next() -> Int { lock.withLock { count += 1; return count } }
}

private let imported = "sylo-imported-2026-11-20T09-00-00.dump"

@Suite("Restore: the health report")
struct RestoreHealthTests {
    @Test("A 5.3 report lists the role's extra rights (empty when fine) and the docs")
    func report53() throws {
        let db = try decode(
            HealthReport.Database.self,
            #"{"size":"12 MB","postgres":true,"intervalHours":24,"retention":7,"roleRisks":["SUPERUSER","pg_read_server_files"],"roleDocsUrl":"https://github.com/Ferdinand99/Sylo/blob/main/docs/postgres.md#least-privilege-database-role"}"#)
        #expect(db.isPostgres)
        #expect(db.roleRisks == ["SUPERUSER", "pg_read_server_files"])
        #expect(db.roleDocsURL?.host == "github.com")
        let fine = try decode(HealthReport.Database.self, #"{"postgres":true,"roleRisks":[]}"#)
        #expect(fine.roleRisks == [])
    }

    @Test("A 5.2 report has neither, and an odd one reads as not sent")
    func report52() throws {
        let db = try decode(HealthReport.Database.self, #"{"size":"12 MB","postgres":true,"intervalHours":24}"#)
        #expect(db.roleRisks == nil)
        #expect(db.roleDocsURL == nil)
        let odd = try decode(HealthReport.Database.self, #"{"postgres":true,"roleRisks":"SUPERUSER","roleDocsUrl":"javascript:alert(1)"}"#)
        #expect(odd.roleRisks == nil)
        #expect(odd.roleDocsURL == nil)
        let report = try decode(HealthReport.self, #"{"ready":true,"db":{"postgres":true,"roleRisks":["CREATEDB"]}}"#)
        #expect(report.database?.roleRisks == ["CREATEDB"])
    }
}

@Suite("Restore: what is sent")
struct RestorePlanTests {
    private static let db53 = HealthReport.Database(isPostgres: true, roleRisks: [])
    private static let db52 = HealthReport.Database(isPostgres: true)
    private static let sqlite53 = HealthReport.Database(isPostgres: false, roleRisks: [])

    @Test("Only a snapshot named sylo-imported- is an uploaded one")
    func importedName() {
        #expect(RestorePlan.isImported(imported))
        #expect(!RestorePlan.isImported("sylo-manual-2026-11-20.dump"))
        #expect(!RestorePlan.isImported("my-sylo-imported-1.dump"))
        #expect(!RestorePlan.isImported(""))
    }

    @Test("An uploaded dump on a 5.3 Postgres is sent the name and the acknowledgement")
    func uploadedDump53() throws {
        let plan = RestorePlan.make(name: imported, database: Self.db53)
        #expect(plan.isUploadedSqlDump)
        #expect(plan.confirmation == RestoreConfirmation(confirm: imported, acknowledgeSql: true))
        let json = try bodyJSON(Endpoints.RestoreBackup(name: imported, confirmation: plan.confirmation).body)
        #expect(Set(json.keys) == ["confirm", "acknowledgeSql"])
        #expect(json["confirm"] as? String == imported)
        #expect(json["acknowledgeSql"] as? Bool == true)
    }

    @Test("Any other snapshot on a 5.3 server is sent the name only, never the acknowledgement")
    func otherSnapshot53() throws {
        let plan = RestorePlan.make(name: "sylo-manual-1.dump", database: Self.db53)
        #expect(!plan.isUploadedSqlDump)
        let json = try bodyJSON(Endpoints.RestoreBackup(name: "sylo-manual-1.dump", confirmation: plan.confirmation).body)
        #expect(Set(json.keys) == ["confirm"])
        // An uploaded file on SQLite runs no SQL: the same.
        let sqlite = RestorePlan.make(name: "sylo-imported-1.db", database: Self.sqlite53)
        #expect(!sqlite.isUploadedSqlDump)
        #expect(sqlite.confirmation == RestoreConfirmation(confirm: "sylo-imported-1.db"))
    }

    @Test("A server that did not send roleRisks (5.2 and older) is sent no body at all")
    func olderServer() {
        let plan = RestorePlan.make(name: imported, database: Self.db52)
        // The app still explains the SQL: it is true on every version.
        #expect(plan.isUploadedSqlDump)
        #expect(plan.confirmation == nil)
        #expect(Endpoints.RestoreBackup(name: imported, confirmation: plan.confirmation).body == nil)
        #expect(RestorePlan.make(name: "sylo-manual-1.dump", database: Self.db52).confirmation == nil)
        #expect(RestorePlan.make(name: "sylo-manual-1.dump", database: nil).confirmation == nil)
    }

    @Test("The warning is the dashboard's words, with the role's extra rights when there are some")
    func notice() {
        #expect(UploadedDumpNotice.title == "This file was uploaded")
        #expect(UploadedDumpNotice.message.contains("runs that SQL with the rights of the database role"))
        #expect(UploadedDumpNotice.message.contains("Restore only a file you made or trust."))
        #expect(UploadedDumpNotice.roleSentence(nil) == nil)
        #expect(UploadedDumpNotice.roleSentence([]) == nil)
        #expect(UploadedDumpNotice.roleSentence(["SUPERUSER", "CREATEDB"])?.contains("SUPERUSER, CREATEDB") == true)
    }
}

@MainActor
@Suite("Restore: the model")
struct RestoreModelTests {
    nonisolated static func report(roleRisks: [String]?, postgres: Bool = true) -> HealthReport {
        HealthReport(
            isReady: true, database: HealthReport.Database(isPostgres: postgres, roleRisks: roleRisks),
            backups: [
                HealthReport.Backup(name: imported, size: "1 MB", age: "1m ago"),
                HealthReport.Backup(name: "sylo-manual-1.dump", size: "1 MB", age: "3h ago"),
            ])
    }

    /// A server that restarts after the restore call (two failed asks), like a real one.
    nonisolated static func clients(_ report: HealthReport) -> StubClients {
        let restored = LockedFlag()
        let asks = Asks()
        return StubClients { endpoint in
            switch endpoint {
            case is Endpoints.RestoreBackup:
                restored.value = true
                return OKResponse()
            case is Endpoints.Health:
                if restored.value, asks.next() < 3 { throw NetworkError.unreachable }
                return report
            default: throw NetworkError.notFound
            }
        }
    }

    private func makeModel(_ clients: StubClients) -> BackupsModel {
        BackupsModel(
            session: makeSignedInSession(clients: clients), firstPoll: .zero, pollEvery: .milliseconds(1),
            giveUpAfter: .seconds(5))
    }

    @Test("An uploaded dump is not restored until the person says they know what it runs")
    func needsAcknowledgement() async {
        let clients = Self.clients(Self.report(roleRisks: []))
        let model = makeModel(clients)
        await model.load()
        #expect(await model.restore(imported, typed: imported) == false)
        #expect(model.actionError == "Confirm that you made this file or trust it before it is restored.")
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.RestoreBackup })
        #expect(model.restoring == nil)
    }

    @Test("With the acknowledgement and the typed name, a 5.3 server gets confirm and acknowledgeSql")
    func restoresUploadedDump() async throws {
        let clients = Self.clients(Self.report(roleRisks: ["CREATEDB"]))
        let model = makeModel(clients)
        await model.load()
        #expect(await model.restore(imported, typed: imported, acknowledgedSql: true))
        let sent = try #require(clients.calls.compactMap { $0.endpoint as? Endpoints.RestoreBackup }.first)
        #expect(sent.name == imported)
        #expect(sent.confirmation == RestoreConfirmation(confirm: imported, acknowledgeSql: true))
        #expect(model.notice == "Restored from \(imported). Sylo is back.")
    }

    @Test("Another snapshot needs no acknowledgement, and a 5.3 server gets its name as confirm")
    func restoresOrdinarySnapshot() async throws {
        let clients = Self.clients(Self.report(roleRisks: []))
        let model = makeModel(clients)
        await model.load()
        #expect(await model.restore("sylo-manual-1.dump", typed: "sylo-manual-1.dump"))
        let sent = try #require(clients.calls.compactMap { $0.endpoint as? Endpoints.RestoreBackup }.first)
        #expect(sent.confirmation == RestoreConfirmation(confirm: "sylo-manual-1.dump"))
    }

    @Test("A 5.2 server is sent no body, uploaded dump or not")
    func olderServerGetsNoBody() async throws {
        let clients = Self.clients(Self.report(roleRisks: nil))
        let model = makeModel(clients)
        await model.load()
        // Even on 5.2 the person is told what the SQL runs with.
        #expect(await model.restore(imported, typed: imported) == false)
        #expect(await model.restore(imported, typed: imported, acknowledgedSql: true))
        let sent = try #require(clients.calls.compactMap { $0.endpoint as? Endpoints.RestoreBackup }.first)
        #expect(sent.confirmation == nil)
        #expect(sent.body == nil)
    }

    @Test("The typed name is still asked first, whatever else is said")
    func typedNameFirst() async {
        let clients = Self.clients(Self.report(roleRisks: []))
        let model = makeModel(clients)
        await model.load()
        #expect(await model.restore(imported, typed: "yes", acknowledgedSql: true) == false)
        #expect(model.actionError == "Type \(imported) to confirm.")
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.RestoreBackup })
    }
}

extension APIClientTests {
    private func client53() throws -> URLSessionAPIClient {
        URLSessionAPIClient(
            server: try ServerURL("https://example.com/sylo"), session: MockURLProtocol.session(),
            decoder: JSONDecoder(), retryDelays: [.zero, .zero], token: { "sylo_secret" })
    }

    @Test("A 5.3 restore of an uploaded dump posts a JSON body with confirm and acknowledgeSql")
    func restoreBodyOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"ok":true}"#)])
        let plan = RestorePlan.make(name: imported, database: HealthReport.Database(isPostgres: true, roleRisks: []))
        _ = try await client53().send(Endpoints.RestoreBackup(name: imported, confirmation: plan.confirmation))
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/health/backups/\(imported)/restore")
        #expect(request.method == "POST")
        #expect(request.header("Content-Type") == "application/json")
        let body = try #require(request.body)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(Set(json.keys) == ["confirm", "acknowledgeSql"])
        #expect(json["confirm"] as? String == imported)
        #expect(json["acknowledgeSql"] as? Bool == true)
    }

    @Test("A restore on a server that sent no roleRisks posts no body and no content type")
    func restoreWithoutBodyOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"ok":true}"#)])
        let plan = RestorePlan.make(name: imported, database: HealthReport.Database(isPostgres: true))
        _ = try await client53().send(Endpoints.RestoreBackup(name: imported, confirmation: plan.confirmation))
        let request = try #require(mock.requests.first)
        #expect(request.header("Content-Type") == nil)
        #expect(request.body == nil || request.body?.isEmpty == true)
    }

    @Test("The public-page look is saved as JSON and a picture goes up as a multipart file")
    func publicLookOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, publicLookJSON)])
        let saved = try await client53().send(
            Endpoints.SavePublicLook(server: "900000000000000201", choice: PublicPageLookChoice(accent: "#5865f2", background: .upload)))
        #expect(saved.background == .upload)
        var request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/900000000000000201/public-page-look")
        #expect(request.header("Content-Type") == "application/json")
        let savedBody = try #require(request.body)
        let json = try #require(try JSONSerialization.jsonObject(with: savedBody) as? [String: Any])
        #expect(Set(json.keys) == ["accent", "background"])

        mock.reset([.json(200, publicLookJSON)])
        let picture = PreparedPicture(data: Data(repeating: 7, count: 32), mimeType: "image/jpeg", filename: "picture.jpg", width: 4, height: 4)
        _ = try await client53().send(Endpoints.UploadPublicLookImage(server: "900000000000000201", picture: picture, boundary: "B"))
        request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/900000000000000201/public-page-look/image")
        #expect(request.header("Content-Type") == "multipart/form-data; boundary=B")
        let uploadBody = try #require(request.body)
        let text = String(decoding: uploadBody, as: UTF8.self)
        #expect(text.contains(#"name="file""#))
    }

    @Test("Update now posts no body and the run is read from its own route")
    func updateOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"runId":42,"status":"queued","from":"5.2.0"}"#)])
        let started = try await client53().send(Endpoints.ApproveUpdate())
        #expect(started.runID == 42)
        var request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/update/wren/approve")
        #expect(request.method == "POST")
        #expect(request.header("Content-Type") == nil)

        mock.reset([.json(200, #"{"run":{"id":42,"status":"running","finished":false,"steps":[{"step":"stop","status":"running","durationMs":null}]}}"#)])
        let answer = try await client53().send(Endpoints.LoadUpdateRun(id: 42))
        #expect(answer.run.described.step == "Stopping Sylo")
        request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/update/wren/runs/42")

        // A proxy's answer while Sylo restarts is a server error without words: the app reads it as Sylo being down.
        mock.reset([.json(502, "{}"), .json(502, "{}"), .json(502, "{}")])
        do {
            _ = try await client53().send(Endpoints.LoadUpdateRun(id: 42))
            Issue.record("a 502 should throw")
        } catch {
            #expect(UpdateModel.syloIsDown(NetworkError(error)))
        }
    }
}
