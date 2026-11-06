import Foundation
import Testing
@testable import SyloKit

/// Holds a stubbed call until the test lets it go.
actor TestGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release() {
        isOpen = true
        waiters.forEach { $0.resume() }
        waiters = []
    }
}

@Suite("Embed message guards")
struct EmbedMessageGuardTests {
    static let otherChannel = "333333333333333333"

    @MainActor
    @Test("a posted message cannot be saved or updated while another channel is chosen")
    func channelChangeIsBlocked() async throws {
        let clients = ComposedMessageModelTests.clients()
        let model = ComposedMessageEditorModel(server: "1", session: makeSignedInSession(clients: clients), id: 7)
        await model.load()
        #expect(model.isPublished)
        #expect(model.channelChangeProblem == nil)
        #expect(model.canPublish)

        model.channelId = Self.otherChannel
        model.draft.content = "Changed"
        #expect(model.channelChangeProblem == "Unpublish first, then pick the new channel.")
        #expect(!model.canPublish)
        #expect(!model.canSaveDraft)
        #expect(await model.saveDraft() == false)
        #expect(model.actionError == "Unpublish first, then pick the new channel.")
        #expect(await model.publish() == false)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.SaveComposedMessage })

        // Picking the old channel again lifts the block.
        model.channelId = "222222222222222222"
        #expect(model.channelChangeProblem == nil)
        #expect(model.canSaveDraft)
    }

    @MainActor
    @Test("taking the message down lets the new channel be saved and published")
    func unpublishThenChange() async {
        let clients = ComposedMessageModelTests.clients()
        let model = ComposedMessageEditorModel(server: "1", session: makeSignedInSession(clients: clients), id: 7)
        await model.load()
        model.channelId = Self.otherChannel
        #expect(await model.unpublish())
        #expect(!model.isPublished)
        #expect(model.channelChangeProblem == nil)
        #expect(model.canSaveDraft)
        #expect(clients.calls.last?.endpoint is Endpoints.UnpublishComposedMessage)
        // The channel that was picked is still there.
        #expect(model.channelId == Self.otherChannel)
        #expect(await model.publish())
        let saves = clients.calls.compactMap { $0.endpoint as? Endpoints.SaveComposedMessage }
        #expect(saves.map(\.channelId) == [Self.otherChannel])
        #expect(saves.map(\.publish) == [true])
    }

    @MainActor
    @Test("a draft may change channel freely")
    func draftChannel() async {
        let model = ComposedMessageEditorModel(
            server: "1", session: makeSignedInSession(clients: ComposedMessageModelTests.clients()), id: nil)
        await model.load()
        model.channelId = Self.otherChannel
        model.draft.content = "x"
        #expect(model.channelChangeProblem == nil)
        #expect(model.canSaveDraft)
    }

    @Test("embed text is counted across all embeds against Discord's 6000")
    func characterTotal() {
        var draft = ComposedMessageDraft(content: String(repeating: "c", count: 2000))
        // Message text is not part of the embed limit.
        #expect(draft.embedCharacterCount == 0)
        var first = EmbedSpec(title: "abc", description: "defg", authorName: "hi", footerText: "jkl")
        first.fields = [
            EmbedSpec.Field(name: "n", value: "vv"),
            // Left out by the server: nothing in it.
            EmbedSpec.Field(),
        ]
        #expect(first.characterCount == 3 + 4 + 2 + 3 + 3)
        draft.embeds = [first, EmbedSpec(description: String(repeating: "a", count: 4096))]
        #expect(draft.embedCharacterCount == 15 + 4096)
        #expect(draft.embedCharactersOver == 0)
        draft.embeds.append(EmbedSpec(description: String(repeating: "b", count: 2000)))
        #expect(draft.embedCharacterCount == 6111)
        #expect(draft.embedCharactersOver == 111)
    }

