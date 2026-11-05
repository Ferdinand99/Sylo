import Foundation
import Observation

// Embed messages (the dashboard's Message Creator: web-v2/src/pages/Messages.jsx and
// MessageBuilder.jsx; the API is in src/web/routes/v2Api.js under /guilds/:id/messages). A message
// is built once, saved as a draft, and published to a channel as Sylo; publishing again edits the
// posted message in place.

/// A message as the server stores it: text, up to ten embeds and rows of buttons.
public struct ComposedSpec: Codable, Sendable, Equatable {
    public var content: String
    public var embeds: [EmbedSpec]
    /// Rows of buttons or menus. The app only edits link buttons; everything else is kept.
    public var rows: [JSONValue]

    public init(content: String = "", embeds: [EmbedSpec] = [], rows: [JSONValue] = []) {
        self.content = content
        self.embeds = embeds
        self.rows = rows
    }

    private enum CodingKeys: String, CodingKey { case content, embeds, rows }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        content = try c.decode(forKey: .content, or: "")
        embeds = try c.decode(forKey: .embeds, or: [])
        rows = try c.decode(forKey: .rows, or: [])
    }
}

/// A button under a message that opens a link.
public struct LinkButton: Sendable, Equatable, Identifiable {
    public let localID = LocalID()
    public var label: String
    /// A unicode emoji or a custom emoji, optional.
    public var emoji: String
    public var url: String

    public var id: UUID { localID.value }

    public init(label: String = "", emoji: String = "", url: String = "") {
        self.label = label
        self.emoji = emoji
        self.url = url
    }

    public static let maxLabelLength = 80
    public static let maxEmojiLength = 64
}

/// What the message editor changes: the message text, the embeds and the link buttons.
public struct ComposedMessageDraft: Sendable, Equatable {
    public var content: String
    public var embeds: [EmbedSpec]
    public var links: [LinkButton]
    /// Rows the editor does not edit (a role menu made by Reaction roles), saved back unchanged.
    var keptRows: [JSONValue]

    public init(content: String = "", embeds: [EmbedSpec] = [], links: [LinkButton] = [], keptRows: [JSONValue] = []) {
        self.content = content
        self.embeds = embeds
        self.links = links
        self.keptRows = keptRows
    }

    public static let maxContentLength = 2000
    public static let maxEmbeds = 10
    public static let maxLinks = 5
    public static let maxNameLength = 100

    /// The editor's form of a stored message, the way the web editor opens it: embeds with the
    /// default colour where none is set, and every link button gathered into one list.
    public init(spec: ComposedSpec) {
        let kept = spec.rows.filter { row in
            guard row.objectValue?["type"]?.stringValue == "buttons" else { return true }
            return (row.objectValue?["buttons"]?.arrayValue ?? []).contains { button in
                button.objectValue?["style"]?.stringValue != "link"
            }
        }
        let links = spec.rows
            .filter { $0.objectValue?["type"]?.stringValue == "buttons" }
            .flatMap { $0.objectValue?["buttons"]?.arrayValue ?? [] }
            .filter { button in
                let object = button.objectValue ?? [:]
                return object["style"]?.stringValue == "link" || !(object["url"]?.stringValue ?? "").isEmpty
            }
            .map { button -> LinkButton in
                let object = button.objectValue ?? [:]
                return LinkButton(
                    label: object["label"]?.stringValue ?? "", emoji: object["emoji"]?.stringValue ?? "",
                    url: object["url"]?.stringValue ?? "")
            }
        self.init(
            content: spec.content, embeds: spec.embeds.map { $0.withDefaultColor() }, links: links, keptRows: kept)
    }

    /// The stored form: link buttons that have a link and a label or emoji go in one row after
    /// the kept rows; fields that are completely empty are dropped.
    public var spec: ComposedSpec {
        let buttons: [JSONValue] = links.compactMap { link in
            let label = link.label.trimmingCharacters(in: .whitespacesAndNewlines)
            let emoji = link.emoji.trimmingCharacters(in: .whitespacesAndNewlines)
            let url = link.url.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !url.isEmpty, !label.isEmpty || !emoji.isEmpty else { return nil }
            return JSONValue.object([
                "style": .string("link"), "label": .string(label), "emoji": .string(emoji), "url": .string(url),
            ])
        }
        var rows = keptRows
        if !buttons.isEmpty {
            rows.append(JSONValue.object(["type": .string("buttons"), "buttons": .array(buttons)]))
        }
        return ComposedSpec(content: content, embeds: embeds, rows: rows)
    }

