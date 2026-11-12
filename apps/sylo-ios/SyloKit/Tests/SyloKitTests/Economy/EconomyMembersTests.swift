import Foundation
import Testing
@testable import SyloKit

@Suite("Economy members")
struct EconomyMembersDecodingTests {
    /// `GET .../economy/members` without a search, shaped like v2Economy.js.
    static let listJSON = #"""
    {
      "search": false, "sort": "total", "dir": "desc", "page": 1, "pages": 3, "total": 61,
      "rows": [
        {"userId": "810000000000000001", "cash": 1200, "bank": 300, "total": 1500, "dailyStreak": 4,
         "hasAccount": true, "member": {"id": "810000000000000001", "name": "Alex", "inServer": true}},
        {"userId": "810000000000000002", "cash": 0, "bank": 40, "total": 40, "dailyStreak": 0,
         "hasAccount": true, "member": {"id": "810000000000000002", "name": "810000000000000002", "inServer": false}}
      ]
    }
    """#

    /// `GET .../economy/members?q=alex`.
    static let searchJSON = #"""
    {
      "search": true, "page": 1, "pages": 1, "total": 1,
      "rows": [{"userId": "810000000000000003", "cash": 0, "bank": 0, "total": 0, "dailyStreak": 0,
                "hasAccount": false, "member": {"id": "810000000000000003", "name": "Alexa", "inServer": true}}]
    }
    """#

    /// `GET .../economy/members/:userId`.
    static let detailJSON = #"""
    {
      "member": {"id": "810000000000000001", "name": "Alex", "inServer": true},
      "account": {"cash": 1200, "bank": 300, "total": 1500, "dailyStreak": 4, "hasAccount": true},
      "transactionCount": 87,
      "inventory": [{"anything": "the app ignores"}],
      "transactions": [
        {"id": 90, "kind": "pay_in", "amount": 250, "cashAfter": 1200, "bankAfter": 300,
         "counterparty": {"id": "810000000000000009", "name": "Sam", "inServer": true}, "actor": null,
         "reason": "", "createdAt": 1794000200000},
        {"id": 89, "kind": "staff_remove", "amount": -50, "cashAfter": 950, "bankAfter": 300,
         "counterparty": null, "actor": {"id": "820000000000000001", "name": "Mod", "inServer": true},
         "reason": "Spam", "createdAt": 1794000100000},
        {"id": 88, "kind": "time_travel", "amount": 1, "cashAfter": 1, "bankAfter": 0,
         "counterparty": null, "actor": null, "reason": null, "createdAt": null}
      ]
    }
    """#

    @Test("the member list reads balances from each row, with the person next to them")
    func decodesList() throws {
        let list = try JSONDecoder().decode(EconomyMemberList.self, from: Data(Self.listJSON.utf8))
        #expect(!list.isSearch)
        #expect(list.page == 1)
        #expect(list.pages == 3)
        #expect(list.total == 61)
        #expect(list.rows.count == 2)
        let first = list.rows[0]
        #expect(first.id == "810000000000000001")
        #expect(first.displayName == "Alex")
        #expect(first.account == EconomyAccount(cash: 1200, bank: 300, total: 1500, dailyStreak: 4, hasAccount: true))
        #expect(list.rows[1].member?.inServer == false)
        #expect(list.rows[1].account.bank == 40)
    }

    @Test("a search answer says so, and a member without an account holds nothing")
    func decodesSearch() throws {
        let list = try JSONDecoder().decode(EconomyMemberList.self, from: Data(Self.searchJSON.utf8))
        #expect(list.isSearch)
        #expect(list.rows.count == 1)
        #expect(!list.rows[0].account.hasAccount)
        #expect(list.rows[0].account.total == 0)
    }

    @Test("a row without a name shows the id, a list without fields is empty")
    func lenient() throws {
        let json = Data(#"{"rows":[{"userId":"7","cash":5,"bank":1},{"cash":1}]}"#.utf8)
        let list = try JSONDecoder().decode(EconomyMemberList.self, from: json)
        #expect(list.rows.count == 1)
        #expect(list.rows[0].displayName == "7")
        #expect(list.rows[0].account.total == 6)
        #expect(list.total == 1)
        let empty = try JSONDecoder().decode(EconomyMemberList.self, from: Data("{}".utf8))
        #expect(empty.rows.isEmpty)
        #expect(empty.pages == 1)
    }

    @Test("a member's detail has balances and the latest transactions, newest first")
    func decodesDetail() throws {
        let detail = try JSONDecoder().decode(EconomyMemberDetail.self, from: Data(Self.detailJSON.utf8))
        #expect(detail.member?.name == "Alex")
        #expect(detail.account.cash == 1200)
        #expect(detail.account.total == 1500)
        #expect(detail.account.dailyStreak == 4)
        #expect(detail.transactionCount == 87)
        #expect(detail.transactions.map(\.id) == [90, 89, 88])

        let payment = detail.transactions[0]
        #expect(payment.kind == "pay_in")
        #expect(payment.kindLabel == "Payment received")
        #expect(payment.amount == 250)
        #expect(payment.counterparty?.name == "Sam")
        #expect(payment.actor == nil)
        #expect(payment.date == Date(timeIntervalSince1970: 1_794_000_200))

        let staff = detail.transactions[1]
        #expect(staff.kindLabel == "Staff removed")
        #expect(staff.amount == -50)
        #expect(staff.actor?.name == "Mod")
        #expect(staff.reason == "Spam")
    }

    @Test("an unknown transaction kind shows as the server named it, a null reason and date are fine")
    func unknownKind() throws {
        let detail = try JSONDecoder().decode(EconomyMemberDetail.self, from: Data(Self.detailJSON.utf8))
        let odd = detail.transactions[2]
        #expect(odd.kindLabel == "time_travel")
        #expect(odd.reason.isEmpty)
        #expect(odd.date == nil)
    }

    @Test("every kind the dashboard words has a label")
    func kindLabels() {
        let kinds = [
            "start", "message", "voice", "daily", "work", "pay_out", "pay_in", "tax", "rob_win", "rob_loss",
            "rob_fine_out", "rob_fine_in", "deposit", "withdraw", "staff_add", "staff_remove", "staff_set", "reset",
        ]
        for kind in kinds {
            #expect(EconomyTransaction(id: 1, kind: kind, amount: 1).kindLabel != kind, "\(kind)")
        }
    }

    @Test("money is written with the server's emoji and name")
    func money() {
        let us = Locale(identifier: "en_US")
        #expect(EconomyMoney.format(1234567, emoji: "🪙", name: "coins", locale: us) == "🪙 1,234,567 coins")
        #expect(EconomyMoney.format(5, emoji: "", name: "gold", locale: us) == "5 gold")
        #expect(EconomyMoney.signed(50, locale: us) == "+50")
        #expect(EconomyMoney.signed(-1200, locale: us) == "-1,200")
        #expect(EconomyMoney.signed(0, locale: us) == "0")
    }
}

@Suite("Economy member endpoints")
struct EconomyMemberEndpointsTests {
    let fluxer: ServerID = "fluxer:1"

    @Test("the list is a GET with the order and no search or page by default")
    func listQuery() {
        let e = Endpoints.EconomyMembers(server: fluxer)
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/modules/economy/members")
        #expect(e.method == .get)
        #expect(e.body == nil)
        #expect(e.requiresAuth)
        #expect(e.query == [URLQueryItem(name: "sort", value: "total"), URLQueryItem(name: "dir", value: "desc")])
    }

    @Test("a search and a page are added, a blank search is not")
    func searchAndPage() {
        let e = Endpoints.EconomyMembers(server: "1", search: "  alex ", sort: .bank, page: 3)
        #expect(e.query == [
            URLQueryItem(name: "sort", value: "bank"), URLQueryItem(name: "dir", value: "desc"),
            URLQueryItem(name: "q", value: "alex"), URLQueryItem(name: "page", value: "3"),
        ])
        #expect(!Endpoints.EconomyMembers(server: "1", search: "   ").query.contains { $0.name == "q" })
    }

    @Test("one member is a GET below the members path, the id encoded")
    func member() {
        let e = Endpoints.EconomyMember(server: fluxer, userID: "810000000000000001")
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/modules/economy/members/810000000000000001")
        #expect(e.method == .get)
        #expect(Endpoints.EconomyMember(server: "1", userID: "a/b").path.hasSuffix("/members/a%2Fb"))
    }
}

@MainActor
@Suite("Economy members model")
struct EconomyMembersModelTests {
    nonisolated static func page(_ ids: ClosedRange<Int>, page: Int, pages: Int, total: Int) -> EconomyMemberList {
        EconomyMemberList(
            rows: ids.map { EconomyMemberRow(userId: "\($0)", account: EconomyAccount(cash: $0, bank: 0)) },
            page: page, pages: pages, total: total)
    }

    @Test("loading shows the first page; more pages are added without repeating a member")
    func paging() async throws {
        let clients = StubClients { endpoint in
            guard let call = endpoint as? Endpoints.EconomyMembers else { throw NetworkError.notFound }
            return call.page == 1
                ? Self.page(1...3, page: 1, pages: 2, total: 5)
                : Self.page(3...5, page: 2, pages: 2, total: 5)
        }
        let model = EconomyMembersModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(!model.hasLoaded)
        await model.load()
        #expect(model.hasLoaded)
        #expect(model.rows.map(\.userId) == ["1", "2", "3"])
        #expect(model.total == 5)
        #expect(model.canLoadMore)

        await model.loadMore()
        #expect(model.rows.map(\.userId) == ["1", "2", "3", "4", "5"])
        #expect(!model.canLoadMore)
        let last = try #require(clients.calls.last?.endpoint as? Endpoints.EconomyMembers)
        #expect(last.page == 2)
        // A page past the end is not asked for.
        let calls = clients.calls.count
        await model.loadMore()
        #expect(clients.calls.count == calls)
    }

    @Test("a search is one page, asked for with the typed text, and it ends paging")
    func search() async throws {
        let clients = StubClients { endpoint in
            guard let call = endpoint as? Endpoints.EconomyMembers else { throw NetworkError.notFound }
            if call.search.isEmpty { return Self.page(1...3, page: 1, pages: 2, total: 5) }
            return EconomyMemberList(
                isSearch: true,
                rows: [EconomyMemberRow(userId: "9", account: EconomyAccount(hasAccount: false))],
                page: 1, pages: 1, total: 1)
        }
        let model = EconomyMembersModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        model.query = "alex"
        await model.load()
        #expect(model.isSearch)
        #expect(model.rows.map(\.userId) == ["9"])
        #expect(!model.canLoadMore)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.EconomyMembers)
        #expect(sent.search == "alex")

        model.query = ""
        await model.load()
        #expect(!model.isSearch)
        #expect(model.rows.count == 3)
    }

    @Test("a failed load explains and keeps the list; a later load clears it")
    func failedLoad() async {
        let clients = StubClients { _ in Self.page(1...2, page: 1, pages: 1, total: 2) }
        let model = EconomyMembersModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        clients.setHandler { _ in throw NetworkError.forbidden }
        await model.load()
        #expect(model.rows.count == 2)
        #expect(model.errorMessage == NetworkError.forbidden.userMessage)
        clients.setHandler { _ in Self.page(1...2, page: 1, pages: 1, total: 2) }
        await model.load()
        #expect(model.errorMessage == nil)
    }

    @Test("one member loads, and a failure says why")
    func memberDetail() async throws {
        let detail = EconomyMemberDetail(
            member: EconomyPerson(id: "7", name: "Alex"), account: EconomyAccount(cash: 10, bank: 5),
            transactions: [EconomyTransaction(id: 1, kind: "daily", amount: 100)])
        let clients = StubClients { _ in detail }
        let model = EconomyMemberModel(server: "9", userID: "7", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.detail == detail)
        #expect(model.errorMessage == nil)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.EconomyMember)
        #expect(sent.userID == "7")

        clients.setHandler { _ in throw NetworkError.notFound }
        await model.load()
        #expect(model.detail == detail)
        #expect(model.errorMessage == NetworkError.notFound.userMessage)
    }
}
