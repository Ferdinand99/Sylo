import Foundation
import Testing
@testable import SyloKit

@Suite("Introductions settings")
struct IntroductionsSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/introductions/config`, shaped like src/web/routes/v2Intro.js.
    static let pageJSON = #"""
    {
      "config": {
        "channelId": "222222222222222222",
        "questions": [
          {"id": "about", "label": "About me", "prompt": "Tell us a little about yourself.",
           "required": true, "maxLength": 500, "inline": false},
          {"id": "pronouns", "label": "Pronouns", "prompt": "Which pronouns do you use?",
           "required": false, "maxLength": 40, "inline": true}
        ],
        "roleGroups": [
          {"name": "Country", "roleIds": ["111111111111111111", "111111111111111112"], "hideWhenEmpty": true}
        ],
        "showRoles": true,
        "colorMode": "fixed",
        "color": "#7aa2f7",
        "description": "Welcome {user}",
        "footer": "{server}",
        "deleteOnLeave": false,
        "promptText": "Introduce yourself!",
        "promptChannelId": "222222222222222222",
        "promptMessageId": "333333333333333333"
      },
      "channels": [{"id": "222222222222222222", "name": "introductions"}],
      "roles": [{"id": "111111111111111111", "name": "Norway"}],
      "placeholders": ["{user}", "{user.name}", "{server}", "{rolegroup:<name>}"],
      "introductions": 42
    }
    """#

    static func decodePage() throws -> IntroductionsPage {
        try JSONDecoder().decode(IntroductionsPage.self, from: Data(pageJSON.utf8))
    }

    @Test("the page decodes settings, questions, role groups, options and the card count")
    func decodesPage() throws {
        let page = try Self.decodePage()
        #expect(IntroductionsPage.moduleID == "introductions")
        let settings = page.settings
        #expect(settings.channelId == "222222222222222222")
        #expect(settings.questions?.map(\.id) == ["about", "pronouns"])
        #expect(settings.questions?.first?.required == true)
        #expect(settings.questions?.last?.inline == true)
        #expect(settings.questions?.last?.maxLength == 40)
        #expect(settings.roleGroups == [
            IntroductionsRoleGroup(
                name: "Country", roleIds: ["111111111111111111", "111111111111111112"], hideWhenEmpty: true),
        ])
        #expect(settings.showRoles)
        #expect(settings.colorMode == .fixed)
        #expect(settings.color == "#7aa2f7")
        #expect(settings.description == "Welcome {user}")
        #expect(settings.footer == "{server}")
        #expect(!settings.deleteOnLeave)
        #expect(settings.promptText == "Introduce yourself!")
        #expect(settings.isPromptPublished)
        #expect(page.channels.map(\.name) == ["introductions"])
        #expect(page.roles.map(\.name) == ["Norway"])
        #expect(page.placeholders.count == 4)
        #expect(page.introductions == 42)
    }

    @Test("missing fields fall back to the server's defaults, and unknown color modes read as fixed")
    func lenientDecoding() throws {
        let page = try JSONDecoder().decode(IntroductionsPage.self, from: Data(#"{"config":{"colorMode":"rainbow"}}"#.utf8))
        #expect(page.settings.colorMode == .fixed)
        #expect(page.settings.deleteOnLeave)
        #expect(!page.settings.showRoles)
        #expect(page.settings.channelId.isEmpty)
        #expect(page.settings.roleGroups.isEmpty)
        #expect(!page.settings.isPromptPublished)
        #expect(page.introductions == 0)
        // No questions sent: not the same as none.
        #expect(page.settings.questions == nil)
        let none = try JSONDecoder().decode(IntroductionsSettings.self, from: Data(#"{"questions":[]}"#.utf8))
        #expect(none.questions == [])
    }

    @Test("a question or group that cannot be read is dropped, the others stay")
    func lossyLists() throws {
        let json = Data(#"""
        {"questions":[{"id":"a","label":"A"},{"label":"no id"},{"id":"b","label":"B","maxLength":10}],
         "roleGroups":[{"name":"G"},{"roleIds":[]}]}
        """#.utf8)
        let settings = try JSONDecoder().decode(IntroductionsSettings.self, from: json)
        #expect(settings.questions?.map(\.id) == ["a", "b"])
        #expect(settings.questions?.first?.maxLength == 500)
        #expect(settings.roleGroups.map(\.name) == ["G"])
    }

    @Test("saving sends what the web form sends: the lists go back, the prompt's message ids never")
    func encodesBody() throws {
        let page = try Self.decodePage()
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == [
            "channelId", "questions", "roleGroups", "showRoles", "colorMode", "color", "description", "footer",
            "deleteOnLeave", "promptText",
        ])
        let questions = try #require(body["questions"] as? [[String: Any]])
        #expect(questions.count == 2)
        #expect(Set(questions[0].keys) == ["id", "label", "prompt", "required", "maxLength", "inline"])
        #expect(questions[1]["maxLength"] as? Int == 40)
        let groups = try #require(body["roleGroups"] as? [[String: Any]])
        #expect(Set(groups[0].keys) == ["name", "roleIds", "hideWhenEmpty"])
        #expect(groups[0]["roleIds"] as? [String] == ["111111111111111111", "111111111111111112"])
        #expect(body["colorMode"] as? String == "fixed")
        #expect(body["deleteOnLeave"] as? Bool == false)
    }

    @Test("questions the server never sent are left out of the save, so it keeps its default ones")
    func omitsMissingQuestions() throws {
        let settings = try JSONDecoder().decode(IntroductionsSettings.self, from: Data("{}".utf8))
        let body = try #require(
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as? [String: Any])
        #expect(body["questions"] == nil)
        #expect(body["roleGroups"] as? [Any] != nil)
    }

    @Test("the colour is one choice in the app and two fields on the server")
    func colorChoice() {
        var settings = IntroductionsSettings()
        #expect(settings.colorChoice == .serverDefault)

        settings.colorChoice = .custom
        #expect(settings.colorMode == .fixed)
        #expect(settings.color == IntroductionsSettings.fallbackColor)
        #expect(settings.colorChoice == .custom)

        settings.setRGB(red: 1, green: 0, blue: 0.5)
        #expect(settings.color == "#ff0080")
        // A custom colour is kept when the choice is set to it again.
        settings.colorChoice = .custom
        #expect(settings.color == "#ff0080")

        settings.colorChoice = .memberRole
        #expect(settings.colorMode == .role)
        #expect(settings.color.isEmpty)
        #expect(settings.colorChoice == .memberRole)

        settings.colorChoice = .serverDefault
        #expect(settings.colorMode == .fixed)
        #expect(settings.color.isEmpty)
    }

    @Test("the colour picker's components round-trip, and an unreadable colour reads as the fallback")
    func rgb() {
        var settings = IntroductionsSettings(color: "#336699")
        let rgb = settings.rgb
        #expect(abs(rgb.red - 0x33 / 255.0) < 0.0001)
        #expect(abs(rgb.green - 0x66 / 255.0) < 0.0001)
        #expect(abs(rgb.blue - 0x99 / 255.0) < 0.0001)
        settings.setRGB(red: rgb.red, green: rgb.green, blue: rgb.blue)
        #expect(settings.color == "#336699")
        // Wide-gamut components are clamped.
        settings.setRGB(red: 1.4, green: -0.2, blue: 0)
        #expect(settings.color == "#ff0000")
        let broken = IntroductionsSettings(color: "blue")
        #expect(abs(broken.rgb.red - 0x7a / 255.0) < 0.0001)
    }

    @Test("the limits are the server's")
    func limits() {
        #expect(IntroductionsSettings.maxDescriptionLength == 1000)
        #expect(IntroductionsSettings.maxFooterLength == 200)
        #expect(IntroductionsSettings.maxPromptTextLength == 500)
        #expect(IntroductionsSettings.maxQuestions == 8)
        #expect(IntroductionsSettings.maxRoleGroups == 10)
    }

    @Test("the model loads the page and saves an edit with the lists intact")
    @MainActor
    func modelSaves() async throws {
        let clients = StubClients { endpoint in
            if let saving = endpoint as? Endpoints.SaveModuleSettings<IntroductionsPage> {
                // The server hands back its own copy; the prompt ids are its to keep.
                var stored = saving.settings
                stored = IntroductionsSettings(
                    channelId: stored.channelId, questions: stored.questions, roleGroups: stored.roleGroups,
                    showRoles: stored.showRoles, colorMode: stored.colorMode, color: stored.color,
                    description: stored.description, footer: stored.footer, deleteOnLeave: stored.deleteOnLeave,
                    promptText: stored.promptText, promptChannelId: "222222222222222222",
                    promptMessageId: "333333333333333333")
                return SavedModuleSettings(settings: stored)
            }
            return try Self.decodePage()
        }
        let model = ModuleSettingsModel<IntroductionsPage>(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(!model.hasChanges)
        model.draft?.showRoles = false
        model.draft?.footer = "See you"
        #expect(model.hasChanges)
        #expect(await model.save())
        #expect(!model.hasChanges)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.SaveModuleSettings<IntroductionsPage>)
        #expect(sent.path == "/api/v2/guilds/9/modules/introductions/config")
        #expect(sent.settings.footer == "See you")
        #expect(sent.settings.questions?.count == 2)
        #expect(sent.settings.roleGroups.count == 1)
        #expect(model.saved?.isPromptPublished == true)
    }
}
