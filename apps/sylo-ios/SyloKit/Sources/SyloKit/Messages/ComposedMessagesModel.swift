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
    /// message), `publish` for a failed post, `move` for taking the posted message out of the old
    /// channel (or a move that was not confirmed).
    public private(set) var failedAction: FailedAction?
    /// What the last action did.
    public private(set) var notice: Notice?
    /// Goes up with every action that went through, for a haptic.
    public private(set) var successCount = 0

    public enum Notice: Sendable, Equatable {
        case saved, published, updated
    }

    public enum FailedAction: Sendable, Equatable {
        case save, publish, move
    }

    /// A posted message whose channel was changed: saving or posting it has to delete the posted
    /// message in the old channel first (the server edits the posted message in the channel the
    /// message is stored under, so a new channel with the old post would fail from then on).
    public struct ChannelMove: Sendable, Equatable {
        public let from: String
        public let to: String
    }

    private struct Snapshot: Equatable {
        var name: String
        var channelId: String
        var spec: ComposedMessageSpec
    }

    /// Whether the server moves a posted message to another channel itself when it is published
    /// there (it posts in the new channel first, then deletes the old post, so a refused post keeps
    /// the old one). Announced as ``ServerFeature/messageMove``; without it the app deletes the old
    /// post first.
    public private(set) var serverMovesMessages = false

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

    /// Set while the message is posted and a different channel is picked. The screen asks the person
    /// before saving or posting (``saveDraft(confirmedMove:)``, ``publish(confirmedMove:)``).
    public var channelMove: ChannelMove? {
        guard isPublished, let snapshot, !snapshot.channelId.isEmpty, !channelId.isEmpty,
              channelId != snapshot.channelId else { return nil }
        return ChannelMove(from: snapshot.channelId, to: channelId)
    }

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
        await loadFeatures()
    }

    /// Whether this server announces ``ServerFeature/messageMove``. Older servers do not say.
    private func loadFeatures() async {
        if let info = try? await session.send(Endpoints.ServerInfo()) {
            serverMovesMessages = info.supports(.messageMove)
        } else if let info = session.serverInfo {
            serverMovesMessages = info.supports(.messageMove)
        }
    }

    /// After a request whose outcome is unknown (it timed out): asks the server whether the message is
    /// still posted, and takes over only that and the stored channel, so unsaved edits stay.
    /// - Returns: Whether the server answered.
    private func refreshPostedState() async -> Bool {
        guard let detail = try? await session.send(Endpoints.LoadComposedMessage(server: server, id: id)) else {
            return false
        }
        messageId = detail.message.messageId
        if let snapshot {
            self.snapshot = Snapshot(name: snapshot.name, channelId: detail.message.channelId, spec: snapshot.spec)
        }
        return true
    }

    /// Throws the unsaved edits away.
    public func discardChanges() {
        guard let snapshot else { return }
        name = snapshot.name
        channelId = snapshot.channelId
        spec = snapshot.spec
    }

    /// Keeps the message as a draft. When the channel of a posted message was changed, the posted
    /// message is deleted in the old channel first, and only with `confirmedMove`.
    /// - Returns: Whether it was saved.
    @discardableResult
    public func saveDraft(confirmedMove: Bool = false) async -> Bool {
        guard !isSaving else { return false }
        notice = nil
        let moved = channelMove != nil
        guard await prepareMove(confirmed: confirmedMove, forPublish: false) else { return false }
        guard await submit(.save) != nil else {
            if moved { explainMove(afterwards: "saving it in the new channel failed") }
            return false
        }
        notice = .saved
        successCount += 1
        return true
    }

    /// Posts the message to the channel, or edits the posted one. A new message is saved first, so a
    /// post that fails (the bot may not write there) still leaves a draft the screen knows about,
    /// rather than one the next try would duplicate; the retry posts that saved message.
    ///
    /// When the channel of a posted message was changed, this needs `confirmedMove`. On a server that
    /// moves the post itself (``serverMovesMessages``) it is one publish with the new channel: the
    /// server posts there first and deletes the old post second, and a refused post keeps the old
    /// one. Otherwise: delete the posted message in the old channel, then save and post in the new
    /// one, each step stopping with its own message.
    /// - Returns: Whether it is in the channel now.
    @discardableResult
    public func publish(confirmedMove: Bool = false) async -> Bool {
        guard canPublish else { return false }
        notice = nil
        // Only a move the app made itself leaves the old post deleted when a later step fails.
        let moved = channelMove != nil && !serverMovesMessages
        guard await prepareMove(confirmed: confirmedMove, forPublish: true) else { return false }
        if id == .new {
            guard await submit(.save) != nil else { return false }
        }
        guard let result = await submit(.publish) else {
            if moved { explainMove(afterwards: "posting it in the new channel failed") }
            return false
        }
        notice = result.status == .updated ? .updated : .published
        successCount += 1
        return true
    }

    /// Takes the posted message out of the old channel before a channel change is saved, while the
    /// server still holds the old channel. Nothing happens without a move, and a publish on a server
    /// that moves the post itself needs only the confirmation.
    private func prepareMove(confirmed: Bool, forPublish: Bool) async -> Bool {
        guard channelMove != nil else { return true }
        guard confirmed else {
            actionError = "Confirm moving the posted message to the other channel first."
            failedAction = .move
            return false
        }
        if forPublish, serverMovesMessages { return true }
        guard case .saved(let savedID) = id else { return true }
        isSaving = true
        defer { isSaving = false }
        actionError = nil
        failedAction = nil
        do {
            _ = try await session.send(Endpoints.UnpublishComposedMessage(server: server, id: savedID))
            messageId = nil
            return true
        } catch {
            let error = NetworkError(error)
            guard error != .cancelled, error != .unauthorized else { return false }
            failedAction = .move
            guard Self.outcomeIsUnknown(error) else {
                actionError = "Couldn't remove the posted message from the old channel, so nothing was changed. "
                    + error.userMessage
                return false
            }
            // The request may have reached the server: ask, rather than claim either way.
            if await refreshPostedState() {
                actionError = isPublished
                    ? "The connection failed while removing the posted message from the old channel, but it is still there, so nothing was changed. "
                        + error.userMessage
                    : "The connection failed while removing the posted message, but the old post is gone. It is not posted any more; publish again to post it in the new channel. "
                        + error.userMessage
            } else {
                actionError = "Couldn't tell whether the posted message was removed from the old channel. Reopen this message to see where it stands, then try again. "
                    + error.userMessage
            }
            return false
        }
    }

    /// Errors after which the server may or may not have done the request: nothing came back, or the
    /// answer was a failure on its side.
    private static func outcomeIsUnknown(_ error: NetworkError) -> Bool {
        switch error {
        case .timeout, .offline, .unreachable, .secureConnectionFailed, .transport, .server: true
        default: false
        }
    }

    /// After the posted message was deleted in the old channel and the next step failed: say where
    /// things stand, so nothing is half done out of sight.
    private func explainMove(afterwards problem: String) {
        guard let text = actionError else { return }
        actionError = "The posted message was deleted in the old channel, but \(problem). It is not posted any more; the draft is what you see here. "
            + text
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
                failedAction = action == .publish ? .publish : .save
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
                failedAction = action == .publish ? .publish : .save
            }
            return nil
        }
    }
}
