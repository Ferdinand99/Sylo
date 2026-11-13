import Foundation
import Observation

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
    /// Whether the server's emoji list was read. Without it a `:shortcode:` cannot be checked here, so
    /// it is sent as typed and the server looks it up.
    public private(set) var hasEmojiList = false
    public private(set) var limits: ModuleFieldLimits = .unlimited
    public private(set) var hasLoaded = false
    public private(set) var isLoading = false
    public private(set) var isSavingAutoroles = false
    public private(set) var isSavingSet = false
    /// Whether this server moves a posted message to a new channel itself (``ServerFeature/messageMove``).
    /// False until the server has been asked, and on servers that do not say.
    public private(set) var serverMovesMessages = false
    /// Why the page could not be loaded.
    public var errorMessage: String?
    /// Why the last autoroles save, delete or set save did not go through, in the server's words.
    public var actionError: String?
    /// Goes up with every save or delete that went through, for a haptic.
    public private(set) var successCount = 0

    private let session: AppSession
    private var emojiListMissing = false
    private var hasLoadedFeatures = false
    /// A request ended without an answer and the list could not be read again to see what it did.
    private var needsRecheck = false

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
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
            apply(try await session.send(Endpoints.LoadRoles(server: server)))
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
            return
        }
        await loadExtras()
    }

    private func apply(_ page: RolesPage) {
        let keepAutoroles = autorolesChanged
        reactionMessages = page.reactionMessages
        channels = page.channels
        roles = page.roles
        savedAutoroles = page.autoroles
        if !keepAutoroles { autoroles = page.autoroles }
        hasLoaded = true
        errorMessage = nil
        needsRecheck = false
    }

    /// Reads the list again, for after a request whose outcome is not known.
    /// - Returns: Whether the server answered.
    private func reloadList() async -> Bool {
        guard let page = try? await session.send(Endpoints.LoadRoles(server: server)) else { return false }
        apply(page)
        return true
    }

    /// Asks for what the form needs beyond the list (the server's limits, custom emojis and whether the
    /// server moves a posted message itself) when an earlier try did not get it. The editor calls this
    /// every time it opens, so a transient failure does not last.
    public func prepare() async {
        await loadExtras()
    }

    private func loadExtras() async {
        limits = await session.moduleLimits()["roles"]
        if !hasEmojiList, !emojiListMissing {
            do {
                customEmojis = try await session.send(Endpoints.LoadGuildEmojis(server: server)).custom
                hasEmojiList = true
            } catch {
                // No such route is final; anything else is tried again.
                if NetworkError(error) == .notFound { emojiListMissing = true }
            }
        }
        if !hasLoadedFeatures { await loadFeatures() }
    }

    /// The server's own word on whether it moves a posted message (the app's cached info is empty after
    /// a relaunch, so the server is asked, as the message builder does).
    private func loadFeatures() async {
        if let info = try? await session.send(Endpoints.ServerInfo()) {
            serverMovesMessages = info.supports(.messageMove)
            hasLoadedFeatures = true
        } else if let info = session.serverInfo {
            serverMovesMessages = info.supports(.messageMove)
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
        /// Saved, but the message that is posted was not updated (the server's words). With `moved` the
        /// channel was changed: the message is still posted in the old channel.
        case stillPosted(String, moved: Bool)
        /// Nothing was saved, or nothing that matters changed. The text says which.
        case failed(String)
        /// The set was posted in the new channel, but the old set could not be deleted: both exist now.
        case movedOldRemains(String)
        /// The old set was deleted first (the server was full) and saving it again failed. The set is
        /// gone from the server; the id is still its own, so the next save puts it back.
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

    /// The move this draft would make: its set is posted, and the draft names another channel.
    public func channelMove(for draft: ReactionRoleMessage) -> ChannelMove? {
        guard !draft.id.isEmpty, !draft.channelId.isEmpty,
              let stored = reactionMessages.first(where: { $0.id == draft.id }), stored.isPublished,
              !stored.channelId.isEmpty, stored.channelId != draft.channelId else { return nil }
        return ChannelMove(from: stored.channelId, to: draft.channelId)
    }

    /// Whether saving this draft has to ask first: a posted set changes channel on a server that does
    /// not move the message itself, so the app does the move.
    public func needsMoveConfirmation(for draft: ReactionRoleMessage) -> Bool {
        channelMove(for: draft) != nil && !serverMovesMessages
    }

    /// Saves one set and posts it to its channel (every save posts, as on the dashboard).
    ///
    /// When the channel of a posted set changed:
    /// - A server with `message-move` posts in the new channel first and deletes the old post after, so a
    ///   failed post keeps the old one. One save does it.
    /// - Older servers (5.1) post a fresh message in the new channel and leave the old post behind, with
    ///   its buttons still working. The app does the move itself, in the safe order: save the set again
    ///   as a new set in the new channel, and delete the old set only after that worked. Any refusal
    ///   leaves the old set as it was. Only a server at its set limit has no room for the new set, so
    ///   then the old one is deleted first and saved again under its own id. That needs `confirmedMove`.
    public func save(_ draft: ReactionRoleMessage, confirmedMove: Bool = false) async -> SaveOutcome {
        guard !isSavingSet else { return .ignored }
        if !hasLoadedFeatures { await loadFeatures() }
        let moves = needsMoveConfirmation(for: draft)
        if moves, !confirmedMove { return .needsConfirmation }
        isSavingSet = true
        defer { isSavingSet = false }
        actionError = nil

        if needsRecheck {
            let reloaded = await reloadList()
            return .failed(reloaded ? Self.recheckedText : Self.cannotCheckText)
        }

        let body = draft.resolvingShortcodes(among: customEmojis)
        if moves { return await moveOnOldServer(draft: draft, body: body) }

        let serverMoves = channelMove(for: draft) != nil
        do {
            let saved = try await session.send(Endpoints.SaveReactionRole(server: server, message: body))
            store(saved.reactionMessage)
            successCount += 1
            if let error = saved.error {
                if saved.reactionMessage?.isPublished == true { return .stillPosted(error, moved: serverMoves) }
                return .savedNotPosted(error)
            }
            return .saved
        } catch {
            let error = NetworkError(error)
            guard error != .cancelled, error != .unauthorized else { return .ignored }
            return .failed(error.userMessage)
        }
    }

    private func store(_ message: ReactionRoleMessage?) {
        guard let message else { return }
        if let index = reactionMessages.firstIndex(where: { $0.id == message.id }) {
            reactionMessages[index] = message
        } else {
            reactionMessages.append(message)
        }
    }

    // MARK: - The move on a server that does not do it itself

    private static let recheckedText =
        "The last request ended without an answer. The list is up to date again: check whether the set is in the new channel, then publish again if it is not."
    private static let cannotCheckText =
        "The last request ended without an answer, and the list could not be read to see what it did. Pull to refresh the list, then publish again."
    private static let untouched = "Nothing was moved: the set is as it was. "

    /// Whether the request may have reached the server even though no answer came back.
    private func isUnknownOutcome(_ error: NetworkError) -> Bool {
        switch error {
        case .timeout, .unreachable, .transport, .decoding: true
        case .server(let status): [502, 503, 504].contains(status.code)
        default: false
        }
    }

    private func moveOnOldServer(draft: ReactionRoleMessage, body: ReactionRoleMessage) async -> SaveOutcome {
        var fresh = body
        fresh.id = ""
        fresh.messageId = ""
        // No room for a second set: free the place first.
        if reactionMessages.count >= maxSets { return await moveDeletingFirst(draft: draft, body: body) }

        let known = Set(reactionMessages.map(\.id))
        let created: ReactionRoleSaved
        do {
            created = try await session.send(Endpoints.SaveReactionRole(server: server, message: fresh))
        } catch {
            let error = NetworkError(error)
            guard error != .cancelled, error != .unauthorized else { return .ignored }
            if case .badRequest(let text) = error, text?.contains("maximum of") == true {
                return await moveDeletingFirst(draft: draft, body: body)
            }
            guard isUnknownOutcome(error) else {
                return .failed(Self.untouched + error.userMessage)
            }
            // It may have been created: look before offering a retry, so a retry cannot make a copy.
            guard await reloadList() else {
                needsRecheck = true
                return .failed(Self.cannotCheckText)
            }
            guard let found = copy(of: fresh, among: reactionMessages.filter { !known.contains($0.id) }) else {
                return .failed(Self.untouched + "The request timed out and the new set was not created. Try again.")
            }
            return await finishMove(
                draft: draft,
                created: ReactionRoleSaved(
                    reactionMessage: found, error: found.isPublished ? nil : "The post did not go through."))
        }
        return await finishMove(draft: draft, created: created)
    }

    /// The set the server made from `body`, among the sets that were not there before.
    private func copy(of body: ReactionRoleMessage, among candidates: [ReactionRoleMessage]) -> ReactionRoleMessage? {
        let wanted = body.pairs.filter { !$0.isBlank }.map(\.roleId)
        return candidates.first {
            $0.channelId == body.channelId && $0.message == body.message
                && $0.pairs.filter { !$0.isBlank }.map(\.roleId) == wanted
        }
    }

    /// The new set exists: when it was posted, delete the old set; when not, take the new draft away
    /// again so the old one stays the only copy.
    private func finishMove(draft: ReactionRoleMessage, created: ReactionRoleSaved) async -> SaveOutcome {
        guard let new = created.reactionMessage else {
            // An answer without the set: read the list to see where things stand.
            _ = await reloadList()
            return .failed(Self.untouched + "The server's answer did not say what it saved. Check the list.")
        }
        store(new)
        if let error = created.error, !new.isPublished {
            var text = Self.untouched
                + "The message could not be posted in the new channel, so it is still posted in the old one. \(error)"
            do {
                _ = try await session.send(Endpoints.DeleteReactionRole(server: server, id: new.id))
                reactionMessages.removeAll { $0.id == new.id }
            } catch {
                text += " A draft copy in the new channel could not be removed; delete it from the list."
            }
            return .failed(text)
        }
        do {
            _ = try await session.send(Endpoints.DeleteReactionRole(server: server, id: draft.id))
        } catch {
            let error = NetworkError(error)
            if error == .cancelled || error == .unauthorized { return .ignored }
            if isUnknownOutcome(error), await reloadList(), !reactionMessages.contains(where: { $0.id == draft.id }) {
                successCount += 1
                return .saved
            }
            return .movedOldRemains(
                "The message is posted in the new channel, but the old set could not be deleted, so the old message is still posted too. Delete the old set from the list. \(error.userMessage)")
        }
        reactionMessages.removeAll { $0.id == draft.id }
        successCount += 1
        return .saved
    }

    /// The set limit leaves no room for a second set: delete the old one first, then save the set again
    /// under its own id (the server takes a number it does not know), so a retry does the same thing and
    /// cannot make a copy.
    private func moveDeletingFirst(draft: ReactionRoleMessage, body: ReactionRoleMessage) async -> SaveOutcome {
        do {
            _ = try await session.send(Endpoints.DeleteReactionRole(server: server, id: draft.id))
        } catch {
            let error = NetworkError(error)
            guard error != .cancelled, error != .unauthorized else { return .ignored }
            guard isUnknownOutcome(error) else {
                return .failed(
                    "Couldn't remove the posted message from the old channel, so nothing was changed. "
                        + error.userMessage)
            }
            guard await reloadList() else {
                needsRecheck = true
                return .failed(Self.cannotCheckText)
            }
            if reactionMessages.contains(where: { $0.id == draft.id }) {
                return .failed(Self.untouched + "The request timed out. Try again.")
            }
            // It went through after all: carry on.
        }
        reactionMessages.removeAll { $0.id == draft.id }

        var again = body
        again.id = draft.id
        again.messageId = ""
        do {
            let saved = try await session.send(Endpoints.SaveReactionRole(server: server, message: again))
            store(saved.reactionMessage)
            successCount += 1
            if let error = saved.error { return .savedNotPosted(error) }
            return .saved
        } catch {
            let error = NetworkError(error)
            guard error != .cancelled, error != .unauthorized else {
                return .failedAfterRemoval(Self.removedText + "The request was cancelled.")
            }
            if isUnknownOutcome(error) {
                guard await reloadList() else {
                    needsRecheck = true
                    return .failedAfterRemoval(Self.removedText + Self.cannotCheckText)
                }
                if let back = reactionMessages.first(where: { $0.id == draft.id }) {
                    successCount += 1
                    return back.isPublished ? .saved : .savedNotPosted("The post did not go through.")
                }
            }
            return .failedAfterRemoval(Self.removedText + error.userMessage)
        }
    }

    private static let removedText =
        "The server was full, so the posted message was deleted from the old channel first, and saving the set in the new channel failed. It is not posted any more; what you see here is kept and the next publish puts it back. "

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
