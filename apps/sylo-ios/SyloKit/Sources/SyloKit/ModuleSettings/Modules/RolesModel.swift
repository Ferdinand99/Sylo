import Foundation
import Observation

/// Whether the server moves a posted message itself when its channel changes (it posts in the new
/// channel first and deletes the old post after). Servers that announce `message-move` do; on older
/// ones the app takes the old post out first.
extension ServerInfo {
    var movesPostedMessages: Bool { supports(ServerFeature(rawValue: "message-move")) }
}

/// The reaction-role screen: the sets, the autoroles, the server's custom emojis and the limits.
@MainActor
@Observable
public final class RolesModel {
    public let server: ServerID
    public private(set) var reactionMessages: [ReactionRoleMessage] = []
    public private(set) var channels: [ChannelOption] = []
    public private(set) var roles: [RoleOption] = []
    /// The autoroles being edited.
    public var autoroles: [String] = []
    /// The autoroles as last loaded or saved.
    public private(set) var savedAutoroles: [String] = []
    /// The server's own emojis, empty when it has none or cannot list them.
    public private(set) var customEmojis: [GuildEmoji] = []
    public private(set) var limits: ModuleFieldLimits = .unlimited
    public private(set) var hasLoaded = false
    public private(set) var isLoading = false
    public private(set) var isSavingAutoroles = false
    public private(set) var isSavingSet = false
    /// Why the page could not be loaded.
    public var errorMessage: String?
    /// Why the last autoroles save, delete or set save did not go through, in the server's words.
    public var actionError: String?
    /// Goes up with every save or delete that went through, for a haptic.
    public private(set) var successCount = 0

    private let session: AppSession
    private let movesOverride: Bool?
    private var hasLoadedExtras = false

    /// - Parameter serverMovesMessages: Whether the server moves posted messages itself. nil reads it
    ///   from the server's info (the `message-move` feature).
    public init(server: ServerID, session: AppSession, serverMovesMessages: Bool? = nil) {
        self.server = server
        self.session = session
        movesOverride = serverMovesMessages
    }

    // MARK: - Limits

    public var maxSets: Int { limits["reactionMessages"].maxItems ?? ReactionRoleMessage.Limits.reactionMessages }
    public var maxAutoroles: Int { limits["autoroles"].maxItems ?? ReactionRoleMessage.Limits.autoroles }
    public var pairsLimit: Int? { limits["reactionMessages[].pairs"].maxItems }
    public var messageLimit: Int {
        limits["reactionMessages[].message"].maxLength ?? ReactionRoleMessage.Limits.messageLength
    }
    public var placeholderLimit: Int {
        limits["reactionMessages[].placeholder"].maxLength ?? ReactionRoleMessage.Limits.placeholderLength
    }
    public var labelLimit: Int {
        limits["reactionMessages[].pairs[].label"].maxLength ?? ReactionRoleMessage.Limits.labelLength
    }

    public var canAddSet: Bool { reactionMessages.count < maxSets }

    // MARK: - Autoroles

    public var autorolesChanged: Bool { autoroles != savedAutoroles }

    public func discardAutoroles() { autoroles = savedAutoroles }

