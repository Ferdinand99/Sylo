import Foundation
import Testing
@testable import SyloKit

@Suite("Giveaway actions")
struct GiveawayActionsTests {
    let fluxer: ServerID = "fluxer:1"

    /// The giveaway list as `giveawaysList` in src/web/routes/v2Api.js sends it (Sylo 5.1 and later).
    static let listJSON = #"""
    {"giveaways": [
      {"id": 12, "prize": "Nitro", "state": "active", "winners": 2, "endsAt": 1794000000000, "entries": 5,
       "wonIds": [], "wonNames": [], "channel": "giveaways", "requiredRoleId": "111111111111111111",
       "entryFee": 100, "prizeAmount": 0, "cancelled": false},
      {"id": 9, "prize": "Sticker pack", "state": "ended", "winners": 1, "endsAt": 1793990000000, "entries": 3,
       "wonIds": ["222222222222222222", "333333333333333333"], "wonNames": ["Alex", "333333333333333333"],
       "channel": "giveaways", "requiredRoleId": null, "entryFee": 0, "prizeAmount": 500, "cancelled": false},
      {"id": 8, "prize": "Mug", "state": "ended", "winners": 1, "endsAt": 1793980000000, "entries": 2,
       "wonIds": [], "wonNames": [], "channel": "giveaways", "entryFee": 50, "prizeAmount": 0, "cancelled": true}
    ]}
    """#

    /// The same from a server before 5.1: no names, fees or `cancelled`.
    static let oldListJSON = #"""
    {"giveaways": [{"id": 12, "prize": "Nitro", "state": "active", "winners": 1, "endsAt": 1794000000000,
                    "entries": 5, "wonIds": [], "channel": "giveaways", "requiredRoleId": null}]}
    """#

    static func body(of endpoint: some APIEndpoint) throws -> [String: Any] {
        let body = try #require(endpoint.body)
        return try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
    }

    @Test("the list decodes the fees, the winners' names and whether a giveaway was cancelled")
    func decodes() throws {
        let answer = try JSONDecoder().decode(GiveawayListAnswer.self, from: Data(Self.listJSON.utf8))
        #expect(answer.giveaways.map(\.id) == [12, 9, 8])
        let running = answer.giveaways[0]
        #expect(running.entryFee == 100)
        #expect(running.cancelled == false)
        #expect(running.canCancel)
        #expect(running.isRoleGated)

        let ended = answer.giveaways[1]
        #expect(ended.prizeAmount == 500)
        #expect(ended.wonNames == ["Alex", "333333333333333333"])
        #expect(!ended.canCancel)
        // A name the server could not resolve is its id: shown as a member, not as a number.
        #expect(ended.winnerName(at: 0) == "Alex")
        #expect(ended.winnerName(at: 1) == "a member (ID 333333333333333333)")
        #expect(ended.winnerName(at: 2) == "")

        let cancelled = answer.giveaways[2]
        #expect(cancelled.isCancelled)
        #expect(cancelled.state == .ended)
        #expect(!cancelled.canCancel)
    }

    @Test("a server from before cancelling sends none of that, so there is no Cancel to offer")
    func decodesOldList() throws {
        let answer = try JSONDecoder().decode(GiveawayListAnswer.self, from: Data(Self.oldListJSON.utf8))
        let giveaway = try #require(answer.giveaways.first)
        #expect(giveaway.cancelled == nil)
        #expect(!giveaway.canCancel)
        #expect(!giveaway.isCancelled)
        #expect(giveaway.entryFee == 0)
        #expect(giveaway.prizeAmount == 0)
        #expect(giveaway.wonNames.isEmpty)
    }

    @Test("a giveaway that does not read is dropped from the page's list and from an answer")
    func lossy() throws {
        let page = try JSONDecoder().decode(
            GiveawaysPage.self,
            from: Data(#"{"config":{},"giveaways":[{"prize":"no id"},{"id":1,"prize":"A","endsAt":1794000000000}]}"#.utf8))
        #expect(page.giveaways.map(\.id) == [1])
    }

    @Test("a cancel answer carries the list and how the refunds went")
    func decodesCancel() throws {
        let json = Data(#"{"giveaways":[{"id":12,"prize":"Nitro","state":"ended","endsAt":1794000000000,"cancelled":true}],"refunded":4,"failed":1}"#.utf8)
        let answer = try JSONDecoder().decode(GiveawayCancelAnswer.self, from: json)
        #expect(answer.refunded == 4)
        #expect(answer.failed == 1)
        #expect(answer.giveaways.first?.isCancelled == true)
    }

    @Test("end and cancel are POSTs of an empty object to the giveaway's path")
    func endAndCancel() throws {
        let end = Endpoints.EndGiveaway(server: fluxer, id: 12)
        #expect(end.path == "/api/v2/guilds/fluxer%3A1/modules/giveaways/12/end")
        #expect(end.method == .post)
        #expect(end.requiresAuth)
        #expect(try Self.body(of: end).isEmpty)

        let cancel = Endpoints.CancelGiveaway(server: fluxer, id: 12)
        #expect(cancel.path == "/api/v2/guilds/fluxer%3A1/modules/giveaways/12/cancel")
        #expect(cancel.method == .post)
        #expect(try Self.body(of: cancel).isEmpty)
    }

    @Test("a reroll posts the number of winners to draw")
    func reroll() throws {
        let e = Endpoints.RerollGiveaway(server: fluxer, id: 9, count: 3)
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/modules/giveaways/9/reroll")
        #expect(e.method == .post)
        let body = try Self.body(of: e)
        #expect(Set(body.keys) == ["count"])
        #expect(body["count"] as? Int == 3)
        #expect(try Self.body(of: Endpoints.RerollGiveaway(server: "1", id: 9))["count"] as? Int == 1)
        #expect(GiveawaysGiveaway.rerollRange == 1...20)
    }

    @Test("the refund notice says how many fees went back, and what is still open")
    func refundNotice() {
        #expect(GiveawayActionsModel.refundNotice(refunded: 4, failed: 0) == CommunityNotice("4 entry fee(s) were given back."))
        let open = GiveawayActionsModel.refundNotice(refunded: 3, failed: 2)
        #expect(open.isError)
        #expect(open.message.hasPrefix("3 entry fee(s) were given back. 2 could not be just now"))
    }
}

@MainActor
@Suite("Giveaway actions model")
struct GiveawayActionsModelTests {
    nonisolated static func giveaway(
        _ id: Int, state: GiveawaysGiveaway.State = .active, entryFee: Int = 0, cancelled: Bool? = false
    ) -> GiveawaysGiveaway {
        GiveawaysGiveaway(id: id, prize: "Prize \(id)", state: state, endsAt: Date(timeIntervalSince1970: 1_794_000_000),
                          entryFee: entryFee, cancelled: cancelled)
    }

    @Test("ending keeps the list the server answers with")
    func ends() async throws {
        let clients = StubClients { _ in GiveawayListAnswer(giveaways: [Self.giveaway(12, state: .ended)]) }
        let model = GiveawayActionsModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(model.giveaways == nil)
        #expect(await model.end(Self.giveaway(12)))
        #expect(model.giveaways?.first?.state == .ended)
        #expect(model.doneCount == 1)
        #expect(model.busyID == nil)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.EndGiveaway)
        #expect(sent.id == 12)
        model.forgetAnswer()
        #expect(model.giveaways == nil)
    }

    @Test("a reroll count outside what the server keeps is pulled into range before it is sent")
    func rerollCount() async throws {
        let clients = StubClients { _ in GiveawayListAnswer() }
        let model = GiveawayActionsModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(await model.reroll(Self.giveaway(9, state: .ended), count: 3))
        #expect((clients.calls.last?.endpoint as? Endpoints.RerollGiveaway)?.count == 3)
        #expect(await model.reroll(Self.giveaway(9, state: .ended), count: 0))
        #expect((clients.calls.last?.endpoint as? Endpoints.RerollGiveaway)?.count == 1)
        #expect(await model.reroll(Self.giveaway(9, state: .ended), count: 99))
        #expect((clients.calls.last?.endpoint as? Endpoints.RerollGiveaway)?.count == 20)
    }

    @Test("cancelling a giveaway with an entry fee explains the refunds, one without says nothing")
    func cancels() async throws {
        let clients = StubClients { _ in
            GiveawayCancelAnswer(giveaways: [Self.giveaway(12, state: .ended, cancelled: true)], refunded: 4, failed: 1)
        }
        let model = GiveawayActionsModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(await model.cancel(Self.giveaway(12, entryFee: 100)))
        #expect(model.giveaways?.first?.isCancelled == true)
        #expect(model.notice?.isError == true)
        #expect(model.notice?.message.hasPrefix("4 entry fee(s) were given back. 1 could not be") == true)

        model.notice = nil
        #expect(await model.cancel(Self.giveaway(12, entryFee: 0)))
        #expect(model.notice == nil)
        #expect(model.doneCount == 2)
    }

    @Test("a giveaway that is no longer running is explained in the server's words")
    func refused() async {
        let clients = StubClients { _ in throw NetworkError.badRequest(message: "Not an active giveaway") }
        let model = GiveawayActionsModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(await model.end(Self.giveaway(12)) == false)
        #expect(model.errorMessage == "Not an active giveaway")
        #expect(model.giveaways == nil)
        #expect(model.doneCount == 0)
        #expect(model.busyID == nil)
    }
}
