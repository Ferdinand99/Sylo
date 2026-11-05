import Foundation

/// Any JSON value. Used to carry parts of a saved message the app does not edit (a role-select
/// row made by the Reaction roles module, an embed link) through an edit unchanged, so saving in
/// the app never drops them.
public enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// The string, for a `.string` value.
    public var stringValue: String? {
        if case .string(let value) = self { value } else { nil }
    }

    /// The members, for an `.object` value.
    public var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { value } else { nil }
    }

    /// The items, for an `.array` value.
    public var arrayValue: [JSONValue]? {
        if case .array(let value) = self { value } else { nil }
    }
}
