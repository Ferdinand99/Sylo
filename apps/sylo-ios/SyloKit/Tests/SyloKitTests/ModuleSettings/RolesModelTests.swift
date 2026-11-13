import Foundation
import Testing
@testable import SyloKit

/// The server's side of the reaction roles for the model tests.
final class FakeRolesServer: @unchecked Sendable {
    // @unchecked: every field is only touched while holding `lock`.
    private let lock = NSLock()
    private var _calls: [String] = []
    private var _sets: [ReactionRoleMessage]
    private var _autoroles: [String]
    private var _saveError: NetworkError?
    private var _saveNewError: NetworkError?
    private var _deleteError: NetworkError?
    private var _autorolesError: NetworkError?
    private var _postError: String?
    private var _bodies: [ReactionRoleMessage] = []
    private var _timeoutSaveStores = false
    private var _timeoutNextSave = false
    private var _timeoutNextDelete = false
    private var _timeoutDeleteRemoves = false
    private var _emojiFailures = 0
    private var _listFailures = 0
    private let info: ServerInfo?
    private let setLimit: Int?
    private let hideLimits: Bool
    private var nextID = 100

    /// `info`: what the server's info answers (nil: it fails). `setLimit`: the server's cap on sets.
    init(
        sets: [ReactionRoleMessage] = [], autoroles: [String] = [], info: ServerInfo? = nil, setLimit: Int? = nil,
        hideLimits: Bool = false
    ) {
        _sets = sets
        _autoroles = autoroles
        self.info = info
        self.setLimit = setLimit
        self.hideLimits = hideLimits
    }

    var calls: [String] { lock.withLock { _calls } }
    var sets: [ReactionRoleMessage] { lock.withLock { _sets } }
    var autoroles: [String] { lock.withLock { _autoroles } }
    var bodies: [ReactionRoleMessage] { lock.withLock { _bodies } }
    /// The calls that change sets, in order.
    var changes: [String] { calls.filter { $0.hasPrefix("save") || $0.hasPrefix("delete") } }

    func failSave(with error: NetworkError?) { lock.withLock { _saveError = error } }
    /// Fails only a save that makes a new set (an empty id).
    func failSaveNew(with error: NetworkError?) { lock.withLock { _saveNewError = error } }
    func failDelete(with error: NetworkError?) { lock.withLock { _deleteError = error } }
    func failAutoroles(with error: NetworkError?) { lock.withLock { _autorolesError = error } }
    func failPost(with text: String?) { lock.withLock { _postError = text } }
    /// The next save times out; `stores` says whether the server did it anyway.
    func timeoutNextSave(stores: Bool) {
        lock.withLock {
            _timeoutNextSave = true
            _timeoutSaveStores = stores
        }
    }
    /// The next delete times out; `removes` says whether the server did it anyway.
    func timeoutNextDelete(removes: Bool) {
        lock.withLock {
            _timeoutNextDelete = true
            _timeoutDeleteRemoves = removes
        }
    }
    /// The emoji list fails this many times, then works.
    func failEmojis(times: Int) { lock.withLock { _emojiFailures = times } }
    /// The list fails this many times, then works.
    func failList(times: Int) { lock.withLock { _listFailures = times } }

