import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import SyloKit

// What the operator screens put on the wire, through the real client and the mock URL protocol: the
// backup import streamed from a file as raw bytes, the limits that refuse before anything is sent, the
// big backup download, and a few of the JSON calls. They extend `APIClientTests` so they run one after
// another: the mock's state is shared.

/// An upload with a limit of its own, to try the client's refusal without a 128 MB file.
private struct SizedUpload: APIEndpoint {
    typealias Response = OKResponse
    var fileURL: URL
    var maxBytes: Int64
    var path = "/api/v2/probe/upload"
    var method: HTTPMethod = .post
    var uploadFile: UploadFile? {
        UploadFile(fileURL: fileURL, contentType: "application/octet-stream", maxBytes: maxBytes)
    }
}

extension APIClientTests {
    private func operatorClient(
        maxDownloadBytes: Int = URLSessionAPIClient.defaultMaxDownloadBytes, directory: URL? = nil
    ) throws -> URLSessionAPIClient {
        URLSessionAPIClient(
            server: try ServerURL("https://example.com/sylo"), session: MockURLProtocol.session(), decoder: JSONDecoder(),
            retryDelays: [.zero, .zero], maxDownloadBytes: maxDownloadBytes, downloadDirectory: directory,
            token: { "sylo_secret" })
    }

    /// A file of known, varied bytes in a folder of its own.
    private func uploadFixture(bytes: Int) throws -> (url: URL, data: Data) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("sylo-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent("backup.db")
        let data = Data((0..<bytes).map { UInt8($0 % 251) })
        try data.write(to: url)
        return (url, data)
    }

    // MARK: Import

    @Test("A backup import is POSTed as raw bytes from the file, with the token and no JSON")
    func importStreamsTheFile() async throws {
        let fixture = try uploadFixture(bytes: 300_000)
        defer { try? FileManager.default.removeItem(at: fixture.url.deletingLastPathComponent()) }
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"name":"sylo-imported-1.db"}"#)])

