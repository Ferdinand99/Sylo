import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import SyloKit

// Raw downloads and uploads through the real client and the mock URL protocol: the file arrives as
// it was sent whatever it is, non-JSON answers are fine, errors still map to NetworkError, and a
// multipart body goes out as it is. They extend `APIClientTests` so they run one after another: the
// mock's state is shared.

private struct ExportProbe: APIEndpoint {
    typealias Response = EmptyResponse
    var path = "/api/v2/guilds/1/modules/applications/forms/3/export"
    var query = [URLQueryItem(name: "format", value: "csv")]
}

private struct PictureUpload: APIEndpoint {
    typealias Response = OKResponse
    var path = "/api/v2/guilds/1/modules/economy/shop/items/7/image"
    var method: HTTPMethod = .post
    var rawBody: RawBody?
}

extension APIClientTests {
    private func rawClient(
        maxDownloadBytes: Int = URLSessionAPIClient.defaultMaxDownloadBytes, directory: URL? = nil
    ) throws -> URLSessionAPIClient {
        URLSessionAPIClient(
            server: try ServerURL("https://example.com/sylo"), session: MockURLProtocol.session(), decoder: JSONDecoder(),
            retryDelays: [.zero, .zero], maxDownloadBytes: maxDownloadBytes, downloadDirectory: directory,
            token: { "sylo_secret" })
    }

    /// An empty folder of its own for one test, so leftovers can be told from other tests' files.
    private func scratchDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("sylo-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func csvReply(_ body: String, disposition: String? = #"attachment; filename="apps.csv""#) -> MockReply {
        var headers = ["Content-Type": "text/csv; charset=utf-8"]
        if let disposition { headers["Content-Disposition"] = disposition }
        return .response(status: 200, headers: headers, body: Data(body.utf8))
    }

    // MARK: Downloads

    @Test("A download keeps the file as sent, named by Content-Disposition, with the token and no JSON Accept")
    func downloadKeepsFile() async throws {
        let mock = MockURLProtocol.state
        mock.reset([csvReply("name,answer\nAlex,yes\n")])
        let file = try await rawClient().download(ExportProbe())
        defer { file.discard() }

        #expect(file.filename == "apps.csv")
        #expect(file.mimeType == "text/csv")
        #expect(file.byteCount == 21)
        #expect(try file.contents() == Data("name,answer\nAlex,yes\n".utf8))

        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/applications/forms/3/export?format=csv")
        #expect(request.method == "GET")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
        #expect(request.header("Accept") == "*/*")
    }

    @Test("An HTML or other non-JSON answer is a file, not a wrong address")
    func downloadHTML() async throws {
        let mock = MockURLProtocol.state
        let html = Data("<!doctype html><html><body>Transcript</body></html>".utf8)
        mock.reset([.response(status: 200, headers: ["Content-Type": "text/html; charset=utf-8"], body: html)])
        let file = try await rawClient().download(ExportProbe())
        defer { file.discard() }
        #expect(file.mimeType == "text/html")
        #expect(file.filename == "download.html")
        #expect(try file.contents() == html)
    }