    func clients() -> StubClients {
        StubClients { [self] endpoint in
            if endpoint is Endpoints.LoadRoles {
                lock.withLock { _calls.append("load") }
                if lock.withLock({ _listFailures > 0 }) {
                    lock.withLock { _listFailures -= 1 }
                    throw NetworkError.timeout
                }
                return lock.withLock {
                    RolesPage(
                        reactionMessages: _sets, autoroles: _autoroles,
                        channels: [ChannelOption(id: "c1", name: "roles"), ChannelOption(id: "c2", name: "info")],
                        roles: [RoleOption(id: "r1", name: "Gamer"), RoleOption(id: "r2", name: "Artist")])
                }
            }
            if endpoint is Endpoints.LoadGuildEmojis {
                lock.withLock { _calls.append("emojis") }
                if lock.withLock({ _emojiFailures > 0 }) {
                    lock.withLock { _emojiFailures -= 1 }
                    throw NetworkError.server(status: 503)
                }
                return GuildEmojis(custom: [GuildEmoji(name: "gamer", display: "<:gamer:111>")])
            }
            if endpoint is Endpoints.ServerInfo {
                lock.withLock { _calls.append("info") }
                guard let info else { throw NetworkError.notFound }
                return info
            }
            if endpoint is Endpoints.LoadModuleLimits {
                guard let setLimit, !hideLimits else { throw NetworkError.notFound }
                return AllModuleLimits(modules: [
                    "roles": ModuleFieldLimits(["reactionMessages": FieldLimit(maxItems: setLimit)]),
                ])
            }
            if let saving = endpoint as? Endpoints.SaveAutoroles {
                lock.withLock { _calls.append("autoroles:\(saving.autoroles.joined(separator: ","))") }
                if let error = lock.withLock({ _autorolesError }) { throw error }
                lock.withLock { _autoroles = saving.autoroles }
                return AutorolesSaved(autoroles: saving.autoroles)
            }
            if let saving = endpoint as? Endpoints.SaveReactionRole {
                return try save(saving.message)
            }
            if let deleting = endpoint as? Endpoints.DeleteReactionRole {
                lock.withLock { _calls.append("delete:\(deleting.id)") }
                if lock.withLock({ _timeoutNextDelete }) {
                    lock.withLock {
                        _timeoutNextDelete = false
                        if _timeoutDeleteRemoves { _sets.removeAll { $0.id == deleting.id } }
                    }
                    throw NetworkError.timeout
                }
                if let error = lock.withLock({ _deleteError }) { throw error }
                lock.withLock { _sets.removeAll { $0.id == deleting.id } }
                return EmptyResponse()
            }
            throw NetworkError.notFound
        }
    }

    private func save(_ body: ReactionRoleMessage) throws -> ReactionRoleSaved {
        lock.withLock { _calls.append("save:\(body.id.isEmpty ? "new" : body.id):\(body.channelId)") }
        lock.withLock { _bodies.append(body) }
        if let error = lock.withLock({ _saveError }) { throw error }
        if body.id.isEmpty, let error = lock.withLock({ _saveNewError }) { throw error }
        let timeout = lock.withLock { () -> Bool in
            let flag = _timeoutNextSave
            _timeoutNextSave = false
            return flag
        }
        return try lock.withLock {
            let existing = _sets.first { $0.id == body.id }
            // The server's own cap on sets, in its own words.
            if existing == nil, let setLimit, _sets.count >= setLimit {
                throw NetworkError.badRequest(
                    message: "This server already has the maximum of \(setLimit) reaction-role messages.")
            }
            var stored = body
            if stored.id.isEmpty {
                stored.id = String(nextID)
                nextID += 1
            }
            if _postError == nil {
                stored.messageId = "m-\(stored.id)"
            } else if let existing, existing.isPublished {
                // A failed post leaves the old message where it is, in the old channel.
                stored.channelId = existing.channelId
                stored.messageId = existing.messageId
            } else {
                stored.messageId = ""
            }
            if !timeout || _timeoutSaveStores {
                if let index = _sets.firstIndex(where: { $0.id == stored.id }) {
                    _sets[index] = stored
                } else {
                    _sets.append(stored)
                }
            }
            if timeout { throw NetworkError.timeout }
            return ReactionRoleSaved(reactionMessage: stored, error: _postError)
        }
    }
}

@MainActor
@Suite("Reaction roles model")
struct RolesModelTests {
    static let posted = ReactionRoleMessage(
        id: "1", channelId: "c1", messageId: "m1", style: "buttons", message: "Pick!",
        pairs: [ReactionRolePair(emoji: "🎮", label: "Gamer", roleId: "r1")])

    static let draftSet = ReactionRoleMessage(
        id: "2", channelId: "c1", messageId: "", style: "reaction",
        pairs: [ReactionRolePair(emoji: "🎨", roleId: "r2")])

    /// The server announces `message-move`.
    static let movingInfo = ServerInfo(features: [.appLogin, .liveAccess, .messageMove])

    func make(_ server: FakeRolesServer) async -> RolesModel {
        let model = RolesModel(server: "9", session: makeSignedInSession(clients: server.clients()))
        await model.load()
        return model
    }

    /// The posted set moved to another channel.
    static var moved: ReactionRoleMessage {
        var edit = posted
        edit.channelId = "c2"
        return edit
    }

