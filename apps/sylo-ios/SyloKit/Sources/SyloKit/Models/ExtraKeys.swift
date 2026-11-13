import Foundation

/// A coding key made from any text, for objects whose keys the app does not all know.
struct ExtraCodingKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

enum ExtraKeys {
    /// The keys of the stored object that are not in `known`, as raw JSON, so a key a newer server
    /// added goes back unchanged when the object is saved again.
    static func read(from decoder: any Decoder, known: Set<String>) -> [String: JSONValue] {
        guard let all = try? decoder.container(keyedBy: ExtraCodingKey.self) else { return [:] }
        var extra: [String: JSONValue] = [:]
        for key in all.allKeys where !known.contains(key.stringValue) {
            if let value = try? all.decode(JSONValue.self, forKey: key) { extra[key.stringValue] = value }
        }
        return extra
    }

    /// Writes the extra keys, in a stable order, never over a key the caller writes (`own`).
    static func write(
        _ extra: [String: JSONValue], to container: inout KeyedEncodingContainer<ExtraCodingKey>, skipping own: Set<String>
    ) throws {
        for (name, value) in extra.sorted(by: { $0.key < $1.key }) where !own.contains(name) {
            try container.encode(value, forKey: ExtraCodingKey(name))
        }
    }
}
