import Foundation

// Raw transfers: the pieces the JSON-only client does not cover. A request body that is not JSON (a
// multipart picture upload) and an answer that is a file (a CSV or JSON export, an HTML transcript,
// a PNG card). Both go through the same client, token and 401 handling as every other call.

/// A request body that is sent as it is, with its own `Content-Type` (a multipart form). An
/// endpoint that sets ``APIEndpoint/rawBody`` sends this instead of its JSON ``APIEndpoint/body``.
public struct RawBody: Sendable, Equatable {
    public let data: Data
    public let contentType: String

    public init(data: Data, contentType: String) {
        self.data = data
        self.contentType = contentType
    }
}

/// A file on disk that is sent as the request body, read from the disk as it goes (a backup of up to
/// 128 MB): it is never loaded into memory. An endpoint that sets ``APIEndpoint/uploadFile`` sends this
/// instead of ``APIEndpoint/rawBody`` and ``APIEndpoint/body``.
///
/// Every upload carries its own size limit, because the limits differ a lot: the server takes 2 MB for a
/// picture and 128 MB for a backup. The client measures the file on disk before sending anything and
/// refuses a longer one with ``NetworkError/tooLarge``.
public struct UploadFile: Sendable, Equatable {
    public let fileURL: URL
    public let contentType: String
    /// The most the endpoint takes, in bytes.
    public let maxBytes: Int64

    public init(fileURL: URL, contentType: String, maxBytes: Int64) {
        self.fileURL = fileURL
        self.contentType = contentType
        self.maxBytes = maxBytes
    }
}

/// A file the server sent, kept on disk in a temporary folder, never as one big `Data`: the share
/// sheet and Quick Look read the file, so a large export does not sit in memory.
///
/// The file lives in its own folder under the temporary directory and is named like the server
/// named it, so a share sheet shows a proper file name. Call ``discard()`` when done with it
/// (``FileDownloadModel`` does); ``removeAllTemporary()`` clears what is left over.
public struct DownloadedFile: Sendable, Equatable {
    /// Where the file is, ending in ``filename``.
    public let fileURL: URL
    /// A safe file name: no path, no control characters, never empty.
    public let filename: String
    /// The answer's `Content-Type` without parameters (`text/csv`), `application/octet-stream` when none.
    public let mimeType: String
    public let byteCount: Int

    public init(fileURL: URL, filename: String, mimeType: String, byteCount: Int) {
        self.fileURL = fileURL
        self.filename = filename
        self.mimeType = mimeType
        self.byteCount = byteCount
    }

    /// The file's bytes. For small files only (a card, a short export); big ones are shared by URL.
    public func contents() throws -> Data {
        try Data(contentsOf: fileURL)
    }

    /// Deletes the file and its folder. Safe to call twice.
    public func discard() {
        try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent())
    }

    /// Writes bytes to a new temporary file, for tests and for content the app builds itself.
    public static func write(_ data: Data, filename: String, mimeType: String) throws -> DownloadedFile {
        let name = ContentDisposition.sanitized(filename) ?? fallbackFilename(mimeType: mimeType)
        let url = try makeDestination(filename: name)
        do {
            try data.write(to: url)
        } catch {
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
            throw error
        }
        return DownloadedFile(fileURL: url, filename: name, mimeType: mimeType, byteCount: data.count)
    }

    /// Deletes every file left behind by earlier downloads. The app calls it at launch, when no
    /// download can be running; exports can hold personal data, so nothing is kept between launches.
    public static func removeAllTemporary() {
        try? FileManager.default.removeItem(at: root)
    }

    /// A file name for an answer that came without one, by its type (`download.csv`).
    public static func fallbackFilename(mimeType: String) -> String {
        let ext: String?
        switch mimeType.lowercased() {
        case "text/csv": ext = "csv"
        case "application/json": ext = "json"
        case "text/html": ext = "html"
        case "text/plain": ext = "txt"
        case "image/png": ext = "png"
        case "image/jpeg": ext = "jpg"
        case "image/webp": ext = "webp"
        case "application/zip": ext = "zip"
        default: ext = nil
        }
        if let ext { return "download." + ext }
        return "download"
    }

    /// A new, empty folder for one file, and the path of the file in it.
    static func makeDestination(filename: String, in directory: URL? = nil) throws -> URL {
        let folder = (directory ?? root).appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent(filename, isDirectory: false)
    }

    private static var root: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("sylo-downloads", isDirectory: true)
    }
}