    @Test("loading fills the sets, autoroles, channels, roles and the server's emojis")
    func loads() async {
        let server = FakeRolesServer(sets: [Self.posted, Self.draftSet], autoroles: ["r1"])
        let model = await make(server)
        #expect(model.hasLoaded)
        #expect(model.reactionMessages.map(\.id) == ["1", "2"])
        #expect(model.autoroles == ["r1"])
        #expect(!model.autorolesChanged)
        #expect(model.channels.map(\.name) == ["roles", "info"])
        #expect(model.roles.map(\.name) == ["Gamer", "Artist"])
        #expect(model.customEmojis.map(\.name) == ["gamer"])
        #expect(model.hasEmojiList)
        // No limits from the server: the fixed ones.
        #expect(model.maxSets == 50)
        #expect(model.maxAutoroles == 100)
        #expect(model.pairsLimit == nil)
        #expect(model.canAddSet)
    }

    @Test("a page that cannot be loaded says why, and the emoji list is not needed")
    func loadFails() async {
        let session = makeSignedInSession(clients: StubClients { _ in throw NetworkError.notFound })
        let model = RolesModel(server: "9", session: session)
        await model.load()
        #expect(!model.hasLoaded)
        #expect(model.errorMessage != nil)
        #expect(model.customEmojis.isEmpty)
    }

    @Test("a server without the emoji list still loads, with no custom emojis, and is not asked again")
    func noEmojiList() async {
        let session = makeSignedInSession(clients: StubClients { endpoint in
            if endpoint is Endpoints.LoadGuildEmojis { throw NetworkError.notFound }
            if endpoint is Endpoints.LoadRoles { return RolesPage() }
            throw NetworkError.notFound
        })
        let model = RolesModel(server: "9", session: session)
        await model.load()
        #expect(model.hasLoaded)
        #expect(model.customEmojis.isEmpty)
        #expect(!model.hasEmojiList)
    }

    @Test("a failed emoji list is asked again when the editor opens")
    func emojiRetry() async {
        let server = FakeRolesServer()
        server.failEmojis(times: 1)
        let model = await make(server)
        #expect(!model.hasEmojiList)
        #expect(model.customEmojis.isEmpty)
        await model.prepare()
        #expect(model.hasEmojiList)
        #expect(model.customEmojis.map(\.name) == ["gamer"])
        #expect(server.calls.filter { $0 == "emojis" }.count == 2)
        // Once it is read it is not asked again.
        await model.prepare()
        #expect(server.calls.filter { $0 == "emojis" }.count == 2)
    }

    @Test("without the emoji list a :shortcode: does not block Publish, and is sent as typed")
    func shortcodeWithoutList() async {
        let server = FakeRolesServer()
        server.failEmojis(times: 5)
        let model = await make(server)
        let draft = ReactionRoleMessage(
            channelId: "c1", style: "reaction", pairs: [ReactionRolePair(emoji: ":gamer:", roleId: "r1")])
        #expect(draft.problems(customEmojis: model.customEmojis, emojiListKnown: model.hasEmojiList).isEmpty)
        #expect(draft.hasUncheckedShortcode(listKnown: model.hasEmojiList))
        #expect(await model.save(draft) == .saved)
        #expect(server.bodies.first?.pairs.first?.emoji == ":gamer:")
        // With the list, a name it does not have is still a problem.
        #expect(!draft.problems(customEmojis: [], emojiListKnown: true).isEmpty)
        #expect(!draft.hasUncheckedShortcode(listKnown: true))
    }

    // MARK: - Autoroles

    @Test("autoroles save sends the list and takes the server's answer")
    func savesAutoroles() async {
        let server = FakeRolesServer(autoroles: ["r1"])
        let model = await make(server)
        model.autoroles = ["r1", "r2"]
        #expect(model.autorolesChanged)
        #expect(await model.saveAutoroles())
        #expect(server.autoroles == ["r1", "r2"])
        #expect(!model.autorolesChanged)
        #expect(model.successCount == 1)
        // Nothing to save the second time: no call.
        let before = server.calls.count
        #expect(await model.saveAutoroles())
        #expect(server.calls.count == before)
    }

    @Test("a refused autoroles save keeps the edits and shows the server's words")
    func autorolesRefused() async {
        let server = FakeRolesServer(autoroles: [])
        server.failAutoroles(
            with: .forbidden(message: "Admin is above or equal to your highest role, so you can't hand it out."))
        let model = await make(server)
        model.autoroles = ["r1"]
        #expect(!(await model.saveAutoroles()))
        #expect(model.actionError == "Admin is above or equal to your highest role, so you can't hand it out.")
        #expect(model.autoroles == ["r1"])
        #expect(model.autorolesChanged)
        model.discardAutoroles()
        #expect(!model.autorolesChanged)
    }

