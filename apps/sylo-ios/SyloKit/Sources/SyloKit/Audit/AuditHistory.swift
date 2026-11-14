import Foundation
import Observation

// Change history with a diff and undo (Sylo 5.2; src/web/routes/v2GuildData.js, src/web/lib/configUndo.js;
// web page web-v2/src/pages/AuditLog.jsx). An audit entry that kept what it changed has `hasChange`:
// `GET .../audit/:id/change` shows the settings before and after (secrets masked) and whether an undo is
// possible, and `POST .../audit/:id/undo` puts the earlier settings back through the module's normal save.
// If the settings were changed again since the entry, the undo needs `confirm: true` with the `token` the
// change view gave, which names the state the person saw. Undo covers a module's settings, not lists kept
// on their own (reminders, shop items). An older server has no `hasChange`, so the app shows nothing new.

/// Where the settings stand against an entry.
public enum AuditUndoState: Hashable, Sendable, RawRepresentable, Decodable {
    /// Unchanged since the entry: undo restores exactly the earlier settings.
    case clean
    /// Already back at the earlier values.
    case reverted
    /// Changed again since the entry: undo loses those later changes, so it needs a confirmation.
    case changed
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "clean": self = .clean
        case "reverted": self = .reverted
        case "changed": self = .changed
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .clean: "clean"
        case .reverted: "reverted"
        case .changed: "changed"
        case .other(let raw): raw
        }
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }
}

/// A setting an undo leaves as it is, and why.
public struct AuditNotRestored: Decodable, Sendable, Hashable {
    public let key: String
    public let reason: String

    public init(key: String, reason: String) {
        self.key = key
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey { case key, reason }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        reason = try c.decodeIfPresent(String.self, forKey: .reason) ?? ""
    }
}

/// Whether an entry can be undone now, and what that would do.
public struct AuditUndoInfo: Decodable, Sendable, Equatable {
    public let isAvailable: Bool
    /// Why it cannot be undone (or that it was too large to keep); nil when it can.
    public let reason: String?
    public let state: AuditUndoState
    /// The settings changed again since the entry (their keys), when ``state`` is `changed`.
    public let laterChanges: [String]
    /// Sent back with a confirmed undo of a `changed` entry; names the state the person saw.
    public let token: String?
    public let notRestored: [AuditNotRestored]
    /// Settings that hold a secret: never stored in the history, so an undo keeps the saved one.
    public let droppedSecrets: [String]

    public init(isAvailable: Bool = false, reason: String? = nil, state: AuditUndoState = .clean,
                laterChanges: [String] = [], token: String? = nil, notRestored: [AuditNotRestored] = [],
                droppedSecrets: [String] = []) {
        self.isAvailable = isAvailable
        self.reason = reason
        self.state = state
        self.laterChanges = laterChanges
        self.token = token
        self.notRestored = notRestored
        self.droppedSecrets = droppedSecrets
    }

    private enum CodingKeys: String, CodingKey {
        case available, reason, state, laterChanges, token, notRestored, droppedSecrets
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            isAvailable: try c.decodeIfPresent(Bool.self, forKey: .available) ?? false,
            reason: try c.decodeIfPresent(String.self, forKey: .reason),
            state: try c.decodeIfPresent(AuditUndoState.self, forKey: .state) ?? .clean,
            laterChanges: (try? c.decodeIfPresent([String].self, forKey: .laterChanges)) ?? [],
            token: try c.decodeIfPresent(String.self, forKey: .token),
            notRestored: try c.decodeLossyArray(of: AuditNotRestored.self, forKey: .notRestored),
            droppedSecrets: (try? c.decodeIfPresent([String].self, forKey: .droppedSecrets)) ?? [])
    }

    /// The undo asks first: the settings were changed again since the entry.
    public var needsConfirmation: Bool { isAvailable && state == .changed }
}

/// `GET .../audit/:id/change`: what one entry changed.
public struct AuditChange: Decodable, Sendable, Equatable {
    /// `module` for a module's settings, `settings` for the server settings; nil for any other entry.
    public let kind: String?
    /// The copy was too large to keep: no diff, no undo.
    public let isTooLarge: Bool
    public let before: [String: JSONValue]
    public let after: [String: JSONValue]
    /// Channel and role names for the ids in the change ("#general", "@Moderators").
    public let names: [String: String]
    public let undo: AuditUndoInfo

    public init(kind: String? = nil, isTooLarge: Bool = false, before: [String: JSONValue] = [:],
                after: [String: JSONValue] = [:], names: [String: String] = [:], undo: AuditUndoInfo = AuditUndoInfo()) {
        self.kind = kind
        self.isTooLarge = isTooLarge
        self.before = before
        self.after = after
        self.names = names
        self.undo = undo
    }

    private enum CodingKeys: String, CodingKey { case kind, tooLarge, before, after, names, undo }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func object(_ key: CodingKeys) -> [String: JSONValue] {
            if case .object(let fields)? = try? c.decodeIfPresent(JSONValue.self, forKey: key) { return fields }
            return [:]
        }
        self.init(
            kind: try c.decodeIfPresent(String.self, forKey: .kind),
            isTooLarge: try c.decodeIfPresent(Bool.self, forKey: .tooLarge) ?? false,
            before: object(.before), after: object(.after),
            names: (try? c.decodeIfPresent([String: String].self, forKey: .names)) ?? [:],
            undo: try c.decodeIfPresent(AuditUndoInfo.self, forKey: .undo) ?? AuditUndoInfo())
    }

    /// The rows to show.
    public var diff: (rows: [ConfigDiff.Row], more: Int) { ConfigDiff.rows(before: before, after: after) }
}