    @MainActor
    @Test("publishing is blocked over the limit and allowed at it")
    func overLimitBlocksPublish() async {
        let model = ComposedMessageEditorModel(
            server: "1", session: makeSignedInSession(clients: ComposedMessageModelTests.clients()), id: nil)
        await model.load()
        model.channelId = Self.otherChannel
        model.draft.embeds = [
            EmbedSpec(description: String(repeating: "a", count: 4096)),
            EmbedSpec(description: String(repeating: "b", count: 1904)),
        ]
        #expect(model.draft.embedCharacterCount == 6000)
        #expect(model.publishProblem == nil)
        model.draft.embeds[1].description += "b"
        let problem = model.publishProblem
        #expect(problem?.contains("1 characters over") == true)
        #expect(!model.canPublish)
        #expect(await model.publish() == false)
        #expect(model.actionError == problem)
    }

    @Test("the author, footer and field name limits are Discord's")
    func limits() {
        #expect(EmbedSpec.maxAuthorNameLength == 256)
        #expect(EmbedSpec.maxFooterLength == 2048)
        #expect(EmbedSpec.Field.maxNameLength == 256)
        #expect(ComposedMessageDraft.maxEmbedCharacters == 6000)
    }

    @Test("a link button needs an http or https link")
    func webLinksOnly() {
        #expect(LinkButton(label: "Site", url: "https://example.com").isReady)
        #expect(LinkButton(label: "Site", url: " http://example.com ").isReady)
        #expect(!LinkButton(label: "Site", url: "ftp://example.com").isReady)
        #expect(!LinkButton(label: "Site", url: "javascript:alert(1)").isReady)
        #expect(!LinkButton(label: "Site", url: "example.com").isReady)
        #expect(!LinkButton(label: "", emoji: "", url: "https://example.com").isReady)

        var draft = ComposedMessageDraft()
        draft.links = [LinkButton(label: "Site", url: "ftp://example.com"), LinkButton(emoji: "🔗", url: "mailto:a@b.c")]
        #expect(draft.spec.rows.isEmpty)
        // An invalid link is not content: the message would post nothing.
        #expect(draft.isEmpty)
        draft.links.append(LinkButton(label: "Real", url: "https://example.com"))
        #expect(!draft.isEmpty)
        let buttons = draft.spec.rows.first?.objectValue?["buttons"]?.arrayValue ?? []
        #expect(buttons.count == 1)
        #expect(buttons.first?.objectValue?["url"]?.stringValue == "https://example.com")
    }
}

@Suite("Review fixes in the record screens")
struct RecordReviewFixTests {
    @MainActor
    @Test("a change that starts while another is saving says so instead of doing nothing")
    func busyChange() async throws {
        let page = try JSONDecoder().decode(RolesPage.self, from: Data(RolesModuleTests.pageJSON.utf8))
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.DeleteReactionRoleSet { return OKResponse() }
            return page
        }
        let gate = TestGate()
        clients.setGate { endpoint in
            if endpoint is Endpoints.DeleteReactionRoleSet { await gate.wait() }
        }
        let model = RecordListModel<RolesPage>(roles: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        let first = Task { await model.delete(page.sets[0]) }
        while !clients.calls.contains(where: { $0.endpoint is Endpoints.DeleteReactionRoleSet }) {
            await Task.yield()
        }
        #expect(model.isWorking)
        let second = await model.delete(page.sets[1])
        #expect(second == false)
        #expect(model.actionError == "Another change is still saving.")
        await gate.release()
        #expect(await first.value)
        #expect(model.changeCount == 1)
    }

    @Test("a reaction-role set over twenty rows cannot be published as reactions")
    func reactionCap() {
        var draft = ReactionRoleDraft()
        draft.channelId = "222"
        draft.style = .buttons
        draft.rows = (0..<21).map { ReactionRoleDraft.Row(emoji: "🎮", label: "R\($0)", roleId: "\($0 + 1)") }
        #expect(draft.problem == nil)
        draft.style = .reaction
        #expect(draft.problem?.contains("at most 20") == true)
        #expect(draft.problem?.contains("Remove 1 row") == true)
        draft.rows.removeLast()
        #expect(draft.rows.count == 20)
        #expect(draft.problem == nil)
    }

