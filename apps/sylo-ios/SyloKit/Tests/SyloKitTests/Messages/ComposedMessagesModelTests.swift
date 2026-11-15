import Foundation
import Testing
@testable import SyloKit

/// The server's side of the embed messages for the model tests.
final class FakeMessagesServer: @unchecked Sendable {
    // @unchecked: every field is only touched while holding `lock`.
    private let lock = NSLock()
    private var _calls: [String] = []
    private var _message: ComposedMessage?
    private var _items: [ComposedMessageSummary]
    private var _publishError: NetworkError?
    private var _saveError: NetworkError?
    private var _unpublishError: NetworkError?
    private var _okAnswerError: String?
    private var _features: [ServerFeature]?
    private var _removesDespiteError = false
    private var _failLoad = false
    private let nextID = 5

    init(message: ComposedMessage? = nil, items: [ComposedMessageSummary] = []) {
        _message = message
        _items = items
    }

    var calls: [String] { lock.withLock { _calls } }
    var message: ComposedMessage? { lock.withLock { _message } }

    func failPublish(with error: NetworkError?) { lock.withLock { _publishError = error } }
    func failSave(with error: NetworkError?) { lock.withLock { _saveError = error } }
    func failUnpublish(with error: NetworkError?) { lock.withLock { _unpublishError = error } }
    func answerOK(withError text: String?) { lock.withLock { _okAnswerError = text } }
    func announce(_ features: [ServerFeature]?) { lock.withLock { _features = features } }
    /// The unpublish fails on the way back, after the server already removed the post.
    func removePostEvenWhenUnpublishFails(_ on: Bool) { lock.withLock { _removesDespiteError = on } }
    func failLoad(_ on: Bool) { lock.withLock { _failLoad = on } }

