import Foundation
import Observation

// Import configuration and Duplicate (Sylo 5.2, P6: src/web/routes/v2ConfigImport.js, v2Duplicate.js; web
// components/ConfigImport.jsx). Import takes the file "Export Configuration" gives, shows what each module would
// change, and applies the ticked items through the modules' normal save paths with a typed confirmation word.
// Duplicate copies a list item on the server. Sylo 5.2 announces no feature string for either (a server gap), so
// the app finds out whether the routes exist: a probe for import (a 404 means no such route), and a 404 on a
// duplicate hides it afterwards.

/// `.../import/preview` answers this; nothing is changed.
public struct ImportPlan: Decodable, Sendable, Equatable {
    public struct Source: Decodable, Sendable, Equatable {
        public let guildID: String?
        public let exportedAt: String?
        public let sameServer: Bool

        public init(guildID: String? = nil, exportedAt: String? = nil, sameServer: Bool = false) {
            self.guildID = guildID
            self.exportedAt = exportedAt
            self.sameServer = sameServer
        }

        private enum CodingKeys: String, CodingKey { case guildId, exportedAt, sameServer }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(guildID: try? c.decodeIfPresent(String.self, forKey: .guildId),
                      exportedAt: try? c.decodeIfPresent(String.self, forKey: .exportedAt),
                      sameServer: (try? c.decodeIfPresent(Bool.self, forKey: .sameServer)) ?? false)
        }
    }

    public let source: Source
    /// What is in the file but not imported yet, and what is not in it at all.
    public let notCarried: String
    /// The word to type before applying (`IMPORT`).
    public let confirmWord: String
    public let items: [ImportItem]

    public static let defaultConfirmWord = "IMPORT"

    public init(source: Source = Source(), notCarried: String = "", confirmWord: String = ImportPlan.defaultConfirmWord,
                items: [ImportItem] = []) {
        self.source = source
        self.notCarried = notCarried
        self.confirmWord = confirmWord
        self.items = items
    }

    private enum CodingKeys: String, CodingKey { case source, notCarried, confirmWord, items }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let word = (try? c.decodeIfPresent(String.self, forKey: .confirmWord)) ?? nil
        self.init(
            source: (try? c.decodeIfPresent(Source.self, forKey: .source)) ?? Source(),
            notCarried: (try? c.decodeIfPresent(String.self, forKey: .notCarried)) ?? "",
            confirmWord: (word?.isEmpty ?? true) ? Self.defaultConfirmWord : word ?? Self.defaultConfirmWord,
            items: try c.decodeLossyArray(of: ImportItem.self, forKey: .items))
    }

    /// The items that would change something: the ones the person can tick.
    public var changes: [ImportItem] { items.filter { $0.status == .change } }
}

public enum ImportItemStatus: Hashable, Sendable, RawRepresentable, Decodable {
    case change
    case same
    case skip
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "change": self = .change
        case "same": self = .same
        case "skip": self = .skip
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .change: "change"
        case .same: "same"
        case .skip: "skip"
        case .other(let raw): raw
        }
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public var label: String {
        switch self {
        case .change: "Changes"
        case .same: "No changes"
        case .skip, .other: "Not imported"
        }
    }
}

public struct ImportItem: Decodable, Sendable, Hashable, Identifiable {
    /// `settings`, `module:<id>` or `command:<name>`.
    public let key: String
    public let kind: String
    public let label: String
    public let status: ImportItemStatus
    /// Warnings and reasons, plain sentences (what was cleared because this server does not have it).
    public let notes: [String]
    /// What it changes: the settings that differ, secrets masked, and names for the ids in them.
    public let change: AuditChange?

    public var id: String { key }

    public init(key: String, kind: String = "module", label: String, status: ImportItemStatus = .change,
                notes: [String] = [], change: AuditChange? = nil) {
        self.key = key
        self.kind = kind
        self.label = label
        self.status = status
        self.notes = notes
        self.change = change
    }

    private enum CodingKeys: String, CodingKey { case key, kind, label, status, notes, change }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let key = try c.decode(String.self, forKey: .key)
        self.init(
            key: key,
            kind: (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "module",
            label: (try? c.decodeIfPresent(String.self, forKey: .label)) ?? key,
            status: (try? c.decodeIfPresent(ImportItemStatus.self, forKey: .status)) ?? .skip,
            notes: (try? c.decodeIfPresent([String].self, forKey: .notes)) ?? [],
            change: try? c.decodeIfPresent(AuditChange.self, forKey: .change))
    }

    public static func == (lhs: ImportItem, rhs: ImportItem) -> Bool {
        lhs.key == rhs.key && lhs.status == rhs.status && lhs.notes == rhs.notes && lhs.label == rhs.label
            && lhs.change == rhs.change
    }

    public func hash(into hasher: inout Hasher) { hasher.combine(key) }
}

/// What happened to one ticked item.
public struct ImportResult: Decodable, Sendable, Hashable, Identifiable {
    public let key: String
    public let label: String
    public let ok: Bool
    public let error: String?

    public var id: String { key }

