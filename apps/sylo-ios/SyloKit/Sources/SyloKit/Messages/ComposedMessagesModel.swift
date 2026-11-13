import Foundation
import Observation

/// The list of a server's embed messages, with unpublishing and deleting from it.
@MainActor
@Observable
public final class ComposedMessagesModel {
    /// How many saved messages a server can have.
    public static let maxMessages = 200

    public let server: ServerID
    public private(set) var items: [ComposedMessageSummary] = []
    public private(set) var isLoading = false
    public private(set) var hasLoaded = false
    /// Why the list could not be loaded (the last list, if any, stays).
    public var errorMessage: String?
    /// Why the last unpublish or delete did not go through.
    public var actionError: String?
    /// The messages an unpublish or a delete is running for.
    public private(set) var busy: Set<Int> = []
    /// Goes up with every action that went through, for a haptic.
    public private(set) var successCount = 0

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public var isFull: Bool { items.count >= Self.maxMessages }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            items = try await session.send(Endpoints.ListComposedMessages(server: server)).items
            hasLoaded = true
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    /// Takes the posted message out of the channel; the draft stays and shows as a draft.
    @discardableResult
    public func unpublish(_ id: Int) async -> Bool {
        guard !busy.contains(id) else { return false }
        busy.insert(id)
        defer { busy.remove(id) }
        actionError = nil
        do {
            _ = try await session.send(Endpoints.UnpublishComposedMessage(server: server, id: id))
            if let index = items.firstIndex(where: { $0.id == id }) {
                let item = items[index]
                items[index] = ComposedMessageSummary(
                    id: item.id, name: item.name, channel: item.channel, published: false, when: item.when)
            }
            successCount += 1
            return true
        } catch {
            report(error)
            return false
        }
    }

    /// Deletes the draft, and the posted message with it.
    @discardableResult
    public func delete(_ id: Int) async -> Bool {
        guard !busy.contains(id) else { return false }
        busy.insert(id)
        defer { busy.remove(id) }
        actionError = nil
        do {
            _ = try await session.send(Endpoints.DeleteComposedMessage(server: server, id: id))
            items.removeAll { $0.id == id }
            successCount += 1
            return true
        } catch {
            report(error)
            return false
        }
    }

    private func report(_ error: any Error) {
        let error = NetworkError(error)
        if error != .cancelled, error != .unauthorized { actionError = error.userMessage }
    }
}

/// One embed message being edited: its name, channel and spec, saving it as a draft and posting it.
@MainActor
@Observable
public final class ComposedMessageBuilderModel {
    public static let maxNameLength = 100

    /// What the screen edits.
    public var name = ""
    public var channelId = ""
    public var spec = ComposedMessageSpec()

    public let server: ServerID
    /// `new` until the first save.
    public private(set) var id: ComposedMessageID
    public private(set) var channels: [ChannelOption] = []
    /// The posted message's id; nil while it is a draft.
    public private(set) var messageId: String?
    public private(set) var isLoading = false
    public private(set) var isSaving = false
    public private(set) var hasLoaded = false
    /// Why the message could not be loaded.
    public var errorMessage: String?
    /// Why the last save or publish did not go through, in the server's words.
    public var actionError: String?
    /// Which step the error belongs to: `save` for a failed save (also the first step of posting a new
    /// message), `publish` for a failed post.
    public private(set) var failedAction: ComposedSaveAction?
    /// What the last action did.
    public private(set) var notice: Notice?
    /// Goes up with every action that went through, for a haptic.
    public private(set) var successCount = 0

    public enum Notice: Sendable, Equatable {
        case saved, published, updated
    }

    private struct Snapshot: Equatable {
        var name: String
        var channelId: String
        var spec: ComposedMessageSpec
    }

    private var snapshot: Snapshot?
    private let session: AppSession

    public init(server: ServerID, id: ComposedMessageID, session: AppSession) {
        self.server = server
        self.id = id
        self.session = session
    }

    public var isPublished: Bool { !(messageId ?? "").isEmpty }

    /// Whether name, channel or spec differ from what the server has.
    public var hasChanges: Bool {
        guard let snapshot else { return false }
        return snapshot != Snapshot(name: name, channelId: channelId, spec: spec)
    }

    /// Posting needs a channel.
    public var canPublish: Bool { hasLoaded && !channelId.isEmpty && !isSaving }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let detail = try await session.send(Endpoints.LoadComposedMessage(server: server, id: id))
            let message = detail.message
            name = message.name
            channelId = message.channelId
            messageId = message.messageId
            spec = message.spec
            channels = detail.channels
            snapshot = Snapshot(name: message.name, channelId: message.channelId, spec: message.spec)
            hasLoaded = true
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    /// Throws the unsaved edits away.
    public func discardChanges() {
        guard let snapshot else { return }
        name = snapshot.name
        channelId = snapshot.channelId
        spec = snapshot.spec
    }

    /// Keeps the message as a draft.
    /// - Returns: Whether it was saved.
    @discardableResult
    public func saveDraft() async -> Bool {
        guard !isSaving else { return false }
        notice = nil
        guard await submit(.save) != nil else { return false }
        notice = .saved
        successCount += 1
        return true
    }

    /// Posts the message to the channel, or edits the posted one. A new message is saved first, so a
    /// post that fails (the bot may not write there) still leaves a draft the screen knows about,
    /// rather than one the next try would duplicate.
    /// - Returns: Whether it is in the channel now.
    @discardableResult
    public func publish() async -> Bool {
        guard canPublish else { return false }
        notice = nil
        if id == .new {
            guard await submit(.save) != nil else { return false }
        }
        guard let result = await submit(.publish) else { return false }
        notice = result.status == .updated ? .updated : .published
        successCount += 1
        return true
    }

    private func submit(_ action: ComposedSaveAction) async -> ComposedSaveResult? {
        guard !isSaving else { return nil }
        isSaving = true
        defer { isSaving = false }
        actionError = nil
        failedAction = nil
        let sent = spec
        do {
            let result = try await session.send(
                Endpoints.SaveComposedMessage(
                    server: server, id: id, name: name, channelId: channelId, action: action, spec: sent))
            if let error = result.error {
                actionError = error
                failedAction = action
                return nil
            }
            let message = result.message
            if let saved = message.id { id = .saved(saved) }
            name = message.name
            channelId = message.channelId
            messageId = message.messageId
            snapshot = Snapshot(name: message.name, channelId: message.channelId, spec: sent)
            return result
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized {
                actionError = error.userMessage
                failedAction = action
            }
            return nil
        }
    }
}