    // MARK: - Loading

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await session.send(Endpoints.LoadRoles(server: server))
            let keepAutoroles = autorolesChanged
            reactionMessages = page.reactionMessages
            channels = page.channels
            roles = page.roles
            savedAutoroles = page.autoroles
            if !keepAutoroles { autoroles = page.autoroles }
            hasLoaded = true
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
            return
        }
        await loadExtras()
    }

    /// The server's limits and custom emojis, once. Either is missing on some servers; the screen then
    /// uses its fixed limits and offers no custom emojis.
    private func loadExtras() async {
        guard !hasLoadedExtras else { return }
        hasLoadedExtras = true
        limits = await session.moduleLimits()["roles"]
        if let emojis = try? await session.send(Endpoints.LoadGuildEmojis(server: server)) {
            customEmojis = emojis.custom
        }
    }

    // MARK: - Autoroles save

    /// Saves the autoroles. The list takes what the server stored.
    /// - Returns: Whether they are saved (also true when nothing changed).
    @discardableResult
    public func saveAutoroles() async -> Bool {
        guard autorolesChanged else { return true }
        guard !isSavingAutoroles else { return false }
        isSavingAutoroles = true
        defer { isSavingAutoroles = false }
        actionError = nil
        do {
            let saved = try await session.send(Endpoints.SaveAutoroles(server: server, autoroles: autoroles))
            savedAutoroles = saved.autoroles
            autoroles = saved.autoroles
            successCount += 1
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { actionError = error.userMessage }
            return false
        }
    }

    // MARK: - Reaction-role sets

    /// What happened to a set that was saved.
    public enum SaveOutcome: Sendable, Equatable {
        /// Saved and posted in the channel.
        case saved
        /// Saved, but the post failed (the server's words): the set is a draft until the next save.
        case savedNotPosted(String)
        /// Nothing was saved.
        case failed(String)
        /// The posted message was deleted from the old channel and saving the set in the new one then
        /// failed: the set is gone from the server, and the next save makes a new one.
        case failedAfterRemoval(String)
        /// The channel was changed and the person has not agreed to the move yet.
        case needsConfirmation
        /// Nothing happened (a save is running, or the request was cancelled).
        case ignored
    }

    /// A posted set whose channel was changed.
    public struct ChannelMove: Sendable, Equatable {
        public let from: String
        public let to: String
    }

    /// Whether the server itself moves a posted message to a new channel.
    public var serverMovesMessages: Bool { movesOverride ?? session.serverInfo?.movesPostedMessages ?? false }

    /// The move this draft would make: its set is posted, and the draft names another channel.
    public func channelMove(for draft: ReactionRoleMessage) -> ChannelMove? {
        guard !draft.id.isEmpty, !draft.channelId.isEmpty,
              let stored = reactionMessages.first(where: { $0.id == draft.id }), stored.isPublished,
              !stored.channelId.isEmpty, stored.channelId != draft.channelId else { return nil }
        return ChannelMove(from: stored.channelId, to: draft.channelId)
    }

    /// Whether saving this draft has to ask first: a posted set changes channel on a server that does
    /// not move the message itself, so the app deletes the old one first.
    public func needsMoveConfirmation(for draft: ReactionRoleMessage) -> Bool {
        channelMove(for: draft) != nil && !serverMovesMessages
    }

    /// Saves one set and posts it to its channel (every save posts, as on the dashboard).
    ///
    /// When the channel of a posted set changed, a server that has `message-move` posts in the new channel
    /// first and deletes the old post after, so a failed post keeps the old one. A server without it would
    /// edit the old post's id in the new channel, so the app deletes the set (and its post) first and
    /// saves the same set as a new one; that needs `confirmedMove`.
    public func save(_ draft: ReactionRoleMessage, confirmedMove: Bool = false) async -> SaveOutcome {
        guard !isSavingSet else { return .ignored }
        let moves = needsMoveConfirmation(for: draft)
        if moves, !confirmedMove { return .needsConfirmation }
        isSavingSet = true
        defer { isSavingSet = false }
        actionError = nil

        var body = draft.resolvingShortcodes(among: customEmojis)
        var removedID: String?
        if moves {
            do {
                _ = try await session.send(Endpoints.DeleteReactionRole(server: server, id: draft.id))
            } catch {
                let error = NetworkError(error)
                guard error != .cancelled, error != .unauthorized else { return .ignored }
                return .failed("Couldn't remove the posted message from the old channel, so nothing was changed. "
                    + error.userMessage)
            }
            removedID = draft.id
            reactionMessages.removeAll { $0.id == draft.id }
            body.id = ""
            body.messageId = ""
        }

        do {
            let saved = try await session.send(Endpoints.SaveReactionRole(server: server, message: body))
            if let message = saved.reactionMessage {
                if let index = reactionMessages.firstIndex(where: { $0.id == message.id }) {
                    reactionMessages[index] = message
                } else {
                    reactionMessages.append(message)
                }
            }
            successCount += 1
            if let error = saved.error { return .savedNotPosted(error) }
            return .saved
        } catch {
            let error = NetworkError(error)
            guard error != .cancelled, error != .unauthorized else {
                return removedID == nil ? .ignored : .failedAfterRemoval(Self.removedText + "The request was cancelled.")
            }
            if removedID != nil { return .failedAfterRemoval(Self.removedText + error.userMessage) }
            return .failed(error.userMessage)
        }
    }

    private static let removedText =
        "The posted message was deleted from the old channel, but saving it in the new channel failed. It is not posted any more; what you see here is kept. "

    /// Deletes a set and its posted message.
    /// - Returns: Whether it is gone.
    @discardableResult
    public func delete(_ id: String) async -> Bool {
        guard !isSavingSet else { return false }
        isSavingSet = true
        defer { isSavingSet = false }
        actionError = nil
        do {
            _ = try await session.send(Endpoints.DeleteReactionRole(server: server, id: id))
            reactionMessages.removeAll { $0.id == id }
            successCount += 1
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { actionError = error.userMessage }
            return false
        }
    }
}