    public init(key: String, label: String = "", ok: Bool, error: String? = nil) {
        self.key = key
        self.label = label.isEmpty ? key : label
        self.ok = ok
        self.error = error
    }

    private enum CodingKeys: String, CodingKey { case key, label, ok, error }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(key: try c.decode(String.self, forKey: .key),
                  label: (try? c.decodeIfPresent(String.self, forKey: .label)) ?? "",
                  ok: (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? false,
                  error: try? c.decodeIfPresent(String.self, forKey: .error))
    }
}

public struct ImportAnswer: Decodable, Sendable, Equatable {
    public let results: [ImportResult]

    public init(results: [ImportResult] = []) { self.results = results }

    private enum CodingKeys: String, CodingKey { case results }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        results = try c.decodeLossyArray(of: ImportResult.self, forKey: .results)
    }
}

extension Endpoints {
    /// `POST /api/v2/guilds/:id/import/preview` with `{export}`: what the file would change. Edit level.
    public struct PreviewConfigImport: APIEndpoint {
        public typealias Response = ImportPlan
        public let server: ServerID
        public let file: JSONValue
        public init(server: ServerID, file: JSONValue) {
            self.server = server
            self.file = file
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/import/preview" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(export: file) }
        private struct Body: Encodable, Sendable { let export: JSONValue }
    }

    /// `POST /api/v2/guilds/:id/import/apply` with `{export, items, confirm}`. `confirm` must be the word the
    /// preview names, typed by the person. Edit level.
    public struct ApplyConfigImport: APIEndpoint {
        public typealias Response = ImportAnswer
        public let server: ServerID
        public let file: JSONValue
        public let keys: [String]
        public let confirm: String
        public init(server: ServerID, file: JSONValue, keys: [String], confirm: String) {
            self.server = server
            self.file = file
            self.keys = keys
            self.confirm = confirm
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/import/apply" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(export: file, items: keys, confirm: confirm) }
        private struct Body: Encodable, Sendable {
            let export: JSONValue
            let items: [String]
            let confirm: String
        }
    }
}

/// Import configuration: choose the file, see what would change, tick the items, type the word, apply.
@MainActor
@Observable
public final class ConfigImportModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case reading
        case review(ImportPlan)
        case applying
        case done([ImportResult])
    }

    /// The server refuses a request body larger than this (256 KB); saying so here saves the upload.
    public static let maxFileBytes = 256 * 1024

    public let server: ServerID
    public private(set) var phase: Phase = .idle
    /// The items ticked for import.
    public var picked: Set<String> = []
    /// What the person typed in the confirmation field.
    public var typedWord = ""
    public var errorMessage: String?
    /// False once this server is known not to have the import routes.
    public private(set) var isAvailable = true

    private var file: JSONValue?
    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public var plan: ImportPlan? {
        if case .review(let plan) = phase { return plan }
        return nil
    }

    /// Reads the chosen file and asks the server what it would change.
    public func preview(fileData data: Data) async {
        errorMessage = nil
        guard data.count <= Self.maxFileBytes else {
            errorMessage = "This file is larger than 256 KB, which is more than a Sylo export holds."
            return
        }
        guard let parsed = try? JSONDecoder().decode(JSONValue.self, from: data) else {
            errorMessage = "This file is not valid JSON."
            return
        }
        phase = .reading
        do {
            let plan = try await session.send(Endpoints.PreviewConfigImport(server: server, file: parsed))
            file = parsed
            picked = Set(plan.changes.map(\.key))
            typedWord = ""
            phase = .review(plan)
        } catch {
            let error = NetworkError(error)
            phase = .idle
            if error.isMissingRoute {
                isAvailable = false
            } else if error != .cancelled, error != .unauthorized {
                errorMessage = error.userMessage
            }
        }
    }

    public func toggle(_ key: String) {
        if picked.contains(key) { picked.remove(key) } else { picked.insert(key) }
    }

    public func tickAll() { picked = Set(plan?.changes.map(\.key) ?? []) }
    public func untickAll() { picked = [] }

    /// Whether the typed word is the one the server asked for (exactly, as the server compares).
    public var isConfirmed: Bool {
        guard let plan else { return false }
        return typedWord.trimmingCharacters(in: .whitespaces) == plan.confirmWord
    }

    public var canApply: Bool { plan != nil && !picked.isEmpty && isConfirmed }

