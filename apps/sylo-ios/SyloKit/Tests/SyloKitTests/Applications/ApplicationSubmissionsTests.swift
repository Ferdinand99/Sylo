import Foundation
import Testing
@testable import SyloKit

@Suite("Application submissions")
struct ApplicationSubmissionsDecodingTests {
    /// One submission as `submissionView` in src/web/routes/v2Applications.js sends it in the list.
    static let listJSON = #"""
    {
      "submissions": [
        {"id": 12, "formId": 3, "formName": "Staff", "userId": "810000000000000001", "userName": "Alex",
         "status": "pending", "source": "dm", "createdAt": 1794000000000, "decidedAt": null, "decidedBy": null,
         "decidedByName": null, "reason": "", "dmNote": "", "cleared": false, "hasPost": true, "rolesPending": []},
        {"id": 11, "formId": 3, "formName": "Staff", "userId": "810000000000000002", "userName": null,
         "status": "denied", "source": "web", "createdAt": 1793990000000, "decidedAt": 1793999000000,
         "decidedBy": "820000000000000001", "decidedByName": "Mod", "reason": "Too young", "dmNote": "",
         "cleared": false, "hasPost": false,
         "rolesPending": [{"op": "add", "roleId": "111111111111111111", "roleName": "Applicant"}]}
      ],
      "total": 31, "page": 1, "pageSize": 25
    }
    """#

    /// The same with `full: true`.
    static let detailJSON = #"""
    {
      "submission": {
        "id": 12, "formId": 3, "formName": "Staff", "userId": "810000000000000001", "userName": "Alex",
        "status": "pending", "source": "dm", "createdAt": 1794000000000, "decidedAt": null, "decidedBy": null,
        "decidedByName": null, "reason": "", "dmNote": "", "cleared": false, "hasPost": true, "rolesPending": [],
        "answers": [
          {"id": "q1", "label": "Why do you want to join?", "type": "text", "required": true, "answer": "I like helping."},
          {"id": "q2", "label": "Are you 18?", "type": "yesno", "required": true, "answer": "Yes"},
          {"id": "q3", "label": "Anything else?", "type": "text", "required": false, "answer": ""}
        ],
        "history": [
          {"at": 1794000000000, "by": "810000000000000001", "byName": "Alex", "action": "submitted", "note": "dm"}
        ]
      }
    }
    """#

    @Test("the list decodes each application, the paging and the roles still waiting")
    func decodesList() throws {
        let list = try JSONDecoder().decode(ApplicationSubmissionList.self, from: Data(Self.listJSON.utf8))
        #expect(list.total == 31)
        #expect(list.page == 1)
        #expect(list.pageSize == 25)
        #expect(list.submissions.map(\.id) == [12, 11])

        let pending = list.submissions[0]
        #expect(pending.formName == "Staff")
        #expect(pending.applicantName == "Alex")
        #expect(pending.status == .pending)
        #expect(pending.source == "dm")
        #expect(pending.createdDate == Date(timeIntervalSince1970: 1_794_000_000))
        #expect(pending.decidedDate == nil)
        #expect(pending.answers.isEmpty)

        let denied = list.submissions[1]
        #expect(denied.applicantName == "810000000000000002")
        #expect(denied.status == .denied)
        #expect(denied.source == "web")
        #expect(denied.reason == "Too young")
        #expect(denied.decidedByName == "Mod")
        #expect(denied.decidedDate == Date(timeIntervalSince1970: 1_793_999_000))
        #expect(denied.rolesPending == [ApplicationRoleChange(op: "add", roleName: "Applicant")])
    }

    @Test("the detail adds the answers, as the server worded them, and the history")
    func decodesDetail() throws {
        let detail = try JSONDecoder().decode(ApplicationSubmissionDetail.self, from: Data(Self.detailJSON.utf8))
        let submission = detail.submission
        #expect(submission.id == 12)
        #expect(submission.answers.map(\.id) == ["q1", "q2", "q3"])
        #expect(submission.answers[0].answer == "I like helping.")
        #expect(submission.answers[1].type == "yesno")
        #expect(submission.answers[2].answer.isEmpty)
        #expect(!submission.answers[2].required)
        #expect(submission.history.count == 1)
        #expect(submission.history[0].action == "submitted")
        #expect(submission.history[0].byName == "Alex")
        #expect(submission.history[0].date == Date(timeIntervalSince1970: 1_794_000_000))
    }

    @Test("an unknown status is kept, the four known ones are the filters")
    func statuses() throws {
        let odd = try JSONDecoder().decode(ApplicationSubmission.self, from: Data(#"{"id":1,"status":"on_hold"}"#.utf8))
        #expect(odd.status == .other("on_hold"))
        #expect(odd.status.rawValue == "on_hold")
        #expect(ApplicationStatus.filters.map(\.rawValue) == ["pending", "accepted", "denied", "withdrawn"])
        #expect(ApplicationStatus(rawValue: "withdrawn") == .withdrawn)
    }

    @Test("an application with only an id still reads, and a broken one is dropped from the list")
    func lenient() throws {
        let bare = try JSONDecoder().decode(ApplicationSubmission.self, from: Data(#"{"id":5}"#.utf8))
        #expect(bare.status == .pending)
        #expect(bare.source == "dm")
        #expect(bare.formName.isEmpty)
        #expect(bare.history.isEmpty)
        let list = try JSONDecoder().decode(
            ApplicationSubmissionList.self, from: Data(#"{"submissions":[{"status":"pending"},{"id":2}]}"#.utf8))
        #expect(list.submissions.map(\.id) == [2])
        #expect(list.total == 1)
    }

    @Test("a decision answers with the application, what went wrong and whether the DM went out")
    func decodesDecision() throws {
        let json = Data(#"""
        {"ok": true, "warnings": ["Some roles could not be changed. Retry from the dashboard."], "dm": false,
         "submission": {"id": 12, "status": "accepted", "reason": "Welcome!", "decidedByName": "Mod"}}
        """#.utf8)
        let decision = try JSONDecoder().decode(ApplicationDecision.self, from: json)
        #expect(decision.submission.status == .accepted)
        #expect(decision.submission.reason == "Welcome!")
        #expect(decision.warnings.count == 1)
        #expect(!decision.dm)
        #expect(ApplicationDecisionAction.accept.resultingStatus == .accepted)
        #expect(ApplicationDecisionAction.deny.resultingStatus == .denied)
    }
}

@Suite("Application endpoints")
struct ApplicationEndpointsTests {
    let fluxer: ServerID = "fluxer:1"

    @Test("the list is a GET, filtered by status and paged")
    func list() {
        let all = Endpoints.ApplicationSubmissions(server: fluxer)
        #expect(all.path == "/api/v2/guilds/fluxer%3A1/applications/submissions")
        #expect(all.method == .get)
        #expect(all.body == nil)
        #expect(all.requiresAuth)
        #expect(all.query.isEmpty)
        let page = Endpoints.ApplicationSubmissions(server: "1", status: .denied, page: 2)
        #expect(page.query == [URLQueryItem(name: "status", value: "denied"), URLQueryItem(name: "page", value: "2")])
        #expect(Endpoints.ApplicationSubmissions(server: "1", status: .pending).query
            == [URLQueryItem(name: "status", value: "pending")])
    }

    @Test("one application is a GET below the submissions path")
    func detail() {
        let e = Endpoints.ApplicationSubmissionByID(server: fluxer, id: 12)
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/applications/submissions/12")
        #expect(e.method == .get)
        #expect(e.requiresAuth)
    }

    @Test("a decision posts the action and the reason")
    func decide() throws {
        let e = Endpoints.DecideApplication(server: fluxer, id: 12, action: .deny, reason: "Too young")
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/applications/submissions/12/decide")
        #expect(e.method == .post)
        #expect(e.requiresAuth)
        let body = try #require(e.body)
        let sent = try JSONDecoder().decode([String: String].self, from: JSONEncoder().encode(body))
        #expect(sent == ["action": "deny", "reason": "Too young"])
        let accept = Endpoints.DecideApplication(server: "1", id: 1, action: .accept)
        let acceptBody = try #require(accept.body)
        #expect(try JSONDecoder().decode([String: String].self, from: JSONEncoder().encode(acceptBody))
            == ["action": "accept", "reason": ""])
    }
}

@MainActor
@Suite("Application models")
struct ApplicationModelsTests {
    nonisolated static func submission(_ id: Int, status: ApplicationStatus = .pending) -> ApplicationSubmission {
        ApplicationSubmission(id: id, formName: "Staff", userId: "\(id)", userName: "User \(id)", status: status)
    }

    @Test("the inbox starts on pending ones and pages without repeating an application")
    func inbox() async throws {
        let clients = StubClients { endpoint in
            guard let call = endpoint as? Endpoints.ApplicationSubmissions else { throw NetworkError.notFound }
            return call.page == 1
                ? ApplicationSubmissionList(submissions: [Self.submission(3), Self.submission(2)], total: 3)
                : ApplicationSubmissionList(submissions: [Self.submission(2), Self.submission(1)], total: 3, page: 2)
        }
        let model = ApplicationSubmissionsModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(model.filter == .pending)
        await model.load()
        #expect(model.hasLoaded)
        #expect(model.submissions.map(\.id) == [3, 2])
        #expect(model.canLoadMore)
        let first = try #require(clients.calls.last?.endpoint as? Endpoints.ApplicationSubmissions)
        #expect(first.status == .pending)

        await model.loadMore()
        #expect(model.submissions.map(\.id) == [3, 2, 1])
        #expect(!model.canLoadMore)
        let second = try #require(clients.calls.last?.endpoint as? Endpoints.ApplicationSubmissions)
        #expect(second.page == 2)
        #expect(second.status == .pending)
    }

    @Test("changing the filter and loading again asks for that status, and all when it is nil")
    func filters() async throws {
        let clients = StubClients { _ in ApplicationSubmissionList() }
        let model = ApplicationSubmissionsModel(server: "9", session: makeSignedInSession(clients: clients))
        model.filter = .accepted
        await model.load()
        #expect((clients.calls.last?.endpoint as? Endpoints.ApplicationSubmissions)?.status == .accepted)
        model.filter = nil
        await model.load()
        let last = try #require(clients.calls.last?.endpoint as? Endpoints.ApplicationSubmissions)
        #expect(last.status == nil)
    }

    @Test("a failed load explains and keeps the list")
    func failedLoad() async {
        let clients = StubClients { _ in ApplicationSubmissionList(submissions: [Self.submission(1)]) }
        let model = ApplicationSubmissionsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        clients.setHandler { _ in throw NetworkError.forbidden }
        await model.load()
        #expect(model.submissions.count == 1)
        #expect(model.errorMessage == NetworkError.forbidden.userMessage)
    }

    @Test("an application loads with its answers")
    func loadsDetail() async throws {
        let full = ApplicationSubmission(id: 12, status: .pending, answers: [ApplicationAnswer(id: "q", label: "Why?", answer: "Fun")])
        let clients = StubClients { _ in ApplicationSubmissionDetail(submission: full) }
        let model = ApplicationSubmissionModel(server: "9", submissionID: 12, session: makeSignedInSession(clients: clients))
        #expect(!model.canDecide)
        await model.load()
        #expect(model.submission == full)
        #expect(model.canDecide)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.ApplicationSubmissionByID)
        #expect(sent.id == 12)
    }

    @Test("denying sends the trimmed reason, takes the answer's application, and notes what failed")
    func decides() async throws {
        let clients = StubClients { endpoint in
            if let call = endpoint as? Endpoints.DecideApplication {
                return ApplicationDecision(
                    submission: ApplicationSubmission(id: call.id, status: call.action.resultingStatus, reason: call.reason),
                    warnings: ["Skipped 1 role the form no longer gives or Sylo cannot manage."], dm: false)
            }
            return ApplicationSubmissionDetail(submission: ApplicationSubmission(id: 12, status: .pending))
        }
        let model = ApplicationSubmissionModel(server: "9", submissionID: 12, session: makeSignedInSession(clients: clients))
        await model.load()
        let ok = await model.decide(.deny, reason: "  Not this time \n")
        #expect(ok)
        #expect(model.submission?.status == .denied)
        #expect(model.submission?.reason == "Not this time")
        #expect(!model.canDecide)
        #expect(model.decisionCount == 1)
        #expect(model.decisionNotes.count == 2)
        #expect(model.decisionNotes.last?.contains("DM") == true)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.DecideApplication)
        #expect(sent.action == .deny)
        #expect(sent.reason == "Not this time")

        // Already decided: nothing more is sent.
        let calls = clients.calls.count
        #expect(await model.decide(.accept, reason: "") == false)
        #expect(clients.calls.count == calls)
    }

    @Test("a reason longer than the server keeps is cut before it is sent")
    func cutsReason() async throws {
        let clients = StubClients { endpoint in
            if let call = endpoint as? Endpoints.DecideApplication {
                return ApplicationDecision(submission: ApplicationSubmission(id: call.id, status: .accepted))
            }
            return ApplicationSubmissionDetail(submission: ApplicationSubmission(id: 12))
        }
        let model = ApplicationSubmissionModel(server: "9", submissionID: 12, session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(await model.decide(.accept, reason: String(repeating: "a", count: 800)))
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.DecideApplication)
        #expect(sent.reason.count == ApplicationSubmissionModel.maxReasonLength)
        #expect(model.decisionNotes.isEmpty)
    }

    @Test("a decision someone else made first explains, and loads the application again")
    func alreadyDecided() async throws {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.DecideApplication { throw NetworkError.http(status: 409) }
            return ApplicationSubmissionDetail(submission: ApplicationSubmission(id: 12, status: .pending))
        }
        let model = ApplicationSubmissionModel(server: "9", submissionID: 12, session: makeSignedInSession(clients: clients))
        await model.load()
        clients.setHandler { endpoint in
            if endpoint is Endpoints.DecideApplication { throw NetworkError.http(status: 409) }
            return ApplicationSubmissionDetail(submission: ApplicationSubmission(id: 12, status: .accepted))
        }
        #expect(await model.decide(.deny, reason: "") == false)
        #expect(model.actionError?.contains("already decided") == true)
        #expect(model.submission?.status == .accepted)
        #expect(model.decisionCount == 0)
    }

    @Test("any other failure keeps the application open and says why")
    func failedDecision() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.DecideApplication { throw NetworkError.rateLimited }
            return ApplicationSubmissionDetail(submission: ApplicationSubmission(id: 12, status: .pending))
        }
        let model = ApplicationSubmissionModel(server: "9", submissionID: 12, session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(await model.decide(.accept, reason: "") == false)
        #expect(model.actionError == NetworkError.rateLimited.userMessage)
        #expect(model.submission?.status == .pending)
        #expect(model.canDecide)
    }
}