    @Test("a custom command shows the Fluxer prefix, and a slash on Discord")
    func commandTrigger() {
        let page = CustomCommandsPage(commandPrefix: "!")
        #expect(page.trigger(for: "hello", isFluxer: true) == "!hello")
        #expect(page.trigger(for: "hello", isFluxer: false) == "/hello")
        #expect(CustomCommandsPage().trigger(for: "hello", isFluxer: true) == "hello")
    }

    @Test("a new schedule, another channel, a shorter age or unpinned deletion need confirming")
    func cleanupConfirmation() throws {
        let page = try JSONDecoder().decode(ChannelCleanupPage.self, from: Data(ChannelCleanupModuleTests.pageJSON.utf8))
        let original = CleanupScheduleDraft(schedule: page.schedules[0])
        #expect(CleanupScheduleDraft().needsConfirmation(comparedTo: nil))
        #expect(CleanupScheduleDraft().needsConfirmation(comparedTo: CleanupScheduleDraft()))

        var edited = original
        #expect(!edited.needsConfirmation(comparedTo: original))
        edited.hour = 9
        edited.days = [1]
        edited.maxAgeHours = 96
        #expect(!edited.needsConfirmation(comparedTo: original))
        edited.maxAgeHours = 71
        #expect(edited.needsConfirmation(comparedTo: original))
        edited = original
        edited.channelId = "333333333333333333"
        #expect(edited.needsConfirmation(comparedTo: original))
        edited = original
        edited.skipPinned = false
        #expect(edited.needsConfirmation(comparedTo: original))
    }

    @Test("the confirmation names the days, time, age, channel and pinned messages")
    func cleanupSentence() {
        var draft = CleanupScheduleDraft()
        draft.channelId = "1"
        draft.days = [1, 3]
        draft.maxAgeHours = 48
        #expect(draft.confirmationSentence(channelName: "#general")
            == "Every Mon/Wed at 03:00 (server time), messages older than 2d in #general are deleted permanently. Pinned messages are kept.")
        draft.days = Set([Int].allWeek)
        draft.skipPinned = false
        draft.maxAgeHours = 36
        #expect(draft.confirmationSentence(channelName: "#general")
            == "Every day at 03:00 (server time), messages older than 36h in #general are deleted permanently. Pinned messages are deleted too.")
    }

    @MainActor
    @Test("a slow answer for an old range neither ends loading nor reports an error")
    func insightsRace() async throws {
        let page = try JSONDecoder().decode(InsightsPage.self, from: Data(InsightsTests.pageJSON.utf8))
        let clients = StubClients { endpoint in
            if let load = endpoint as? Endpoints.Insights, load.range == .month { throw NetworkError.timeout }
            return page
        }
        let monthGate = TestGate()
        let weekGate = TestGate()
        clients.setGate { endpoint in
            guard let load = endpoint as? Endpoints.Insights else { return }
            if load.range == .month { await monthGate.wait() }
            if load.range == .week { await weekGate.wait() }
        }
        let model = InsightsModel(server: "1", session: makeSignedInSession(clients: clients))
        #expect(model.range == .month)
        let stale = Task { await model.load() }
        while clients.calls.isEmpty { await Task.yield() }
        let fresh = Task { await model.select(.week) }
        while clients.calls.count < 2 { await Task.yield() }

        // The old range fails late: the newer one is still loading and nothing is reported.
        await monthGate.release()
        await stale.value
        #expect(model.isLoading)
        #expect(model.errorMessage == nil)

        await weekGate.release()
        await fresh.value
        #expect(!model.isLoading)
        #expect(model.errorMessage == nil)
        #expect(model.page?.totals.messages == 400)
    }
}

@Suite("Link button validation and Discord text length")
struct LinkValidationAndLengthTests {
    @Test("the web link rule is the server's: http(s)://, then at least one character, no whitespace")
    func serverRule() {
        #expect(EmbedSpec.isWebLink("http://a"))
        #expect(EmbedSpec.isWebLink("HTTPS://Example.com/path?q=1"))
        #expect(!EmbedSpec.isWebLink("http://"))
        #expect(!EmbedSpec.isWebLink("https://"))
        #expect(!EmbedSpec.isWebLink("https://a b"))
        #expect(!EmbedSpec.isWebLink("www.example.com"))
        #expect(!EmbedSpec.isWebLink(""))
    }

