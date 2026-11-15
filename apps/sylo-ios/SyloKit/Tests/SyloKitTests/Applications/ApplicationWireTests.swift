import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import SyloKit

// What the Applications and Introductions editors put on the wire, through the real client and the mock
// URL protocol. They extend `APIClientTests` so they run one after another: the mock's state is shared.
extension APIClientTests {
    private func appsClient() throws -> URLSessionAPIClient {
        URLSessionAPIClient(
            server: try ServerURL("https://example.com/sylo"), session: MockURLProtocol.session(),
            decoder: JSONDecoder(), retryDelays: [.zero, .zero], token: { "sylo_secret" })
    }

    private func appsBody(_ mock: MockState) throws -> [String: Any] {
        let body = try #require(mock.requests.first?.body)
        return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    @Test("Creating a form posts every editor field to the forms path and reads the stored form back")
    func createFormOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"form":"# + ApplicationFormsTests.formJSON + #"}"#)])
        var form = ApplicationForm.blank(
            messages: ApplicationFormMessages(start: "Hi", completed: "Done", accepted: "Yes", denied: "No"))
        form.name = "Staff"
        form.addQuestion()
        form.questions[0].label = "Why?"
        form.questions[0].required = true
        let saved = try await appsClient().send(Endpoints.SaveApplicationForm(server: "1", form: form))
        #expect(saved.form.id == 3)
        #expect(saved.form.questions.count == 4)

        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/applications/forms")
        #expect(request.method == "POST")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
        #expect(request.header("Content-Type")?.hasPrefix("application/json") == true)
        let json = try appsBody(mock)
        #expect(Set(json.keys) == ApplicationFormsTests.formKeys)
        #expect(json["name"] as? String == "Staff")
        let questions = try #require(json["questions"] as? [[String: Any]])
        #expect(questions.count == 1)
        #expect(Set(questions[0].keys) == ApplicationFormsTests.questionKeys)
        #expect(questions[0]["required"] as? Bool == true)
        #expect((questions[0]["id"] as? String)?.isEmpty == false)
    }

    @Test("Saving an existing form posts to its own path")
    func saveFormOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"form":"# + ApplicationFormsTests.formJSON + #"}"#)])
        var form = try ApplicationFormsTests.decodeForm()
        form.description = "Changed"
        _ = try await appsClient().send(Endpoints.SaveApplicationForm(server: "1", form: form))
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/applications/forms/3")
        #expect(try appsBody(mock)["description"] as? String == "Changed")
    }

    @Test("A refused form shows the server's reason, and a form that is gone is a not-found")
    func refusedFormOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(400, #"{"error":"The form cannot be enabled yet: No channel is set for new applications."}"#)])
        let form = ApplicationForm(id: 3, name: "Staff", enabled: true)
        await #expect(throws: NetworkError.badRequest(message: "The form cannot be enabled yet: No channel is set for new applications.")) {
            try await appsClient().send(Endpoints.SaveApplicationForm(server: "1", form: form))
        }
        mock.reset([.json(404, #"{"error":"No such form."}"#)])
        await #expect(throws: NetworkError.notFound) {
            try await appsClient().send(Endpoints.DeleteApplicationForm(server: "1", id: 3))
        }
    }

    @Test("Deleting a form posts an empty object, reordering posts the ids")
    func deleteAndReorderOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"ok":true}"#)])
        _ = try await appsClient().send(Endpoints.DeleteApplicationForm(server: "1", id: 3))
        var request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/applications/forms/3/delete")
        #expect(request.method == "POST")
        #expect(request.body == Data("{}".utf8))

        mock.reset([.json(200, #"{"forms":[{"id":2,"name":"B"},{"id":1,"name":"A"}]}"#)])
        let list = try await appsClient().send(Endpoints.ReorderApplicationForms(server: "1", ids: [2, 1]))
        #expect(list.forms.map(\.id) == [2, 1])
        request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/applications/forms/reorder")
        #expect(try appsBody(mock)["ids"] as? [Int] == [2, 1])
    }

    @Test("Publishing the panel posts the channel and text, and a missing permission comes back as the server's words")
    func panelOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"config":{"retentionDays":90,"panelText":"Apply","panelChannelId":"222222222222222222","panelMessageId":"333333333333333333"},"warning":"Sylo could not pin it."}"#)])
        let result = try await appsClient().send(
            Endpoints.PublishApplicationsPanel(server: "1", channelId: "222222222222222222", text: "Apply"))
        #expect(result.settings.isPanelPublished)
        #expect(result.warning == "Sylo could not pin it.")
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/applications/panel/publish")
        #expect(request.method == "POST")
        let json = try appsBody(mock)
        #expect(Set(json.keys) == ["channelId", "text"])
        #expect(json["channelId"] as? String == "222222222222222222")

        mock.reset([.json(400, #"{"error":"Sylo needs View Channel, Read Message History, Send Messages and Embed Links in that channel."}"#)])
        do {
            _ = try await appsClient().send(
                Endpoints.PublishApplicationsPanel(server: "1", channelId: "222222222222222222", text: ""))
            Issue.record("the publish should have been refused")
        } catch {
            let error = NetworkError(error)
            #expect(EditorFailure.message(for: error).hasPrefix("Sylo needs View Channel"))
        }
    }

    @Test("Removing the panel posts an empty object; a delete Sylo may not do is a 502")
    func unpublishPanelOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"config":{"retentionDays":180,"panelText":"","panelChannelId":"","panelMessageId":""}}"#)])
        let result = try await appsClient().send(Endpoints.UnpublishApplicationsPanel(server: "1"))
        #expect(!result.settings.isPanelPublished)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/applications/panel/unpublish")
        #expect(request.body == Data("{}".utf8))

        mock.reset([.json(502, #"{"error":"Sylo could not delete the panel message: it needs Manage Messages in that channel."}"#)])
        await #expect(throws: NetworkError.server(status: 502)) {
            try await appsClient().send(Endpoints.UnpublishApplicationsPanel(server: "1"))
        }
    }

    @Test("Retrying roles, deleting an application and the member history use the staff paths")
    func submissionActionsOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"ok":true,"remaining":0,"applied":1,"submission":{"id":12,"status":"accepted"}}"#)])
        let retry = try await appsClient().send(Endpoints.RetryApplicationRoles(server: "1", id: 12))
        #expect(retry.applied == 1)
        #expect(retry.submission?.status == .accepted)
        var request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/applications/submissions/12/retry-roles")
        #expect(request.method == "POST")

        mock.reset([.json(200, #"{"ok":true}"#)])
        _ = try await appsClient().send(Endpoints.DeleteApplicationSubmission(server: "1", id: 12))
        request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/applications/submissions/12/delete")
        #expect(request.method == "POST")

        mock.reset([.json(200, #"{"userId":"810000000000000001","userName":"Alex","submissions":[{"id":3,"status":"pending"}]}"#)])
        let history = try await appsClient().send(Endpoints.ApplicantHistoryOf(server: "1", userID: "810000000000000001"))
        #expect(history.displayName == "Alex")
        #expect(history.submissions.map(\.id) == [3])
        request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/applications/members/810000000000000001")
        #expect(request.method == "GET")
    }

    @Test("The inbox asks for one form with formId")
    func inboxFormOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"submissions":[],"total":0,"page":1,"pageSize":25}"#)])
        _ = try await appsClient().send(Endpoints.ApplicationSubmissions(server: "1", status: .pending, formID: 3))
        let url = try #require(mock.requests.first?.url)
        #expect(url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/applications/submissions?status=pending&formId=3")
    }

    @Test("Saving the Applications settings still posts only the retention and the panel text")
    func saveApplicationsSettingsOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"config":{"retentionDays":365,"panelText":"Hi"}}"#)])
        var settings = try ApplicationsSettingsTests.decodePage().settings
        settings.retentionDays = 365
        _ = try await appsClient().send(Endpoints.SaveModuleSettings<ApplicationsPage>(server: "1", settings: settings))
        #expect(Set(try appsBody(mock).keys) == ["retentionDays", "panelText"])
    }

    @Test("Publishing the Introductions prompt posts the form's channel and text, and removing it posts an empty object")
    func introPromptOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"config":{"channelId":"222222222222222222","promptText":"Hello","promptChannelId":"222222222222222222","promptMessageId":"333333333333333333"}}"#)])
        let result = try await appsClient().send(
            Endpoints.PublishIntroPrompt(server: "1", channelId: "222222222222222222", promptText: "Hello"))
        #expect(result.settings.isPromptPublished)
        var request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/introductions/prompt/publish")
        #expect(request.method == "POST")
        let json = try appsBody(mock)
        #expect(Set(json.keys) == ["channelId", "promptText"])
        #expect(json["promptText"] as? String == "Hello")

        mock.reset([.json(200, #"{"config":{"promptChannelId":"","promptMessageId":""}}"#)])
        let removed = try await appsClient().send(Endpoints.UnpublishIntroPrompt(server: "1"))
        #expect(!removed.settings.isPromptPublished)
        request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/introductions/prompt/unpublish")
        #expect(request.body == Data("{}".utf8))
    }

    @Test("Saving Introductions with an edited list posts the new question and the group, and still never the prompt's ids")
    func saveEditedIntroductionsOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"config":{}}"#)])
        var settings = try IntroductionsSettingsTests.decodePage().settings
        settings.addQuestion()
        settings.questions?[2].label = "Hobby"
        settings.addRoleGroup()
        settings.roleGroups[1].name = "Age"
        _ = try await appsClient().send(Endpoints.SaveModuleSettings<IntroductionsPage>(server: "1", settings: settings))
        let json = try appsBody(mock)
        let questions = try #require(json["questions"] as? [[String: Any]])
        #expect(questions.count == 3)
        #expect(questions[2]["label"] as? String == "Hobby")
        let groups = try #require(json["roleGroups"] as? [[String: Any]])
        #expect(groups.count == 2)
        #expect(groups[1]["name"] as? String == "Age")
        #expect(Set(groups[1].keys) == ["name", "roleIds", "hideWhenEmpty"])
        #expect(json["promptMessageId"] == nil)
        #expect(json["promptChannelId"] == nil)
    }
}