    @Test("a reload keeps unsaved autoroles edits")
    func reloadKeepsEdits() async {
        let server = FakeRolesServer(autoroles: ["r1"])
        let model = await make(server)
        model.autoroles = ["r2"]
        await model.load()
        #expect(model.autoroles == ["r2"])
        #expect(model.autorolesChanged)
    }

    // MARK: - Saving a set

    @Test("a new set is saved with an empty id and posted; a shortcode becomes the emoji it names")
    func savesNewSet() async {
        let server = FakeRolesServer()
        let model = await make(server)
        let draft = ReactionRoleMessage(
            channelId: "c1", style: "reaction", pairs: [ReactionRolePair(emoji: ":gamer:", roleId: "r1")])
        let outcome = await model.save(draft)
        #expect(outcome == .saved)
        #expect(server.calls.contains("save:new:c1"))
        #expect(server.bodies.first?.pairs.first?.emoji == "<:gamer:111>")
        #expect(model.reactionMessages.count == 1)
        #expect(model.reactionMessages[0].isPublished)
        #expect(model.successCount == 1)
    }

    @Test("a post that fails still saves the set as a draft, with the server's reason")
    func postFails() async {
        let server = FakeRolesServer()
        server.failPost(with: "Missing Permissions")
        let model = await make(server)
        let outcome = await model.save(
            ReactionRoleMessage(channelId: "c1", pairs: [ReactionRolePair(emoji: "🎮", roleId: "r1")]))
        #expect(outcome == .savedNotPosted("Missing Permissions"))
        #expect(model.reactionMessages.count == 1)
        #expect(!model.reactionMessages[0].isPublished)
    }

    @Test("a role the person may not hand out is refused with the server's words, and nothing is added")
    func roleGrantRefused() async {
        let server = FakeRolesServer()
        server.failSave(with: .forbidden(message: "Gamer is above or equal to your highest role, so you can't hand it out."))
        let model = await make(server)
        let outcome = await model.save(
            ReactionRoleMessage(channelId: "c1", pairs: [ReactionRolePair(emoji: "🎮", roleId: "r1")]))
        #expect(outcome == .failed("Gamer is above or equal to your highest role, so you can't hand it out."))
        #expect(model.reactionMessages.isEmpty)
        #expect(model.successCount == 0)
    }

    @Test("a draft set that changes channel is saved in one call, with no delete")
    func draftChannelChange() async {
        let server = FakeRolesServer(sets: [Self.draftSet])
        let model = await make(server)
        var edit = Self.draftSet
        edit.channelId = "c2"
        #expect(model.channelMove(for: edit) == nil)
        #expect(await model.save(edit) == .saved)
        #expect(server.changes == ["save:2:c2"])
    }

    // MARK: - Moving a posted set: a server that does it itself

    @Test("a server that announces message-move gets one save, and no delete")
    func moveOnNewServer() async {
        let server = FakeRolesServer(sets: [Self.posted], info: Self.movingInfo)
        let model = await make(server)
        let edit = Self.moved
        #expect(model.serverMovesMessages)
        #expect(model.channelMove(for: edit) == RolesModel.ChannelMove(from: "c1", to: "c2"))
        #expect(!model.needsMoveConfirmation(for: edit))
        #expect(await model.save(edit) == .saved)
        #expect(server.changes == ["save:1:c2"])
        #expect(model.reactionMessages.map(\.id) == ["1"])
        #expect(model.reactionMessages[0].channelId == "c2")
    }

    @Test("the feature is read from the server when the cached info is empty, as after a relaunch")
    func featureFromServerNotCache() async {
        // The session never saw the server's info (no sign-in), so only the endpoint can tell.
        let server = FakeRolesServer(sets: [Self.posted], info: Self.movingInfo)
        let session = makeSignedInSession(clients: server.clients())
        #expect(session.serverInfo == nil)
        let model = RolesModel(server: "9", session: session)
        await model.load()
        #expect(model.serverMovesMessages)
        #expect(await model.save(Self.moved) == .saved)
        #expect(!server.calls.contains { $0.hasPrefix("delete") })
        #expect(server.changes == ["save:1:c2"])
    }

