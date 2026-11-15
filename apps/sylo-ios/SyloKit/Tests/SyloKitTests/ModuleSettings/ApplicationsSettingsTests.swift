import Foundation
import Testing
@testable import SyloKit

@Suite("Applications settings")
struct ApplicationsSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/applications/config`, shaped like src/web/routes/v2Applications.js
    /// (a form as `formView` sends it: the form's own settings plus `version` and `problems`).
    static let pageJSON = #"""
    {
      "config": {
        "retentionDays": 90,
        "panelChannelId": "222222222222222222",
        "panelMessageId": "333333333333333333",
        "panelText": "Apply here"
      },
      "forms": [
        {"id": 3, "name": "Staff", "description": "", "enabled": true, "fillMode": "both", "timeoutMinutes": 30,
         "questions": [{"id": "q1", "type": "text", "label": "Why?"}, {"id": "q2", "type": "yesno", "label": "Adult?"}],
         "pendingChannelId": "222222222222222222", "version": 1794000000000,
         "problems": {"setup": null, "roles": "Sylo cannot manage the role Admin."}},
        {"id": 4, "name": "Builder", "enabled": false, "fillMode": "web", "questions": [],
         "version": 1794000000001, "problems": {"setup": "The form has no questions.", "roles": null}}
      ],
      "maxForms": 10,
      "shortTextMax": 1024,
      "defaultMessages": {"start": "x"},
      "defaultRetentionDays": 180,
      "defaultPanelText": "Press a button to apply.",
      "placeholders": ["{user}"],
      "channels": [{"id": "222222222222222222", "name": "applications"}],
      "roles": [{"id": "111111111111111111", "name": "Staff"}],
      "pending": 4,
      "webAddress": "https://sylo.example.com/apply/1/<form>",
      "threads": true
    }
    """#

    static func decodePage() throws -> ApplicationsPage {
        try JSONDecoder().decode(ApplicationsPage.self, from: Data(pageJSON.utf8))
    }

    @Test("the page decodes the settings, the forms and the counts")
    func decodesPage() throws {
        let page = try Self.decodePage()
        #expect(ApplicationsPage.moduleID == "applications")
        #expect(page.settings.retentionDays == 90)
        #expect(page.settings.panelText == "Apply here")
        #expect(page.settings.isPanelPublished)
        #expect(page.pending == 4)
        #expect(page.maxForms == 10)
        #expect(page.defaultRetentionDays == 180)
        #expect(page.defaultPanelText == "Press a button to apply.")
        #expect(page.channels.map(\.name) == ["applications"])
        #expect(page.roles.map(\.name) == ["Staff"])

        #expect(page.forms.count == 2)
        let staff = page.forms[0]
        #expect(staff.id == 3)
        #expect(staff.name == "Staff")
        #expect(staff.isEnabled)
        #expect(staff.fillMode == .both)
        #expect(staff.questionCount == 2)
        #expect(staff.setupProblem == nil)
        #expect(staff.rolesProblem == "Sylo cannot manage the role Admin.")
        let builder = page.forms[1]
        #expect(!builder.isEnabled)
        #expect(builder.fillMode == .web)
        #expect(builder.questionCount == 0)
        #expect(builder.setupProblem == "The form has no questions.")
        #expect(builder.rolesProblem == nil)
    }

    @Test("missing fields fall back to the server's defaults")
    func lenientDecoding() throws {
        let page = try JSONDecoder().decode(ApplicationsPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(page.settings == ApplicationsSettings())
        #expect(page.settings.retentionDays == 180)
        #expect(page.settings.panelText.isEmpty)
        #expect(!page.settings.isPanelPublished)
        #expect(page.forms.isEmpty)
        #expect(page.pending == 0)
    }

    @Test("a form that cannot be read is dropped, an unknown fill mode is kept")
    func lossyForms() throws {
        let json = Data(#"{"forms":[{"name":"no id"},{"id":1,"name":"A","fillMode":"carrier-pigeon"}]}"#.utf8)
        let page = try JSONDecoder().decode(ApplicationsPage.self, from: json)
        #expect(page.forms.map(\.id) == [1])
        #expect(page.forms[0].fillMode == .other("carrier-pigeon"))
        #expect(page.forms[0].fillMode.rawValue == "carrier-pigeon")
        #expect(ApplicationFillMode(rawValue: "discord") == .discord)
    }

    @Test("saving sends what the web dashboard sends: the retention and the panel text, never the panel's ids")
    func encodesBody() throws {
        let page = try Self.decodePage()
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["retentionDays", "panelText"])
        #expect(body["retentionDays"] as? Int == 90)
        #expect(body["panelText"] as? String == "Apply here")
    }

    @Test("the limits are the server's")
    func limits() {
        #expect(ApplicationsSettings.retentionRange == 7...3650)
        #expect(ApplicationsSettings.maxPanelTextLength == 500)
    }

    @Test("the model saves an edit")
    @MainActor
    func modelSaves() async throws {
        let clients = StubClients { endpoint in
            if let saving = endpoint as? Endpoints.SaveModuleSettings<ApplicationsPage> {
                return SavedModuleSettings(settings: saving.settings)
            }
            return try Self.decodePage()
        }
        let model = ModuleSettingsModel<ApplicationsPage>(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(!model.hasChanges)
        model.draft?.retentionDays = 365
        #expect(model.hasChanges)
        #expect(await model.save())
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.SaveModuleSettings<ApplicationsPage>)
        #expect(sent.path == "/api/v2/guilds/9/modules/applications/config")
        #expect(sent.settings.retentionDays == 365)
        #expect(model.page?.forms.count == 2)
    }
}