    /// Whether the message would post nothing at all.
    public var isEmpty: Bool {
        content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && embeds.allSatisfy(\.isEmpty)
            && spec.rows.isEmpty
    }
}

/// One saved message in the list.
public struct ComposedMessageSummary: Decodable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let name: String
    /// The channel's name, or its id when the channel is gone.
    public let channel: String
    public let isPublished: Bool
    /// When it was last edited, as "3h ago".
    public let edited: String

    public init(id: Int, name: String, channel: String, isPublished: Bool, edited: String) {
        self.id = id
        self.name = name
        self.channel = channel
        self.isPublished = isPublished
        self.edited = edited
    }

    private enum CodingKeys: String, CodingKey { case id, name, channel, published, when }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(forKey: .name, or: "")
        channel = try c.decode(forKey: .channel, or: "")
        isPublished = try c.decode(forKey: .published, or: false)
        edited = try c.decode(forKey: .when, or: "")
    }
}

/// `GET /api/v2/guilds/:id/messages`.
public struct ComposedMessageList: Decodable, Sendable, Equatable {
    public let items: [ComposedMessageSummary]

    public init(items: [ComposedMessageSummary]) { self.items = items }

    private enum CodingKeys: String, CodingKey { case items }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeLossyArray(of: ComposedMessageSummary.self, forKey: .items)
    }
}

/// A saved message with its channel and the id of the message posted from it.
public struct ComposedMessageRecord: Decodable, Sendable, Equatable {
    /// Nil for a message that was never saved.
    public let id: Int?
    public let name: String
    public let channelId: String
    /// The posted message's id; nil for a draft.
    public let messageId: String?
    public let spec: ComposedSpec

    public init(id: Int?, name: String, channelId: String, messageId: String?, spec: ComposedSpec) {
        self.id = id
        self.name = name
        self.channelId = channelId
        self.messageId = messageId
        self.spec = spec
    }

    private enum CodingKeys: String, CodingKey { case id, name, channelId, messageId, spec }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A new message has id "", a saved one a number.
        if let number = try? c.decodeIfPresent(Int.self, forKey: .id) {
            id = number
        } else if let text = try? c.decodeIfPresent(String.self, forKey: .id) {
            id = Int(text)
        } else {
            id = nil
        }
        name = try c.decode(forKey: .name, or: "")
        channelId = try c.decode(forKey: .channelId, or: "")
        let posted = try c.decodeIfPresent(String.self, forKey: .messageId)
        messageId = (posted ?? "").isEmpty ? nil : posted
        spec = try c.decode(forKey: .spec, or: ComposedSpec())
    }
}

/// `GET /api/v2/guilds/:id/messages/:id` (`new` for a message that does not exist yet).
public struct ComposedMessagePage: Decodable, Sendable, Equatable {
    public let record: ComposedMessageRecord
    public let channels: [ChannelOption]
    public let roles: [RoleOption]

    public init(record: ComposedMessageRecord, channels: [ChannelOption] = [], roles: [RoleOption] = []) {
        self.record = record
        self.channels = channels
        self.roles = roles
    }

    private enum CodingKeys: String, CodingKey { case rec, channels, roles }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        record = try c.decode(ComposedMessageRecord.self, forKey: .rec)
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
    }
}

/// What saving a message did.
public enum ComposedSaveStatus: String, Sendable {
    /// Saved as a draft.
    case saved
    /// Posted to the channel.
    case sent
    /// The posted message was edited.
    case updated
}

/// The answer to saving a message.
public struct SavedComposedMessage: Decodable, Sendable, Equatable {
    public let record: ComposedMessageRecord
    public let status: ComposedSaveStatus

    public init(record: ComposedMessageRecord, status: ComposedSaveStatus) {
        self.record = record
        self.status = status
    }

    private enum CodingKeys: String, CodingKey { case rec, status }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        record = try c.decode(ComposedMessageRecord.self, forKey: .rec)
        status = ComposedSaveStatus(rawValue: try c.decode(forKey: .status, or: "saved")) ?? .saved
    }
}

/// The answer to taking a message down.
public struct UnpublishedComposedMessage: Decodable, Sendable, Equatable {
    public let record: ComposedMessageRecord