    @Test("a save that starts before the feature was read asks for it first")
    func featureReadAtSave() async {
        let server = FakeRolesServer(sets: [Self.posted], info: Self.movingInfo)
        let model = RolesModel(server: "9", session: makeSignedInSession(clients: server.clients()))
        // Not loaded at all: the set is unknown, so this is a plain save, but the flag is asked for.
        _ = await model.save(Self.moved)
        #expect(server.calls.contains("info"))
    }

    @Test("a server without the feature in its info is treated as an older one")
    func noFeature() async {
        let server = FakeRolesServer(sets: [Self.posted], info: ServerInfo(features: [.appLogin]))
        let model = await make(server)
        #expect(!model.serverMovesMessages)
        #expect(model.needsMoveConfirmation(for: Self.moved))
    }

    @Test("a failed post in a server-side move leaves the message posted in the old channel")
    func serverMoveNotPosted() async {
        let server = FakeRolesServer(sets: [Self.posted], info: Self.movingInfo)
        server.failPost(with: "Missing Access")
        let model = await make(server)
        let outcome = await model.save(Self.moved)
        #expect(outcome == .stillPosted("Missing Access", moved: true))
        #expect(model.reactionMessages[0].channelId == "c1")
        #expect(model.reactionMessages[0].isPublished)
    }

    @Test("a failed edit without a move says the posted message was not updated")
    func editNotPosted() async {
        let server = FakeRolesServer(sets: [Self.posted], info: Self.movingInfo)
        server.failPost(with: "Missing Access")
        let model = await make(server)
        var edit = Self.posted
        edit.message = "New text"
        #expect(await model.save(edit) == .stillPosted("Missing Access", moved: false))
    }

    // MARK: - Moving a posted set: an older server

    @Test("an older server needs the person's yes first")
    func moveNeedsConfirmation() async {
        let server = FakeRolesServer(sets: [Self.posted])
        let model = await make(server)
        #expect(model.needsMoveConfirmation(for: Self.moved))
        #expect(await model.save(Self.moved) == .needsConfirmation)
        #expect(server.changes.isEmpty)
    }

    @Test("an older server gets the new set first and the old one deleted after that")
    func moveSavesFirst() async {
        let server = FakeRolesServer(sets: [Self.posted])
        let model = await make(server)
        #expect(await model.save(Self.moved, confirmedMove: true) == .saved)
        #expect(server.changes == ["save:new:c2", "delete:1"])
        #expect(model.reactionMessages.count == 1)
        #expect(model.reactionMessages[0].channelId == "c2")
        #expect(model.reactionMessages[0].id != "1")
        #expect(model.reactionMessages[0].isPublished)
        #expect(server.sets.map(\.id) == model.reactionMessages.map(\.id))
    }

    @Test("a refused new set (a 403 for a role) leaves the old set as it was, and no delete is sent")
    func moveSaveRefused() async {
        let server = FakeRolesServer(sets: [Self.posted])
        server.failSaveNew(with: .forbidden(message: "Gamer is above or equal to your highest role, so you can't hand it out."))
        let model = await make(server)
        let outcome = await model.save(Self.moved, confirmedMove: true)
        guard case .failed(let text) = outcome else {
            Issue.record("expected failed, got \(outcome)")
            return
        }
        #expect(text.hasPrefix("Nothing was moved"))
        #expect(text.hasSuffix("Gamer is above or equal to your highest role, so you can't hand it out."))
        #expect(server.changes == ["save:new:c2"])
        #expect(model.reactionMessages.map(\.id) == ["1"])
        #expect(model.reactionMessages[0].channelId == "c1")
        #expect(model.reactionMessages[0].isPublished)
    }

    @Test("a rate limit on the new set changes nothing either")
    func moveRateLimited() async {
        let server = FakeRolesServer(sets: [Self.posted])
        server.failSaveNew(with: .rateLimited)
        let model = await make(server)
        let outcome = await model.save(Self.moved, confirmedMove: true)
        guard case .failed(let text) = outcome else {
            Issue.record("expected failed, got \(outcome)")
            return
        }
        #expect(text.contains("Too many requests"))
        #expect(server.changes == ["save:new:c2"])
        #expect(server.sets.map(\.id) == ["1"])
    }