    @Test("An answer without a type or a name is a plain download")
    func downloadBare() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.response(status: 200, headers: [:], body: Data([1, 2, 3]))])
        let file = try await rawClient().download(ExportProbe())
        defer { file.discard() }
        #expect(file.mimeType == "application/octet-stream")
        #expect(file.filename == "download")
        #expect(file.byteCount == 3)
    }

    @Test("A name with a path in it is cut down to the file name")
    func downloadUnsafeName() async throws {
        let mock = MockURLProtocol.state
        mock.reset([csvReply("x", disposition: #"attachment; filename="../../evil.csv""#)])
        let file = try await rawClient().download(ExportProbe())
        defer { file.discard() }
        #expect(file.filename == "evil.csv")
        #expect(file.fileURL.lastPathComponent == "evil.csv")
    }

    @Test("A UTF-8 file name comes through", arguments: [
        (#"attachment; filename*=UTF-8''%E2%82%AC.csv"#, "\u{20AC}.csv"),
    ])
    func downloadUTF8Name(disposition: String, expected: String) async throws {
        let mock = MockURLProtocol.state
        mock.reset([csvReply("x", disposition: disposition)])
        let file = try await rawClient().download(ExportProbe())
        defer { file.discard() }
        #expect(file.filename == expected)
    }

    @Test("Download errors map like any other call", arguments: [
        (401, #"{"error":"Not signed in"}"#, NetworkError.unauthorized),
        (403, #"{"error":"No access"}"#, .forbidden),
        (404, #"{"error":"Unknown"}"#, .notFound),
        (400, #"{"error":"Pick a form first."}"#, .badRequest(message: "Pick a form first.")),
        (413, #"{"error":"too big"}"#, .tooLarge),
        (429, "", .rateLimited),
        (500, #"{"error":"boom"}"#, .server(status: 500)),
    ])
    func downloadErrors(status: Int, body: String, expected: NetworkError) async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(status, body)])
        await #expect(throws: expected) { try await rawClient().download(ExportProbe()) }
        #expect(mock.requests.count == 1)
    }

    @Test("A download over the limit is refused, one at the limit is kept")
    func downloadLimit() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.response(status: 200, headers: ["Content-Type": "text/csv"], body: Data(repeating: 0x61, count: 500))])
        await #expect(throws: NetworkError.tooLarge) { try await rawClient(maxDownloadBytes: 100).download(ExportProbe()) }

        mock.reset([.response(status: 200, headers: ["Content-Type": "text/csv"], body: Data(repeating: 0x61, count: 100))])
        let file = try await rawClient(maxDownloadBytes: 100).download(ExportProbe())
        defer { file.discard() }
        #expect(file.byteCount == 100)
    }

    @Test("An answer that grows past the limit mid-stream leaves no file behind")
    func downloadLimitCleansUp() async throws {
        let mock = MockURLProtocol.state
        let directory = try scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        mock.reset([.response(status: 200, headers: ["Content-Type": "text/csv"], body: Data(repeating: 0x61, count: 500))])
        await #expect(throws: NetworkError.tooLarge) {
            try await rawClient(maxDownloadBytes: 100, directory: directory).download(ExportProbe())
        }
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)

        // One that is kept is written into the folder it was given, in a folder of its own.
        mock.reset([csvReply("ok")])
        let file = try await rawClient(directory: directory).download(ExportProbe())
        #expect(file.fileURL.path.hasPrefix(directory.path))
        file.discard()
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
    }

    @Test("An answer that declares itself too long is refused before it is written")
    func downloadDeclaredLimit() async throws {
        let mock = MockURLProtocol.state
        let directory = try scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        mock.reset([.response(
            status: 200, headers: ["Content-Type": "text/csv", "Content-Length": "500"],
            body: Data(repeating: 0x61, count: 500))])
        await #expect(throws: NetworkError.tooLarge) {
            try await rawClient(maxDownloadBytes: 100, directory: directory).download(ExportProbe())
        }
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
    }

    @Test("A link's query reaches the server exactly as the server wrote it")
    func downloadKeepsLinkQuery() async throws {
        let mock = MockURLProtocol.state
        mock.reset([csvReply("x")])
        let server = try ServerURL("https://example.com/sylo")
        let linked = try #require(URL(string: "https://example.com/sylo/c/a.csv?x=a+b&y=c%2Bd"))
        let resource = try #require(Endpoints.Resource(url: linked, on: server))
        let file = try await rawClient().download(resource)
        defer { file.discard() }
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/c/a.csv?x=a+b&y=c%2Bd")
    }

    @Test("A + in a query value goes out as %2B on the wire")
    func plusOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"members":[]}"#)])
        _ = try await rawClient().send(Endpoints.SearchMembers(server: "1", text: "a+b"))
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/members?q=a%2Bb")
    }

    @Test("A big download is written in chunks and arrives whole")
    func downloadBig() async throws {
        let mock = MockURLProtocol.state
        let body = Data((0..<300_000).map { UInt8($0 % 251) })
        mock.reset([.response(status: 200, headers: ["Content-Type": "application/octet-stream"], body: body)])
        let file = try await rawClient().download(ExportProbe())
        defer { file.discard() }
        #expect(file.byteCount == 300_000)
        #expect(try file.contents() == body)
    }

    @Test("A download is tried again after a 503, like a GET")
    func downloadRetries() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(503, "{}"), csvReply("ok")])
        let file = try await rawClient().download(ExportProbe())
        defer { file.discard() }
        #expect(mock.requests.count == 2)
        #expect(try file.contents() == Data("ok".utf8))
    }

    @Test("A redirect is refused on a download too, and carries no token anywhere")
    func downloadRedirect() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.response(status: 302, headers: ["Location": "https://evil.example.org/x"], body: Data())])
        await #expect(throws: NetworkError.notASyloServer) { try await rawClient().download(ExportProbe()) }
        #expect(mock.requests.count == 1)
    }

    @Test("JSON calls still refuse an HTML page after the raw path was added")
    func jsonStillStrict() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.response(status: 200, headers: ["Content-Type": "text/html"], body: Data("<html></html>".utf8))])
        await #expect(throws: NetworkError.notASyloServer) { try await rawClient().send(Endpoints.ServerInfo()) }
    }

    // MARK: Uploads

    @Test("A raw body goes out as it is with its own Content-Type, and the JSON answer is read")
    func uploadSendsRawBody() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"ok":true}"#)])
        var form = MultipartForm(boundary: "TESTBOUNDARY")
        form.addFile(name: "file", filename: "pic.jpg", mimeType: "image/jpeg", data: Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00]))

        let answer = try await rawClient().send(PictureUpload(rawBody: form.rawBody))
        #expect(answer == OKResponse(ok: true))

        let request = try #require(mock.requests.first)
        #expect(request.method == "POST")
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/economy/shop/items/7/image")
        #expect(request.header("Content-Type") == "multipart/form-data; boundary=TESTBOUNDARY")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
        #expect(request.header("Accept") == "application/json")
        #expect(request.body == form.data)
    }

    @Test("Upload errors map to words: too large, wrong type, busy", arguments: [
        (413, #"{"error":"That picture is over 2 MB."}"#, NetworkError.tooLarge),
        (415, #"{"error":"Use PNG, JPEG or WebP."}"#, .http(status: 415)),
        (429, "", .rateLimited),
        (503, #"{"error":"Busy, try again."}"#, .server(status: 503)),
    ])
    func uploadErrors(status: Int, body: String, expected: NetworkError) async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(status, body)])
        var form = MultipartForm(boundary: "B")
        form.addFile(name: "file", filename: "pic.jpg", mimeType: "image/jpeg", data: Data([1]))
        await #expect(throws: expected) { try await rawClient().send(PictureUpload(rawBody: form.rawBody)) }
        // A POST is never retried, a busy answer included.
        #expect(mock.requests.count == 1)
    }
}
