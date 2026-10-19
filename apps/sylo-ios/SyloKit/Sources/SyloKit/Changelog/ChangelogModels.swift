import Foundation

/// The What's New page's release notes, from `GET /api/v2/changelog`: the server's own version
/// and its releases, newest first. Missing parts read as empty, and a release without a version
/// is dropped, so an older or newer server still shows what it has.
public struct ChangelogPage: Decodable, Sendable, Equatable {
    /// The Sylo version the server runs, for example `4.6.0`.
    public let version: String?
    public let releases: [ChangelogRelease]

    public init(version: String? = nil, releases: [ChangelogRelease] = []) {
        self.version = version
        self.releases = releases
    }

    private enum CodingKeys: String, CodingKey { case version, releases }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(String.self, forKey: .version)
        releases = try c.decodeLossyArray(of: ChangelogRelease.self, forKey: .releases)
    }
}

/// One Sylo release and what changed in it.
public struct ChangelogRelease: Decodable, Sendable, Equatable, Identifiable {
    /// "4.6.0", without a leading "v".
    public let version: String
    /// The release day as the server sends it, `YYYY-MM-DD`; nil while unreleased. See ``day(in:)``.
    public let date: String?
    /// The release on GitHub.
    public let url: URL?
    public let sections: [ChangelogSection]

    public var id: String { version }

    public init(version: String, date: String? = nil, url: URL? = nil, sections: [ChangelogSection] = []) {
        self.version = version
        self.date = date
        self.url = url
        self.sections = sections
    }

    /// The start of the release day in `calendar`, so it shows as that same day wherever the
    /// person is; nil when there is no date or it is not a `YYYY-MM-DD` day.
    public func day(in calendar: Calendar = .current) -> Date? {
        guard let date else { return nil }
        let parts = date.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
            let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2])
        else { return nil }
        let components = DateComponents(year: year, month: month, day: day)
        // Rejects days that do not exist (2026-13-40) rather than rolling them over.
        guard components.isValidDate(in: calendar) else { return nil }
        return calendar.date(from: components)
    }

    private enum CodingKeys: String, CodingKey { case version, date, url, sections }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(String.self, forKey: .version)
        date = try c.decodeIfPresent(String.self, forKey: .date)
        url = try c.decodeURLIfPresent(forKey: .url)
        sections = try c.decodeLossyArray(of: ChangelogSection.self, forKey: .sections)
    }
}

/// A group of changes in a release, such as "New" or "Fixes".
public struct ChangelogSection: Decodable, Sendable, Equatable {
    /// The heading as the server words it.
    public let title: String
    public let kind: ChangelogKind
    public let items: [ChangelogItem]

    public init(title: String, kind: ChangelogKind, items: [ChangelogItem] = []) {
        self.title = title
        self.kind = kind
        self.items = items
    }

    private enum CodingKeys: String, CodingKey { case title, kind, items }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        kind = try c.decodeIfPresent(ChangelogKind.self, forKey: .kind) ?? .other("")
        items = try c.decodeLossyArray(of: ChangelogItem.self, forKey: .items)
    }
}

/// One change.
public struct ChangelogItem: Decodable, Sendable, Equatable {
    /// The part of Sylo it is about ("dashboard"), when the server names one.
    public let scope: String?
    /// May hold inline Markdown: `code`, [links](https://…) and **bold**.
    public let text: String
    /// The issues and pull requests behind it.
    public let refs: [ChangelogRef]

    public init(scope: String? = nil, text: String, refs: [ChangelogRef] = []) {
        self.scope = scope
        self.text = text
        self.refs = refs
    }

    private enum CodingKeys: String, CodingKey { case scope, text, refs }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let scope = try c.decodeIfPresent(String.self, forKey: .scope)
        self.scope = scope?.isEmpty == true ? nil : scope
        text = try c.decode(String.self, forKey: .text)
        refs = try c.decodeLossyArray(of: ChangelogRef.self, forKey: .refs)
    }
}

/// An issue or pull request a change links to, such as "#266".
public struct ChangelogRef: Decodable, Sendable, Hashable {
    public let label: String
    /// Nil when the server sent no usable address; the label still shows.
    public let url: URL?

    public init(label: String, url: URL?) {
        self.label = label
        self.url = url
    }

    private enum CodingKeys: String, CodingKey { case label, url }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = try c.decode(String.self, forKey: .label)
        url = try c.decodeURLIfPresent(forKey: .url)
    }
}

/// What kind of changes a section holds. A kind the app does not know, and the server's own
/// "other", are `.other(raw)`, so a newer server adding one never breaks decoding.
public enum ChangelogKind: Hashable, Sendable, RawRepresentable, Codable {
    case features
    case fixes
    case performance
    /// Changes someone running Sylo has to act on.
    case breaking
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "features": self = .features
        case "fixes": self = .fixes
        case "performance": self = .performance
        case "breaking": self = .breaking
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .features: "features"
        case .fixes: "fixes"
        case .performance: "performance"
        case .breaking: "breaking"
        case .other(let raw): raw
        }
    }
}

extension Endpoints {
    /// `GET /api/v2/changelog`: the release notes, newest first; `limit` caps how many releases.
    public struct Changelog: APIEndpoint {
        public typealias Response = ChangelogPage
        public let limit: Int?

        public init(limit: Int? = nil) { self.limit = limit }

        public var path: String { "/api/v2/changelog" }
        public var query: [URLQueryItem] {
            guard let limit else { return [] }
            return [URLQueryItem(name: "limit", value: String(limit))]
        }
    }
}
