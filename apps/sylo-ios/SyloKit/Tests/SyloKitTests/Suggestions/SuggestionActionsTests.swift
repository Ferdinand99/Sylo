import Foundation
import Testing
@testable import SyloKit

@Suite("Suggestion actions")
struct SuggestionActionsTests {
    let fluxer: ServerID = "fluxer:1"

    /// `GET /modules/suggestions/list` as src/web/routes/v2Suggestions.js sends it (Sylo 5.1 and later).
    static let listJSON = #"""
    {
      "suggestions": [
        {"id": 31, "number": 12, "title": "Movie night", "text": "Add a movie night", "status": "approved",
         "reason": "Starting next week", "up": 8, "down": 1, "anonymous": true, "authorId": "810000000000000001",
         "author": "Alex", "decidedBy": "820000000000000001", "decidedAt": 1794000000000, "createdAt": 1793990000000,
         "channelId": "333333333333333333", "canMoveBack": true},
        {"id": 30, "number": 11, "title": "", "text": "More emoji", "status": "open", "reason": "", "up": 2, "down": 0,
         "anonymous": false, "authorId": null, "author": null, "createdAt": 1793980000000,
         "channelId": "222222222222222222", "canMoveBack": false}
      ],
      "outside": 3
    }
    """#

    /// The same from a server before 5.1: no `canMoveBack`, no `outside`.
    static let oldListJSON = #"""
    {"suggestions": [{"id": 30, "number": 11, "title": "", "text": "More emoji", "status": "open", "reason": "",
                      "up": 2, "down": 0, "anonymous": false, "author": "Alex", "createdAt": 1793980000000}]}
    """#

    static func body(of endpoint: some APIEndpoint) throws -> [String: Any] {
        let body = try #require(endpoint.body)
        return try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
    }

    @Test("the list decodes whether a suggestion can move back, and how many in all can")
    func decodesList() throws {
        let answer = try JSONDecoder().decode(SuggestionListAnswer.self, from: Data(Self.listJSON.utf8))
        #expect(answer.outside == 3)
        #expect(answer.suggestions.map(\.number) == [12, 11])
        #expect(answer.suggestions[0].canMoveBack)
        #expect(answer.suggestions[0].isAnonymous)
        #expect(answer.suggestions[0].status == .approved)
        #expect(!answer.suggestions[1].canMoveBack)
        #expect(answer.suggestions[1].author == nil)
    }

    @Test("a server from before moving back sends neither key, so nothing can move back")
    func decodesOldList() throws {
        let answer = try JSONDecoder().decode(SuggestionListAnswer.self, from: Data(Self.oldListJSON.utf8))
        #expect(answer.outside == 0)
        #expect(answer.suggestions.map(\.canMoveBack) == [false])
    }

    @Test("the settings page carries the count of suggestions that can move back, 0 when the server sends none")
    func pageOutside() throws {
        let page = try JSONDecoder().decode(
            SuggestionsPage.self, from: Data(#"{"config":{},"suggestions":[],"outside":2}"#.utf8))
        #expect(page.outside == 2)
        let old = try JSONDecoder().decode(SuggestionsPage.self, from: Data(#"{"config":{},"suggestions":[]}"#.utf8))
        #expect(old.outside == 0)
    }

    @Test("a decision answers with the suggestion and what happened around it")
    func decodesDecision() throws {
        let json = Data(#"""
        {"suggestion": {"id": 31, "number": 12, "text": "Add a movie night", "status": "denied", "reason": "No"},
         "moved": true, "copied": false, "dm": true}
        """#.utf8)
        let answer = try JSONDecoder().decode(SuggestionDecisionAnswer.self, from: json)
        #expect(answer.suggestion.status == .denied)
        #expect(answer.moved)
        #expect(!answer.copied)
        #expect(answer.dm)
    }

    @Test("a batch of move all back reads the counts, the skipped ones and a stop")
    func decodesBatch() throws {
        let json = Data(#"""
        {"moved": 8, "remaining": 5, "failed": [{"number": 4, "error": "No access to the old post of #4."}], "next": 17,
         "error": "Stopped at #18: Sylo could not post in the suggestions channel."}
        """#.utf8)
        let batch = try JSONDecoder().decode(SuggestionMoveBatch.self, from: json)
        #expect(batch.moved == 8)
        #expect(batch.remaining == 5)
        #expect(batch.failed == [SuggestionMoveFailure(number: 4, error: "No access to the old post of #4.")])
        #expect(batch.next == 17)
        #expect(batch.error?.hasPrefix("Stopped at #18") == true)
        let clean = try JSONDecoder().decode(
            SuggestionMoveBatch.self, from: Data(#"{"moved":2,"remaining":0,"failed":[],"next":9}"#.utf8))
        #expect(clean.error == nil)
    }

    @Test("a suggestion can be set to every status but the one it has")
    func availableActions() {
        #expect(SuggestionAction.available(for: .open) == [.approve, .deny, .implement, .consider])
        #expect(SuggestionAction.available(for: .approved) == [.deny, .implement, .consider])
        #expect(SuggestionAction.available(for: .considering) == [.approve, .deny, .implement])
        #expect(SuggestionAction.available(for: .other("on_hold")).count == 4)
        #expect(SuggestionAction.approve.resultingStatus == .approved)
        #expect(SuggestionAction.consider.resultingStatus == .considering)
    }

    @Test("the list is a GET with the filter and the order")
    func listEndpoint() {
        let all = Endpoints.SuggestionList(server: fluxer)
        #expect(all.path == "/api/v2/guilds/fluxer%3A1/modules/suggestions/list")
        #expect(all.method == .get)
        #expect(all.body == nil)
        #expect(all.requiresAuth)
        #expect(all.query == [URLQueryItem(name: "status", value: "all"), URLQueryItem(name: "sort", value: "new")])
        let top = Endpoints.SuggestionList(server: "1", status: .open, sort: .top)
        #expect(top.query == [URLQueryItem(name: "status", value: "open"), URLQueryItem(name: "sort", value: "top")])
        #expect(SuggestionFilter.allCases.map(\.rawValue) == ["all", "open", "approved", "denied", "implemented"])
    }

    @Test("a decision posts the action and the reason to the suggestion's number")
    func decisionEndpoint() throws {
        let e = Endpoints.DecideSuggestion(server: fluxer, number: 12, action: .deny, reason: "Not now")
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/modules/suggestions/12/decision")
        #expect(e.method == .post)
        #expect(e.requiresAuth)
        let body = try Self.body(of: e)
        #expect(Set(body.keys) == ["action", "reason"])
        #expect(body["action"] as? String == "deny")
        #expect(body["reason"] as? String == "Not now")
        let none = try Self.body(of: Endpoints.DecideSuggestion(server: "1", number: 1, action: .implement))
        #expect(none["reason"] as? String == "")
    }

    @Test("delete, move back and move all back are POSTs to their own paths")
    func otherEndpoints() throws {
        let delete = Endpoints.DeleteSuggestion(server: fluxer, number: 12)
        #expect(delete.path == "/api/v2/guilds/fluxer%3A1/modules/suggestions/12/delete")
        #expect(delete.method == .post)
        #expect(try Self.body(of: delete).isEmpty)

        let back = Endpoints.MoveSuggestionBack(server: fluxer, number: 12)
        #expect(back.path == "/api/v2/guilds/fluxer%3A1/modules/suggestions/12/move-back")
        #expect(back.method == .post)

        let all = Endpoints.MoveAllSuggestionsBack(server: fluxer, after: 17)
        #expect(all.path == "/api/v2/guilds/fluxer%3A1/modules/suggestions/move-all-back")
        #expect(all.method == .post)
        #expect(try Self.body(of: all)["after"] as? Int == 17)
        #expect(try Self.body(of: Endpoints.MoveAllSuggestionsBack(server: "1"))["after"] as? Int == 0)
    }

    @Test("the notice for skipped suggestions names them and the first reason")
    func skippedText() {
        #expect(SuggestionListModel.skippedText([]) == "")
        let text = SuggestionListModel.skippedText([
            SuggestionMoveFailure(number: 4, error: "No access."), SuggestionMoveFailure(number: 9, error: "Other."),
        ])
        #expect(text == " 2 could not be moved and stay where they are: #4, #9. No access.")
    }
}

@MainActor
@Suite("Suggestion list model")
struct SuggestionListModelTests {
    nonisolated static func suggestion(_ number: Int, status: SuggestionStatus = .open, canMoveBack: Bool = false)
        -> SuggestionSummary
    {
        SuggestionSummary(id: number, number: number, text: "Idea \(number)", status: status, canMoveBack: canMoveBack)
    }

    @Test("the page's list is taken over for the default view, and fetched again for another")
    func adopts() async throws {
        let clients = StubClients { _ in
            SuggestionListAnswer(suggestions: [Self.suggestion(7, status: .approved)], outside: 0)
        }
        let model = SuggestionListModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(!model.hasLoaded)
        let page = SuggestionsPage(settings: SuggestionsSettings(), suggestions: [Self.suggestion(1)], outside: 2)
        await model.adopt(page)
        #expect(model.hasLoaded)
        #expect(model.suggestions.map(\.number) == [1])
        #expect(model.outside == 2)
        #expect(clients.calls.isEmpty)

        model.filter = .approved
        await model.adopt(page)
        #expect(model.suggestions.map(\.number) == [7])
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.SuggestionList)
        #expect(sent.status == .approved)
        #expect(sent.sort == .new)
    }

    @Test("loading asks for the filter and the order and keeps the old list when it fails")
    func loads() async throws {
        let clients = StubClients { _ in SuggestionListAnswer(suggestions: [Self.suggestion(3)], outside: 1) }
        let model = SuggestionListModel(server: "9", session: makeSignedInSession(clients: clients))
        model.filter = .denied
        model.sort = .top
        await model.load()
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.SuggestionList)
        #expect(sent.status == .denied)
        #expect(sent.sort == .top)
        #expect(model.outside == 1)

        clients.setHandler { _ in throw NetworkError.offline }
        await model.load()
        #expect(model.suggestions.map(\.number) == [3])
        #expect(model.errorMessage == NetworkError.offline.userMessage)
    }

    @Test("deciding sends the trimmed, cut reason and loads the list again")
    func decides() async throws {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.DecideSuggestion {
                return SuggestionDecisionAnswer.make(Self.suggestion(5, status: .denied))
            }
            return SuggestionListAnswer(suggestions: [Self.suggestion(5, status: .denied)])
        }
        let model = SuggestionListModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(await model.decide(Self.suggestion(5), .deny, reason: "  Not now \n"))
        let decision = try #require(clients.calls.first?.endpoint as? Endpoints.DecideSuggestion)
        #expect(decision.number == 5)
        #expect(decision.action == .deny)
        #expect(decision.reason == "Not now")
        #expect(clients.calls.last?.endpoint is Endpoints.SuggestionList)
        #expect(model.suggestions.first?.status == .denied)
        #expect(model.doneCount == 1)

        #expect(await model.decide(Self.suggestion(5), .approve, reason: String(repeating: "a", count: 800)))
        let long = try #require(clients.calls.last(where: { $0.endpoint is Endpoints.DecideSuggestion })?.endpoint
            as? Endpoints.DecideSuggestion)
        #expect(long.reason.count == SuggestionListModel.maxReasonLength)
    }

    @Test("a refused decision explains in the server's words and the list stays as it was")
    func refusedDecision() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.DecideSuggestion {
                throw NetworkError.badRequest(message: "Turn the Suggestions module on first.")
            }
            return SuggestionListAnswer()
        }
        let model = SuggestionListModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(await model.decide(Self.suggestion(5), .approve, reason: "") == false)
        #expect(model.actionError == "Turn the Suggestions module on first.")
        #expect(model.doneCount == 0)
        #expect(clients.calls.count == 1)
    }

    @Test("delete and move back call their endpoints, and moving back says so")
    func deleteAndMoveBack() async throws {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.DeleteSuggestion { return OKResponse() }
            if endpoint is Endpoints.MoveSuggestionBack { return SuggestionMoved.make(Self.suggestion(5)) }
            return SuggestionListAnswer()
        }
        let model = SuggestionListModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(await model.delete(Self.suggestion(4)))
        let delete = try #require(clients.calls.first?.endpoint as? Endpoints.DeleteSuggestion)
        #expect(delete.number == 4)

        #expect(await model.moveBack(Self.suggestion(5, canMoveBack: true)))
        #expect(model.notice == CommunityNotice("Suggestion #5 is back in the suggestions channel."))
        #expect(clients.calls.contains { ($0.endpoint as? Endpoints.MoveSuggestionBack)?.number == 5 })
    }

    @Test("move all back asks again after the last number until nothing is left, and totals the batches")
    func moveAll() async throws {
        let batches = Batches([
            SuggestionMoveBatch(moved: 10, remaining: 4, next: 20),
            SuggestionMoveBatch(moved: 4, remaining: 0, next: 31),
        ])
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.MoveAllSuggestionsBack { return batches.next() }
            return SuggestionListAnswer()
        }
        let model = SuggestionListModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.moveAllBack()
        let asked = clients.calls.compactMap { ($0.endpoint as? Endpoints.MoveAllSuggestionsBack)?.after }
        #expect(asked == [0, 20])
        #expect(model.notice == CommunityNotice("14 suggestions moved back."))
        #expect(clients.calls.last?.endpoint is Endpoints.SuggestionList)
        #expect(!model.isWorking)
    }

    @Test("move all back lists what was skipped, and stops with the server's reason")
    func moveAllStops() async {
        let batches = Batches([
            SuggestionMoveBatch(moved: 10, remaining: 6, failed: [SuggestionMoveFailure(number: 3, error: "No access.")], next: 20),
            SuggestionMoveBatch(moved: 1, remaining: 5, next: 21, error: "Stopped at #22: no permission."),
        ])
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.MoveAllSuggestionsBack { return batches.next() }
            return SuggestionListAnswer()
        }
        let model = SuggestionListModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.moveAllBack()
        let notice = model.notice
        #expect(notice?.isError == true)
        #expect(notice?.message == "Stopped at #22: no permission. 11 moved back, 5 left. 1 could not be moved and stay where they are: #3. No access.")
    }

    @Test("a single suggestion moved says suggestion, and skipped ones make it an error notice")
    func moveAllOne() async {
        let batches = Batches([
            SuggestionMoveBatch(moved: 1, remaining: 0, failed: [SuggestionMoveFailure(number: 3, error: "No access.")], next: 9),
        ])
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.MoveAllSuggestionsBack { return batches.next() }
            return SuggestionListAnswer()
        }
        let model = SuggestionListModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.moveAllBack()
        #expect(model.notice?.isError == true)
        #expect(model.notice?.message.hasPrefix("1 suggestion moved back.") == true)
    }

    @Test("a request that fails part way says how many were moved before that")
    func moveAllFails() async {
        let batches = Batches([SuggestionMoveBatch(moved: 10, remaining: 4, next: 20)])
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.MoveAllSuggestionsBack {
                if batches.isEmpty { throw NetworkError.timeout }
                return batches.next()
            }
            return SuggestionListAnswer()
        }
        let model = SuggestionListModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.moveAllBack()
        #expect(model.notice == CommunityNotice("\(NetworkError.timeout.userMessage) 10 moved back before that.", isError: true))
    }
}

/// Hands out canned batches in order, for a stub that may be called from any thread.
private final class Batches: @unchecked Sendable {
    private let lock = NSLock()
    private var rest: [SuggestionMoveBatch]

    init(_ batches: [SuggestionMoveBatch]) { rest = batches }

    var isEmpty: Bool { lock.withLock { rest.isEmpty } }

    func next() -> SuggestionMoveBatch {
        lock.withLock { rest.isEmpty ? SuggestionMoveBatch() : rest.removeFirst() }
    }
}

extension SuggestionDecisionAnswer {
    /// An answer for a stub: it only has a decoder.
    static func make(_ suggestion: SuggestionSummary) -> SuggestionDecisionAnswer {
        let json = #"{"suggestion":{"id":\#(suggestion.id),"number":\#(suggestion.number),"text":"x","status":"\#(suggestion.status.rawValue)"},"dm":true}"#
        return try! JSONDecoder().decode(SuggestionDecisionAnswer.self, from: Data(json.utf8))
    }
}

extension SuggestionMoved {
    static func make(_ suggestion: SuggestionSummary) -> SuggestionMoved {
        let json = #"{"suggestion":{"id":\#(suggestion.id),"number":\#(suggestion.number),"text":"x"}}"#
        return try! JSONDecoder().decode(SuggestionMoved.self, from: Data(json.utf8))
    }
}
