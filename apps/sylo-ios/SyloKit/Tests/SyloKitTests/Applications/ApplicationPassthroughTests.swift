import Foundation
import Testing
@testable import SyloKit

@Suite("Application form passthrough")
struct ApplicationPassthroughTests {
    /// A form from a newer server: fields on the form, on a question and on an option that this version of
    /// the app does not model, and one question it cannot read.
    static let newerJSON = #"""
    {
      "id": 5, "name": "Staff", "enabled": false, "fillMode": "both", "timeoutMinutes": 30,
      "reviewMode": "double", "limits": {"perDay": 3, "tags": ["a", "b"]}, "createdAt": 1790000000000,
      "guildId": "1", "sortOrder": 2, "updatedAt": 1794000000000,
      "questions": [
        {"id": "q1", "type": "choice", "label": "Pick", "required": false, "unanswerable": false,
         "options": [{"id": "oa", "label": "A", "emoji": "x", "weight": 2.5}],
         "multiple": false, "grant": "never", "scoring": {"points": 3}, "hidden": true, "note": null},
        {"id": "q2", "type": "text", "label": "Why?", "maxLength": "lots"}
      ],
      "version": 1794000000000, "problems": {"setup": null, "roles": null}
    }
    """#

    static func decode() throws -> ApplicationForm {
        try JSONDecoder().decode(ApplicationForm.self, from: Data(newerJSON.utf8))
    }

    static func sent(_ form: ApplicationForm) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(form)) as? [String: Any])
    }

    @Test("fields the app does not model are kept on the form, the question and the option, and sent back")
    func keepsUnknownKeys() throws {
        let form = try Self.decode()
        #expect(form.extras["reviewMode"] == .string("double"))
        #expect(form.extras["limits"] == .object(["perDay": .int(3), "tags": .array([.string("a"), .string("b")])]))
        // What the server only reports is not kept: the web editor drops it too.
        for key in ["id", "version", "problems", "createdAt", "guildId", "sortOrder", "updatedAt"] {
            #expect(form.extras[key] == nil)
        }

        let body = try Self.sent(form)
        #expect(body["reviewMode"] as? String == "double")
        let limits = try #require(body["limits"] as? [String: Any])
        #expect(limits["perDay"] as? Int == 3)
        #expect(limits["tags"] as? [String] == ["a", "b"])
        #expect(Set(body.keys) == ApplicationFormsTests.formKeys.union(["reviewMode", "limits"]))

        let questions = try #require(body["questions"] as? [[String: Any]])
        #expect(questions.count == 1)
        #expect(Set(questions[0].keys) == ApplicationFormsTests.questionKeys.union(["scoring", "hidden", "note"]))
        #expect(questions[0]["unanswerable"] == nil)
        let scoring = try #require(questions[0]["scoring"] as? [String: Any])
        #expect(scoring["points"] as? Int == 3)
        #expect(questions[0]["hidden"] as? Bool == true)
        #expect(questions[0]["note"] is NSNull)
        let options = try #require(questions[0]["options"] as? [[String: Any]])
        #expect(Set(options[0].keys) == ["id", "label", "emoji", "weight"])
        #expect(options[0]["weight"] as? Double == 2.5)
    }

    @Test("an edit to a modelled field does not disturb the kept ones, and a kept key never overrides a modelled one")
    func editsAroundKeptKeys() throws {
        var form = try Self.decode()
        form.name = "Moderators"
        form.questions[0].label = "Choose"
        form.extras["name"] = .string("sneaky")
        let body = try Self.sent(form)
        #expect(body["name"] as? String == "Moderators")
        #expect(body["reviewMode"] as? String == "double")
        let questions = try #require(body["questions"] as? [[String: Any]])
        #expect(questions[0]["label"] as? String == "Choose")
        #expect(questions[0]["hidden"] as? Bool == true)
    }

    @Test("a question that cannot be read is counted, and the form is not saved, so the save cannot delete it")
    func unreadableQuestion() throws {
        let form = try Self.decode()
        #expect(form.unreadableQuestions == 1)
        #expect(form.questions.map(\.id) == ["q1"])
        let problem = try #require(form.saveProblem)
        #expect(problem.contains("cannot read"))
        #expect(problem.contains("delete"))

        let two = ApplicationForm(
            id: form.id, name: form.name, questions: form.questions, unreadableQuestions: 2, extras: form.extras)
        #expect(two.saveProblem?.contains("2 questions") == true)

        // One that can all be read has no such problem.
        let clean = try ApplicationFormsTests.decodeForm()
        #expect(clean.unreadableQuestions == 0)
        #expect(clean.saveProblem == nil)
    }

    @Test("an option that cannot be read makes its question unreadable instead of dropping the option")
    func unreadableOption() throws {
        let json = Data(#"""
        {"id": 1, "name": "F", "questions": [
          {"id": "q1", "type": "choice", "label": "Pick", "options": [{"id": "a", "label": 5}]},
          {"id": "q2", "type": "text", "label": "Fine"}]}
        """#.utf8)
        let form = try JSONDecoder().decode(ApplicationForm.self, from: json)
        #expect(form.unreadableQuestions == 1)
        #expect(form.questions.map(\.id) == ["q2"])
    }

    @MainActor
    @Test("the editor does not send a form with an unreadable question")
    func editorRefusesToSave() async throws {
        let clients = StubClients { _ in ApplicationFormSaved(form: try Self.decode()) }
        let model = ApplicationFormEditorModel(
            server: "9", form: try Self.decode(), session: makeSignedInSession(clients: clients))
        model.draft.name = "Renamed"
        #expect(model.problem != nil)
        #expect(await model.save() == false)
        #expect(clients.calls.isEmpty)
        // It can still be deleted: nothing is lost by that choice.
        clients.setHandler { _ in EmptyResponse() }
        #expect(await model.delete())
    }

    @Test("a saved form with unknown keys survives the save through the real client")
    func wireKeepsKeys() async throws {
        // The kept keys are in the encoded body, which is what the wire carries.
        let data = try JSONEncoder().encode(try Self.decode())
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["reviewMode"] as? String == "double")
        // And reading what was sent gives the same form again (with the id put back).
        var withID = object
        withID["id"] = 5
        let again = try JSONDecoder().decode(ApplicationForm.self, from: JSONSerialization.data(withJSONObject: withID))
        let original = try Self.decode()
        #expect(again.extras == original.extras)
        #expect(again.questions[0].extras == original.questions[0].extras)
        #expect(again.questions[0].options[0].extras["emoji"] == .string("x"))
    }

    // MARK: Question type

    @Test("switching a question between choice and role clears the options, other switches keep them")
    func typeSwitch() {
        var question = ApplicationQuestion(
            type: .choice, label: "Pick", required: true, options: [.init(id: "oa", label: "A"), .init(id: "ob", label: "B")])
        question.type = .role
        #expect(question.options.isEmpty)
        #expect(question.isUnanswerable)

        question.setRoleOptions(["111111111111111111"], roles: [RoleOption(id: "111111111111111111", name: "Staff")])
        #expect(!question.isUnanswerable)
        question.type = .choice
        #expect(question.options.isEmpty)

        question.options = [.init(id: "oa", label: "A")]
        question.type = .text
        #expect(question.options.count == 1)
        question.type = .choice
        #expect(question.options.count == 1)
        // The same type again is not a switch.
        question.type = .choice
        #expect(question.options.count == 1)
    }

    @Test("only role ids count as the options of a role question")
    func roleIDs() {
        #expect(ApplicationQuestion.isRoleID("111111111111111111"))
        #expect(ApplicationQuestion.isRoleID(String(repeating: "7", count: 17)))
        #expect(ApplicationQuestion.isRoleID(String(repeating: "7", count: 20)))
        #expect(!ApplicationQuestion.isRoleID(String(repeating: "7", count: 16)))
        #expect(!ApplicationQuestion.isRoleID(String(repeating: "7", count: 21)))
        #expect(!ApplicationQuestion.isRoleID("oa1b2c3d4"))
        #expect(!ApplicationQuestion.isRoleID("11111111111111111a"))
    }

    // MARK: Web address

    @Test("the page carries the web address and fills in the form's number")
    func webAddress() throws {
        let page = try JSONDecoder().decode(
            ApplicationsPage.self,
            from: Data(#"{"config":{},"webAddress":"https://sylo.example.com/apply/1/<form>"}"#.utf8))
        #expect(page.webAddress == "https://sylo.example.com/apply/1/<form>")
        #expect(page.webAddress(for: ApplicationForm(id: 7, name: "Staff")) == "https://sylo.example.com/apply/1/7")
        #expect(page.webAddress(for: .blank()) == nil)

        let none = try JSONDecoder().decode(ApplicationsPage.self, from: Data(#"{"config":{},"webAddress":null}"#.utf8))
        #expect(none.webAddress == nil)
        #expect(none.webAddress(for: ApplicationForm(id: 7, name: "Staff")) == nil)
        let old = try JSONDecoder().decode(ApplicationsPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(old.webAddress(for: ApplicationForm(id: 7, name: "Staff")) == nil)
    }

    // MARK: Equality

    @Test("settings are equal by what a save sends, so a field added later counts and only the ids do not")
    func equalityIsTheSentBody() throws {
        let base = ApplicationsSettings(retentionDays: 90, panelText: "Hi")
        #expect(base == ApplicationsSettings(retentionDays: 90, panelText: "Hi", panelChannelId: "1", panelMessageId: "2"))
        #expect(base != ApplicationsSettings(retentionDays: 91, panelText: "Hi"))

        let intro = try IntroductionsSettingsTests.decodePage().settings
        var withExtra = intro
        withExtra.questions?[0].extras["scoring"] = .int(3)
        #expect(intro != withExtra)
        var group = intro
        group.roleGroups[0].extras["colour"] = .string("red")
        #expect(intro != group)
        var renamed = intro
        renamed.roleGroups[0].name = "Land"
        #expect(intro != renamed)
    }

    @Test("Introductions questions and role groups keep unknown keys too")
    func introExtras() throws {
        let json = Data(#"""
        {"questions": [{"id": "a", "label": "About", "weight": 4}],
         "roleGroups": [{"name": "Country", "roleIds": [], "colour": "red"}]}
        """#.utf8)
        let settings = try JSONDecoder().decode(IntroductionsSettings.self, from: json)
        #expect(settings.questions?[0].extras["weight"] == .int(4))
        #expect(settings.roleGroups[0].extras["colour"] == .string("red"))
        let body = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as? [String: Any])
        let questions = try #require(body["questions"] as? [[String: Any]])
        #expect(questions[0]["weight"] as? Int == 4)
        #expect(Set(questions[0].keys) == IntroductionsEditorTests.questionKeys.union(["weight"]))
        let groups = try #require(body["roleGroups"] as? [[String: Any]])
        #expect(groups[0]["colour"] as? String == "red")
        #expect(Set(groups[0].keys) == ["name", "roleIds", "hideWhenEmpty", "colour"])
    }
}