/// Reads the file name out of a `Content-Disposition` header.
public enum ContentDisposition {
    /// The file name the header asks for, made safe (see ``sanitized(_:)``), or nil when there is
    /// none. Understands `filename="a b.csv"` (quoted, with `\"` escapes), `filename=a.csv`
    /// (unquoted) and `filename*=UTF-8''%E2%82%AC.csv` (which wins over the plain form).
    public static func filename(from header: String?) -> String? {
        guard let header else { return nil }
        var plain: String?
        var extended: String?
        for part in splitParameters(header).dropFirst() {
            guard let equals = part.firstIndex(of: "=") else { continue }
            let name = part[..<equals].trimmingCharacters(in: .whitespaces).lowercased()
            let value = part[part.index(after: equals)...].trimmingCharacters(in: .whitespaces)
            switch name {
            case "filename": plain = unquote(value)
            case "filename*": extended = decodeExtended(value)
            default: break
            }
        }
        for candidate in [extended, plain] {
            if let candidate, let safe = sanitized(candidate) { return safe }
        }
        return nil
    }

    /// A name that cannot leave its folder or confuse a file system: only the part after the last
    /// `/` or `\`, no control characters, no leading dots or spaces, at most 120 characters. Nil when
    /// nothing is left.
    public static func sanitized(_ name: String) -> String? {
        let last = name.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
        var scalars = String.UnicodeScalarView()
        for scalar in last.unicodeScalars where scalar.value >= 0x20 && scalar.value != 0x7F {
            scalars.append(scalar)
        }
        var trimmed = String(scalars).trimmingCharacters(in: .whitespaces)
        while trimmed.hasPrefix(".") { trimmed.removeFirst() }
        trimmed = trimmed.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(120))
    }

    /// The header split at `;` outside quotes.
    private static func splitParameters(_ header: String) -> [String] {
        var parts: [String] = []
        var current = ""
        var inQuotes = false
        var escaped = false
        for character in header {
            if escaped {
                current.append(character)
                escaped = false
            } else if inQuotes, character == "\\" {
                current.append(character)
                escaped = true
            } else if character == "\"" {
                inQuotes.toggle()
                current.append(character)
            } else if character == ";", !inQuotes {
                parts.append(current)
                current = ""
            } else {
                current.append(character)
            }
        }
        parts.append(current)
        return parts
    }

    private static func unquote(_ value: String) -> String {
        guard value.count >= 2, value.first == "\"", value.last == "\"" else { return value }
        var out = ""
        var escaped = false
        for character in value.dropFirst().dropLast() {
            if escaped {
                out.append(character)
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else {
                out.append(character)
            }
        }
        return out
    }

    /// `UTF-8''%E2%82%AC.csv` (RFC 5987): only UTF-8 is read.
    private static func decodeExtended(_ value: String) -> String? {
        let pieces = value.split(separator: "'", maxSplits: 2, omittingEmptySubsequences: false)
        guard pieces.count == 3 else { return nil }
        let charset = pieces[0].lowercased()
        guard charset == "utf-8" || charset == "utf8" else { return nil }
        return String(pieces[2]).removingPercentEncoding
    }
}

extension ServerURL {
    /// The API path and query of a URL on this server (same scheme, host, port and sub-path), or nil
    /// for a URL anywhere else. Lets a link the server sent be fetched with the token, while a link
    /// to another host never gets it.
    /// The query comes back percent-encoded exactly as the link spelled it, so a `+` or a `%2B` keeps
    /// its meaning when it is sent again.
    public func apiPath(of url: URL) -> (path: String, percentEncodedQuery: String?)? {
        let base = baseURL.absoluteString
        let text = url.absoluteString
        guard text.lowercased().hasPrefix(base.lowercased() + "/") else { return nil }
        let rest = String(text.dropFirst(base.count))
        guard let components = URLComponents(string: rest) else { return nil }
        return (components.percentEncodedPath, components.percentEncodedQuery)
    }
}

extension Endpoints {
    /// `GET <path>`: any file or picture on the server, for ``APIClient/download(_:)``.
    public struct Resource: APIEndpoint {
        public typealias Response = EmptyResponse
        /// Below the server address, percent-encoded, a leading slash optional.
        public let path: String
        public let query: [URLQueryItem]
        /// The query of a link, as the server spelled it; used instead of ``query`` when set.
        public let percentEncodedQuery: String?
        /// A limit for this file (a picture), checked before it is read; see ``APIEndpoint/maxDownloadBytes``.
        public let maxDownloadBytes: Int?

        public init(path: String, query: [URLQueryItem] = [], maxDownloadBytes: Int? = nil) {
            self.path = path
            self.query = query
            self.percentEncodedQuery = nil
            self.maxDownloadBytes = maxDownloadBytes
        }

        /// The resource a link on `server` points to; nil for a link to another host.
        public init?(url: URL, on server: ServerURL, maxDownloadBytes: Int? = nil) {
            guard let found = server.apiPath(of: url) else { return nil }
            path = found.path
            query = []
            percentEncodedQuery = found.percentEncodedQuery
            self.maxDownloadBytes = maxDownloadBytes
        }
    }
}
