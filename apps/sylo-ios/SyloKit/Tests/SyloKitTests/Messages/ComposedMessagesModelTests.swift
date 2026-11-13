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

    func clients() -> StubClients {
        StubClients { [self] endpoint in
            if endpoint is Endpoints.ListComposedMessages {
                lock.withLock { _calls.append("list") }
                return ComposedMessageList(items: lock.withLock { _items })
            }
            if let load = endpoint as? Endpoints.LoadComposedMessage {
                lock.withLock { _calls.append("load:\(load.id.pathComponent)") }
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
                if let error = lock.withLock({ _unpublishError }) { throw error }
                return try JSONDecoder().decode(
                    ComposedMessageRecord.self, from: Data(#"{"rec":{"id":3,"messageId":null}}"#.utf8))
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
