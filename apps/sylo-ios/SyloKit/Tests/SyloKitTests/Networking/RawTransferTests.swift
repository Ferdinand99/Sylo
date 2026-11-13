import Foundation
import Testing
@testable import SyloKit

@Suite("Raw transfer helpers")
struct RawTransferTests {
    // MARK: Content-Disposition

    @Test("File names are read from a Content-Disposition header", arguments: [
        (#"attachment; filename="applications-form-3-pending.csv""#, "applications-form-3-pending.csv"),
        (#"attachment; filename="a b.csv""#, "a b.csv"),
        ("attachment; filename=plain.json", "plain.json"),
        (#"attachment; filename="say \"hi\".txt""#, #"say "hi".txt"#),
        (#"attachment; filename="semi;colon.csv""#, "semi;colon.csv"),
        (#"attachment; filename="sylo-123-config.json"; size=12"#, "sylo-123-config.json"),
        ("attachment; filename*=UTF-8''%E2%82%AC%20list.csv", "\u{20AC} list.csv"),
        (#"attachment; filename="fallback.csv"; filename*=UTF-8''r%C3%A9sum%C3%A9.csv"#, "r\u{E9}sum\u{E9}.csv"),
        (#"attachment; FILENAME="Upper.CSV""#, "Upper.CSV"),
        (#"attachment; filename="../../etc/passwd""#, "passwd"),
        (#"attachment; filename="..""#, ""),
    ])
    func filenames(header: String, expected: String) {
        // "" stands for "no usable name".
        #expect(ContentDisposition.filename(from: header) ?? "" == expected)
    }

    @Test("No file name in the header means nil")
    func noFilename() {
        #expect(ContentDisposition.filename(from: nil) == nil)
        #expect(ContentDisposition.filename(from: "") == nil)
        #expect(ContentDisposition.filename(from: "attachment") == nil)
        #expect(ContentDisposition.filename(from: "inline; size=4") == nil)
        #expect(ContentDisposition.filename(from: #"attachment; filename="""#) == nil)
    }

    @Test("An extended name in another charset is ignored in favour of the plain one")
    func unknownCharset() {
        #expect(ContentDisposition.filename(from: "attachment; filename*=ISO-8859-1''r%E9sum%E9.csv; filename=\"plain.csv\"") == "plain.csv")
    }

    @Test("Sanitising keeps the last path part, drops control characters and leading dots, and caps the length")
    func sanitising() {
        #expect(ContentDisposition.sanitized("a/b\\c.txt") == "c.txt")
        #expect(ContentDisposition.sanitized(".hidden") == "hidden")
        #expect(ContentDisposition.sanitized("a\u{0}b\u{7}.txt") == "ab.txt")
        #expect(ContentDisposition.sanitized("  spaced.csv  ") == "spaced.csv")
        #expect(ContentDisposition.sanitized("") == nil)
        #expect(ContentDisposition.sanitized("/") == nil)
        #expect(ContentDisposition.sanitized("...") == nil)
        #expect(ContentDisposition.sanitized(String(repeating: "x", count: 300))?.count == 120)
    }

    @Test("A name by media type when the server sent none", arguments: [
        ("text/csv", "download.csv"), ("application/json", "download.json"), ("TEXT/HTML", "download.html"),
        ("image/png", "download.png"), ("application/octet-stream", "download"),
    ])
    func fallbackNames(mime: String, expected: String) {
        #expect(DownloadedFile.fallbackFilename(mimeType: mime) == expected)
    }

    // MARK: Downloaded files

    @Test("A written file is on disk under its name, readable, and gone after discard")
    func writeAndDiscard() throws {
        let file = try DownloadedFile.write(Data("a,b\n1,2\n".utf8), filename: "rows.csv", mimeType: "text/csv")
        #expect(file.filename == "rows.csv")
        #expect(file.mimeType == "text/csv")
        #expect(file.byteCount == 8)
        #expect(file.fileURL.lastPathComponent == "rows.csv")
        #expect(try file.contents() == Data("a,b\n1,2\n".utf8))
        #expect(FileManager.default.fileExists(atPath: file.fileURL.path))

        file.discard()
        #expect(!FileManager.default.fileExists(atPath: file.fileURL.path))
        #expect(!FileManager.default.fileExists(atPath: file.fileURL.deletingLastPathComponent().path))
        file.discard()
    }

    @Test("Two files with the same name do not collide")
    func sameNameTwice() throws {
        let one = try DownloadedFile.write(Data("1".utf8), filename: "same.txt", mimeType: "text/plain")
        let two = try DownloadedFile.write(Data("2".utf8), filename: "same.txt", mimeType: "text/plain")
        defer { one.discard(); two.discard() }
        #expect(one.fileURL != two.fileURL)
        #expect(try one.contents() == Data("1".utf8))
        #expect(try two.contents() == Data("2".utf8))
    }

    @Test("A name that cannot be used becomes one by type")
    func unusableName() throws {
        let file = try DownloadedFile.write(Data("x".utf8), filename: "../", mimeType: "text/csv")
        defer { file.discard() }
        #expect(file.filename == "download.csv")
        #expect(file.fileURL.lastPathComponent == "download.csv")
    }

    // MARK: Links on the server

    @Test("A link on the server becomes an API path and query; links elsewhere do not")
    func apiPath() throws {
        let server = try ServerURL("https://example.com/sylo")
        let found = try #require(server.apiPath(of: try #require(URL(string: "https://example.com/sylo/c/abc.webp?size=2&x=a%20b"))))
        #expect(found.path == "/c/abc.webp")
        #expect(found.query == [URLQueryItem(name: "size", value: "2"), URLQueryItem(name: "x", value: "a b")])

        #expect(server.apiPath(of: try #require(URL(string: "https://example.com/sylo/c/abc.webp")))?.query == [])
        #expect(server.apiPath(of: try #require(URL(string: "HTTPS://EXAMPLE.COM/sylo/c/abc.webp")))?.path == "/c/abc.webp")
        // Another host, the same host outside the sub-path, a lookalike path and another scheme.
        #expect(server.apiPath(of: try #require(URL(string: "https://evil.example.org/sylo/c/abc.webp"))) == nil)
        #expect(server.apiPath(of: try #require(URL(string: "https://example.com/other/c/abc.webp"))) == nil)
        #expect(server.apiPath(of: try #require(URL(string: "https://example.com/sylo-evil/c/abc.webp"))) == nil)
        #expect(server.apiPath(of: try #require(URL(string: "http://example.com/sylo/c/abc.webp"))) == nil)
        #expect(server.apiPath(of: try #require(URL(string: "https://example.com/sylo"))) == nil)
    }

    @Test("A resource from a link keeps the path and query, and refuses another host")
    func resourceFromURL() throws {
        let server = try ServerURL("https://example.com")
        let resource = try #require(Endpoints.Resource(url: try #require(URL(string: "https://example.com/api/v2/x?a=1")), on: server))
        #expect(resource.path == "/api/v2/x")
        #expect(resource.query == [URLQueryItem(name: "a", value: "1")])
        #expect(resource.method == .get)
        #expect(Endpoints.Resource(url: try #require(URL(string: "https://example.org/api/v2/x")), on: server) == nil)
    }

    @Test("The network error for a too-large answer has words")
    func tooLargeMessage() {
        #expect(!NetworkError.tooLarge.userMessage.isEmpty)
        #expect(NetworkError.from(status: 413, body: Data(), isJSON: false) == .tooLarge)
    }
}