    @Test("a new set that cannot be posted is taken away again, and the old message stays")
    func moveNotPosted() async {
        let server = FakeRolesServer(sets: [Self.posted])
        server.failPost(with: "Missing Access")
        let model = await make(server)
        let outcome = await model.save(Self.moved, confirmedMove: true)
        guard case .failed(let text) = outcome else {
            Issue.record("expected failed, got \(outcome)")
            return
        }
        #expect(text.contains("still posted in the old one"))
        #expect(text.contains("Missing Access"))
        #expect(server.changes == ["save:new:c2", "delete:100"])
        #expect(model.reactionMessages.map(\.id) == ["1"])
        #expect(server.sets.map(\.id) == ["1"])
    }

    @Test("when the old set cannot be deleted, both exist and the person is told")
    func moveDeleteFails() async {
        let server = FakeRolesServer(sets: [Self.posted])
        server.failDelete(with: .server(status: 500))
        let model = await make(server)
        let outcome = await model.save(Self.moved, confirmedMove: true)
        guard case .movedOldRemains(let text) = outcome else {
            Issue.record("expected movedOldRemains, got \(outcome)")
            return
        }
        #expect(text.contains("Delete the old set from the list"))
        #expect(model.reactionMessages.map(\.id) == ["1", "100"])
        #expect(model.reactionMessages[1].channelId == "c2")
        #expect(server.sets.count == 2)
    }

    @Test("a timeout on the new set that did not reach the server is a plain failure, then a retry works with no copy")
    func moveSaveTimeoutNotStored() async {
        let server = FakeRolesServer(sets: [Self.posted])
        server.timeoutNextSave(stores: false)
        let model = await make(server)
        let outcome = await model.save(Self.moved, confirmedMove: true)
        guard case .failed(let text) = outcome else {
            Issue.record("expected failed, got \(outcome)")
            return
        }
        #expect(text.contains("was not created"))
        // The list was read again to look.
        #expect(server.calls.filter { $0 == "load" }.count == 2)
        #expect(server.changes == ["save:new:c2"])

        #expect(await model.save(Self.moved, confirmedMove: true) == .saved)
        #expect(server.sets.count == 1)
        #expect(server.sets[0].channelId == "c2")
        #expect(server.changes == ["save:new:c2", "save:new:c2", "delete:1"])
    }

    @Test("a timeout on the new set that the server stored carries on to the delete, with no copy")
    func moveSaveTimeoutStored() async {
        let server = FakeRolesServer(sets: [Self.posted])
        server.timeoutNextSave(stores: true)
        let model = await make(server)
        #expect(await model.save(Self.moved, confirmedMove: true) == .saved)
        #expect(server.changes == ["save:new:c2", "delete:1"])
        #expect(server.sets.count == 1)
        #expect(server.sets[0].channelId == "c2")
        #expect(model.reactionMessages.map(\.id) == server.sets.map(\.id))
    }

    @Test("a timeout when the list cannot be read afterwards blocks a retry until the list is read")
    func moveTimeoutThenListFails() async {
        let server = FakeRolesServer(sets: [Self.posted])
        let model = await make(server)
        server.timeoutNextSave(stores: true)
        server.failList(times: 1)
        let outcome = await model.save(Self.moved, confirmedMove: true)
        guard case .failed(let text) = outcome else {
            Issue.record("expected failed, got \(outcome)")
            return
        }
        #expect(text.contains("could not be read"))
        // The next publish reads the list first and does not send another save.
        let again = await model.save(Self.moved, confirmedMove: true)
        guard case .failed = again else {
            Issue.record("expected failed, got \(again)")
            return
        }
        #expect(server.changes == ["save:new:c2"])
        #expect(model.reactionMessages.contains { $0.channelId == "c2" })
    }

    @Test("a timeout on the delete of the old set: gone means done, still there means both exist")
    func moveDeleteTimeout() async {
        let removed = FakeRolesServer(sets: [Self.posted])
        let model = await make(removed)
        removed.timeoutNextDelete(removes: true)
        #expect(await model.save(Self.moved, confirmedMove: true) == .saved)
        #expect(removed.sets.count == 1)

        let kept = FakeRolesServer(sets: [Self.posted])
        let other = await make(kept)
        kept.timeoutNextDelete(removes: false)
        let outcome = await other.save(Self.moved, confirmedMove: true)
        guard case .movedOldRemains = outcome else {
            Issue.record("expected movedOldRemains, got \(outcome)")
            return
        }
        #expect(kept.sets.count == 2)
    }

