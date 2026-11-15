import Foundation
import Testing
@testable import SyloKit

@Suite("Multipart form")
struct MultipartFormTests {
    private static let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF])

    @Test("One file part, byte for byte")
    func goldenFile() {
        var form = MultipartForm(boundary: "BOUNDARY")
        form.addFile(name: "file", filename: "pic.png", mimeType: "image/png", data: Self.png)

        var expected = Data()
        expected.append(Data((
            "--BOUNDARY\r\n"
            + "Content-Disposition: form-data; name=\"file\"; filename=\"pic.png\"\r\n"
            + "Content-Type: image/png\r\n"
            + "\r\n").utf8))
        expected.append(Self.png)
        expected.append(Data("\r\n--BOUNDARY--\r\n".utf8))
        #expect(form.data == expected)
    }

    @Test("Fields and files keep their order, each after its own boundary")
    func goldenFieldAndFile() {
        var form = MultipartForm(boundary: "B")
        form.addField(name: "name", value: "Gold coin")
        form.addFile(name: "file", filename: "a.jpg", mimeType: "image/jpeg", data: Data("JPEG".utf8))

        let text = String(decoding: form.data, as: UTF8.self)
        #expect(text == "--B\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\nGold coin\r\n"
            + "--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.jpg\"\r\nContent-Type: image/jpeg\r\n\r\nJPEG\r\n"
            + "--B--\r\n")
    }

    @Test("An empty form is only the closing boundary")
    func empty() {
        #expect(MultipartForm(boundary: "B").data == Data("--B--\r\n".utf8))
    }

    @Test("The content type names the boundary, and the raw body carries both")
    func contentType() {
        var form = MultipartForm(boundary: "XYZ")
        form.addField(name: "a", value: "b")
        #expect(form.contentType == "multipart/form-data; boundary=XYZ")
        #expect(form.rawBody == RawBody(data: form.data, contentType: "multipart/form-data; boundary=XYZ"))
    }

    @Test("A default boundary is different every time")
    func randomBoundary() {
        #expect(MultipartForm().boundary != MultipartForm().boundary)
        #expect(MultipartForm().boundary.hasPrefix("SyloBoundary-"))
    }

    @Test("A quote or a line break in a name cannot end the header early")
    func escaping() {
        var form = MultipartForm(boundary: "B")
        form.addFile(name: "file", filename: "a\"b\r\nX-Evil: 1.png", mimeType: "image/png", data: Data())
        let text = String(decoding: form.data, as: UTF8.self)
        #expect(text.contains("filename=\"a%22bX-Evil: 1.png\"\r\n"))
        // Exactly the lines this form needs: boundary, disposition, type, blank, empty body, closing.
        #expect(text.components(separatedBy: "\r\n").count == 7)
    }
}
