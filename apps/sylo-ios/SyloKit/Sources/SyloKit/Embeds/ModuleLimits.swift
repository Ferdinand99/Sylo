import Foundation

// The setting limits the server publishes (`GET /api/v2/modules/limits`, src/modules/limits.js): max
// lengths, ranges and item counts of every module, so a form reads them instead of keeping its own
// numbers. `_embed` is a pseudo-module holding the limits of one embed. The answer is static per
// server version and missing on servers from before it; every reader has a fixed fallback.

/// One field's limit. Every part is optional; only what applies to the field is sent.
public struct FieldLimit: Decodable, Sendable, Equatable {
    public let maxLength: Int?
    public let min: Int?
    public let max: Int?
    public let maxItems: Int?

    public init(maxLength: Int? = nil, min: Int? = nil, max: Int? = nil, maxItems: Int? = nil) {
        self.maxLength = maxLength
        self.min = min
        self.max = max
        self.maxItems = maxItems
    }

    private enum CodingKeys: String, CodingKey { case maxLength, min, max, maxItems }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // One odd value (a newer server) must not lose the others.
        self.init(
            maxLength: try? c.decodeIfPresent(Int.self, forKey: .maxLength),
            min: try? c.decodeIfPresent(Int.self, forKey: .min),
            max: try? c.decodeIfPresent(Int.self, forKey: .max),
            maxItems: try? c.decodeIfPresent(Int.self, forKey: .maxItems))
    }
}

/// The limits of one module by field path (`title`, `stickies[].content`; `[]` marks list items).
public struct ModuleFieldLimits: Sendable, Equatable {
    public let fields: [String: FieldLimit]

    public static let unlimited = ModuleFieldLimits()

    public init(_ fields: [String: FieldLimit] = [:]) {
        self.fields = fields
    }

    /// The limit of a field; an empty one (no limit) when the server has none for it.
    public subscript(path: String) -> FieldLimit { fields[path] ?? FieldLimit() }
}

/// The limits of every module, by module id, from `GET /api/v2/modules/limits`.
public struct AllModuleLimits: Decodable, Sendable, Equatable {
    public let modules: [String: ModuleFieldLimits]

    /// What a server without the endpoint gives: no limits.
    public static let empty = AllModuleLimits()

    public init(modules: [String: ModuleFieldLimits] = [:]) {
        self.modules = modules
    }

    /// One module's limits; none when the server did not send that module.
    public subscript(module: String) -> ModuleFieldLimits { modules[module] ?? .unlimited }

    /// The limits of one embed (the `_embed` entry), on top of ``EmbedLimits/standard``.
    public var embed: EmbedLimits { EmbedLimits(self["_embed"]) }

    private struct Key: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        var modules: [String: ModuleFieldLimits] = [:]
        for key in c.allKeys {
            // A module entry that cannot be read is skipped, not fatal.
            if let fields = try? c.decode([String: FieldLimit].self, forKey: key) {
                modules[key.stringValue] = ModuleFieldLimits(fields)
            }
        }
        self.modules = modules
    }
}

/// The limits one embed editor works to. The numbers are Discord's, which the server uses unless it
/// says otherwise; read them from ``AllModuleLimits/embed`` (or ``AppSession/moduleLimits()``).
public struct EmbedLimits: Sendable, Equatable {
    /// The message text above the embed.
    public var content: Int
    public var title: Int
    public var description: Int
    public var authorName: Int
    public var footerText: Int
    /// How many fields an embed has.
    public var maxFields: Int
    public var fieldName: Int
    public var fieldValue: Int

    public init(
        content: Int = 2000, title: Int = 256, description: Int = 4096, authorName: Int = 256,
        footerText: Int = 2048, maxFields: Int = 25, fieldName: Int = 256, fieldValue: Int = 1024
    ) {
        self.content = content
        self.title = title
        self.description = description
        self.authorName = authorName
        self.footerText = footerText
        self.maxFields = maxFields
        self.fieldName = fieldName
        self.fieldValue = fieldValue
    }

    /// The fixed limits, for a server that sends none.
    public static let standard = EmbedLimits()

    /// The standard limits with whatever the server sent (`title`, `description`, `authorName`,
    /// `footerText`, `fields`, `fields[].name`, `fields[].value`, and `content` when a module gives it).
    public init(_ limits: ModuleFieldLimits) {
        self = EmbedLimits.standard.overriding(limits)
    }

    /// These limits with the ones `limits` names replaced, for a module whose embed is narrower than
    /// the rest (a poll's title). Same field paths as the `_embed` entry.
    public func overriding(_ limits: ModuleFieldLimits) -> EmbedLimits {
        EmbedLimits(
            content: limits["content"].maxLength ?? content,
            title: limits["title"].maxLength ?? title,
            description: limits["description"].maxLength ?? description,
            authorName: limits["authorName"].maxLength ?? authorName,
            footerText: limits["footerText"].maxLength ?? footerText,
            maxFields: limits["fields"].maxItems ?? maxFields,
            fieldName: limits["fields[].name"].maxLength ?? fieldName,
            fieldValue: limits["fields[].value"].maxLength ?? fieldValue)
    }
}

extension Endpoints {
    /// `GET /api/v2/modules/limits`: every module's setting limits. 404 on a server from before it;
    /// ``AppSession/moduleLimits()`` turns that into no limits.
    public struct LoadModuleLimits: APIEndpoint {
        public typealias Response = AllModuleLimits
        public var path: String { "/api/v2/modules/limits" }
        public init() {}
    }
}