    func clients() -> StubClients {
        StubClients { [self] endpoint in
            if endpoint is Endpoints.ListComposedMessages {
                lock.withLock { _calls.append("list") }
                return ComposedMessageList(items: lock.withLock { _items })
            }
            if let load = endpoint as? Endpoints.LoadComposedMessage {
                lock.withLock { _calls.append("load:\(load.id.pathComponent)") }
                if lock.withLock({ _failLoad }) { throw NetworkError.timeout }
                let message = lock.withLock { _message } ?? ComposedMessage()
                return ComposedMessageDetail(
                    message: load.id == .new ? ComposedMessage() : message,
                    channels: [ChannelOption(id: "111111111111111111", name: "rules")])
            }
            if let saving = endpoint as? Endpoints.SaveComposedMessage {
                return try save(saving)
            }
            if let unpublish = endpoint as? Endpoints.UnpublishComposedMessage {
                lock.withLock { _calls.append("unpublish:\(unpublish.id)") }
                let failure = lock.withLock { _unpublishError }
                if let failure, !lock.withLock({ _removesDespiteError }) { throw failure }
                lock.withLock {
                    if let m = _message {
                        _message = ComposedMessage(
                            id: m.id, name: m.name, channelId: m.channelId, messageId: nil, spec: m.spec)
                    }
                }
                if let failure { throw failure }
                return try JSONDecoder().decode(
                    ComposedMessageRecord.self, from: Data(#"{"rec":{"id":3,"messageId":null}}"#.utf8))
            }
            if endpoint is Endpoints.ServerInfo {
                guard let features = lock.withLock({ _features }) else { throw NetworkError.notFound }
                return ServerInfo(features: features)
            }
            if let delete = endpoint as? Endpoints.DeleteComposedMessage {
                lock.withLock { _calls.append("delete:\(delete.id)") }
                return EmptyResponse()
            }
            throw NetworkError.notFound
        }
    }

    private func save(_ saving: Endpoints.SaveComposedMessage) throws -> ComposedSaveResult {
        lock.withLock { _calls.append("save:\(saving.id.pathComponent):\(saving.action.rawValue)") }
        if saving.action == .save, let error = lock.withLock({ _saveError }) { throw error }
        if saving.action == .publish, let error = lock.withLock({ _publishError }) { throw error }
        return lock.withLock {
            let existing = _message
            let id = existing?.id ?? nextID
            let hadPosted = existing?.isPublished ?? false
            let posted = saving.action == .publish ? "999999999999999999" : existing?.messageId
            let message = ComposedMessage(
                id: id, name: saving.name.isEmpty ? "Untitled embed" : saving.name, channelId: saving.channelId,
                messageId: posted, spec: saving.spec)
            _message = message
            if let text = _okAnswerError { return ComposedSaveResult(message: message, error: text) }
            let status: ComposedSaveStatus = saving.action == .save ? .saved : (hadPosted ? .updated : .sent)
            return ComposedSaveResult(message: message, status: status)
        }
    }
}

@MainActor
@Suite("Embed message builder")
struct ComposedMessageBuilderModelTests {
    func make(_ server: FakeMessagesServer, id: ComposedMessageID = .new) async -> ComposedMessageBuilderModel {
        let model = ComposedMessageBuilderModel(
            server: "9", id: id, session: makeSignedInSession(clients: server.clients()))
        await model.load()
        return model
    }

    static let posted = ComposedMessage(
        id: 3, name: "Rules", channelId: "111111111111111111", messageId: "222222222222222222",
        spec: ComposedMessageSpec(content: "Hi", embeds: [EmbedItem(EmbedDraft(title: "Rules"))]))

    @Test("a new message loads empty, with the channels, and editing it marks changes")
    func loadsNew() async {
        let server = FakeMessagesServer()
        let model = await make(server)
        #expect(model.hasLoaded)
        #expect(model.id == .new)
        #expect(model.channels.map(\.name) == ["rules"])
        #expect(!model.hasChanges)
        #expect(!model.canPublish)
        model.name = "Rules"
        #expect(model.hasChanges)
        model.discardChanges()
        #expect(!model.hasChanges)
        #expect(model.name.isEmpty)
    }

    @Test("a message that cannot be loaded says why")
    func loadFails() async {
        let session = makeSignedInSession(clients: StubClients { _ in throw NetworkError.notFound })
        let model = ComposedMessageBuilderModel(server: "9", id: .saved(1), session: session)
        await model.load()
        #expect(!model.hasLoaded)
        #expect(model.errorMessage != nil)
    }

    @Test("saving a new message keeps a draft and then edits that message, not a new one")
    func savesDraft() async {
        let server = FakeMessagesServer()
        let model = await make(server)
        model.channelId = "111111111111111111"
        model.spec.content = "Hello"

        #expect(await model.saveDraft())

        #expect(server.calls == ["load:new", "save:new:save"])
        #expect(model.id == .saved(5))
        // The server named it, and what is on screen is what it keeps.
        #expect(model.name == "Untitled embed")
        #expect(!model.hasChanges)
        #expect(model.notice == .saved)
        #expect(model.successCount == 1)

        model.spec.content = "Changed"
        #expect(model.hasChanges)
        #expect(await model.saveDraft())
        #expect(server.calls.last == "save:5:save")
    }

    @Test("publishing a new message saves it first, then posts it, and ends up as a posted message")
    func publishesNew() async {
        let server = FakeMessagesServer()
        let model = await make(server)
        model.name = "Rules"
        model.channelId = "111111111111111111"
        model.spec.embeds = [EmbedItem(EmbedDraft(title: "Rules"))]
        #expect(model.canPublish)

        #expect(await model.publish())

        #expect(server.calls == ["load:new", "save:new:save", "save:5:publish"])
        #expect(model.id == .saved(5))
        #expect(model.isPublished)
        #expect(model.notice == .published)
        #expect(!model.hasChanges)
        #expect(server.message?.isPublished == true)
    }

    @Test("publishing a message that is already posted edits it in place")
    func updatesPosted() async {
        let server = FakeMessagesServer(message: Self.posted)
        let model = await make(server, id: .saved(3))
        #expect(model.isPublished)
        model.spec.content = "Edited"

        #expect(await model.publish())

        #expect(server.calls == ["load:3", "save:3:publish"])
        #expect(model.notice == .updated)
        #expect(!model.hasChanges)
    }

    @Test("a post the server refuses shows its words, and a new message stays saved so a retry does not duplicate it")
    func publishFailsForNew() async {
        let server = FakeMessagesServer()
        server.failPublish(with: .badRequest(message: "The bot lacks View Channel / Send Messages / Embed Links there."))
        let model = await make(server)
        model.channelId = "111111111111111111"
        model.spec.content = "Hello"

        #expect(await model.publish() == false)

        #expect(model.actionError == "The bot lacks View Channel / Send Messages / Embed Links there.")
        #expect(model.failedAction == .publish)
        #expect(model.id == .saved(5))
        #expect(!model.isPublished)
        #expect(model.notice == nil)
        #expect(!model.isSaving)

        // The retry goes to the saved message.
        server.failPublish(with: nil)
        #expect(await model.publish())
        #expect(server.calls == ["load:new", "save:new:save", "save:5:publish", "save:5:publish"])
    }

    @Test("a failed save is a failed save, and the edits stay")
    func saveFails() async {
        let server = FakeMessagesServer()
        server.failSave(with: .badRequest(message: "You can keep at most 200 saved messages."))
        let model = await make(server)
        model.spec.content = "x"

        #expect(await model.saveDraft() == false)

        #expect(model.actionError == "You can keep at most 200 saved messages.")
        #expect(model.failedAction == .save)
        #expect(model.hasChanges)
        #expect(model.id == .new)
    }

    @Test("publishing a new message stops when the first save fails")
    func publishStopsAtSave() async {
        let server = FakeMessagesServer()
        server.failSave(with: .badRequest(message: "The message is too large to save."))
        let model = await make(server)
        model.channelId = "111111111111111111"

        #expect(await model.publish() == false)

        #expect(server.calls == ["load:new", "save:new:save"])
        #expect(model.failedAction == .save)
    }

    @Test("an error in a 2xx answer is a failure, not a success")
    func errorInOKAnswer() async {
        let server = FakeMessagesServer(message: Self.posted)
        server.answerOK(withError: "Nothing to send.")
        let model = await make(server, id: .saved(3))
        model.spec.content = "x"

        #expect(await model.publish() == false)

        #expect(model.actionError == "Nothing to send.")
        #expect(model.failedAction == .publish)
        #expect(model.notice == nil)
        #expect(model.hasChanges)
    }

    // MARK: Changing the channel of a posted message

    @Test("a posted message with another channel picked is a move, and it is not one before or after")
    func channelMove() async {
        let server = FakeMessagesServer(message: Self.posted)
        let model = await make(server, id: .saved(3))
        #expect(model.channelMove == nil)
        model.channelId = "333333333333333333"
        #expect(model.channelMove == ComposedMessageBuilderModel.ChannelMove(from: "111111111111111111", to: "333333333333333333"))
        model.discardChanges()
        #expect(model.channelMove == nil)

        // A draft can change channel freely.
        let draft = FakeMessagesServer(message: ComposedMessage(id: 3, name: "x", channelId: "111111111111111111"))
        let draftModel = await make(draft, id: .saved(3))
        draftModel.channelId = "333333333333333333"
        #expect(draftModel.channelMove == nil)
    }

    @Test("a move is not made without the person's confirmation")
    func moveNeedsConfirmation() async {
        let server = FakeMessagesServer(message: Self.posted)
        let model = await make(server, id: .saved(3))
        model.channelId = "333333333333333333"

        #expect(await model.publish() == false)
        #expect(await model.saveDraft() == false)

        #expect(server.calls == ["load:3"])
        #expect(model.failedAction == .move)
        #expect(model.actionError != nil)
        #expect(model.isPublished)
    }

    @Test("a confirmed move deletes the post in the old channel first, then saves and posts in the new one")
    func movesAndPublishes() async {
        let server = FakeMessagesServer(message: Self.posted)
        let model = await make(server, id: .saved(3))
        model.channelId = "333333333333333333"

        #expect(await model.publish(confirmedMove: true))

        #expect(server.calls == ["load:3", "unpublish:3", "save:3:publish"])
        #expect(model.isPublished)
        #expect(model.channelId == "333333333333333333")
        #expect(model.channelMove == nil)
        #expect(!model.hasChanges)
        #expect(model.notice == .published)
        #expect(model.actionError == nil)
    }

    @Test("a confirmed move can also just save the draft in the new channel")
    func movesAndSaves() async {
        let server = FakeMessagesServer(message: Self.posted)
        let model = await make(server, id: .saved(3))
        model.channelId = "333333333333333333"

        #expect(await model.saveDraft(confirmedMove: true))

        #expect(server.calls == ["load:3", "unpublish:3", "save:3:save"])
        #expect(!model.isPublished)
        #expect(model.notice == .saved)
        #expect(model.channelMove == nil)
    }

    @Test("when the old post cannot be deleted nothing else happens, and the message says nothing changed")
    func moveStopsAtUnpublish() async {
        let server = FakeMessagesServer(message: Self.posted)
        server.failUnpublish(with: .forbidden(message: "Sylo can't delete messages in that channel."))
        let model = await make(server, id: .saved(3))
        model.channelId = "333333333333333333"

        #expect(await model.publish(confirmedMove: true) == false)

        #expect(server.calls == ["load:3", "unpublish:3"])
        #expect(model.failedAction == .move)
        #expect(model.actionError?.contains("nothing was changed") == true)
        #expect(model.actionError?.contains("Sylo can't delete messages in that channel.") == true)
        #expect(model.isPublished)
        #expect(!model.isSaving)
        #expect(server.message?.channelId == "111111111111111111")
    }

    @Test("when posting in the new channel fails after the old post is gone, the message says where things stand and the retry does not delete again")
    func movePublishFails() async {
        let server = FakeMessagesServer(message: Self.posted)
        server.failPublish(with: .badRequest(message: "The bot lacks View Channel / Send Messages / Embed Links there."))
        let model = await make(server, id: .saved(3))
        model.channelId = "333333333333333333"

        #expect(await model.publish(confirmedMove: true) == false)

        #expect(model.failedAction == .publish)
        let text = model.actionError ?? ""
        #expect(text.contains("deleted in the old channel"))
        #expect(text.contains("The bot lacks View Channel / Send Messages / Embed Links there."))
        // The post is gone, so the screen shows a draft and no move is pending.
        #expect(!model.isPublished)
        #expect(model.channelMove == nil)

        server.failPublish(with: nil)
        #expect(await model.publish())
        #expect(server.calls == ["load:3", "unpublish:3", "save:3:publish", "save:3:publish"])
        #expect(model.isPublished)
    }

    @Test("a move followed by a failed save says the old post is gone and the draft is what is on screen")
    func moveThenSaveFails() async {
        let server = FakeMessagesServer(message: Self.posted)
        server.failSave(with: .badRequest(message: "The message is too large to save."))
        let model = await make(server, id: .saved(3))
        model.channelId = "333333333333333333"

        #expect(await model.saveDraft(confirmedMove: true) == false)

        #expect(server.calls == ["load:3", "unpublish:3", "save:3:save"])
        #expect(model.failedAction == .save)
        let text = model.actionError ?? ""
        #expect(text.contains("deleted in the old channel"))
        #expect(text.contains("saving it in the new channel failed"))
        #expect(text.contains("The message is too large to save."))
        #expect(!model.isPublished)
        #expect(model.channelMove == nil)
        #expect(model.hasChanges)
    }

    // MARK: A server that moves the post itself (message-move)

    @Test("with message-move, publishing in another channel is one publish and the server does the move")
    func serverMovesOnPublish() async {
        let server = FakeMessagesServer(message: Self.posted)
        server.announce([.appLogin, .messageMove])
        let model = await make(server, id: .saved(3))
        #expect(model.serverMovesMessages)
        model.channelId = "333333333333333333"
        #expect(model.channelMove != nil)

        // The person still has to agree.
        #expect(await model.publish() == false)
        #expect(model.failedAction == .move)
        #expect(server.calls == ["load:3"])

        #expect(await model.publish(confirmedMove: true))

        #expect(server.calls == ["load:3", "save:3:publish"])
        #expect(!server.calls.contains("unpublish:3"))
        #expect(model.isPublished)
        #expect(model.channelId == "333333333333333333")
        #expect(model.channelMove == nil)
        #expect(!model.hasChanges)
    }

    @Test("with message-move, a refused post keeps the old post and the move stays pending")
    func serverMoveRefused() async {
        let server = FakeMessagesServer(message: Self.posted)
        server.announce([.messageMove])
        server.failPublish(with: .badRequest(message: "The bot lacks View Channel / Send Messages / Embed Links there."))
        let model = await make(server, id: .saved(3))
        model.channelId = "333333333333333333"

        #expect(await model.publish(confirmedMove: true) == false)

        #expect(!server.calls.contains("unpublish:3"))
        #expect(model.failedAction == .publish)
        let text = model.actionError ?? ""
        #expect(text == "The bot lacks View Channel / Send Messages / Embed Links there.")
        // Nothing was deleted: the message is still posted, and the move can be asked again.
        #expect(model.isPublished)
        #expect(model.channelMove != nil)
    }

    @Test("with message-move, saving a draft in another channel still takes the old post down first")
    func serverMoveSaveKeepsClientFlow() async {
        let server = FakeMessagesServer(message: Self.posted)
        server.announce([.messageMove])
        let model = await make(server, id: .saved(3))
        model.channelId = "333333333333333333"

        #expect(await model.saveDraft(confirmedMove: true))

        #expect(server.calls.suffix(2) == ["unpublish:3", "save:3:save"])
        #expect(!model.isPublished)
    }

    @Test("without message-move, and when the server does not say, publishing deletes the old post first")
    func clientMoveWithoutTheFeature() async {
        for features in [nil, [ServerFeature.appLogin]] as [[ServerFeature]?] {
            let server = FakeMessagesServer(message: Self.posted)
            server.announce(features)
            let model = await make(server, id: .saved(3))
            #expect(!model.serverMovesMessages)
            model.channelId = "333333333333333333"

            #expect(await model.publish(confirmedMove: true))

            #expect(server.calls.suffix(2) == ["unpublish:3", "save:3:publish"])
        }
    }

    // MARK: An unpublish whose outcome is not known

    @Test("a timeout while removing the old post is not reported as nothing changed: the model asks and says the post is gone")
    func timeoutAfterRemoval() async {
        let server = FakeMessagesServer(message: Self.posted)
        server.failUnpublish(with: .timeout)
        server.removePostEvenWhenUnpublishFails(true)
        let model = await make(server, id: .saved(3))
        model.channelId = "333333333333333333"
        model.spec.content = "Edited while moving"

        #expect(await model.publish(confirmedMove: true) == false)

        let text = model.actionError ?? ""
        #expect(!text.contains("nothing was changed"))
        #expect(text.contains("the old post is gone"))
        #expect(model.failedAction == .move)
        // The state was read from the server, and the unsaved edits are still there.
        #expect(!model.isPublished)
        #expect(model.channelMove == nil)
        #expect(model.spec.content == "Edited while moving")
        #expect(model.channelId == "333333333333333333")
        #expect(server.calls == ["load:3", "unpublish:3", "load:3"])
    }

    @Test("a timeout when the post was not removed says it is still there")
    func timeoutBeforeRemoval() async {
        let server = FakeMessagesServer(message: Self.posted)
        server.failUnpublish(with: .timeout)
        let model = await make(server, id: .saved(3))
        model.channelId = "333333333333333333"

        #expect(await model.publish(confirmedMove: true) == false)

        let text = model.actionError ?? ""
        #expect(text.contains("still there"))
        #expect(model.isPublished)
        #expect(model.channelMove != nil)
    }

    @Test("when the model cannot ask after a timeout it says it does not know")
    func timeoutAndNoAnswer() async {
        let server = FakeMessagesServer(message: Self.posted)
        server.failUnpublish(with: .timeout)
        let model = await make(server, id: .saved(3))
        model.channelId = "333333333333333333"
        server.failLoad(true)

        #expect(await model.publish(confirmedMove: true) == false)

        let text = model.actionError ?? ""
        #expect(text.contains("Couldn't tell whether"))
        #expect(!text.contains("nothing was changed"))
        #expect(model.failedAction == .move)
    }

    @Test("publishing needs a channel")
    func needsChannel() async {
        let server = FakeMessagesServer(message: ComposedMessage(id: 3, name: "x"))
        let model = await make(server, id: .saved(3))
        #expect(!model.canPublish)
        #expect(await model.publish() == false)
        #expect(server.calls == ["load:3"])
        model.channelId = "111111111111111111"
        #expect(model.canPublish)
    }
}

@MainActor
@Suite("Embed messages list")
struct ComposedMessagesModelTests {
    static let items = [
        ComposedMessageSummary(id: 3, name: "Rules", channel: "rules", published: true, when: "5m ago"),
        ComposedMessageSummary(id: 4, name: "Giveaway", channel: "news", published: false, when: "2d ago"),
    ]

    func make(_ server: FakeMessagesServer) async -> ComposedMessagesModel {
        let model = ComposedMessagesModel(server: "9", session: makeSignedInSession(clients: server.clients()))
        await model.load()
        return model
    }

    @Test("the list loads and counts toward the limit")
    func loads() async {
        let model = await make(FakeMessagesServer(items: Self.items))
        #expect(model.hasLoaded)
        #expect(model.items.map(\.id) == [3, 4])
        #expect(!model.isFull)
        #expect(ComposedMessagesModel.maxMessages == 200)
    }

    @Test("unpublishing turns the row into a draft and keeps it")
    func unpublishes() async {
        let server = FakeMessagesServer(items: Self.items)
        let model = await make(server)

        #expect(await model.unpublish(3))

        #expect(server.calls == ["list", "unpublish:3"])
        #expect(model.items.map(\.id) == [3, 4])
        #expect(model.items[0].published == false)
        #expect(model.items[0].name == "Rules")
        #expect(model.items[0].channel == "rules")
        #expect(model.successCount == 1)
        #expect(model.busy.isEmpty)
    }

    @Test("deleting removes the row")
    func deletes() async {
        let server = FakeMessagesServer(items: Self.items)
        let model = await make(server)

        #expect(await model.delete(3))

        #expect(server.calls == ["list", "delete:3"])
        #expect(model.items.map(\.id) == [4])
    }

    @Test("an unpublish the server refuses shows its words and leaves the row as it was")
    func unpublishFails() async {
        let server = FakeMessagesServer(items: Self.items)
        server.failUnpublish(with: .forbidden(message: "Sylo can't delete messages in that channel."))
        let model = await make(server)

        #expect(await model.unpublish(3) == false)

        #expect(model.actionError == "Sylo can't delete messages in that channel.")
        #expect(model.items[0].published)
        #expect(model.busy.isEmpty)
    }

    @Test("a list that cannot be loaded says why")
    func loadFails() async {
        let session = makeSignedInSession(clients: StubClients { _ in throw NetworkError.forbidden })
        let model = ComposedMessagesModel(server: "9", session: session)
        await model.load()
        #expect(!model.hasLoaded)
        #expect(model.errorMessage != nil)
    }
}
