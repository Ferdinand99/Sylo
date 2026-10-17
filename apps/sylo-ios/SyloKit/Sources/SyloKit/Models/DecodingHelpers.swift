import Foundation

// Small decoding helpers shared by the models. Kept per field rather than as decoder strategies,
// so a date in milliseconds or a lossy list never changes how any other field is read.

extension KeyedDecodingContainer {
    /// A date sent as milliseconds since 1970, the way Sylo's API sends every timestamp.
    func decodeEpochMilliseconds(forKey key: Key) throws -> Date {
        Date(timeIntervalSince1970: try decode(Double.self, forKey: key) / 1000)
    }

    /// Like ``decodeEpochMilliseconds(forKey:)``, nil when the field is missing or null.
    func decodeEpochMillisecondsIfPresent(forKey key: Key) throws -> Date? {
        try decodeIfPresent(Double.self, forKey: key).map { Date(timeIntervalSince1970: $0 / 1000) }
    }

    /// A list where an entry that cannot be read is dropped instead of failing the whole answer,
    /// so one odd card from a newer server does not empty the screen. Missing or null is empty.
    func decodeLossyArray<Element: Decodable>(of type: Element.Type, forKey key: Key) throws -> [Element] {
        try decodeIfPresent([Lossy<Element>].self, forKey: key)?.compactMap(\.value) ?? []
    }

    /// A URL sent as a string, nil when missing, null, empty or not a URL.
    func decodeURLIfPresent(forKey key: Key) throws -> URL? {
        guard let string = try decodeIfPresent(String.self, forKey: key), !string.isEmpty else { return nil }
        return URL(string: string)
    }
}

private struct Lossy<Value: Decodable>: Decodable {
    let value: Value?

    init(from decoder: any Decoder) throws {
        value = try? Value(from: decoder)
    }
}
