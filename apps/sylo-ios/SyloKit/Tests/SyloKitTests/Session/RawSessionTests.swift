import Foundation
import Testing
@testable import SyloKit

/// Downloads and uploads through the session: the token goes along and a 401 signs out, like
/// every other signed-in call.
@MainActor
@Suite("Session downloads and uploads")
struct RawSessionTests {
    private struct Upload: APIEndpoint {
        typealias Response = OKResponse
        var path = "/api/v2/upload"
        var method: HTTPMethod = .post
        var rawBody: RawBody? = RawBody(data: Data([1]), contentType: "application/octet-stream")
    }

    @Test("A download goes out with the token and returns the file")
    func downloadWithToken() async throws {
        let clients = StubClients { _ in
            try DownloadedFile.write(Data("a".utf8), filename: "x.csv", mimeType: "text/csv")
        }
        let session = makeSignedInSession(clients: clients)
        let file = try await session.download(Endpoints.Resource(path: "/api/v2/x"))
        defer { file.discard() }
        #expect(file.filename == "x.csv")
        #expect(clients.calls.last?.token == "sylo_live")
        #expect(clients.calls.last?.endpoint is Endpoints.Resource)
    }

    @Test("A 401 on a download signs the app out, with a notice")
    func downloadUnauthorized() async throws {
        let clients = StubClients { _ in throw NetworkError.unauthorized }
        let server = try ServerURL("https://sylo.example.com")
        let session = makeSignedInSession(clients: clients, server: server)
        await #expect(throws: NetworkError.unauthorized) {
            try await session.download(Endpoints.Resource(path: "/api/v2/x"))
        }
        #expect(session.phase == .signIn(server))
        #expect(session.notice == NetworkError.unauthorized.userMessage)
    }

    @Test("Other download errors keep the session and reach the caller")
    func downloadErrorKeepsSession() async throws {
        let clients = StubClients { _ in throw NetworkError.tooLarge }
        let server = try ServerURL("https://sylo.example.com")
        let session = makeSignedInSession(clients: clients, server: server)
        await #expect(throws: NetworkError.tooLarge) {
            try await session.download(Endpoints.Resource(path: "/api/v2/x"))
        }
        #expect(session.phase == .signedIn(server))
    }

    @Test("A client that cannot download answers like a missing file")
    func defaultDownload() async throws {
        struct JSONOnly: APIClient {
            func send<E: APIEndpoint>(_ endpoint: E) async throws -> E.Response { throw NetworkError.notFound }
        }
        await #expect(throws: NetworkError.notFound) {
            try await JSONOnly().download(Endpoints.Resource(path: "/x"))
        }
    }

    @Test("An upload is a send with the token and the 401 handling")
    func uploadWithToken() async throws {
        let clients = StubClients { _ in OKResponse(ok: true) }
        let session = makeSignedInSession(clients: clients)
        let answer = try await session.upload(Upload())
        #expect(answer == OKResponse(ok: true))
        #expect(clients.calls.last?.token == "sylo_live")

        clients.setHandler { _ in throw NetworkError.unauthorized }
        await #expect(throws: NetworkError.unauthorized) { try await session.upload(Upload()) }
        #expect(session.notice == NetworkError.unauthorized.userMessage)
    }

    @Test("The file model downloads, holds the file, and deletes it on clear")
    func fileModel() async throws {
        let clients = StubClients { _ in
            try DownloadedFile.write(Data("a".utf8), filename: "x.csv", mimeType: "text/csv")
        }
        let model = FileDownloadModel(session: makeSignedInSession(clients: clients))
        #expect(model.file == nil)

        #expect(await model.download(Endpoints.Resource(path: "/x")))
        let first = try #require(model.file)
        #expect(model.downloadCount == 1)
        #expect(model.errorMessage == nil)
        #expect(FileManager.default.fileExists(atPath: first.fileURL.path))

        // A second download replaces the first, and the first is deleted.
        #expect(await model.download(Endpoints.Resource(path: "/x")))
        let second = try #require(model.file)
        #expect(second.fileURL != first.fileURL)
        #expect(!FileManager.default.fileExists(atPath: first.fileURL.path))

        model.clear()
        #expect(model.file == nil)
        #expect(!FileManager.default.fileExists(atPath: second.fileURL.path))
    }

    @Test("A failed download shows the server's message and keeps no file")
    func fileModelError() async {
        let clients = StubClients { _ in throw NetworkError.forbidden }
        let model = FileDownloadModel(session: makeSignedInSession(clients: clients))
        #expect(await model.download(Endpoints.Resource(path: "/x")) == false)
        #expect(model.file == nil)
        #expect(model.errorMessage == NetworkError.forbidden.userMessage)
        #expect(!model.isDownloading)
    }
}
