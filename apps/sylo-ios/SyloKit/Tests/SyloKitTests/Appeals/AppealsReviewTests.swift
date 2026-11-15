import Foundation
import Testing
@testable import SyloKit

@Suite("Appeals review")
struct AppealsReviewDecodingTests {
    /// `GET /appeals` as src/web/routes/v2Staff.js sends it.
    static let json = #"""
    {
      "appeals": [
        {"id": 7, "user": "Alex#0", "userId": "810000000000000001", "banReason": "Spam",
         "answers": [{"q": "Why should we unban you?", "a": "It was a mistake."}, {"q": "Anything else?", "a": ""}],
         "status": "open", "decidedBy": null, "decisionReason": null, "ago": "2h ago", "decidedAgo": null,
         "at": 1794000000000, "decidedAt": null},
        {"id": 6, "user": "810000000000000002", "userId": "810000000000000002", "banReason": "—",
         "answers": [], "status": "denied", "decidedBy": "Mod (dashboard)", "decisionReason": "Not this time",
         "ago": "3d ago", "decidedAgo": "2d ago", "at": 1793700000000, "decidedAt": 1793800000000}
      ],
      "open": 1, "moduleEnabled": true, "configured": false
    }
    """#

    @Test("the appeals decode with their answers, the decision and the module state")
    func decodes() throws {
        let review = try JSONDecoder().decode(AppealsReview.self, from: Data(Self.json.utf8))
        #expect(review.open == 1)
        #expect(review.moduleEnabled)
        #expect(!review.configured)
        #expect(review.appeals.map(\.id) == [7, 6])

        let open = review.appeals[0]
        #expect(open.isOpen)
        #expect(open.memberName == "Alex#0")
        #expect(open.banReason == "Spam")
        #expect(open.answers == [
            AppealAnswer(question: "Why should we unban you?", answer: "It was a mistake."),
            AppealAnswer(question: "Anything else?", answer: ""),
        ])
        #expect(open.date == Date(timeIntervalSince1970: 1_794_000_000))
        #expect(open.decidedBy == nil)
        #expect(open.decisionReason.isEmpty)
        #expect(open.decidedDate == nil)

        let denied = review.appeals[1]
        #expect(!denied.isOpen)
        #expect(denied.status == .denied)
        #expect(denied.memberName == "810000000000000002")
        // The dash the server sends for "no ban reason" is not a reason.
        #expect(denied.banReason.isEmpty)
        #expect(denied.decidedBy == "Mod (dashboard)")
        #expect(denied.decisionReason == "Not this time")
        #expect(denied.decidedDate == Date(timeIntervalSince1970: 1_793_800_000))
    }

    @Test("a bare appeal reads as open, an unknown status is kept, a broken entry is dropped")
    func lenient() throws {
        let bare = try JSONDecoder().decode(Appeal.self, from: Data(#"{"id":5}"#.utf8))
        #expect(bare.status == .open)
        #expect(bare.answers.isEmpty)
        let odd = try JSONDecoder().decode(Appeal.self, from: Data(#"{"id":5,"status":"withdrawn"}"#.utf8))
        #expect(odd.status == .other("withdrawn"))
        #expect(odd.status.rawValue == "withdrawn")
        let list = try JSONDecoder().decode(
            AppealsReview.self, from: Data(#"{"appeals":[{"status":"open"},{"id":2}]}"#.utf8))
        #expect(list.appeals.map(\.id) == [2])
        // Counted from the list when the server does not say.
        #expect(list.open == 1)
        #expect(list.moduleEnabled)
        #expect(list.configured)
    }

    @Test("a decision answers with the status, the DM and whether the ban was lifted")
    func decisionResult() throws {
        let result = try JSONDecoder().decode(
            AppealDecisionResult.self,
            from: Data(#"{"ok": true, "status": "accepted", "dmDelivered": false, "unbanned": true}"#.utf8))
        #expect(result == AppealDecisionResult(status: .accepted, dmDelivered: false, unbanned: true))
        #expect(AppealDecision.accept.resultingStatus == .accepted)
        #expect(AppealDecision.deny.resultingStatus == .denied)
    }
}

@Suite("Appeals endpoints")
struct AppealsEndpointsTests {
    @Test("the inbox is a GET")
    func load() {
        let e = Endpoints.LoadAppeals(server: "fluxer:1")
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/appeals")
        #expect(e.method == .get)
        #expect(e.body == nil)
        #expect(e.requiresAuth)
    }

    @Test("a decision posts `decision` (not `action`) and the note")
    func decide() throws {
        let e = Endpoints.DecideAppeal(server: "fluxer:1", id: 7, decision: .deny, reason: "Not this time")
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/appeals/7/decide")
        #expect(e.method == .post)
        #expect(e.requiresAuth)
        let body = try #require(e.body)
        let sent = try JSONDecoder().decode([String: String].self, from: JSONEncoder().encode(body))
        #expect(sent == ["decision": "deny", "reason": "Not this time"])
        let accept = Endpoints.DecideAppeal(server: "1", id: 1, decision: .accept)
        let acceptBody = try #require(accept.body)
        #expect(try JSONDecoder().decode([String: String].self, from: JSONEncoder().encode(acceptBody))
            == ["decision": "accept", "reason": ""])
    }
}

@MainActor
@Suite("Appeals model")
struct AppealsReviewModelTests {
    nonisolated static func appeal(_ id: Int, status: AppealStatus = .open) -> Appeal {
        Appeal(id: id, user: "User \(id)", userId: "\(id)", status: status)
    }

    @Test("the inbox splits open and decided, and tells the badge how many are open")
    func inbox() async {
        let stub = StubClients { _ in
            AppealsReview(appeals: [Self.appeal(3), Self.appeal(2, status: .accepted), Self.appeal(1)])
        }
        let model = AppealsReviewModel(server: "9", session: makeSignedInSession(clients: stub))
        var counts: [Int] = []
        model.onOpenCount = { counts.append($0) }
        #expect(!model.hasLoaded)
        await model.load()
        #expect(model.open.map(\.id) == [3, 1])
        #expect(model.decided.map(\.id) == [2])
        #expect(counts == [2])
    }

    @Test("a failed load explains in the server's words and keeps the list")
    func failedLoad() async {
        let stub = StubClients { _ in AppealsReview(appeals: [Self.appeal(1)]) }
        let model = AppealsReviewModel(server: "9", session: makeSignedInSession(clients: stub))
        await model.load()
        stub.setHandler { _ in throw NetworkError.forbidden(message: "You need Manage Server.") }
        await model.load()
        #expect(model.review?.appeals.count == 1)
        #expect(model.errorMessage == "You need Manage Server.")
    }

    @Test("accepting sends the trimmed note, reloads, and notes a ban that was not lifted and a missed DM")
    func accepts() async throws {
        let stub = StubClients { endpoint in
            if endpoint is Endpoints.DecideAppeal {
                return AppealDecisionResult(status: .accepted, dmDelivered: false, unbanned: false)
            }
            return AppealsReview(appeals: [Self.appeal(7, status: .accepted)])
        }
        let model = AppealsReviewModel(server: "9", session: makeSignedInSession(clients: stub))
        let ok = await model.decide(Self.appeal(7), .accept, reason: "  Welcome back \n")
        #expect(ok)
        #expect(model.decisionSummary == "Appeal accepted.")
        #expect(model.decisionAppealID == 7)
        #expect(model.decisionNotes == [
            "The ban could not be lifted. Unban them manually.", "The member could not be sent a DM.",
        ])
        #expect(model.decisionCount == 1)
        #expect(model.open.isEmpty)
        let sent = try #require(stub.calls.compactMap { $0.endpoint as? Endpoints.DecideAppeal }.first)
        #expect(sent.decision == .accept)
        #expect(sent.reason == "Welcome back")
        #expect(stub.calls.last?.endpoint is Endpoints.LoadAppeals)
    }

    @Test("a clean denial has no notes, and the note is cut at 1000 characters")
    func denies() async throws {
        let stub = StubClients { endpoint in
            if endpoint is Endpoints.DecideAppeal { return AppealDecisionResult(status: .denied, dmDelivered: true) }
            return AppealsReview()
        }
        let model = AppealsReviewModel(server: "9", session: makeSignedInSession(clients: stub))
        #expect(await model.decide(Self.appeal(7), .deny, reason: String(repeating: "n", count: 1500)))
        #expect(model.decisionSummary == "Appeal denied.")
        #expect(model.decisionNotes.isEmpty)
        let sent = try #require(stub.calls.compactMap { $0.endpoint as? Endpoints.DecideAppeal }.first)
        #expect(sent.reason.count == 1000)
    }

    @Test("an appeal that was already decided shows the server's text, reloads, and sends nothing for a decided one")
    func alreadyDecided() async {
        let stub = StubClients { endpoint in
            if endpoint is Endpoints.DecideAppeal {
                throw NetworkError.http(status: HTTPStatus(409, message: "This appeal has already been decided."))
            }
            return AppealsReview(appeals: [Self.appeal(7, status: .denied)])
        }
        let model = AppealsReviewModel(server: "9", session: makeSignedInSession(clients: stub))
        let ok = await model.decide(Self.appeal(7), .accept, reason: "")
        #expect(!ok)
        #expect(model.actionError == "This appeal has already been decided.")
        #expect(model.decisionCount == 0)
        #expect(model.open.isEmpty)

        let calls = stub.calls.count
        #expect(await model.decide(Self.appeal(7, status: .denied), .accept, reason: "") == false)
        #expect(stub.calls.count == calls)
    }

    @Test("a 409 without text still explains")
    func alreadyDecidedNoText() async {
        let stub = StubClients { endpoint in
            if endpoint is Endpoints.DecideAppeal { throw NetworkError.http(status: 409) }
            return AppealsReview()
        }
        let model = AppealsReviewModel(server: "9", session: makeSignedInSession(clients: stub))
        await model.decide(Self.appeal(7), .deny, reason: "")
        #expect(model.actionError == "Someone already decided this appeal. Refresh to see how.")
    }

    @Test("a refusal for another reason shows the server's text")
    func refusal() async {
        let stub = StubClients { endpoint in
            if endpoint is Endpoints.DecideAppeal { throw NetworkError.badRequest(message: "Choose accept or deny.") }
            return AppealsReview()
        }
        let model = AppealsReviewModel(server: "9", session: makeSignedInSession(clients: stub))
        #expect(await model.decide(Self.appeal(7), .deny, reason: "") == false)
        #expect(model.actionError == "Choose accept or deny.")
    }

    @Test("the badge is told again after every decision, with the count the reload found")
    func badgeAfterDecision() async {
        let stub = StubClients { endpoint in
            if endpoint is Endpoints.DecideAppeal { return AppealDecisionResult(status: .denied) }
            return AppealsReview(appeals: [Self.appeal(8)])
        }
        let model = AppealsReviewModel(server: "9", session: makeSignedInSession(clients: stub))
        var counts: [Int] = []
        model.onOpenCount = { counts.append($0) }
        await model.load()
        await model.decide(Self.appeal(7), .deny, reason: "")
        #expect(counts == [1, 1])
    }
}

@MainActor
@Suite("Open appeals badge")
struct OpenAppealsModelTests {
    @Test("the first look reads the open count")
    func refreshes() async throws {
        let stub = StubClients { _ in AppealsReview(appeals: [Appeal(id: 1), Appeal(id: 2, status: .denied)]) }
        let model = OpenAppealsModel(server: "9", session: makeSignedInSession(clients: stub))
        #expect(model.count == nil)
        await model.refresh()
        #expect(model.count == 1)
        #expect(stub.calls.last?.endpoint is Endpoints.LoadAppeals)
    }

    @Test("a failed look leaves the count as it was")
    func failure() async {
        let stub = StubClients { _ in throw NetworkError.forbidden }
        let model = OpenAppealsModel(server: "9", session: makeSignedInSession(clients: stub))
        model.update(4)
        await model.refresh()
        #expect(model.count == 4)
    }

    @Test("a newer count is not overwritten by a slower, older answer")
    func newestWins() async throws {
        let gate = TestGate()
        let session = makeGatedAnswerSession(gate: gate) { _ in
            AppealsReview(appeals: [Appeal(id: 1), Appeal(id: 2), Appeal(id: 3)])
        }
        let model = OpenAppealsModel(server: "9", session: session)
        let look = Task { await model.refresh() }
        await waitForArrival(gate)
        #expect(gate.arrivals == 1)
        // The overview (or a decision) reports 2 while the first look is still on its way.
        model.update(2)
        gate.open()
        await look.value
        #expect(model.count == 2)
    }
}
