import Foundation
import Testing
@testable import SyloKit

@Suite("Application forms")
struct ApplicationFormsTests {
    /// A form as `formView` in src/web/routes/v2Applications.js sends it: every field `normaliseForm`
    /// keeps, `unanswerable` on each question, plus `version` and `problems`.
    static let formJSON = #"""
    {
      "id": 3, "name": "Staff", "description": "Join the team", "enabled": true, "fillMode": "both",
      "timeoutMinutes": 30,
      "questions": [
        {"id": "q1", "type": "text", "label": "Why?", "help": "Be honest", "required": true, "unanswerable": false,
         "long": true, "minLength": 10, "maxLength": 1500, "options": [], "multiple": false, "minChoices": 0,
         "maxChoices": 1, "grant": "never"},
        {"id": "q2", "type": "choice", "label": "Timezone", "help": "", "required": true, "unanswerable": false,
         "long": false, "minLength": 0, "maxLength": 300,
         "options": [{"id": "oa1b2c", "label": "Europe"}, {"id": "od4e5f", "label": "America"}],
         "multiple": true, "minChoices": 1, "maxChoices": 2, "grant": "never"},
        {"id": "q3", "type": "role", "label": "Pick a role", "help": "", "required": false, "unanswerable": false,
         "long": false, "minLength": 0, "maxLength": 300,
         "options": [{"id": "111111111111111111", "label": "Builder"}],
         "multiple": false, "minChoices": 0, "maxChoices": 1, "grant": "accept"},
        {"id": "q4", "type": "yesno", "label": "Adult?", "help": "", "required": true, "unanswerable": false,
         "long": false, "minLength": 0, "maxLength": 300, "options": [], "multiple": false, "minChoices": 0,
         "maxChoices": 1, "grant": "never"}
      ],
      "requiredRoleIds": ["111111111111111111"], "requiredRolesMode": "any",
      "restrictedRoleIds": ["111111111111111112"], "restrictedRolesMode": "all",
      "minAccountDays": 7, "minServerDays": 3, "cooldownHours": 24,
      "pendingChannelId": "222222222222222222", "acceptedChannelId": "222222222222222223",
      "deniedChannelId": "", "decidedPost": "copy",
      "pingRoleIds": ["111111111111111113"], "managerRoleIds": ["111111111111111111"], "staffThread": true,
      "pendingRoleId": "111111111111111114", "removeOnSubmitRoleIds": ["111111111111111115"],
      "acceptAddRoleIds": ["111111111111111111"], "acceptRemoveRoleIds": [], "denyAddRoleIds": [],
      "denyRemoveRoleIds": [], "onLeave": "deny",
      "messages": {"start": "Start", "completed": "Done", "accepted": "Yes {reason}", "denied": ""},
      "version": 1794000000000,
      "problems": {"setup": null, "roles": "Sylo cannot manage the role Admin."}
    }
    """#

    /// What `normaliseForm` reads from a body, and nothing else.
    static let formKeys: Set<String> = [
        "name", "description", "enabled", "fillMode", "timeoutMinutes", "questions", "requiredRoleIds",
        "requiredRolesMode", "restrictedRoleIds", "restrictedRolesMode", "minAccountDays", "minServerDays",
        "cooldownHours", "pendingChannelId", "acceptedChannelId", "deniedChannelId", "decidedPost", "pingRoleIds",
        "managerRoleIds", "staffThread", "pendingRoleId", "removeOnSubmitRoleIds", "acceptAddRoleIds",
        "acceptRemoveRoleIds", "denyAddRoleIds", "denyRemoveRoleIds", "onLeave", "messages",
    ]

    /// What `normaliseQuestion` reads from a question.
    static let questionKeys: Set<String> = [
        "id", "type", "label", "help", "required", "long", "minLength", "maxLength", "options", "multiple",
        "minChoices", "maxChoices", "grant",
    ]

    static func decodeForm() throws -> ApplicationForm {
        try JSONDecoder().decode(ApplicationForm.self, from: Data(formJSON.utf8))
    }

    static func jsonObject(_ value: some Encodable) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    }

    @Test("a form decodes every editor field")
    func decodesForm() throws {
        let form = try Self.decodeForm()
        #expect(form.id == 3)
        #expect(!form.isNew)
        #expect(form.name == "Staff")
        #expect(form.description == "Join the team")
        #expect(form.enabled)
        #expect(form.fillMode == .both)
        #expect(form.timeoutMinutes == 30)
        #expect(form.questionCount == 4)
        #expect(form.requiredRoleIds == ["111111111111111111"])
        #expect(form.requiredRolesMode == .any)
        #expect(form.restrictedRoleIds == ["111111111111111112"])
        #expect(form.restrictedRolesMode == .all)
        #expect(form.minAccountDays == 7)
        #expect(form.minServerDays == 3)
        #expect(form.cooldownHours == 24)
        #expect(form.pendingChannelId == "222222222222222222")
        #expect(form.acceptedChannelId == "222222222222222223")
        #expect(form.deniedChannelId.isEmpty)
        #expect(form.decidedPost == .copy)
        #expect(form.pingRoleIds == ["111111111111111113"])
        #expect(form.managerRoleIds == ["111111111111111111"])
        #expect(form.staffThread)
        #expect(form.pendingRoleId == "111111111111111114")
        #expect(form.removeOnSubmitRoleIds == ["111111111111111115"])
        #expect(form.acceptAddRoleIds == ["111111111111111111"])
        #expect(form.onLeave == .deny)
        #expect(form.messages == ApplicationFormMessages(start: "Start", completed: "Done", accepted: "Yes {reason}", denied: ""))
        #expect(form.version == 1_794_000_000_000)
        #expect(form.setupProblem == nil)
        #expect(form.rolesProblem == "Sylo cannot manage the role Admin.")
    }

    @Test("the questions decode with their type, limits and options")
    func decodesQuestions() throws {
        let questions = try Self.decodeForm().questions
        #expect(questions.map(\.id) == ["q1", "q2", "q3", "q4"])
        #expect(questions.map(\.type) == [.text, .choice, .role, .yesno])
        #expect(questions[0].long)
        #expect(questions[0].minLength == 10)
        #expect(questions[0].maxLength == 1500)
        #expect(questions[0].help == "Be honest")
        #expect(questions[1].multiple)
        #expect(questions[1].minChoices == 1)
        #expect(questions[1].maxChoices == 2)
        #expect(questions[1].options.map(\.label) == ["Europe", "America"])
        #expect(questions[2].grant == .accept)
        #expect(questions[2].roleIds == ["111111111111111111"])
        #expect(questions[3].required)
    }

    @Test("saving sends exactly the keys normaliseForm reads, never the id, version or problems")
    func encodesFormKeySet() throws {
        let body = try Self.jsonObject(try Self.decodeForm())
        #expect(Set(body.keys) == Self.formKeys)
        #expect(body["id"] == nil)
        #expect(body["version"] == nil)
        #expect(body["problems"] == nil)
        #expect(body["fillMode"] as? String == "both")
        #expect(body["requiredRolesMode"] as? String == "any")
        #expect(body["decidedPost"] as? String == "copy")
        #expect(body["onLeave"] as? String == "deny")
        #expect(body["timeoutMinutes"] as? Int == 30)
        let messages = try #require(body["messages"] as? [String: String])
        #expect(messages == ["start": "Start", "completed": "Done", "accepted": "Yes {reason}", "denied": ""])
    }

    @Test("every question goes out with the fields normaliseQuestion reads, options as id and label")
    func encodesQuestionKeySet() throws {
        let body = try Self.jsonObject(try Self.decodeForm())
        let questions = try #require(body["questions"] as? [[String: Any]])
        #expect(questions.count == 4)
        for question in questions { #expect(Set(question.keys) == Self.questionKeys) }
        #expect(questions[0]["long"] as? Bool == true)
        #expect(questions[1]["multiple"] as? Bool == true)
        #expect(questions[2]["grant"] as? String == "accept")
        let options = try #require(questions[1]["options"] as? [[String: Any]])
        #expect(Set(options[0].keys) == ["id", "label"])
        #expect(options[0]["id"] as? String == "oa1b2c")
    }

    @Test("a form decoded and encoded again reads the same")
    func roundTrips() throws {
        let form = try Self.decodeForm()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let first = try encoder.encode(form)
        // The id is in the path and not in the body; put it back to read the form again.
        var object = try #require(try JSONSerialization.jsonObject(with: first) as? [String: Any])
        object["id"] = 3
        let again = try JSONDecoder().decode(ApplicationForm.self, from: JSONSerialization.data(withJSONObject: object))
        #expect(again.id == 3)
        #expect(again.version == nil)
        #expect(again.questions == form.questions)
        #expect(try encoder.encode(again) == first)
    }

    @Test("a value the app does not know is kept and sent back as it came")
    func keepsUnknownValues() throws {
        let json = Data(#"""
        {"id": 9, "name": "Odd", "fillMode": "carrier-pigeon", "decidedPost": "shred", "onLeave": "ghost",
         "requiredRolesMode": "some",
         "questions": [{"id": "z", "type": "hologram", "label": "Show us", "grant": "later"}]}
        """#.utf8)
        let form = try JSONDecoder().decode(ApplicationForm.self, from: json)
        #expect(form.fillMode == .other("carrier-pigeon"))
        #expect(form.decidedPost == .other("shred"))
        #expect(form.onLeave == .other("ghost"))
        #expect(form.requiredRolesMode == .other("some"))
        #expect(form.questions[0].type == .other("hologram"))
        #expect(form.questions[0].grant == .other("later"))
        let body = try Self.jsonObject(form)
        #expect(body["fillMode"] as? String == "carrier-pigeon")
        #expect(body["decidedPost"] as? String == "shred")
        #expect(body["onLeave"] as? String == "ghost")
        let questions = try #require(body["questions"] as? [[String: Any]])
        #expect(questions[0]["type"] as? String == "hologram")
        #expect(questions[0]["grant"] as? String == "later")
    }

    @Test("a form with only an id reads with the server's defaults; one without an id, or a broken question, is dropped")
    func lenient() throws {
        let bare = try JSONDecoder().decode(ApplicationForm.self, from: Data(#"{"id":1}"#.utf8))
        #expect(bare.name.isEmpty)
        #expect(!bare.enabled)
        #expect(bare.fillMode == .both)
        #expect(bare.timeoutMinutes == 30)
        #expect(bare.requiredRolesMode == .all)
        #expect(bare.restrictedRolesMode == .any)
        #expect(bare.decidedPost == .move)
        #expect(bare.onLeave == .keep)
        #expect(bare.questions.isEmpty)
        #expect(bare.setupProblem == nil)

        let list = try JSONDecoder().decode(
            ApplicationFormList.self, from: Data(#"{"forms":[{"name":"no id"},{"id":2,"name":"B"}]}"#.utf8))
        #expect(list.forms.map(\.id) == [2])

        let question = try JSONDecoder().decode(ApplicationQuestion.self, from: Data(#"{"label":"Why"}"#.utf8))
        #expect(question.type == .text)
        #expect(question.maxLength == 300)
        #expect(question.maxChoices == 1)
        #expect(question.grant == .never)
        #expect(!question.id.isEmpty)
    }

    @Test("a question added in the app gets an id the server accepts, and ids differ")
    func newIDs() {
        let a = ApplicationQuestion()
        let b = ApplicationQuestion()
        #expect(a.id != b.id)
        func isValid(_ id: String) -> Bool {
            id.range(of: "^[A-Za-z0-9_-]{1,24}$", options: .regularExpression) != nil
        }
        #expect(isValid(a.id))
        #expect(isValid(ApplicationQuestionOption().id))
        #expect(isValid(IntroductionsQuestion.blank().id))
    }

    @Test("the form's limits are the server's")
    func limits() {
        #expect(ApplicationForm.maxQuestions == 25)
        #expect(ApplicationForm.maxNameLength == 60)
        #expect(ApplicationForm.maxDescriptionLength == 500)
        #expect(ApplicationForm.timeoutRange == 1...1440)
        #expect(ApplicationForm.ageDaysRange == 0...3650)
        #expect(ApplicationForm.cooldownHoursRange == 0...8760)
        #expect(ApplicationForm.maxRoles == 25)
        #expect(ApplicationForm.maxPingRoles == 10)
        #expect(ApplicationQuestion.maxLabelLength == 100)
        #expect(ApplicationQuestion.maxHelpLength == 300)
        #expect(ApplicationQuestion.maxOptionLabelLength == 80)
        #expect(ApplicationQuestion.maxOptions == 10)
        #expect(ApplicationFormMessages.maxLength == 1000)
        #expect(ApplicationQuestion(long: false).lengthCap() == 1024)
        #expect(ApplicationQuestion(long: false).lengthCap(shortTextMax: 500) == 500)
        #expect(ApplicationQuestion(long: true).lengthCap(shortTextMax: 500) == 4000)
    }

    // MARK: Editing

    @Test("questions reorder the way onMove reports it")
    func reordersQuestions() throws {
        var form = try Self.decodeForm()
        form.moveQuestions(fromOffsets: IndexSet(integer: 0), toOffset: 3)
        #expect(form.questions.map(\.id) == ["q2", "q3", "q1", "q4"])
        form.moveQuestions(fromOffsets: IndexSet(integer: 3), toOffset: 0)
        #expect(form.questions.map(\.id) == ["q4", "q2", "q3", "q1"])
        form.moveQuestions(fromOffsets: IndexSet([0, 1]), toOffset: 4)
        #expect(form.questions.map(\.id) == ["q3", "q1", "q4", "q2"])
        // Moving onto itself changes nothing, and a bad offset is ignored.
        form.moveQuestions(fromOffsets: IndexSet(integer: 1), toOffset: 1)
        form.moveQuestions(fromOffsets: IndexSet(integer: 9), toOffset: 0)
        #expect(form.questions.map(\.id) == ["q3", "q1", "q4", "q2"])
    }

    @Test("the options of a choice question reorder too")
    func reordersOptions() {
        var question = ApplicationQuestion(
            type: .choice, label: "Pick",
            options: [.init(id: "a", label: "A"), .init(id: "b", label: "B"), .init(id: "c", label: "C")])
        question.moveOptions(fromOffsets: IndexSet(integer: 2), toOffset: 0)
        #expect(question.options.map(\.id) == ["c", "a", "b"])
    }

    @Test("a form takes at most 25 questions and a question at most 10 options")
    func addLimits() {
        var form = ApplicationForm()
        for _ in 0..<30 { form.addQuestion() }
        #expect(form.questions.count == 25)
        let extra = form.addQuestion()
        #expect(extra == nil)
        #expect(Set(form.questions.map(\.id)).count == 25)

        var question = ApplicationQuestion(type: .choice)
        for _ in 0..<15 { question.addOption() }
        #expect(question.options.count == 10)
    }

    @Test("picking roles for a role question keeps the options that stay and names the new ones")
    func roleOptions() {
        let one = "111111111111111111"
        let two = "111111111111111112"
        let three = "111111111111111113"
        let nine = "111111111111111119"
        let roles = [RoleOption(id: one, name: "Builder"), RoleOption(id: two, name: "Admin"), RoleOption(id: three, name: "Mod")]
        var question = ApplicationQuestion(type: .role, label: "Roles", options: [.init(id: one, label: "Old name")])
        question.setRoleOptions([one, two], roles: roles)
        #expect(question.roleIds == [one, two])
        #expect(question.options.map(\.label) == ["Old name", "Admin"])
        question.setRoleOptions([three, nine], roles: roles)
        #expect(question.options == [.init(id: three, label: "Mod"), .init(id: nine, label: "")])
        question.setRoleOptions((0..<14).map { "11111111111111\(1000 + $0)" }, roles: roles)
        #expect(question.options.count == 10)
    }

    // MARK: What stops a save

    @Test("a form is saved only when the server would take it")
    func saveProblems() {
        var form = ApplicationForm()
        #expect(form.saveProblem == "Give the form a name.")
        form.name = "  "
        #expect(form.saveProblem == "Give the form a name.")
        form.name = "Staff"
        #expect(form.saveProblem == nil)

        form.addQuestion()
        #expect(form.saveProblem == "Give every question some text.")
        form.questions[0].label = "Why?"
        #expect(form.saveProblem == nil)

        form.questions[0].type = .choice
        form.questions[0].required = true
        #expect(form.saveProblem == "The question \"Why?\" is required but has no options.")
        form.questions[0].options = [.init(id: "a", label: "  ")]
        #expect(form.saveProblem?.contains("has no options") == true)
        form.questions[0].options = [.init(id: "a", label: "Yes")]
        #expect(form.saveProblem == nil)

        // An open form needs a question and a channel for new applications.
        form.enabled = true
        #expect(form.saveProblem == "The form cannot be enabled yet: No channel is set for new applications.")
        form.pendingChannelId = "222222222222222222"
        #expect(form.saveProblem == nil)
        form.questions = []
        #expect(form.saveProblem == "The form cannot be enabled yet: The form has no questions.")
        form.enabled = false
        #expect(form.saveProblem == nil)
    }

    @Test("a required role question with no roles is stuck, an optional one is not")
    func unanswerable() {
        #expect(ApplicationQuestion(type: .role, label: "R", required: true).isUnanswerable)
        #expect(!ApplicationQuestion(type: .role, label: "R", required: false).isUnanswerable)
        #expect(!ApplicationQuestion(type: .text, label: "T", required: true).isUnanswerable)
        #expect(!ApplicationQuestion(type: .role, label: "R", required: true, options: [.init(id: "111111111111111111", label: "")]).isUnanswerable)
        // A choice option's id is not a role: the server keeps only role ids on a role question.
        #expect(ApplicationQuestion(type: .role, label: "R", required: true, options: [.init(id: "oa1b2c3d4", label: "Yes")]).isUnanswerable)
    }

    @Test("a new form starts closed with the server's message texts")
    func blankForm() {
        let messages = ApplicationFormMessages(start: "Hi", completed: "Thanks", accepted: "Yes", denied: "No")
        let form = ApplicationForm.blank(messages: messages)
        #expect(form.isNew)
        #expect(form.id == nil)
        #expect(!form.enabled)
        #expect(form.fillMode == .both)
        #expect(form.timeoutMinutes == 30)
        #expect(form.messages == messages)
        #expect(form.questions.isEmpty)
    }

    @Test("the page decodes the full forms and what the editor needs")
    func pageCarriesFullForms() throws {
        let json = Data(#"""
        {"config": {}, "forms": [\#(Self.formJSON)], "shortTextMax": 800,
         "defaultMessages": {"start": "S", "completed": "C", "accepted": "A", "denied": "D"},
         "placeholders": ["{user}", "{server}"], "threads": false,
         "channels": [{"id": "1", "name": "apps"}], "roles": [{"id": "2", "name": "Staff"}]}
        """#.utf8)
        let page = try JSONDecoder().decode(ApplicationsPage.self, from: json)
        #expect(page.forms.count == 1)
        #expect(page.forms[0].questions.count == 4)
        #expect(page.shortTextMax == 800)
        #expect(page.defaultMessages == ApplicationFormMessages(start: "S", completed: "C", accepted: "A", denied: "D"))
        #expect(page.placeholders == ["{user}", "{server}"])
        #expect(page.supportsThreads == false)

        let old = try JSONDecoder().decode(ApplicationsPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(old.shortTextMax == 1024)
        #expect(old.supportsThreads == nil)
        #expect(old.defaultMessages == ApplicationFormMessages())
    }

    @Test("publishing the panel is not an unsaved change, but the person's edits are")
    func panelIDsAreNotEdits() {
        let before = ApplicationsSettings(retentionDays: 90, panelText: "Hi")
        let published = ApplicationsSettings(
            retentionDays: 90, panelText: "Hi", panelChannelId: "1", panelMessageId: "2")
        #expect(before == published)
        #expect(published.isPanelPublished)
        #expect(!before.isPanelPublished)
        #expect(before != ApplicationsSettings(retentionDays: 91, panelText: "Hi"))
        #expect(before != ApplicationsSettings(retentionDays: 90, panelText: "Other"))
    }
}

@Suite("Application form endpoints")
struct ApplicationFormEndpointsTests {
    let fluxer: ServerID = "fluxer:1"

    @Test("a new form posts to the forms path and an existing one to its own")
    func save() throws {
        let new = Endpoints.SaveApplicationForm(server: fluxer, form: ApplicationForm(name: "Staff"))
        #expect(new.path == "/api/v2/guilds/fluxer%3A1/applications/forms")
        #expect(new.method == .post)
        #expect(new.requiresAuth)
        let existing = Endpoints.SaveApplicationForm(server: "1", form: ApplicationForm(id: 7, name: "Staff"))
        #expect(existing.path == "/api/v2/guilds/1/applications/forms/7")
        let body = try #require(existing.body)
        let sent = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        #expect(Set(sent.keys) == ApplicationFormsTests.formKeys)
        #expect(sent["name"] as? String == "Staff")
    }

    @Test("deleting a form is a POST to its delete path with an empty object")
    func delete() throws {
        let e = Endpoints.DeleteApplicationForm(server: fluxer, id: 4)
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/applications/forms/4/delete")
        #expect(e.method == .post)
        let body = try #require(e.body)
        #expect(try JSONEncoder().encode(body) == Data("{}".utf8))
    }

    @Test("reordering posts the ids in their new order")
    func reorder() throws {
        let e = Endpoints.ReorderApplicationForms(server: "1", ids: [3, 1, 2])
        #expect(e.path == "/api/v2/guilds/1/applications/forms/reorder")
        #expect(e.method == .post)
        let body = try #require(e.body)
        let sent = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        #expect(sent["ids"] as? [Int] == [3, 1, 2])
        #expect(sent.count == 1)
    }

    @Test("publishing the panel posts the channel and the text; removing it posts an empty object")
    func panel() throws {
        let publish = Endpoints.PublishApplicationsPanel(server: fluxer, channelId: "222222222222222222", text: "Apply!")
        #expect(publish.path == "/api/v2/guilds/fluxer%3A1/applications/panel/publish")
        #expect(publish.method == .post)
        let body = try #require(publish.body)
        let sent = try JSONDecoder().decode([String: String].self, from: JSONEncoder().encode(body))
        #expect(sent == ["channelId": "222222222222222222", "text": "Apply!"])

        let remove = Endpoints.UnpublishApplicationsPanel(server: "1")
        #expect(remove.path == "/api/v2/guilds/1/applications/panel/unpublish")
        #expect(remove.method == .post)
        let removeBody = try #require(remove.body)
        #expect(try JSONEncoder().encode(removeBody) == Data("{}".utf8))
    }

    @Test("retrying roles, deleting an application and reading a member's history use the staff paths")
    func submissionActions() throws {
        let retry = Endpoints.RetryApplicationRoles(server: fluxer, id: 12)
        #expect(retry.path == "/api/v2/guilds/fluxer%3A1/applications/submissions/12/retry-roles")
        #expect(retry.method == .post)
        let delete = Endpoints.DeleteApplicationSubmission(server: "1", id: 12)
        #expect(delete.path == "/api/v2/guilds/1/applications/submissions/12/delete")
        #expect(delete.method == .post)
        let history = Endpoints.ApplicantHistoryOf(server: "1", userID: "810000000000000001")
        #expect(history.path == "/api/v2/guilds/1/applications/members/810000000000000001")
        #expect(history.method == .get)
        #expect(history.body == nil)
    }

    @Test("the inbox can be narrowed to one form")
    func listByForm() {
        let e = Endpoints.ApplicationSubmissions(server: "1", status: .pending, formID: 3, page: 2)
        #expect(e.query == [
            URLQueryItem(name: "status", value: "pending"),
            URLQueryItem(name: "formId", value: "3"),
            URLQueryItem(name: "page", value: "2"),
        ])
        #expect(Endpoints.ApplicationSubmissions(server: "1", formID: 5).query == [URLQueryItem(name: "formId", value: "5")])
        #expect(Endpoints.ApplicationSubmissions(server: "1").query.isEmpty)
    }

    @Test("the export asks for one form, optionally one status, as CSV or JSON, and names the file like the server")
    func export() {
        let csv = Endpoints.ExportApplications(server: "fluxer:1", formID: 3)
        #expect(csv.path == "/api/v2/guilds/fluxer%3A1/applications/export")
        #expect(csv.method == .get)
        #expect(csv.body == nil)
        #expect(csv.requiresAuth)
        #expect(csv.query == [URLQueryItem(name: "formId", value: "3"), URLQueryItem(name: "format", value: "csv")])
        #expect(csv.expectedFilename == "applications-form-3.csv")

        let json = Endpoints.ExportApplications(server: "1", formID: 12, status: .pending, format: .json)
        #expect(json.query == [
            URLQueryItem(name: "formId", value: "12"),
            URLQueryItem(name: "status", value: "pending"),
            URLQueryItem(name: "format", value: "json"),
        ])
        #expect(json.expectedFilename == "applications-form-12-pending.json")
        #expect(ApplicationExportFormat.allCases == [.csv, .json])
        #expect(ApplicationExportFormat.csv.mimeType == "text/csv")
        #expect(ApplicationExportFormat.json.mimeType == "application/json")
        #expect(ApplicationExportFormat.csv.fileExtension == "csv")
    }

    @Test("the answers decode: a panel result, a retry and a member's history")
    func answers() throws {
        let panel = try JSONDecoder().decode(
            ApplicationsPanelResult.self,
            from: Data(#"{"config":{"retentionDays":90,"panelText":"Hi","panelChannelId":"1","panelMessageId":"2"},"warning":"Could not pin it."}"#.utf8))
        #expect(panel.settings.isPanelPublished)
        #expect(panel.settings.panelText == "Hi")
        #expect(panel.warning == "Could not pin it.")
        let plain = try JSONDecoder().decode(ApplicationsPanelResult.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(plain.warning == nil)
        #expect(!plain.settings.isPanelPublished)

        let retry = try JSONDecoder().decode(
            ApplicationRoleRetry.self,
            from: Data(#"{"ok":true,"remaining":1,"applied":2,"submission":{"id":12,"status":"accepted"}}"#.utf8))
        #expect(retry.applied == 2)
        #expect(retry.remaining == 1)
        #expect(retry.submission?.id == 12)
        let none = try JSONDecoder().decode(ApplicationRoleRetry.self, from: Data(#"{"ok":true,"remaining":0,"applied":0}"#.utf8))
        #expect(none.submission == nil)

        let history = try JSONDecoder().decode(
            ApplicantHistory.self,
            from: Data(#"{"userId":"810000000000000001","userName":null,"submissions":[{"id":2,"status":"denied"},{"nope":1}]}"#.utf8))
        #expect(history.displayName == "810000000000000001")
        #expect(history.submissions.map(\.id) == [2])
        let named = try JSONDecoder().decode(ApplicantHistory.self, from: Data(#"{"userId":"1","userName":"Alex"}"#.utf8))
        #expect(named.displayName == "Alex")
        #expect(named.submissions.isEmpty)
    }

    @Test("the server's reason is shown for a refusal, the generic text for anything else")
    func failureText() {
        #expect(EditorFailure.message(for: .badRequest(message: "Give the form a name.")) == "Give the form a name.")
        #expect(EditorFailure.message(for: .badRequest(message: "invalid_grant")) == NetworkError.badRequest(message: "invalid_grant").userMessage)
        #expect(EditorFailure.message(for: .badRequest(message: "invalid_request")) == NetworkError.badRequest(message: "invalid_request").userMessage)
        #expect(EditorFailure.message(for: .badRequest(message: nil)) == NetworkError.badRequest(message: nil).userMessage)
        #expect(EditorFailure.message(for: .badRequest(message: "")) == NetworkError.badRequest(message: nil).userMessage)
        #expect(EditorFailure.message(for: .server(status: 502), serverFailure: "Manage Messages is missing.") == "Manage Messages is missing.")
        #expect(EditorFailure.message(for: .server(status: 502)) == NetworkError.server(status: 502).userMessage)
        #expect(EditorFailure.message(for: .server(status: 500), serverFailure: "x") == NetworkError.server(status: 500).userMessage)
        #expect(EditorFailure.message(for: .forbidden) == NetworkError.forbidden.userMessage)
        #expect(EditorFailure.message(for: .forbidden, forbidden: "Not that role.") == "Not that role.")
        // The server's own text always wins over a fallback.
        #expect(EditorFailure.message(for: .badRequest(message: "Server says no."), serverFailure: "x", forbidden: "y") == "Server says no.")
        #expect(EditorFailure.serverText(of: .badRequest(message: "Server says no.")) == "Server says no.")
        #expect(EditorFailure.serverText(of: .forbidden) == nil)
        #expect(EditorFailure.serverText(of: .badRequest(message: "invalid_request")) == nil)
    }
}

@MainActor
@Suite("Application form models")
struct ApplicationFormModelsTests {
    @Test("saving sends the draft, and the server's answer becomes the draft and the original")
    func saves() async throws {
        let stored = ApplicationForm(id: 11, name: "Staff", questions: [ApplicationQuestion(id: "qserver1", label: "Why?")])
        let clients = StubClients { endpoint in
            guard endpoint is Endpoints.SaveApplicationForm else { throw NetworkError.notFound }
            return ApplicationFormSaved(form: stored)
        }
        let model = ApplicationFormEditorModel(
            server: "9", form: .blank(), session: makeSignedInSession(clients: clients))
        #expect(model.isNew)
        #expect(!model.hasChanges)
        #expect(model.problem == "Give the form a name.")
        #expect(await model.save() == false)
        #expect(clients.calls.isEmpty)

        model.draft.name = "Staff"
        model.draft.addQuestion()
        model.draft.questions[0].label = "Why?"
        #expect(model.hasChanges)
        #expect(model.problem == nil)
        #expect(await model.save())
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.SaveApplicationForm)
        #expect(sent.path == "/api/v2/guilds/9/applications/forms")
        #expect(sent.form.name == "Staff")
        #expect(model.draft == stored)
        #expect(model.original == stored)
        #expect(!model.hasChanges)
        #expect(!model.isNew)
        #expect(model.saveCount == 1)

        // The next save goes to the form's own path.
        model.draft.description = "More"
        #expect(await model.save())
        let again = try #require(clients.calls.last?.endpoint as? Endpoints.SaveApplicationForm)
        #expect(again.path == "/api/v2/guilds/9/applications/forms/11")
    }

    @Test("a refused save keeps the draft and shows the server's reason")
    func refusedSave() async {
        let clients = StubClients { _ in throw NetworkError.badRequest(message: "A server can have at most 10 forms.") }
        let model = ApplicationFormEditorModel(
            server: "9", form: ApplicationForm(name: "Staff"), session: makeSignedInSession(clients: clients))
        model.draft.description = "x"
        #expect(await model.save() == false)
        #expect(model.errorMessage == "A server can have at most 10 forms.")
        #expect(model.draft.description == "x")
        #expect(model.hasChanges)
        #expect(model.saveCount == 0)
        model.discardChanges()
        #expect(!model.hasChanges)
    }

    @Test("deleting a form posts its delete and marks it deleted; a new form cannot be deleted")
    func deletes() async throws {
        let clients = StubClients { _ in EmptyResponse() }
        let model = ApplicationFormEditorModel(
            server: "9", form: ApplicationForm(id: 4, name: "Staff"), session: makeSignedInSession(clients: clients))
        #expect(await model.delete())
        #expect(model.wasDeleted)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.DeleteApplicationForm)
        #expect(sent.id == 4)

        let fresh = ApplicationFormEditorModel(
            server: "9", form: .blank(), session: makeSignedInSession(clients: clients))
        #expect(await fresh.delete() == false)
        #expect(!fresh.wasDeleted)
    }

    @Test("a failed delete explains and keeps the form")
    func failedDelete() async {
        let clients = StubClients { _ in throw NetworkError.notFound }
        let model = ApplicationFormEditorModel(
            server: "9", form: ApplicationForm(id: 4, name: "Staff"), session: makeSignedInSession(clients: clients))
        #expect(await model.delete() == false)
        #expect(!model.wasDeleted)
        #expect(model.errorMessage == NetworkError.notFound.userMessage)
    }

    @Test("reordering forms tells the server the new order, and puts the old one back when it fails")
    func reordersForms() async throws {
        let forms = [ApplicationForm(id: 1, name: "A"), ApplicationForm(id: 2, name: "B"), ApplicationForm(id: 3, name: "C")]
        let clients = StubClients { _ in ApplicationFormList() }
        let model = ApplicationFormOrderModel(server: "9", forms: forms, session: makeSignedInSession(clients: clients))
        await model.move(fromOffsets: IndexSet(integer: 2), toOffset: 0)
        #expect(model.forms.map(\.id) == [3, 1, 2])
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.ReorderApplicationForms)
        #expect(sent.ids == [3, 1, 2])

        // Nothing moved: nothing sent.
        let count = clients.calls.count
        await model.move(fromOffsets: IndexSet(integer: 0), toOffset: 0)
        #expect(clients.calls.count == count)

        clients.setHandler { _ in throw NetworkError.forbidden }
        await model.move(fromOffsets: IndexSet(integer: 0), toOffset: 3)
        #expect(model.forms.map(\.id) == [3, 1, 2])
        #expect(model.errorMessage == NetworkError.forbidden.userMessage)

        model.sync(forms)
        #expect(model.forms.map(\.id) == [1, 2, 3])
    }

    @Test("publishing the panel returns the stored settings and keeps the server's warning")
    func publishesPanel() async throws {
        let clients = StubClients { endpoint in
            guard endpoint is Endpoints.PublishApplicationsPanel else { throw NetworkError.notFound }
            return ApplicationsPanelResult(
                settings: ApplicationsSettings(panelText: "Apply", panelChannelId: "1", panelMessageId: "2"),
                warning: "Sylo could not pin it.")
        }
        let model = ApplicationsPanelModel(server: "9", session: makeSignedInSession(clients: clients))
        let settings = await model.publish(channelId: "222222222222222222", text: "Apply")
        #expect(settings?.isPanelPublished == true)
        #expect(model.notice == "Sylo could not pin it.")
        #expect(model.errorMessage == nil)
        #expect(model.successCount == 1)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.PublishApplicationsPanel)
        #expect(sent.channelId == "222222222222222222")
        #expect(sent.text == "Apply")
    }

    @Test("publishing needs a channel, and a refusal shows the server's reason about permissions")
    func panelErrors() async {
        let clients = StubClients { _ in
            throw NetworkError.badRequest(
                message: "Sylo needs View Channel, Read Message History, Send Messages and Embed Links in that channel.")
        }
        let model = ApplicationsPanelModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(await model.publish(channelId: "", text: "") == nil)
        #expect(model.errorMessage == "Pick the channel for the panel first.")
        #expect(clients.calls.isEmpty)

        #expect(await model.publish(channelId: "222222222222222222", text: "") == nil)
        #expect(model.errorMessage == "Sylo needs View Channel, Read Message History, Send Messages and Embed Links in that channel.")
        #expect(model.successCount == 0)
    }

    @Test("removing the panel that Sylo may not delete explains the missing permission")
    func unpublishFails() async {
        let clients = StubClients { _ in throw NetworkError.server(status: 502) }
        let model = ApplicationsPanelModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(await model.unpublish() == nil)
        #expect(model.errorMessage?.contains("Manage Messages") == true)

        // A 502 while publishing is not a failed delete.
        clients.setHandler { _ in throw NetworkError.server(status: 502) }
        #expect(await model.publish(channelId: "222222222222222222", text: "") == nil)
        #expect(model.errorMessage == NetworkError.server(status: 502).userMessage)

        clients.setHandler { _ in
            ApplicationsPanelResult(settings: ApplicationsSettings(panelChannelId: "", panelMessageId: ""))
        }
        let settings = await model.unpublish()
        #expect(settings?.isPanelPublished == false)
        #expect(model.errorMessage == nil)
    }

    @Test("retrying roles replaces the application and says what is still left")
    func retriesRoles() async throws {
        let waiting = ApplicationSubmission(
            id: 12, status: .accepted, rolesPending: [ApplicationRoleChange(op: "add", roleName: "Member")])
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.RetryApplicationRoles {
                return ApplicationRoleRetry(applied: 1, remaining: 2, submission: ApplicationSubmission(id: 12, status: .accepted))
            }
            return ApplicationSubmissionDetail(submission: waiting)
        }
        let model = ApplicationSubmissionModel(server: "9", submissionID: 12, session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.submission?.rolesPending.count == 1)
        #expect(await model.retryRoles())
        #expect(model.submission?.rolesPending.isEmpty == true)
        #expect(model.decisionNotes.count == 1)
        #expect(model.decisionNotes[0].contains("2 role changes"))
        #expect(model.decisionCount == 1)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.RetryApplicationRoles)
        #expect(sent.id == 12)

        clients.setHandler { _ in ApplicationRoleRetry(applied: 1, remaining: 0, submission: ApplicationSubmission(id: 12)) }
        #expect(await model.retryRoles())
        #expect(model.decisionNotes.isEmpty)
    }

    @Test("a failed retry explains and keeps the application")
    func failedRetry() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.RetryApplicationRoles { throw NetworkError.notFound }
            return ApplicationSubmissionDetail(submission: ApplicationSubmission(id: 12, status: .accepted))
        }
        let model = ApplicationSubmissionModel(server: "9", submissionID: 12, session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(await model.retryRoles() == false)
        #expect(model.actionError == NetworkError.notFound.userMessage)
        #expect(model.submission?.id == 12)
    }

    @Test("deleting an application marks it deleted; one the server no longer has counts as gone")
    func deletesSubmission() async throws {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.DeleteApplicationSubmission { return EmptyResponse() }
            return ApplicationSubmissionDetail(submission: ApplicationSubmission(id: 12))
        }
        let model = ApplicationSubmissionModel(server: "9", submissionID: 12, session: makeSignedInSession(clients: clients))
        #expect(await model.deleteSubmission() == false)  // not loaded yet
        await model.load()
        #expect(await model.deleteSubmission())
        #expect(model.wasDeleted)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.DeleteApplicationSubmission)
        #expect(sent.id == 12)

        clients.setHandler { endpoint in
            if endpoint is Endpoints.DeleteApplicationSubmission { throw NetworkError.notFound }
            return ApplicationSubmissionDetail(submission: ApplicationSubmission(id: 12))
        }
        let gone = ApplicationSubmissionModel(server: "9", submissionID: 12, session: makeSignedInSession(clients: clients))
        await gone.load()
        #expect(await gone.deleteSubmission())
        #expect(gone.wasDeleted)
        #expect(gone.actionError == nil)
    }

    @Test("a post that cannot be deleted leaves the application, reloaded, with an explanation")
    func deleteFailsOnThePost() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.DeleteApplicationSubmission { throw NetworkError.server(status: 502) }
            return ApplicationSubmissionDetail(submission: ApplicationSubmission(id: 12, cleared: true))
        }
        let model = ApplicationSubmissionModel(server: "9", submissionID: 12, session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(await model.deleteSubmission() == false)
        #expect(!model.wasDeleted)
        #expect(model.actionError?.contains("answers were erased") == true)
        #expect(model.submission?.cleared == true)
    }

    @Test("a member's history loads, and a failure explains")
    func history() async throws {
        let clients = StubClients { _ in
            ApplicantHistory(userId: "810000000000000001", userName: "Alex", submissions: [ApplicationSubmission(id: 3), ApplicationSubmission(id: 2)])
        }
        let model = ApplicantHistoryModel(server: "9", userID: "810000000000000001", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.history?.submissions.map(\.id) == [3, 2])
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.ApplicantHistoryOf)
        #expect(sent.userID == "810000000000000001")
        clients.setHandler { _ in throw NetworkError.forbidden }
        await model.load()
        #expect(model.errorMessage == NetworkError.forbidden.userMessage)
        #expect(model.history?.submissions.count == 2)
    }

    @Test("the inbox can be narrowed to one form, and pages keep that form")
    func inboxByForm() async throws {
        let clients = StubClients { endpoint in
            guard let call = endpoint as? Endpoints.ApplicationSubmissions else { throw NetworkError.notFound }
            return call.page == 1
                ? ApplicationSubmissionList(submissions: [ApplicationSubmission(id: 2)], total: 2)
                : ApplicationSubmissionList(submissions: [ApplicationSubmission(id: 1)], total: 2, page: 2)
        }
        let model = ApplicationSubmissionsModel(server: "9", session: makeSignedInSession(clients: clients))
        model.formFilter = 3
        await model.load()
        let first = try #require(clients.calls.last?.endpoint as? Endpoints.ApplicationSubmissions)
        #expect(first.formID == 3)
        model.formFilter = nil
        await model.loadMore()
        let second = try #require(clients.calls.last?.endpoint as? Endpoints.ApplicationSubmissions)
        #expect(second.page == 2)
        #expect(second.formID == 3)
    }
}