    /// Applies the ticked items, in the order of the preview. Needs the typed word.
    public func apply() async {
        guard let plan, canApply, let file else { return }
        let keys = plan.items.map(\.key).filter(picked.contains)
        phase = .applying
        errorMessage = nil
        do {
            let answer = try await session.send(
                Endpoints.ApplyConfigImport(server: server, file: file, keys: keys, confirm: plan.confirmWord))
            self.file = nil
            phase = .done(answer.results)
        } catch {
            let error = NetworkError(error)
            phase = .review(plan)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    public func reset() {
        phase = .idle
        picked = []
        typedWord = ""
        file = nil
        errorMessage = nil
    }
}

// MARK: - Duplicate

/// What "Duplicate" copies. Each copy is made by the server and respects its limits.
public enum DuplicateKind: Sendable, Hashable {
    /// The copy is paused.
    case reminder
    /// The copy is a draft, nothing posted.
    case composedMessage
    /// The copy is a draft, nothing posted.
    case reactionRoleSet
    /// The name gets a "-copy" suffix and stays unique.
    case customCommand
    /// The copy is paused, with nothing sold.
    case shopItem

    func path(_ raw: String) -> String {
        let id = raw.encodedPathSegment
        switch self {
        case .reminder: return "modules/reminders/\(id)/duplicate"
        case .composedMessage: return "messages/\(id)/duplicate"
        case .reactionRoleSet: return "modules/roles/rr/\(id)/duplicate"
        case .customCommand: return "modules/custom-commands/cmd/\(id)/duplicate"
        case .shopItem: return "modules/economy/shop/items/\(id)/duplicate"
        }
    }

    /// What the copy is, for the message after it was made.
    public var copyNote: String {
        switch self {
        case .reminder, .shopItem: "The copy is paused."
        case .composedMessage, .reactionRoleSet: "The copy is a draft: nothing is posted yet."
        case .customCommand: "The copy has a -copy suffix on its name."
        }
    }
}

/// `{ok, id, name}`: the copy.
public struct DuplicateResult: Decodable, Sendable, Equatable {
    public let id: String
    public let name: String

    public init(id: String = "", name: String = "") {
        self.id = id
        self.name = name
    }

    private enum CodingKeys: String, CodingKey { case id, name }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var id = ""
        if let number = try? c.decodeIfPresent(Int.self, forKey: .id) {
            id = String(number)
        } else if let text = try? c.decodeIfPresent(String.self, forKey: .id) {
            id = text
        }
        self.init(id: id, name: (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "")
    }
}

extension Endpoints {
    /// `POST /api/v2/guilds/:id/<item>/duplicate` with `{}`. Edit level; 30 a minute; 400 with the server's
    /// words at a limit ("This server already has the maximum of ...").
    public struct DuplicateItem: APIEndpoint {
        public typealias Response = DuplicateResult
        public let server: ServerID
        public let kind: DuplicateKind
        public let id: String
        public init(server: ServerID, kind: DuplicateKind, id: String) {
            self.server = server
            self.kind = kind
            self.id = id
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/\(kind.path(id))" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { CommunityEmptyBody() }
    }
}

/// Makes copies and remembers whether this server can: a 404 on the route (a Sylo before 5.2's P6) hides the
/// action afterwards. Shared by the lists that have a "Duplicate" in their menu.
@MainActor
@Observable
public final class DuplicateModel {
    public let server: ServerID
    /// The copy's name after the last duplicate, for the alert.
    public private(set) var lastNote: String?
    public var errorMessage: String?
    public private(set) var isWorking = false
    /// Goes up with every copy made, so the list can read again.
    public private(set) var copyCount = 0
    public private(set) var isAvailable = true

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Copies one item.
    /// - Returns: The copy, or nil (``errorMessage`` says why, unless the server has no such route).
    @discardableResult
    public func duplicate(_ kind: DuplicateKind, id: String) async -> DuplicateResult? {
        guard !isWorking else { return nil }
        isWorking = true
        defer { isWorking = false }
        errorMessage = nil
        do {
            let copy = try await session.send(Endpoints.DuplicateItem(server: server, kind: kind, id: id))
            copyCount += 1
            lastNote = "Copied\(copy.name.isEmpty ? "" : " as \(copy.name)"). \(kind.copyNote)"
            return copy
        } catch {
            let error = NetworkError(error)
            if error.isMissingRoute {
                isAvailable = false
            } else if error != .cancelled, error != .unauthorized {
                errorMessage = error.userMessage
            }
            return nil
        }
    }
}

// MARK: - Do the routes exist?

extension AppSession {
    /// Whether this server has the Sylo 5.2 import, duplicate and template features (P6). They have no feature
    /// string, so this sends a harmless preview of an empty file: any answer but a 404 means the route exists
    /// (400 says it is not an export). Asked once per sign-in and server and kept; a server that cannot be
    /// reached right now is not remembered.
    public func hasImportRoutes(server: ServerID) async -> Bool {
        if let known = importRoutes[server] { return known }
        do {
            _ = try await send(Endpoints.PreviewConfigImport(server: server, file: .object([:])))
            importRoutes[server] = true
            return true
        } catch {
            let error = NetworkError(error)
            if error.isMissingRoute {
                importRoutes[server] = false
                return false
            }
            switch error {
            case .offline, .timeout, .unreachable, .transport, .secureConnectionFailed, .cancelled, .unauthorized,
                 .notASyloServer, .invalidURL:
                return false
            default:
                // The route answered (a refusal or a "not an export"): it exists.
                importRoutes[server] = true
                return true
            }
        }
    }
}

extension AppSession {
    /// Whether a probe (``hasImportRoutes(server:)``) has found the P6 routes on this Sylo, without asking again. Every
    /// server of one Sylo has the same routes, so one answer is enough. False until the server screen has asked.
    public var knowsImportRoutes: Bool { importRoutes.values.contains(true) }
}
