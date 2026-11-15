import Foundation

/// A `multipart/form-data` body, built in memory (the collectible picture is at most 2 MB after the
/// app downsizes it). Use it as an endpoint's ``APIEndpoint/rawBody`` through ``rawBody``.
///
/// ```swift
/// var form = MultipartForm()
/// form.addFile(name: "file", filename: "picture.jpg", mimeType: "image/jpeg", data: jpeg)
/// ```
public struct MultipartForm: Sendable, Equatable {
    /// The boundary between parts. A random one by default; tests pass their own.
    public let boundary: String

    private struct Part: Sendable, Equatable {
        let name: String
        let filename: String?
        let mimeType: String?
        let data: Data
    }

    private var parts: [Part] = []

    public init(boundary: String = "SyloBoundary-" + UUID().uuidString) {
        self.boundary = boundary
    }

    /// The `Content-Type` header value, with the boundary.
    public var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    /// Adds a file part (`name` is the form field, `file` for the collectible picture).
    public mutating func addFile(name: String, filename: String, mimeType: String, data: Data) {
        parts.append(Part(name: name, filename: filename, mimeType: mimeType, data: data))
    }

    /// Adds a plain text field.
    public mutating func addField(name: String, value: String) {
        parts.append(Part(name: name, filename: nil, mimeType: nil, data: Data(value.utf8)))
    }

    /// The finished body: each part after `--boundary`, ending with `--boundary--`, lines ending in CRLF.
    public var data: Data {
        var body = Data()
        let crlf = Data("\r\n".utf8)
        for part in parts {
            body.append(Data("--\(boundary)\r\n".utf8))
            var disposition = "Content-Disposition: form-data; name=\"\(Self.escape(part.name))\""
            if let filename = part.filename {
                disposition += "; filename=\"\(Self.escape(filename))\""
            }
            body.append(Data((disposition + "\r\n").utf8))
            if let mimeType = part.mimeType {
                body.append(Data("Content-Type: \(mimeType)\r\n".utf8))
            }
            body.append(crlf)
            body.append(part.data)
            body.append(crlf)
        }
        body.append(Data("--\(boundary)--\r\n".utf8))
        return body
    }

    /// The body and its content type, ready for ``APIEndpoint/rawBody``.
    public var rawBody: RawBody { RawBody(data: data, contentType: contentType) }

    /// A quote or a line break in a name or file name would end the header early.
    private static func escape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: "\n", with: "")
            .replacingOccurrences(of: "\"", with: "%22")
    }
}
