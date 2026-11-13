import Foundation
import Testing
@testable import SyloKit

@Suite("Introductions editor")
struct IntroductionsEditorTests {
    static let questionKeys: Set<String> = ["id", "label", "prompt", "required", "maxLength", "inline"]

    @Test("adding questions stops at the server's limit of eight, and each gets its own id")
    func addsQuestions() {
        var settings = IntroductionsSettings(questions: [])
        for _ in 0..<8 {
            let added = settings.addQuestion()
            #expect(added)
        }
        let ninth = settings.addQuestion()
        #expect(!ninth)
        #expect(settings.questions?.count == 8)
        #expect(Set((settings.questions ?? []).map(\.id)).count == 8)
        #expect((settings.questions ?? []).allSatisfy { $0.label.isEmpty && $0.maxLength == 300 && !$0.required })
    }

    @Test("a server that sent no questions gets a list when the first one is added")
    func addsToMissingList() throws {
        var settings = try JSONDecoder().decode(IntroductionsSettings.self, from: Data("{}".utf8))
        #expect(settings.questions == nil)
        settings.moveQuestions(fromOffsets: IndexSet(integer: 0), toOffset: 1)
        #expect(settings.questions == nil)
        let added = settings.addQuestion()
        #expect(added)
        #expect(settings.questions?.count == 1)
    }

    @Test("questions reorder the way onMove reports it, and the save keeps that order")
    func reordersQuestions() throws {
        var settings = try IntroductionsSettingsTests.decodePage().settings
        #expect(settings.questions?.map(\.id) == ["about", "pronouns"])
        settings.moveQuestions(fromOffsets: IndexSet(integer: 1), toOffset: 0)
        #expect(settings.questions?.map(\.id) == ["pronouns", "about"])
        let body = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as? [String: Any])
        let questions = try #require(body["questions"] as? [[String: Any]])
        #expect(questions.map { $0["id"] as? String } == ["pronouns", "about"])
        for question in questions { #expect(Set(question.keys) == Self.questionKeys) }
    }

    @Test("a new question goes out with every key and its own id")
    func encodesNewQuestion() throws {
        var question = IntroductionsQuestion.blank()
        question.label = "Favourite colour"
        question.prompt = "What is it?"
        question.inline = true
        let body = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(question)) as? [String: Any])
        #expect(Set(body.keys) == Self.questionKeys)
        #expect(body["label"] as? String == "Favourite colour")
        #expect(body["maxLength"] as? Int == 300)
        #expect(body["inline"] as? Bool == true)
        #expect((body["id"] as? String)?.isEmpty == false)
    }

    @Test("role groups add up to ten, are told apart while the name changes, and send name, roles and hide flag")
    func roleGroups() throws {
        var settings = IntroductionsSettings()
        for _ in 0..<10 {
            let added = settings.addRoleGroup()
            #expect(added)
        }
        let eleventh = settings.addRoleGroup()
        #expect(!eleventh)
        #expect(Set(settings.roleGroups.map(\.id)).count == 10)

        var group = IntroductionsRoleGroup(name: "Country", roleIds: ["1", "2"], hideWhenEmpty: true)
        let id = group.id
        group.name = "Countr"
        #expect(group.id == id)
        let body = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(group)) as? [String: Any])
        #expect(Set(body.keys) == ["name", "roleIds", "hideWhenEmpty"])
        // The local identity is not part of what makes two groups the same.
        #expect(IntroductionsRoleGroup(name: "A") == IntroductionsRoleGroup(name: "A"))
        #expect(IntroductionsRoleGroup(name: "A") != IntroductionsRoleGroup(name: "B"))
    }

    @Test("what the server would drop silently stops the save instead")
    func problems() {
        var settings = IntroductionsSettings(questions: [IntroductionsQuestion(id: "a", label: "About")])
        #expect(settings.problem == nil)

        settings.addQuestion()
        #expect(settings.problem == "Give every question a label.")
        settings.questions?[1].label = "  "
        #expect(settings.problem == "Give every question a label.")
        settings.questions?[1].label = "Pronouns"
        #expect(settings.problem == nil)

        settings.addRoleGroup()
        #expect(settings.problem == "Give every role group a name.")
        settings.roleGroups[0].name = "{ }"
        #expect(settings.problem == "Give every role group a name.")
        settings.roleGroups[0].name = "Country"
        #expect(settings.problem == nil)
        settings.addRoleGroup()
        settings.roleGroups[1].name = "country"
        #expect(settings.problem == "Two role groups have the same name.")
        settings.roleGroups[1].name = "Age"
        #expect(settings.problem == nil)
    }

    @Test("a group's name is cleaned like the server does, and gives a placeholder")
    func cleanNames() {
        let group = IntroductionsRoleGroup(name: "  Home   {town} ")
        #expect(group.cleanName == "Home town")
        var settings = IntroductionsSettings(roleGroups: [group, IntroductionsRoleGroup(name: "")])
        #expect(settings.roleGroupPlaceholders == ["{rolegroup:Home town}"])
        settings.roleGroups = []
        #expect(settings.roleGroupPlaceholders.isEmpty)
    }

    @Test("the limits are the server's")
    func limits() {
        #expect(IntroductionsQuestion.maxLabelLength == 45)
        #expect(IntroductionsQuestion.maxPromptLength == 300)
        #expect(IntroductionsQuestion.answerLengthRange == 1...1024)
        #expect(IntroductionsRoleGroup.maxNameLength == 45)
        #expect(IntroductionsSettings.maxRolesPerGroup == 25)
    }

    @Test("publishing the prompt is not an unsaved change, but the person's edits are")
    func promptIDsAreNotEdits() throws {
        let base = try IntroductionsSettingsTests.decodePage().settings
        let moved = IntroductionsSettings(
            channelId: base.channelId, questions: base.questions, roleGroups: base.roleGroups,
            showRoles: base.showRoles, colorMode: base.colorMode, color: base.color,
            description: base.description, footer: base.footer, deleteOnLeave: base.deleteOnLeave,
            promptText: base.promptText, promptChannelId: "999999999999999999", promptMessageId: "")
        #expect(base == moved)
        #expect(!moved.isPromptPublished)
        var edited = base
        edited.footer = "Changed"
        #expect(base != edited)
    }
}