    @Test("a link button with a bad link has an error; an empty row has none")
    func invalidURL() {
        #expect(LinkButton(label: "Site", url: "example.com").urlProblem == "Enter a full link starting with https://")
        #expect(LinkButton(label: "Site", url: "").hasInvalidURL)
        #expect(LinkButton(emoji: "🔗", url: "ftp://x").hasInvalidURL)
        #expect(LinkButton(url: "nope").hasInvalidURL)
        #expect(!LinkButton(label: "Site", url: " https://example.com ").hasInvalidURL)
        #expect(!LinkButton().hasInvalidURL)
        #expect(LinkButton().urlProblem == nil)

        var draft = ComposedMessageDraft(links: [LinkButton(label: "Ok", url: "https://example.com")])
        #expect(!draft.hasInvalidLinks)
        draft.links.append(LinkButton(label: "Bad", url: "example.com"))
        #expect(draft.hasInvalidLinks)
    }

    @MainActor
    @Test("a bad link button blocks Save Draft and Publish")
    func badLinkBlocksSave() async {
        let model = ComposedMessageEditorModel(
            server: "1", session: makeSignedInSession(clients: ComposedMessageModelTests.clients()), id: nil)
        await model.load()
        model.channelId = EmbedMessageGuardTests.otherChannel
        model.draft.content = "Hello"
        #expect(model.canSaveDraft)
        #expect(model.canPublish)
        model.draft.links = [LinkButton(label: "Bad", url: "example.com")]
        #expect(model.linkProblem != nil)
        #expect(!model.canSaveDraft)
        #expect(!model.canPublish)
        #expect(await model.saveDraft() == false)
        #expect(model.actionError == model.linkProblem)
        model.draft.links[0].url = "https://example.com"
        #expect(model.linkProblem == nil)
        #expect(model.canSaveDraft)
    }

    @Test("Discord counts UTF-16 code units, not Characters")
    func utf16Length() {
        let thumbs = String(repeating: "👍", count: 10)
        #expect(thumbs.count == 10)
        #expect(thumbs.discordLength == 20)
        #expect(EmbedSpec(title: thumbs).characterCount == 20)

        let embed = EmbedSpec(
            title: thumbs, description: thumbs, authorName: thumbs, footerText: thumbs,
            fields: [EmbedSpec.Field(name: thumbs, value: thumbs)])
        #expect(embed.characterCount == 120)
        #expect(ComposedMessageDraft(embeds: [embed, embed]).embedCharacterCount == 240)

        // 3000 emoji are 3000 Characters but 6000 units: at the limit. One more is over it.
        var draft = ComposedMessageDraft(embeds: [EmbedSpec(description: String(repeating: "👍", count: 3000))])
        #expect(draft.embedCharacterCount == 6000)
        #expect(draft.embedCharactersOver == 0)
        draft.embeds[0].description += "a"
        #expect(draft.embedCharactersOver == 1)
    }

    @Test("truncating to a Discord limit never splits an emoji")
    func truncation() {
        let thumbs = String(repeating: "👍", count: 10)
        #expect(thumbs.truncatedForDiscord(to: 20) == thumbs)
        #expect(thumbs.truncatedForDiscord(to: 7) == String(repeating: "👍", count: 3))
        #expect(thumbs.truncatedForDiscord(to: 1) == "")
        #expect("abc".truncatedForDiscord(to: 2) == "ab")
        #expect("abc".truncatedForDiscord(to: 5) == "abc")
        // A family emoji is one Character of eleven units.
        let family = "👨‍👩‍👧‍👦"
        #expect(family.count == 1)
        #expect(("a" + family).truncatedForDiscord(to: 5) == "a")
        #expect(("a" + family).truncatedForDiscord(to: 12) == "a" + family)
    }
}
