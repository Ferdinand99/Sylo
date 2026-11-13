import Foundation
import Testing
@testable import SyloKit

@Suite("Economy admin")
struct EconomyAdminDecodingTests {
    /// `POST .../adjust` as v2Economy.js answers: what happened, plus the member's detail.
    static let adjustJSON = #"""
    {
      "applied": 500, "clamped": false, "summary": "Now 🪙 900 coins in cash and 🪙 0 coins in the bank.",
      "member": {"id": "810000000000000001", "name": "Alex", "inServer": true},
      "account": {"cash": 900, "bank": 0, "total": 900, "dailyStreak": 2, "hasAccount": true},
      "transactionCount": 1,
      "inventory": [{"id": 5, "itemName": "Badge", "itemType": "collectible", "rarity": "rare"}],
      "transactions": [{"id": 12, "kind": "staff_add", "amount": 500, "cashAfter": 900, "bankAfter": 0,
                        "counterparty": null, "actor": {"id": "820000000000000001", "name": "Mod", "inServer": true},
                        "reason": "Event prize", "createdAt": 1794000300000}]
    }
    """#

    @Test("an adjustment carries what was applied, the server's summary and the member as they are now")
    func decodes() throws {
        let result = try JSONDecoder().decode(EconomyAdjustment.self, from: Data(Self.adjustJSON.utf8))
        #expect(result.applied == 500)
        #expect(!result.clamped)
        #expect(result.summary == "Now 🪙 900 coins in cash and 🪙 0 coins in the bank.")
        #expect(result.detail.account.cash == 900)
        #expect(result.detail.member?.name == "Alex")
        #expect(result.detail.transactions.map(\.id) == [12])
        #expect(result.detail.transactions[0].kindLabel == "Staff added")
        #expect(result.detail.inventory.map(\.id) == [5])
    }

    @Test("a bare answer is read with defaults")
    func lenient() throws {
        let result = try JSONDecoder().decode(EconomyAdjustment.self, from: Data("{}".utf8))
        #expect(result.applied == 0)
        #expect(result.summary.isEmpty)
        #expect(!result.detail.account.hasAccount)
    }

    @Test("the reset answer has the number of accounts")
    func resetResult() throws {
        let result = try JSONDecoder().decode(EconomyResetResult.self, from: Data(#"{"ok":true,"accounts":61}"#.utf8))
        #expect(result == EconomyResetResult(ok: true, accounts: 61))
        #expect(try JSONDecoder().decode(EconomyResetResult.self, from: Data("{}".utf8)).accounts == 0)
    }

    @Test("the four actions have the dashboard's words, ranges and confirmation text")
    func actions() {
        #expect(EconomyAdjustAction.allCases.map(\.rawValue) == ["add", "remove", "set", "reset-user"])
        #expect(EconomyAdjustAction.allCases.map(\.title) == [
            "Add to cash", "Remove (cash first, then bank)", "Set cash to", "Reset the member",
        ])
        #expect(EconomyAdjustAction.add.amountRange == 1...1_000_000_000)
        #expect(EconomyAdjustAction.remove.amountRange == 1...1_000_000_000)
        #expect(EconomyAdjustAction.set.amountRange == 0...1_000_000_000)
        #expect(!EconomyAdjustAction.resetMember.needsAmount)
        #expect(EconomyAdjustAction.set.needsAmount)
        #expect(!EconomyAdjustAction.add.isDestructive)
        #expect(EconomyAdjustAction.remove.isDestructive && EconomyAdjustAction.set.isDestructive)
        #expect(EconomyAdjustAction.resetMember.isDestructive)
        #expect(EconomyAdjustAction.add.question(member: "Alex", amount: "🪙 500") == "Add 🪙 500 to Alex?")
        #expect(EconomyAdjustAction.remove.question(member: "Alex", amount: "🪙 500") == "Remove 🪙 500 from Alex?")
        #expect(EconomyAdjustAction.set.question(member: "Alex", amount: "🪙 500") == "Set Alex's cash to 🪙 500?")
        #expect(EconomyAdjustAction.resetMember.question(member: "Alex", amount: "") == "Reset Alex?")
        for action in EconomyAdjustAction.allCases {
            #expect(!action.consequence.isEmpty)
            #expect(!action.confirmTitle.isEmpty)
        }
    }

    @Test("an amount outside the server's range has a problem, a reset has no amount to check")
    func amountProblems() {
        #expect(EconomyMemberModel.amountProblem(0, for: .add) != nil)
        #expect(EconomyMemberModel.amountProblem(0, for: .set) == nil)
        #expect(EconomyMemberModel.amountProblem(-1, for: .set) != nil)
        #expect(EconomyMemberModel.amountProblem(1, for: .remove) == nil)
        #expect(EconomyMemberModel.amountProblem(1_000_000_001, for: .add) != nil)
        #expect(EconomyMemberModel.amountProblem(0, for: .resetMember) == nil)
    }

    @Test("the typed word is RESET, in any case, around spaces, and nothing else")
    func typedWord() {
        #expect(EconomyReset.confirmationWord == "RESET")
        for typed in ["RESET", "reset", " Reset ", "rEsEt\n"] { #expect(EconomyReset.accepts(typed), "\(typed)") }
        for typed in ["", "res", "RESETS", "reset it", "RESET RESET"] { #expect(!EconomyReset.accepts(typed), "\(typed)") }
    }
}

@Suite("Economy admin endpoints")
struct EconomyAdminEndpointTests {
    private func json(_ body: (any Encodable & Sendable)?) throws -> [String: Any] {
        guard let body else {
            Issue.record("the call has no body")
            return [:]
        }
        let data = try JSONEncoder().encode(body)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("an add, a remove and a set post the action, the amount and the reason")
    func adjust() throws {
        for action in [EconomyAdjustAction.add, .remove, .set] {
            let e = Endpoints.AdjustEconomyMember(server: "fluxer:1", userID: "810000000000000001", action: action,
                                                  amount: 250, reason: "Event prize")
            #expect(e.path == "/api/v2/guilds/fluxer%3A1/modules/economy/members/810000000000000001/adjust")
            #expect(e.method == .post)
            let body = try json(e.body)
            #expect(Set(body.keys) == ["action", "amount", "reason"])
            #expect(body["action"] as? String == action.rawValue)
            #expect(body["amount"] as? Int == 250)
            #expect(body["reason"] as? String == "Event prize")
        }
    }

    @Test("setting the cash to zero sends the zero")
    func setZero() throws {
        let body = try json(Endpoints.AdjustEconomyMember(server: "1", userID: "7", action: .set, amount: 0).body)
        #expect(body["amount"] as? Int == 0)
    }

    @Test("resetting a member sends no amount")
    func resetMember() throws {
        let e = Endpoints.AdjustEconomyMember(server: "1", userID: "7", action: .resetMember, amount: 999, reason: "Fresh start")
        let body = try json(e.body)
        #expect(Set(body.keys) == ["action", "reason"])
        #expect(body["action"] as? String == "reset-user")
    }

    @Test("the reset of the economy posts the confirmation word, nothing else")
    func reset() throws {
        let e = Endpoints.ResetEconomy(server: "fluxer:1")
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/modules/economy/reset")
        #expect(e.method == .post)
        #expect(try json(e.body) as NSDictionary == ["confirm": "RESET"] as NSDictionary)
    }
}

@MainActor
@Suite("Economy admin models")
struct EconomyAdminModelTests {
    nonisolated static func detail(cash: Int) -> EconomyMemberDetail {
        EconomyMemberDetail(member: EconomyPerson(id: "7", name: "Alex"), account: EconomyAccount(cash: cash, bank: 0))
    }

    @Test("a change sends the trimmed reason, replaces the detail and says what the server said")
    func adjustWorks() async throws {
        let clients = StubClients { _ in
            EconomyAdjustment(applied: 500, summary: "Now 🪙 900 coins in cash and 🪙 0 coins in the bank.", detail: Self.detail(cash: 900))
        }
        let model = EconomyMemberModel(server: "9", userID: "7", session: makeSignedInSession(clients: clients))
        let ok = await model.adjust(.add, amount: 500, reason: "  Event prize ")
        #expect(ok)
        #expect(model.detail?.account.cash == 900)
        #expect(model.notice == "Now 🪙 900 coins in cash and 🪙 0 coins in the bank.")
        #expect(model.changeCount == 1)
        #expect(model.actionError == nil)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.AdjustEconomyMember)
        #expect(sent.action == .add)
        #expect(sent.amount == 500)
        #expect(sent.reason == "Event prize")
        #expect(sent.userID == "7")
    }

    @Test("a hit on the cap is said")
    func clamped() async {
        let clients = StubClients { _ in EconomyAdjustment(applied: 3, clamped: true, summary: "Now 1.", detail: Self.detail(cash: 1)) }
        let model = EconomyMemberModel(server: "9", userID: "7", session: makeSignedInSession(clients: clients))
        await model.adjust(.add, amount: 5, reason: "")
        #expect(model.notice?.contains("most a member can hold") == true)
    }

    @Test("an amount out of range is not sent")
    func notSent() async {
        let clients = StubClients { _ in EconomyAdjustment(detail: Self.detail(cash: 1)) }
        let model = EconomyMemberModel(server: "9", userID: "7", session: makeSignedInSession(clients: clients))
        let ok = await model.adjust(.remove, amount: 0, reason: "")
        #expect(!ok)
        #expect(model.actionError?.hasPrefix("Enter a whole number from 1 to ") == true)
        #expect(clients.calls.isEmpty)
    }

    @Test("a reset of the member needs no amount")
    func resetMemberNoAmount() async throws {
        let clients = StubClients { _ in EconomyAdjustment(summary: "Reset.", detail: Self.detail(cash: 0)) }
        let model = EconomyMemberModel(server: "9", userID: "7", session: makeSignedInSession(clients: clients))
        #expect(await model.adjust(.resetMember, amount: 0, reason: ""))
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.AdjustEconomyMember)
        #expect(sent.action == .resetMember)
    }

    @Test("the server's refusal is shown in its words and the detail stays")
    func refused() async {
        let clients = StubClients { _ in throw NetworkError.badRequest(message: "That member does not have that much.") }
        let model = EconomyMemberModel(server: "9", userID: "7", session: makeSignedInSession(clients: clients))
        let ok = await model.adjust(.remove, amount: 5_000, reason: "")
        #expect(!ok)
        #expect(model.actionError == "That member does not have that much.")
        #expect(model.detail == nil)
        #expect(model.changeCount == 0)
    }

    @Test("the economy is reset only after the word is typed, and says how many accounts it covered")
    func resetModel() async throws {
        let clients = StubClients { _ in EconomyResetResult(accounts: 61) }
        let model = EconomyResetModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(await model.reset(typed: "") == false)
        #expect(await model.reset(typed: "yes") == false)
        #expect(clients.calls.isEmpty)
        #expect(await model.reset(typed: "reset"))
        #expect(model.accountsReset == 61)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.ResetEconomy)
        #expect(sent.server == "9")
    }

    @Test("a reset that stops half way shows the server's words")
    func resetPartial() async {
        let text = "Only part of the economy was reset: 30 of 61 accounts. Run it again to finish."
        let clients = StubClients { _ in throw NetworkError.server(status: HTTPStatus(500, message: text)) }
        let model = EconomyResetModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(await model.reset(typed: "RESET") == false)
        #expect(model.errorMessage == text)
        #expect(model.accountsReset == nil)
    }
}