@Suite("Introductions prompt")
struct IntroPromptTests {
    @Test("publishing posts the channel and the text; removing posts an empty object")
    func endpoints() throws {
        let publish = Endpoints.PublishIntroPrompt(server: "fluxer:1", channelId: "222222222222222222", promptText: "Hello")
        #expect(publish.path == "/api/v2/guilds/fluxer%3A1/modules/introductions/prompt/publish")
        #expect(publish.method == .post)
        #expect(publish.requiresAuth)
        let body = try #require(publish.body)
        let sent = try JSONDecoder().decode([String: String].self, from: JSONEncoder().encode(body))
        #expect(sent == ["channelId": "222222222222222222", "promptText": "Hello"])

        let remove = Endpoints.UnpublishIntroPrompt(server: "1")
        #expect(remove.path == "/api/v2/guilds/1/modules/introductions/prompt/unpublish")
        #expect(remove.method == .post)
        #expect(try JSONEncoder().encode(try #require(remove.body)) == Data("{}".utf8))
    }

    @Test("the answer carries the stored settings with the prompt's message, and a warning")
    func decodesResult() throws {
        let json = Data(#"""
        {"config": {"channelId": "222222222222222222", "promptText": "Hi", "promptChannelId": "222222222222222222",
                    "promptMessageId": "333333333333333333", "questions": []},
         "warning": "The new prompt is published, but the old one was not removed."}
        """#.utf8)
        let result = try JSONDecoder().decode(IntroPromptResult.self, from: json)
        #expect(result.settings.isPromptPublished)
        #expect(result.settings.promptText == "Hi")
        #expect(result.warning == "The new prompt is published, but the old one was not removed.")
        let plain = try JSONDecoder().decode(IntroPromptResult.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(plain.warning == nil)
        #expect(!plain.settings.isPromptPublished)
    }

    @MainActor
    @Test("publishing sends the form's channel and text and returns what the server stored")
    func publishes() async throws {
        let clients = StubClients { endpoint in
            guard endpoint is Endpoints.PublishIntroPrompt else { throw NetworkError.notFound }
            return IntroPromptResult(
                settings: IntroductionsSettings(channelId: "222222222222222222", promptText: "Hello",
                                                promptChannelId: "222222222222222222", promptMessageId: "3"),
                warning: "Old prompt stays.")
        }
        let model = IntroPromptModel(server: "9", session: makeSignedInSession(clients: clients))
        let settings = await model.publish(channelId: "222222222222222222", text: "Hello")
        #expect(settings?.isPromptPublished == true)
        #expect(model.notice == "Old prompt stays.")
        #expect(model.successCount == 1)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.PublishIntroPrompt)
        #expect(sent.channelId == "222222222222222222")
        #expect(sent.promptText == "Hello")
    }

    @MainActor
    @Test("a missing channel is caught before the call, a refusal shows the server's reason")
    func publishErrors() async {
        let clients = StubClients { _ in
            throw NetworkError.badRequest(
                message: "Sylo needs View Channel, Read Message History, Send Messages and Embed Links in that channel.")
        }
        let model = IntroPromptModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(await model.publish(channelId: "", text: "") == nil)
        #expect(model.errorMessage == "Pick the introductions channel first.")
        #expect(clients.calls.isEmpty)
        #expect(await model.publish(channelId: "222222222222222222", text: "") == nil)
        #expect(model.errorMessage?.hasPrefix("Sylo needs View Channel") == true)
        #expect(model.successCount == 0)
    }

    @MainActor
    @Test("removing a prompt Sylo may not delete explains the missing permission")
    func unpublishFails() async {
        let clients = StubClients { _ in throw NetworkError.server(status: 502) }
        let model = IntroPromptModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(await model.unpublish() == nil)
        #expect(model.errorMessage?.contains("Manage Messages") == true)
        clients.setHandler { _ in IntroPromptResult(settings: IntroductionsSettings()) }
        let settings = await model.unpublish()
        #expect(settings?.isPromptPublished == false)
        #expect(model.errorMessage == nil)
    }

    @MainActor
    @Test("after publishing, reloading the page shows it published without turning it into an unsaved change")
    func reloadAfterPublish() async throws {
        let page = IntroductionsSettingsTests.pageJSON.replacingOccurrences(
            of: #""promptMessageId": "333333333333333333""#, with: #""promptMessageId": """#)
        let unpublished = Data(page.utf8)
        let published = Data(IntroductionsSettingsTests.pageJSON.utf8)
        let clients = StubClients { _ in try JSONDecoder().decode(IntroductionsPage.self, from: unpublished) }
        let model = ModuleSettingsModel<IntroductionsPage>(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.page?.settings.isPromptPublished == false)

        clients.setHandler { _ in try JSONDecoder().decode(IntroductionsPage.self, from: published) }
        await model.load()
        #expect(model.page?.settings.isPromptPublished == true)
        #expect(!model.hasChanges)

        // An edit that is still unsaved survives the reload.
        model.draft?.footer = "Not saved yet"
        await model.load()
        #expect(model.draft?.footer == "Not saved yet")
        #expect(model.hasChanges)
    }
}