    // MARK: - Moving when the server is full

    @Test("at the set limit the old set is deleted first and saved again under its own id")
    func moveAtTheCap() async {
        let server = FakeRolesServer(sets: [Self.posted], setLimit: 1)
        let model = await make(server)
        #expect(model.maxSets == 1)
        #expect(await model.save(Self.moved, confirmedMove: true) == .saved)
        #expect(server.changes == ["delete:1", "save:1:c2"])
        #expect(model.reactionMessages.map(\.id) == ["1"])
        #expect(model.reactionMessages[0].channelId == "c2")
        #expect(model.reactionMessages[0].isPublished)
    }

    @Test("a server that answers 400 with its cap while the app saw no limit falls back too")
    func moveCapAnswer() async {
        // The app could not read the limits (it assumes 50); the server's own cap is 1.
        let server = FakeRolesServer(sets: [Self.posted], setLimit: 1, hideLimits: true)
        let model = await make(server)
        #expect(model.maxSets == 50)
        #expect(await model.save(Self.moved, confirmedMove: true) == .saved)
        #expect(server.changes == ["save:new:c2", "delete:1", "save:1:c2"])
    }

    @Test("at the cap, a delete that fails changes nothing and no save is sent")
    func capDeleteFails() async {
        let server = FakeRolesServer(sets: [Self.posted], setLimit: 1)
        server.failDelete(with: .server(status: 500))
        let model = await make(server)
        let outcome = await model.save(Self.moved, confirmedMove: true)
        guard case .failed(let text) = outcome else {
            Issue.record("expected failed, got \(outcome)")
            return
        }
        #expect(text.hasPrefix("Couldn't remove the posted message from the old channel, so nothing was changed."))
        #expect(server.changes == ["delete:1"])
        #expect(model.reactionMessages.map(\.id) == ["1"])
    }

    @Test("at the cap, a save that fails after the delete keeps the id, and the retry puts the set back")
    func capSaveFails() async {
        let server = FakeRolesServer(sets: [Self.posted], setLimit: 1)
        server.failSave(with: .forbidden(message: "Gamer is above or equal to your highest role, so you can't hand it out."))
        let model = await make(server)
        let outcome = await model.save(Self.moved, confirmedMove: true)
        guard case .failedAfterRemoval(let text) = outcome else {
            Issue.record("expected failedAfterRemoval, got \(outcome)")
            return
        }
        #expect(text.contains("deleted from the old channel first"))
        #expect(text.hasSuffix("Gamer is above or equal to your highest role, so you can't hand it out."))
        #expect(model.reactionMessages.isEmpty)

        // The sheet keeps the set under its id with no message: the retry is a plain save.
        server.failSave(with: nil)
        var retry = Self.moved
        retry.messageId = ""
        #expect(model.channelMove(for: retry) == nil)
        #expect(await model.save(retry) == .saved)
        #expect(server.changes == ["delete:1", "save:1:c2", "save:1:c2"])
        #expect(server.sets.map(\.id) == ["1"])
    }

    @Test("at the cap, a timeout on the save is checked in the list, so no copy is made")
    func capSaveTimeout() async {
        let server = FakeRolesServer(sets: [Self.posted], setLimit: 1)
        let model = await make(server)
        server.timeoutNextSave(stores: true)
        #expect(await model.save(Self.moved, confirmedMove: true) == .saved)
        #expect(server.sets.map(\.id) == ["1"])
        #expect(server.sets[0].channelId == "c2")
    }

    // MARK: - Deleting

    @Test("deleting a set removes it from the list")
    func deletes() async {
        let server = FakeRolesServer(sets: [Self.posted, Self.draftSet])
        let model = await make(server)
        #expect(await model.delete("1"))
        #expect(model.reactionMessages.map(\.id) == ["2"])
        #expect(server.calls.contains("delete:1"))
        #expect(model.successCount == 1)
    }

    @Test("a refused delete keeps the set and says why")
    func deleteFails() async {
        let server = FakeRolesServer(sets: [Self.posted])
        server.failDelete(with: .forbidden(message: "Only the server owner can do this."))
        let model = await make(server)
        #expect(!(await model.delete("1")))
        #expect(model.reactionMessages.count == 1)
        #expect(model.actionError == "Only the server owner can do this.")
    }
}
