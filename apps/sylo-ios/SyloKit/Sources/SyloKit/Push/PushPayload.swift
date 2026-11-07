import Foundation

// What a push from Postal Pigeon carries, and the tag that ties a handle to a Sylo server.
// Pigeon's docs/api.md, "What the push contains":
// `{"hr": {"v": 1, "k": "<kind>", "t": "<tag>", "r": "<ref>"}}`.
//
// The app never acts on the content of a push. It looks `t` up in its own registry, which gives
// one of its own servers, and it asks that server for the text behind `r`.

/// The tag the app gives Pigeon with a new handle. Pigeon echoes it in every push for that handle.
public enum PushTag {
    /// 16 random bytes as unpadded base64url (22 characters).
    public static func generate() -> String {
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<16).map { _ in UInt8.random(in: 0...255, using: &generator) }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// What the app sends to Pigeon: exactly the shape ``generate()`` makes.
    public static func isWellFormed(_ tag: String) -> Bool {
        tag.utf8.count == 22 && tag.utf8.allSatisfy(isURLSafe)
    }
}

/// 1 to 64 characters of `A-Za-z0-9_-`: safe to put in a URL path, whatever the sender meant by it.
func isLookupKey(_ value: String) -> Bool {
    (1...64).contains(value.utf8.count) && value.utf8.allSatisfy(isURLSafe)
}

/// `A-Za-z0-9_-`.
func isURLSafe(_ byte: UInt8) -> Bool {
    (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A)
        || byte == 0x5F || byte == 0x2D
}

/// The `hr` object of a version 1 push.
public struct PigeonPush: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// A visible notification; `ref` names the text on the server.
        case alert
        /// A silent push. Sylo does not use it.
        case sync
        /// A kind this version of the app does not know.
        case other(String)
    }

    public let kind: Kind
    /// Looks up the server in the ``PushRegistry``.
    public let tag: String
    /// A lookup key for the text on that server; never a URL, never shown.
    public let ref: String?

    public init(kind: Kind, tag: String, ref: String?) {
        self.kind = kind
        self.tag = tag
        self.ref = ref
    }
}

/// How the app reads the payload of a push.
public enum PushPayload: Equatable, Sendable {
    case v1(PigeonPush)
    /// A later version of the format: nothing is read from it.
    case unsupportedVersion
    /// Not a Pigeon push (the older direct and relay pushes have no `hr`), or a field is missing or
    /// does not have the expected shape.
    case malformed

    /// `userInfo` as iOS hands it over (the whole payload, `aps` included).
    public static func parse(_ userInfo: [AnyHashable: Any]) -> PushPayload {
        guard let hr = userInfo["hr"] as? [String: Any] else { return .malformed }
        guard let version = integer(hr["v"]) else { return .malformed }
        guard version == 1 else { return .unsupportedVersion }
        guard let kind = hr["k"] as? String, !kind.isEmpty, kind.utf8.count <= 32,
            let tag = hr["t"] as? String, isLookupKey(tag)
        else { return .malformed }
        var ref: String?
        if let raw = hr["r"], !(raw is NSNull) {
            // A ref that cannot be a lookup key is not used (and not put in a URL).
            guard let text = raw as? String, isLookupKey(text) else { return .malformed }
            ref = text
        }
        let parsedKind: PigeonPush.Kind =
            switch kind {
            case "alert": .alert
            case "sync": .sync
            default: .other(kind)
            }
        return .v1(PigeonPush(kind: parsedKind, tag: tag, ref: ref))
    }

    private static func integer(_ value: Any?) -> Int? {
        if let int = value as? Int { return int }
        // JSON numbers can arrive as doubles; only whole ones count.
        if let double = value as? Double, double == double.rounded(), abs(double) < 1_000_000 {
            return Int(double)
        }
        return nil
    }
}
