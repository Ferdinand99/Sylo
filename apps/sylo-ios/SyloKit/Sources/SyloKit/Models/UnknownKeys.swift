import Foundation

// The one way the app keeps the keys of a server object that it does not model. The server builds a
// whole object from what it is sent (a form, a question, an embed), so a field the app does not know
// about would be reset to its default by the next save unless it is kept (as a `JSONValue`) and sent
// back, the way the web dashboard's editor spreads the draft.

/// A coding key made from any text, to read and write the keys a type does not list (and the keys it
/// does, where a type decodes by hand).
struct AnyCodingKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }

    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

enum UnknownKeys {
    /// The keys of the stored object that are not in `known`, as raw JSON, so a key a newer server
    /// added goes back unchanged when the object is saved again.
    ///
    /// Never throws: any JSON value decodes as a `JSONValue`, so a key is only left out when the
    /// decoder holds no object at all, and then there is nothing to keep.
    static func read(from decoder: any Decoder, excluding known: Set<String>) -> [String: JSONValue] {
        guard let all = try? decoder.container(keyedBy: AnyCodingKey.self) else { return [:] }
        var extra: [String: JSONValue] = [:]
        for key in all.allKeys where !known.contains(key.stringValue) {
            if let value = try? all.decode(JSONValue.self, forKey: key) { extra[key.stringValue] = value }
        }
        return extra
    }

    /// Writes the kept keys in a stable order, never over a key the caller writes (`known`). Call it
    /// before the modeled keys, so a field the app models always wins over a kept one of that name.
    static func write(
        _ extra: [String: JSONValue], excluding known: Set<String>,
        to container: inout KeyedEncodingContainer<AnyCodingKey>
    ) throws {
        for (name, value) in extra.sorted(by: { $0.key < $1.key }) where !known.contains(name) {
            try container.encode(value, forKey: AnyCodingKey(name))
        }
    }
}
