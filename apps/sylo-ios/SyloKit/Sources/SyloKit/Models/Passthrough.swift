import Foundation

// Fields of a server object that the app does not model. The server builds a whole object from what it
// is sent (a form, a question), so a field the app does not know about would be reset to its default by
// the next save unless it is kept (as a `JSONValue`) and sent back, the way the web dashboard's editor
// spreads the draft.

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
    static func read(_ decoder: any Decoder, excluding known: Set<String>) throws -> [String: JSONValue] {
        let all = try decoder.container(keyedBy: PassthroughKey.self)
        var extras: [String: JSONValue] = [:]
        for key in all.allKeys where !known.contains(key.stringValue) {
            extras[key.stringValue] = try all.decode(JSONValue.self, forKey: key)
        }
        return extras
    }

    /// Writes the kept keys first, so a field the app models always wins over a kept one of the same name.
    static func write(_ extras: [String: JSONValue], excluding known: Set<String>,
                      to container: inout KeyedEncodingContainer<PassthroughKey>) throws {
        for (key, value) in extras where !known.contains(key) {
            try container.encode(value, forKey: PassthroughKey(key))
        }
    }
}
