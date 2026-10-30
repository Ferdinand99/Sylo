import Foundation
import Testing
@testable import SyloKit

@Suite("Push payload and registry")
struct PushPayloadTests {
    static let tag = "AAAAAAAAAAAAAAAAAAAAAA"
    static let ref = "BBBBBBBBBBBBBBBBBBBBBB"

    static func userInfo(_ hr: [String: Any]) -> [AnyHashable: Any] {
        ["aps": ["alert": ["title-loc-key": "HR_PUSH_TITLE"], "mutable-content": 1], "hr": hr]
    }

    // MARK: Payload

    @Test("A version 1 alert names its tag and its ref")
    func alert() {
        let payload = PushPayload.parse(Self.userInfo(["v": 1, "k": "alert", "t": Self.tag, "r": Self.ref]))
        #expect(payload == .v1(PigeonPush(kind: .alert, tag: Self.tag, ref: Self.ref)))
    }

    @Test("The ref is optional, and a sync or unknown kind is kept as it is")
    func kinds() {
        #expect(
            PushPayload.parse(Self.userInfo(["v": 1, "k": "sync", "t": Self.tag]))
                == .v1(PigeonPush(kind: .sync, tag: Self.tag, ref: nil)))
        #expect(
            PushPayload.parse(Self.userInfo(["v": 1, "k": "alert", "t": Self.tag, "r": NSNull()]))
                == .v1(PigeonPush(kind: .alert, tag: Self.tag, ref: nil)))
        #expect(
            PushPayload.parse(Self.userInfo(["v": 1, "k": "novel", "t": Self.tag]))
                == .v1(PigeonPush(kind: .other("novel"), tag: Self.tag, ref: nil)))
    }

    @Test("The version may arrive as a whole number of any kind, but only 1 is read")
    func versions() {
        #expect(PushPayload.parse(Self.userInfo(["v": 1.0, "k": "alert", "t": Self.tag])) != .malformed)
        #expect(PushPayload.parse(Self.userInfo(["v": NSNumber(value: 1), "k": "alert", "t": Self.tag])) != .malformed)
        #expect(PushPayload.parse(Self.userInfo(["v": 2, "k": "alert", "t": Self.tag])) == .unsupportedVersion)
        #expect(PushPayload.parse(Self.userInfo(["v": 1.5, "k": "alert", "t": Self.tag])) == .malformed)
        #expect(PushPayload.parse(Self.userInfo(["v": "1", "k": "alert", "t": Self.tag])) == .malformed)
    }

    @Test("Anything else is not a Pigeon push: the older direct and relay pushes, or a damaged one")
    func malformed() {
        #expect(PushPayload.parse([:]) == .malformed)
        // The older paths carry their own text and a `sylo` entry.
        #expect(
            PushPayload.parse(["aps": ["alert": ["title": "Alpha"]], "sylo": ["kind": "ticket"]]) == .malformed)
        #expect(PushPayload.parse(["hr": "alert"]) == .malformed)
        #expect(PushPayload.parse(Self.userInfo(["k": "alert", "t": Self.tag])) == .malformed)
        #expect(PushPayload.parse(Self.userInfo(["v": 1, "t": Self.tag])) == .malformed)
        #expect(PushPayload.parse(Self.userInfo(["v": 1, "k": "", "t": Self.tag])) == .malformed)
        #expect(PushPayload.parse(Self.userInfo(["v": 1, "k": String(repeating: "k", count: 33), "t": Self.tag])) == .malformed)
        #expect(PushPayload.parse(Self.userInfo(["v": 1, "k": "alert"])) == .malformed)
        #expect(PushPayload.parse(Self.userInfo(["v": 1, "k": "alert", "t": 5])) == .malformed)
    }

    @Test("A tag or ref that could change a URL is refused, not used")
    func unsafeKeys() {
        for bad in ["a/b", "../x", "a b", "a?b", "a#b", "", String(repeating: "a", count: 65), "é"] {
            #expect(
                PushPayload.parse(Self.userInfo(["v": 1, "k": "alert", "t": bad])) == .malformed, "tag \(bad)")
            #expect(
                PushPayload.parse(Self.userInfo(["v": 1, "k": "alert", "t": Self.tag, "r": bad])) == .malformed,
                "ref \(bad)")
        }
    }

    // MARK: Tags

    @Test("A tag is 16 random bytes as 22 characters of base64url, and a different one every time")
    func tags() {
        let tags = (0..<50).map { _ in PushTag.generate() }
        for tag in tags {
            #expect(PushTag.isWellFormed(tag), "\(tag)")
            #expect(tag.utf8.count == 22)
        }
        #expect(Set(tags).count == 50)
        #expect(!PushTag.isWellFormed("short"))
        #expect(!PushTag.isWellFormed(String(repeating: "a", count: 21)))
        #expect(!PushTag.isWellFormed(String(repeating: "a", count: 22) + "="))
        #expect(!PushTag.isWellFormed(String(repeating: "+", count: 22)))
    }

    // MARK: Registry

    private static func entry(
        tag: String = tag, server: String = "https://sylo.example.com", device: String = "hrd_1", handle: String = "h1"
    ) throws -> PushEntry {
        PushEntry(
            tag: tag, server: try ServerURL(server), relayDeviceId: device, relayHandleId: handle,
            created: Date(timeIntervalSince1970: 1_800_000_000))
    }

    private func withRegistry(_ body: (PushRegistry, URL) throws -> Void) throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("SyloKitTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("nested").appendingPathComponent("push-tags.json")
        try body(PushRegistry(fileURL: file), file)
    }

    @Test("Entries are found by tag and by server, and survive a new registry on the same file")
    func registry() throws {
        try withRegistry { registry, file in
            #expect(registry.entries().isEmpty)
            let one = try Self.entry()
            try registry.save(one)
            #expect(registry.entry(forTag: Self.tag) == one)
            #expect(registry.entry(forServer: one.server) == one)
            #expect(registry.entry(forTag: "other") == nil)
            #expect(registry.entry(forServer: try ServerURL("https://other.example.com")) == nil)
            #expect(PushRegistry(fileURL: file).entries() == [one])
        }
    }

    @Test("A server or a tag has one entry: saving replaces the old one")
    func replaces() throws {
        try withRegistry { registry, _ in
            try registry.save(try Self.entry(tag: "tag-1", handle: "h1"))
            try registry.save(try Self.entry(tag: "tag-2", handle: "h2"))
            #expect(registry.entries().map(\.tag) == ["tag-2"])

            try registry.save(try Self.entry(tag: "tag-3", server: "https://other.example.com", handle: "h3"))
            #expect(registry.entries().count == 2)
            // The same tag for another server replaces that one.
            try registry.save(try Self.entry(tag: "tag-3", handle: "h4"))
            #expect(registry.entries().map(\.relayHandleId) == ["h4"])
        }
    }

    @Test("Removing a server and removing everything")
    func removes() throws {
        try withRegistry { registry, _ in
            let a = try Self.entry(tag: "tag-a")
            let b = try Self.entry(tag: "tag-b", server: "https://other.example.com")
            try registry.save(a)
            try registry.save(b)
            try registry.remove(server: a.server)
            #expect(registry.entries() == [b])
            try registry.remove(server: a.server)
            #expect(registry.entries() == [b])
            try registry.removeAll()
            #expect(registry.entries().isEmpty)
            try registry.removeAll()
        }
    }

    @Test("A damaged file, or one from a later version, reads as empty")
    func damaged() throws {
        try withRegistry { registry, file in
            try registry.save(try Self.entry())
            try Data("not json".utf8).write(to: file)
            #expect(registry.entries().isEmpty)

            try Data(#"{"version": 2, "entries": []}"#.utf8).write(to: file)
            #expect(registry.entries().isEmpty)

            // And a good save puts it right.
            try registry.save(try Self.entry())
            #expect(registry.entries().count == 1)
        }
    }

    @Test("The file holds no handle and no key, only what the extension needs")
    func noSecrets() throws {
        try withRegistry { registry, file in
            try registry.save(try Self.entry())
            let text = String(decoding: try Data(contentsOf: file), as: UTF8.self)
            #expect(text.contains(Self.tag))
            #expect(text.contains("sylo.example.com"))
            #expect(!text.contains("hrh_"))
            #expect(!text.contains("hrm_"))
        }
    }
}