    private enum CodingKeys: String, CodingKey { case rec }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        record = try c.decode(ComposedMessageRecord.self, forKey: .rec)
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/messages`: the saved embed messages.
    public struct ComposedMessages: APIEndpoint {
        public typealias Response = ComposedMessageList
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/messages" }
    }

    /// `GET /api/v2/guilds/:id/messages/:id`: one message and the channels to post it in; a nil
    /// `id` is a new message.
    public struct ComposedMessage: APIEndpoint {
        public typealias Response = ComposedMessagePage
        public let server: ServerID
        public let id: Int?
        public init(server: ServerID, id: Int?) {
            self.server = server
            self.id = id
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/messages/\(id.map(String.init) ?? "new")" }
    }

    /// `POST /api/v2/guilds/:id/messages/:id`: saves the message, and with `publish` posts it (or
    /// edits the posted one).
    public struct SaveComposedMessage: APIEndpoint {
        public typealias Response = SavedComposedMessage
        public let server: ServerID
        public let id: Int?
        public let name: String
        public let channelId: String
        public let publish: Bool
        public let spec: ComposedSpec

        public init(server: ServerID, id: Int?, name: String, channelId: String, publish: Bool, spec: ComposedSpec) {
            self.server = server
            self.id = id
            self.name = name
            self.channelId = channelId
            self.publish = publish
            self.spec = spec
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/messages/\(id.map(String.init) ?? "new")" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            Body(name: name, channelId: channelId, action: publish ? "publish" : "save", spec: spec)
        }

        private struct Body: Encodable, Sendable {
            let name: String
            let channelId: String
            let action: String
            let spec: ComposedSpec
        }
    }

    /// `POST /api/v2/guilds/:id/messages/:id/unpublish`: deletes the posted message, keeps the draft.
    public struct UnpublishComposedMessage: APIEndpoint {
        public typealias Response = UnpublishedComposedMessage
        public let server: ServerID
        public let id: Int
        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/messages/\(id)/unpublish" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Empty() }
        private struct Empty: Encodable, Sendable {}
    }

    /// `POST /api/v2/guilds/:id/messages/:id/delete`: deletes the draft and the posted message.
    public struct DeleteComposedMessage: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let id: Int
        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/messages/\(id)/delete" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Empty() }
        private struct Empty: Encodable, Sendable {}
    }
}

// MARK: - The list

/// The saved embed messages of one server.
@MainActor
@Observable
public final class ComposedMessagesModel {
    public let server: ServerID
    public private(set) var items: [ComposedMessageSummary]?
    public private(set) var isLoading = false
    /// Why the list could not be loaded.
    public var errorMessage: String?
    /// Why the last unpublish or delete did not go through.
    public var actionError: String?
    /// Messages being unpublished or deleted.
    public private(set) var busy: Set<Int> = []
    /// Goes up with every successful change, for a haptic.
    public private(set) var changeCount = 0

    /// How many messages a server may keep.
    public static let limit = 200

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            items = try await session.send(Endpoints.ComposedMessages(server: server)).items
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.detailMessage }
        }
    }

    /// Deletes the posted message and keeps the draft.
    public func unpublish(_ id: Int) async {
        await change(id) { session, server in
            _ = try await session.send(Endpoints.UnpublishComposedMessage(server: server, id: id))
        }
        if actionError == nil, let index = items?.firstIndex(where: { $0.id == id }), let old = items?[index] {
            items?[index] = ComposedMessageSummary(
                id: old.id, name: old.name, channel: old.channel, isPublished: false, edited: old.edited)
        }
    }

    /// Deletes the draft, and the posted message too when it is published.
    public func delete(_ id: Int) async {
        await change(id) { session, server in
            _ = try await session.send(Endpoints.DeleteComposedMessage(server: server, id: id))
        }
        if actionError == nil { items?.removeAll { $0.id == id } }
    }

    private func change(
        _ id: Int, _ work: @MainActor (AppSession, ServerID) async throws -> Void
    ) async {
        guard !busy.contains(id) else { return }
        busy.insert(id)
        defer { busy.remove(id) }
        actionError = nil
        do {
            try await work(session, server)
            changeCount += 1
            session.noteModulesChanged()
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { actionError = error.detailMessage }
        }
    }
}

// MARK: - The editor

/// One message being edited: its name, the channel it goes to and its content, with Save draft and
/// Publish. Saving a message that was never saved creates it; publishing one that is already
/// posted edits the posted message.
@MainActor
@Observable
public final class ComposedMessageEditorModel {
    public let server: ServerID
    public private(set) var recordID: Int?
    public private(set) var isLoaded = false
    public private(set) var isLoading = false
    /// Why the message could not be loaded.
    public var errorMessage: String?
    /// Why the last save or publish did not go through (what was typed is kept).
    public var actionError: String?
    public var name = ""
    public var channelId = ""
    public var draft = ComposedMessageDraft()
    /// The posted message's id; nil while the message is a draft.
    public private(set) var messageID: String?
    public private(set) var channels: [ChannelOption] = []
    public private(set) var isBusy = false
    /// What the last save did, for a confirmation line.
    public private(set) var lastStatus: ComposedSaveStatus?
    /// Goes up with every successful save, for a haptic.
    public private(set) var saveCount = 0

    private var saved: Snapshot?
    private let session: AppSession

    struct Snapshot: Equatable {
        var name: String
        var channelId: String
        var draft: ComposedMessageDraft
    }

    /// - Parameter id: The saved message to edit; nil starts a new one.
    public init(server: ServerID, session: AppSession, id: Int?) {
        self.server = server
        self.session = session
        recordID = id
    }

    public var isNew: Bool { recordID == nil }
    public var isPublished: Bool { messageID != nil }
    public var hasChanges: Bool { isLoaded && saved != Snapshot(name: name, channelId: channelId, draft: draft) }

    /// Why Publish cannot be used yet, in words for the person; nil when it can.
    public var publishProblem: String? {
        if channelId.isEmpty { return "Choose a channel before publishing." }
        if draft.isEmpty { return "Add some text or an embed before publishing." }
        return nil
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await session.send(Endpoints.ComposedMessage(server: server, id: recordID))
            channels = page.channels
            if !hasChanges { apply(page.record) }
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.detailMessage }
        }
    }

    /// Saves without posting.
    @discardableResult
    public func saveDraft() async -> Bool {
        await save(publish: false)
    }

    /// Saves, then posts the message to the channel, or edits the posted one.
    @discardableResult
    public func publish() async -> Bool {
        if let problem = publishProblem {
            actionError = problem
            return false
        }
        return await save(publish: true)
    }

    /// Throws the unsaved edits away.
    public func discardChanges() {
        guard let saved else { return }
        name = saved.name
        channelId = saved.channelId
        draft = saved.draft
    }

    private func save(publish: Bool) async -> Bool {
        guard !isBusy else { return false }
        isBusy = true
        defer { isBusy = false }
        actionError = nil
        let sent = Snapshot(name: name, channelId: channelId, draft: draft)
        do {
            // A message never saved is created first, so a refused post cannot leave the person
            // with a draft they do not know the id of (and a second one the next time).
            if publish, recordID == nil {
                let created = try await session.send(
                    Endpoints.SaveComposedMessage(
                        server: server, id: nil, name: name, channelId: channelId, publish: false, spec: draft.spec))
                remember(created.record, sent: sent)
            }
            let result = try await session.send(
                Endpoints.SaveComposedMessage(
                    server: server, id: recordID, name: name, channelId: channelId, publish: publish,
                    spec: draft.spec))
            remember(result.record, sent: sent)
            lastStatus = result.status
            saveCount += 1
            session.noteModulesChanged()
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { actionError = error.detailMessage }
            return false
        }
    }

    /// The server's copy of what was just sent becomes the saved state; edits typed while the save
    /// was on its way stay as edits.
    private func remember(_ record: ComposedMessageRecord, sent: Snapshot) {
        recordID = record.id ?? recordID
        messageID = record.messageId
        var snapshot = sent
        snapshot.channelId = record.channelId
        if channelId == sent.channelId { channelId = record.channelId }
        snapshot.name = record.name.isEmpty ? sent.name : record.name
        if name == sent.name, !record.name.isEmpty { name = record.name }
        saved = snapshot
    }

    private func apply(_ record: ComposedMessageRecord) {
        recordID = record.id ?? recordID
        messageID = record.messageId
        name = record.name
        channelId = record.channelId
        draft = ComposedMessageDraft(spec: record.spec)
        saved = Snapshot(name: name, channelId: channelId, draft: draft)
        isLoaded = true
    }
}