/// `POST .../audit/:id/undo`: `adjusted` are the settings that ended up different from the earlier ones
/// (today's limits), `notRestored` the ones left alone.
public struct AuditUndoResult: Decodable, Sendable, Equatable {
    public let adjusted: [String]
    public let notRestored: [String]

    public init(adjusted: [String] = [], notRestored: [String] = []) {
        self.adjusted = adjusted
        self.notRestored = notRestored
    }

    private enum CodingKeys: String, CodingKey { case adjusted, notRestored }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(adjusted: (try? c.decodeIfPresent([String].self, forKey: .adjusted)) ?? [],
                  notRestored: (try? c.decodeIfPresent([String].self, forKey: .notRestored)) ?? [])
    }

    /// The sentence the dashboard shows after an undo.
    public var summary: String {
        var parts = ["Change undone."]
        if !adjusted.isEmpty {
            parts.append("Some settings are not exactly as before: \(adjusted.map(ConfigDiff.label(for:)).joined(separator: ", ")).")
        }
        if !notRestored.isEmpty {
            parts.append("Left as they are: \(notRestored.map(ConfigDiff.label(for:)).joined(separator: ", ")).")
        }
        return parts.joined(separator: " ")
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/audit/:entry/change`. View level; 404 for an entry with no saved change.
    public struct LoadAuditChange: APIEndpoint {
        public typealias Response = AuditChange
        public let server: ServerID
        public let entry: String
        public init(server: ServerID, entry: String) {
            self.server = server
            self.entry = entry
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/audit/\(entry.encodedPathSegment)/change" }
    }

    /// `POST /api/v2/guilds/:id/audit/:entry/undo` with `{confirm, token}`. Edit level. 409 when the settings
    /// changed since and the confirmation or its token is missing or out of date.
    public struct UndoAuditChange: APIEndpoint {
        public typealias Response = AuditUndoResult
        public let server: ServerID
        public let entry: String
        public let confirm: Bool
        public let token: String

        public init(server: ServerID, entry: String, confirm: Bool = false, token: String = "") {
            self.server = server
            self.entry = entry
            self.confirm = confirm
            self.token = token
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/audit/\(entry.encodedPathSegment)/undo" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(confirm: confirm, token: token) }

        private struct Body: Encodable, Sendable {
            let confirm: Bool
            let token: String
        }
    }
}

/// "Show changes" and "Undo this change" for one audit entry.
@MainActor
@Observable
public final class AuditChangeModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready(AuditChange)
        case failed(String)
    }

    public let server: ServerID
    public let entry: String
    public private(set) var phase: Phase = .idle
    public private(set) var isUndoing = false
    /// Why the last undo did not go through.
    public var undoError: String?
    /// What the last undo did ("Change undone. ...").
    public private(set) var doneMessage: String?
    /// Goes up with every undo that went through, so the list reads again.
    public private(set) var undoCount = 0

    private let session: AppSession

    public init(server: ServerID, entry: String, session: AppSession) {
        self.server = server
        self.entry = entry
        self.session = session
    }

    public var change: AuditChange? {
        if case .ready(let change) = phase { return change }
        return nil
    }

    /// Loads what the entry changed (once; ``reload()`` reads it again).
    public func load() async {
        guard phase == .idle else { return }
        await reload()
    }

    public func reload() async {
        phase = .loading
        do {
            phase = .ready(try await session.send(Endpoints.LoadAuditChange(server: server, entry: entry)))
        } catch {
            let error = NetworkError(error)
            if error == .cancelled || error == .unauthorized {
                phase = .idle
            } else {
                phase = .failed(error.userMessage)
            }
        }
    }

    /// Undoes the entry. When the settings were changed again since (``AuditUndoInfo/needsConfirmation``)
    /// pass `confirmed: true` only after the person said yes: the token the change view gave goes with it. If
    /// the settings changed once more in between, the server refuses with a 409; the change is read again and
    /// ``undoError`` asks the person to look at it again.
    /// - Returns: Whether the undo went through.
    @discardableResult
    public func undo(confirmed: Bool) async -> Bool {
        guard let change, change.undo.isAvailable, !isUndoing else { return false }
        isUndoing = true
        defer { isUndoing = false }
        undoError = nil
        let changedSince = change.undo.state == .changed
        let endpoint = Endpoints.UndoAuditChange(
            server: server, entry: entry, confirm: confirmed && changedSince,
            token: confirmed && changedSince ? (change.undo.token ?? "") : "")
        do {
            let result = try await session.send(endpoint)
            doneMessage = result.summary
            undoCount += 1
            await reload()
            return true
        } catch {
            let error = NetworkError(error)
            if error == .cancelled || error == .unauthorized { return false }
            if case .http(let status) = error, status.code == 409 {
                // Changed again since the page looked (or already restored): show the state as it is now.
                await reload()
                if let now = self.change, now.undo.needsConfirmation {
                    undoError = "These settings were changed again after you opened this entry. Review it, then undo again."
                } else {
                    undoError = error.userMessage
                }
            } else {
                undoError = error.userMessage
            }
            return false
        }
    }
}