        let answer = try await operatorClient().send(Endpoints.ImportBackup(fileURL: fixture.url))
        #expect(answer.name == "sylo-imported-1.db")

        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/health/backups/import")
        #expect(request.method == "POST")
        #expect(request.header("Content-Type") == "application/octet-stream")
        #expect(request.header("Accept") == "application/json")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
        #expect(request.body == fixture.data)
        // Read from the disk as it goes, not held by the request.
        #expect(request.usedBodyStream)
    }

    @Test("The same upload through the progress call reaches the same route")
    func uploadWithProgressCall() async throws {
        let fixture = try uploadFixture(bytes: 2_000)
        defer { try? FileManager.default.removeItem(at: fixture.url.deletingLastPathComponent()) }
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"name":"sylo-imported-2.db"}"#)])
        let answer = try await operatorClient().upload(Endpoints.ImportBackup(fileURL: fixture.url), progress: { _, _ in })
        #expect(answer.name == "sylo-imported-2.db")
        #expect(mock.requests.count == 1)
        #expect(mock.requests.first?.body == fixture.data)
    }

    @Test("A file over the endpoint's own limit is refused before anything is sent")
    func overTheLimit() async throws {
        let fixture = try uploadFixture(bytes: 200)
        defer { try? FileManager.default.removeItem(at: fixture.url.deletingLastPathComponent()) }
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"ok":true}"#)])
        let client = try operatorClient()

        await #expect(throws: NetworkError.tooLarge) {
            _ = try await client.send(SizedUpload(fileURL: fixture.url, maxBytes: 199))
        }
        #expect(mock.requests.isEmpty)

        // At the limit exactly is fine.
        _ = try await client.send(SizedUpload(fileURL: fixture.url, maxBytes: 200))
        #expect(mock.requests.count == 1)
    }

    @Test("Each endpoint has its own limit: a backup may be far over a picture's 2 MB")
    func limitsDiffer() {
        #expect(BackupLimits.maxImportBytes == Int64(64 * CollectiblePictureLimits.maxUploadBytes))
        #expect(BackupLimits.maxImportBytes > Int64(CollectiblePictureLimits.maxUploadBytes))
    }

    @Test("A file that is not there is an error, and nothing is sent")
    func missingFile() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"name":"x"}"#)])
        let missing = FileManager.default.temporaryDirectory.appendingPathComponent("sylo-missing-\(UUID().uuidString).db")
        let client = try operatorClient()
        var thrown: NetworkError?
        do {
            _ = try await client.send(Endpoints.ImportBackup(fileURL: missing))
        } catch {
            thrown = NetworkError(error)
        }
        guard case .transport? = thrown else {
            Issue.record("expected a transport error, got \(String(describing: thrown))")
            return
        }
        #expect(mock.requests.isEmpty)
    }

    @Test("The server's refusals of an import keep their words", arguments: [
        (400, #"{"error":"not a recognised Sylo backup file (SQLite snapshot or Postgres dump)"}"#,
         NetworkError.badRequest(message: "not a recognised Sylo backup file (SQLite snapshot or Postgres dump)")),
        (413, #"{"error":"Payload too large"}"#, NetworkError.tooLarge),
        (403, #"{"error":"Restricted to Sylo's operators."}"#, NetworkError.forbidden),
        (429, #"{"error":"Too many backup operations — wait a minute."}"#, NetworkError.rateLimited),
    ])
    func importRefusals(status: Int, body: String, expected: NetworkError) async throws {
        let fixture = try uploadFixture(bytes: 600)
        defer { try? FileManager.default.removeItem(at: fixture.url.deletingLastPathComponent()) }
        MockURLProtocol.state.reset([.json(status, body)])
        let client = try operatorClient()
        await #expect(throws: expected) {
            _ = try await client.send(Endpoints.ImportBackup(fileURL: fixture.url))
        }
    }

    // MARK: Download

    @Test("A backup download may be longer than an ordinary one; an ordinary download may not")
    func largeDownloadCeiling() async throws {
        let mock = MockURLProtocol.state
        let reply = MockReply.response(
            status: 200,
            headers: ["Content-Type": "application/octet-stream", "Content-Disposition": #"attachment; filename="sylo-1.db""#],
            body: Data(repeating: 0x42, count: 20))
        mock.reset([reply])
        let client = try operatorClient(maxDownloadBytes: 10)

        let file = try await client.download(Endpoints.DownloadBackup(name: "sylo-1.db"))
        defer { file.discard() }
        #expect(file.filename == "sylo-1.db")
        #expect(file.byteCount == 20)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/health/backups/sylo-1.db")
        #expect(request.header("Authorization") == "Bearer sylo_secret")

        mock.reset([reply])
        await #expect(throws: NetworkError.tooLarge) {
            _ = try await client.download(Endpoints.Resource(path: "/api/v2/other"))
        }
    }

    // MARK: JSON calls

    @Test("Operator JSON calls carry the token and a JSON body only where the dashboard sends one")
    func jsonCalls() async throws {
        let mock = MockURLProtocol.state
        let client = try operatorClient()

        mock.reset([.json(200, #"{"name":"sylo-2.db"}"#)])
        let made = try await client.send(Endpoints.CreateBackup())
        #expect(made.name == "sylo-2.db")
        var request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/health/backups")
        #expect(request.method == "POST")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
        #expect(request.header("Content-Type") == nil)

        mock.reset([.json(200, #"{"ok":true}"#)])
        _ = try await client.send(Endpoints.RestoreBackup(name: "sylo-1.db"))
        request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/health/backups/sylo-1.db/restore")

        mock.reset([.json(200, #"{"done":["username"],"failed":[]}"#)])
        let result = try await client.send(Endpoints.SavePersonalizerIdentity(change: IdentityDraft(username: "Sylo")))
        #expect(result.done == ["username"])
        request = try #require(mock.requests.first)
        #expect(request.header("Content-Type") == "application/json")
        let body = try #require(request.body)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(Set(json.keys) == ["username", "avatarUrl", "bannerUrl", "resetAvatar"])

        mock.reset([.json(200, #"{"ok":true}"#)])
        _ = try await client.send(Endpoints.SetRoadmapAdminStatus(id: 3, status: "started"))
        request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/roadmap/admin/3/status")
        let statusBody = try #require(request.body)
        let statusJSON = try #require(try JSONSerialization.jsonObject(with: statusBody) as? [String: String])
        #expect(statusJSON == ["status": "started"])
    }

    // MARK: Chunked download

    private func emptyDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("sylo-test-(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func backupReply(bytes: Int, contentLength: Int? = nil) -> MockReply {
        var headers = [
            "Content-Type": "application/octet-stream",
            "Content-Disposition": #"attachment; filename="sylo-1.db""#,
        ]
        if let contentLength { headers["Content-Length"] = String(contentLength) }
        return .response(status: 200, headers: headers, body: Data(repeating: 0x42, count: bytes))
    }

    @Test("A backup download reports its progress and keeps the bytes as sent")
    func chunkedProgress() async throws {
        let mock = MockURLProtocol.state
        mock.reset([backupReply(bytes: 20, contentLength: 20)])
        let seen = ProgressLog()
        let file = try await operatorClient().download(
            Endpoints.DownloadBackup(name: "sylo-1.db"), progress: { seen.add($0, $1) })
        defer { file.discard() }
        #expect(file.filename == "sylo-1.db")
        #expect(try file.contents() == Data(repeating: 0x42, count: 20))
        let last = try #require(seen.last)
        #expect(last.sent == 20)
        #expect(last.total == 20)
    }

    @Test("A big download that grows past its limit stops, and nothing is left on disk")
    func chunkedLimitWhileReading() async throws {
        let directory = try emptyDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        MockURLProtocol.state.reset([backupReply(bytes: 20)])
        let client = try operatorClient(directory: directory)
        await #expect(throws: NetworkError.tooLarge) {
            _ = try await client.download(BigDownload())
        }
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
    }

    @Test("A big download that says it is too long is refused before any byte is kept")
    func chunkedLimitDeclared() async throws {
        let directory = try emptyDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        MockURLProtocol.state.reset([backupReply(bytes: 20, contentLength: 600)])
        let client = try operatorClient(directory: directory)
        await #expect(throws: NetworkError.tooLarge) {
            _ = try await client.download(BigDownload())
        }
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
    }

    @Test("A big download keeps the server's words when it is refused")
    func chunkedRefusal() async throws {
        MockURLProtocol.state.reset([.json(403, #"{"error":"Restricted to Sylo's operators."}"#)])
        let client = try operatorClient()
        var thrown: NetworkError?
        do {
            _ = try await client.download(Endpoints.DownloadBackup(name: "sylo-1.db"))
        } catch {
            thrown = NetworkError(error)
        }
        #expect(thrown == NetworkError.forbidden)
        #expect(thrown?.serverMessage == "Restricted to Sylo's operators.")
    }
}

/// A big download with a limit of its own (10 bytes), to try the stop without a 512 MB answer.
private struct BigDownload: APIEndpoint {
    typealias Response = EmptyResponse
    var path = "/api/v2/probe/big"
    var isLargeDownload: Bool { true }
    var maxDownloadBytes: Int? = 10
}

/// What a @Sendable progress closure saw.
private final class ProgressLog: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [(sent: Int64, total: Int64)] = []
    func add(_ sent: Int64, _ total: Int64) { lock.withLock { values.append((sent, total)) } }
    var last: (sent: Int64, total: Int64)? { lock.withLock { values.last } }
}
