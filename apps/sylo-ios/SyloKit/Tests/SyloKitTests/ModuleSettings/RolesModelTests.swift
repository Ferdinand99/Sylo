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
    private var _deleteError: NetworkError?
    private var _autorolesError: NetworkError?
    private var _postError: String?
    private var _bodies: [ReactionRoleMessage] = []
    private var nextID = 100

    init(sets: [ReactionRoleMessage] = [], autoroles: [String] = []) {
        _sets = sets
        _autoroles = autoroles
    }

    var calls: [String] { lock.withLock { _calls } }
    var sets: [ReactionRoleMessage] { lock.withLock { _sets } }
    var autoroles: [String] { lock.withLock { _autoroles } }
    var bodies: [ReactionRoleMessage] { lock.withLock { _bodies } }

    func failSave(with error: NetworkError?) { lock.withLock { _saveError = error } }
    func failDelete(with error: NetworkError?) { lock.withLock { _deleteError = error } }
    func failAutoroles(with error: NetworkError?) { lock.withLock { _autorolesError = error } }
    func failPost(with text: String?) { lock.withLock { _postError = text } }

    func clients() -> StubClients {
        StubClients { [self] endpoint in
            if endpoint is Endpoints.LoadRoles {
                lock.withLock { _calls.append("load") }
                return lock.withLock {
                    RolesPage(
                        reactionMessages: _sets, autoroles: _autoroles,
                        channels: [ChannelOption(id: "c1", name: "roles"), ChannelOption(id: "c2", name: "info")],
                        roles: [RoleOption(id: "r1", name: "Gamer"), RoleOption(id: "r2", name: "Artist")])
                }
            }
            if endpoint is Endpoints.LoadGuildEmojis {
                lock.withLock { _calls.append("emojis") }
                return GuildEmojis(custom: [GuildEmoji(name: "gamer", display: "<:gamer:111>")])
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
        return lock.withLock {
            var stored = body
            if stored.id.isEmpty {
                stored.id = String(nextID)
                nextID += 1
            }
            stored.messageId = _postError == nil ? "m-\(stored.id)" : ""
            if let index = _sets.firstIndex(where: { $0.id == stored.id }) {
                _sets[index] = stored
            } else {
                _sets.append(stored)
            }
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

    func make(
        _ server: FakeRolesServer, movesMessages: Bool = false
    ) async -> RolesModel {
        let model = RolesModel(
            server: "9", session: makeSignedInSession(clients: server.clients()), serverMovesMessages: movesMessages)
        await model.load()
        return model
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

    @Test("a server without the emoji list still loads, with no custom emojis")
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
        #expect(server.calls.filter { $0.hasPrefix("save") || $0.hasPrefix("delete") } == ["save:2:c2"])
    }

    // MARK: - Moving a posted set

    @Test("a server with message-move gets the new channel in one save: it posts first and deletes after")
    func moveOnNewServer() async {
        let server = FakeRolesServer(sets: [Self.posted])
        let model = await make(server, movesMessages: true)
        var edit = Self.posted
        edit.channelId = "c2"
        #expect(model.channelMove(for: edit) == RolesModel.ChannelMove(from: "c1", to: "c2"))
        #expect(!model.needsMoveConfirmation(for: edit))
        #expect(await model.save(edit) == .saved)
        #expect(server.calls.filter { $0.hasPrefix("save") || $0.hasPrefix("delete") } == ["save:1:c2"])
        #expect(model.reactionMessages.map(\.id) == ["1"])
        #expect(model.reactionMessages[0].channelId == "c2")
    }

    @Test("an older server needs the person's yes first, then the app deletes the old set and saves a new one")
    func moveOnOldServer() async {
        let server = FakeRolesServer(sets: [Self.posted])
        let model = await make(server)
        var edit = Self.posted
        edit.channelId = "c2"
        #expect(model.needsMoveConfirmation(for: edit))

        #expect(await model.save(edit) == .needsConfirmation)
        #expect(server.calls.filter { $0.hasPrefix("save") || $0.hasPrefix("delete") }.isEmpty)

        #expect(await model.save(edit, confirmedMove: true) == .saved)
        #expect(server.calls.filter { $0.hasPrefix("save") || $0.hasPrefix("delete") } == ["delete:1", "save:new:c2"])
        #expect(model.reactionMessages.count == 1)
        #expect(model.reactionMessages[0].channelId == "c2")
        #expect(model.reactionMessages[0].id != "1")
        #expect(model.reactionMessages[0].isPublished)
    }

    @Test("an older server that refuses the delete changes nothing and no save is sent")
    func moveDeleteFails() async {
        let server = FakeRolesServer(sets: [Self.posted])
        server.failDelete(with: .server(status: 502))
        let model = await make(server)
        var edit = Self.posted
        edit.channelId = "c2"
        let outcome = await model.save(edit, confirmedMove: true)
        guard case .failed(let text) = outcome else {
            Issue.record("expected failed, got \(outcome)")
            return
        }
        #expect(text.hasPrefix("Couldn't remove the posted message from the old channel, so nothing was changed."))
        #expect(!server.calls.contains { $0.hasPrefix("save") })
        #expect(model.reactionMessages.map(\.id) == ["1"])
        #expect(model.reactionMessages[0].channelId == "c1")
    }

    @Test("when the save after the delete fails, the person is told the old message is gone")
    func moveSaveFails() async {
        let server = FakeRolesServer(sets: [Self.posted])
        server.failSave(with: .badRequest(message: "Pick a channel."))
        let model = await make(server)
        var edit = Self.posted
        edit.channelId = "c2"
        let outcome = await model.save(edit, confirmedMove: true)
        guard case .failedAfterRemoval(let text) = outcome else {
            Issue.record("expected failedAfterRemoval, got \(outcome)")
            return
        }
        #expect(text.contains("deleted from the old channel"))
        #expect(text.hasSuffix("Pick a channel."))
        #expect(model.reactionMessages.isEmpty)
        // The retry is a plain new set: no second delete.
        server.failSave(with: nil)
        var retry = edit
        retry.id = ""
        retry.messageId = ""
        #expect(await model.save(retry, confirmedMove: true) == .saved)
        #expect(server.calls.filter { $0.hasPrefix("delete") } == ["delete:1"])
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
