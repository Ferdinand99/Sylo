import Foundation

/// One Sylo server's push handle. No secrets: the handle itself (`hrh_…`) goes from Pigeon to the
/// server and is not kept. This is what lets the app, and the notification extension, tell which
/// server a push belongs to, and what is needed to take the handle down again.
public struct PushEntry: Codable, Sendable, Equatable {
    /// The tag Pigeon echoes in every push for the handle.
    public let tag: String
    /// The Sylo server that was given the handle.
    public let server: ServerURL
    /// The Pigeon device the handle belongs to (`hrd_…`). When the device is registered again the
    /// handle is dead, and this is how the app notices.
    public let relayDeviceId: String
    /// Pigeon's id for the handle, to revoke it.
    public let relayHandleId: String
    public let created: Date

    public init(tag: String, server: ServerURL, relayDeviceId: String, relayHandleId: String, created: Date) {
        self.tag = tag
        self.server = server
        self.relayDeviceId = relayDeviceId
        self.relayHandleId = relayHandleId
        self.created = created
    }
}

/// The tags in use, in a JSON file in the App Group container (written by the app, read by the
/// notification extension). Writes are atomic. A missing, damaged or newer file reads as empty: the
/// extension then leaves the notification as Pigeon sent it, and the app finds the handles again
/// by asking Pigeon (``PushHandleManager``).
public final class PushRegistry: @unchecked Sendable {
    // @unchecked: the file is only read or written while holding `lock` (and writes are atomic, so
    // the extension's process never sees half a file).
    private struct File: Codable {
        var version = 1
        var entries: [PushEntry]
    }

    private let fileURL: URL
    private let lock = NSLock()

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public func entries() -> [PushEntry] {
        lock.withLock { read() }
    }

    public func entry(forTag tag: String) -> PushEntry? {
        entries().first { $0.tag == tag }
    }

    public func entry(forServer server: ServerURL) -> PushEntry? {
        entries().first { $0.server == server }
    }

    /// Replaces the entry the server (or the tag) already had.
    public func save(_ entry: PushEntry) throws {
        try lock.withLock {
            var list = read().filter { $0.server != entry.server && $0.tag != entry.tag }
            list.append(entry)
            try write(list)
        }
    }

    public func remove(server: ServerURL) throws {
        try lock.withLock {
            let list = read()
            let kept = list.filter { $0.server != server }
            if kept.count != list.count { try write(kept) }
        }
    }

    public func removeAll() throws {
        try lock.withLock {
            if !read().isEmpty { try write([]) }
        }
    }

    private func read() -> [PushEntry] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let file = try? decoder.decode(File.self, from: data), file.version == 1 else { return [] }
        return file.entries
    }

    private func write(_ entries: [PushEntry]) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(File(entries: entries))
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: fileURL, options: .atomic)
    }
}
