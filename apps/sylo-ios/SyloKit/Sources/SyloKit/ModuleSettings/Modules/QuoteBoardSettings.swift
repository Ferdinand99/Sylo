import Foundation

// Quote board (src/modules/quoteBoard.js, normaliseQuoteBoardConfig; page route
// src/web/routes/v2Quotes.js; web form web-v2/src/moduleForms/QuoteBoard.jsx): members save
// memorable messages as numbered quotes and bring them back later. The app edits the settings,
// lists and searches the quotes and deletes them (Quotes/QuoteEndpoints.swift).

/// The Quote board settings page.
public struct QuoteBoardPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "quote-board"

    public let settings: QuoteBoardSettings
    public let roles: [RoleOption]
    /// The address of the public quote page, below the Sylo server's address ("/quotes/123").
    public let publicPath: String?
    /// How many quotes the server has.
    public let total: Int
    /// The newest quotes first (at most 100).
    public let quotes: [QuoteSummary]

    public init(settings: QuoteBoardSettings, roles: [RoleOption] = [], publicPath: String? = nil,
                total: Int = 0, quotes: [QuoteSummary] = []) {
        self.settings = settings
        self.roles = roles
        self.publicPath = publicPath
        self.total = total
        self.quotes = quotes
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case roles, publicPath, total, quotes
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: QuoteBoardSettings())
        roles = try c.decode(forKey: .roles, or: [])
        publicPath = try c.decodeIfPresent(String.self, forKey: .publicPath)
        let quotes = try c.decodeLossyArray(of: QuoteSummary.self, forKey: .quotes)
        self.quotes = quotes
        total = try c.decode(forKey: .total, or: quotes.count)
    }
}

/// Who may save a quote.
public enum QuoteSaveMode: String, Codable, Sendable, CaseIterable {
    case everyone
    /// Staff and the listed roles.
    case roles

    public init(from decoder: any Decoder) throws {
        self = QuoteSaveMode(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .everyone
    }
}

public struct QuoteBoardSettings: Codable, Sendable, Equatable {
    /// Anyone with the link can read the latest quotes without signing in.
    public var publicPage: Bool
    public var saveMode: QuoteSaveMode
    /// With `saveMode == .roles`: the roles that may save, on top of staff.
    public var saveRoles: [String]
    /// May remove any quote (Manage Messages, Manage Server and Administrator always may).
    public var staffRoles: [String]

    public init(publicPage: Bool = false, saveMode: QuoteSaveMode = .everyone, saveRoles: [String] = [],
                staffRoles: [String] = []) {
        self.publicPage = publicPage
        self.saveMode = saveMode
        self.saveRoles = saveRoles
        self.staffRoles = staffRoles
    }

    public static let maxRoles = 25

    private enum CodingKeys: String, CodingKey { case publicPage, saveMode, saveRoles, staffRoles }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        publicPage = try c.decode(forKey: .publicPage, or: false)
        saveMode = try c.decode(forKey: .saveMode, or: .everyone)
        saveRoles = try c.decode(forKey: .saveRoles, or: [])
        staffRoles = try c.decode(forKey: .staffRoles, or: [])
    }
}

/// One saved quote in the list under the settings.
public struct QuoteSummary: Decodable, Sendable, Hashable, Identifiable {
    /// The per-server number ("#7"); never reused.
    public let number: Int
    public let author: String
    public let text: String
    public let attachments: Int
    /// The channel's name; nil when it is gone.
    public let channel: String?
    /// When the quoted message was written, in milliseconds since 1970.
    public let messageAt: Double?
    /// Whether the public page shows it (only quotes from channels everyone can read).
    public let publicSource: Bool
    /// The quoted message on Discord or Fluxer.
    public let url: URL?

    public var id: Int { number }

    public init(number: Int, author: String = "", text: String = "", attachments: Int = 0, channel: String? = nil,
                messageAt: Double? = nil, publicSource: Bool = true, url: URL? = nil) {
        self.number = number
        self.author = author
        self.text = text
        self.attachments = attachments
        self.channel = channel
        self.messageAt = messageAt
        self.publicSource = publicSource
        self.url = url
    }

    private enum CodingKeys: String, CodingKey {
        case number, author, text, attachments, channel, messageAt, publicSource, url
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            number: try c.decode(Int.self, forKey: .number),
            author: try c.decodeIfPresent(String.self, forKey: .author) ?? "",
            text: try c.decodeIfPresent(String.self, forKey: .text) ?? "",
            attachments: try c.decode(forKey: .attachments, or: 0),
            channel: try c.decodeIfPresent(String.self, forKey: .channel),
            messageAt: try c.decodeIfPresent(Double.self, forKey: .messageAt),
            publicSource: try c.decode(forKey: .publicSource, or: true),
            url: try c.decodeURLIfPresent(forKey: .url))
    }

    public var messageDate: Date? { messageAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
}
