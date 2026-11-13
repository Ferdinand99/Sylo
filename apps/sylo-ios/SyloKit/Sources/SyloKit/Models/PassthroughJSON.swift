import Foundation

// Fields of a server object that the app does not model. The server builds a whole object from what it
// is sent (a form, a question), so a field the app does not know about would be reset to its default by
// the next save unless it is kept and sent back, the way the web dashboard's editor spreads the draft.

/// Any JSON value, kept as it came so it can be sent back unchanged.
public enum PassthroughJSON: Codable, Sendable, Hashable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([PassthroughJSON])
    case object([String: PassthroughJSON])

    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let value = try? c.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? c.decode(Int.self) {
            self = .int(value)
        } else if let value = try? c.decode(Double.self) {
            self = .double(value)
        } else if let value = try? c.decode(String.self) {
            self = .string(value)
        } else if let value = try? c.decode([PassthroughJSON].self) {
            self = .array(value)
        } else {
            self = .object(try c.decode([String: PassthroughJSON].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let value): try c.encode(value)
        case .int(let value): try c.encode(value)
        case .double(let value): try c.encode(value)
        case .string(let value): try c.encode(value)
        case .array(let value): try c.encode(value)
        case .object(let value): try c.encode(value)
        }
    }
}

/// A coding key for any name, to read and write the keys a type does not list.
struct PassthroughKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }

    init(_ name: String) { stringValue = name }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

enum Passthrough {
    /// Every key of the object that is not in `known`, with its value.
    static func read(_ decoder: any Decoder, excluding known: Set<String>) throws -> [String: PassthroughJSON] {
        let all = try decoder.container(keyedBy: PassthroughKey.self)
        var extras: [String: PassthroughJSON] = [:]
        for key in all.allKeys where !known.contains(key.stringValue) {
            extras[key.stringValue] = try all.decode(PassthroughJSON.self, forKey: key)
        }
        return extras
    }

    /// Writes the kept keys first, so a field the app models always wins over a kept one of the same name.
    static func write(_ extras: [String: PassthroughJSON], excluding known: Set<String>,
                      to container: inout KeyedEncodingContainer<PassthroughKey>) throws {
        for (key, value) in extras where !known.contains(key) {
            try container.encode(value, forKey: PassthroughKey(key))
        }
    }
}
