import Foundation
import Testing
@testable import SyloKit

// The Sylo 5.2 polish (P1) as the app reads it: suggestion counts for the filter chips, the reminder limit,
// the shop's picture quota, the custom commands registered on Discord, and the inbox lists a View-only person
// gets without their content. Each has a 5.1-shaped payload (the field is missing) and a 5.2-shaped one.

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

@Suite("Suggestion counts")
struct SuggestionCountsTests {
    @Test("A 5.2 list and page carry counts per status")
    func fiveTwo() throws {
        let list = try decode(SuggestionListAnswer.self, #"""
            {"suggestions":[],"outside":0,"openCount":4,"counts":{"all":10,"open":3,"considering":1,"approved":4,"denied":1,"implemented":1}}
            """#)
        let counts = try #require(list.counts)
        #expect(counts.all == 10)
        // "Open" covers open and considering ones, like the server's own filter.
        #expect(counts.count(for: .open) == 4)
        #expect(counts.count(for: .approved) == 4)
        #expect(counts.count(for: .denied) == 1)
        #expect(counts.count(for: .implemented) == 1)
        #expect(counts.count(for: .all) == 10)
        let page = try decode(SuggestionsPage.self, #"{"config":{},"suggestions":[],"counts":{"all":2,"open":2}}"#)
        #expect(page.counts?.count(for: .all) == 2)
    }

    @Test("A 5.1 answer has none, and the chips show no numbers")
    func fiveOne() throws {
        let list = try decode(SuggestionListAnswer.self, #"{"suggestions":[],"outside":0}"#)
        #expect(list.counts == nil)
        let page = try decode(SuggestionsPage.self, #"{"config":{},"suggestions":[]}"#)
        #expect(page.counts == nil)
        // An odd block never fails the list.
        let odd = try decode(SuggestionListAnswer.self, #"{"suggestions":[],"counts":"x"}"#)
        #expect(odd.counts == nil)
    }

    @Test("Without an all the total is the sum")
    func sum() {
        #expect(SuggestionCounts(open: 1, considering: 2, approved: 3, denied: 4, implemented: 5).all == 15)
    }

    @Test("The chips are in the dashboard's order")
    func chips() {
        #expect(SuggestionFilter.chipOrder.map(\.chipTitle) == ["Open", "Approved", "Denied", "Implemented", "All"])
    }

    @MainActor
    @Test("The list model keeps the counts of the newest answer")
    func model() async {
        let counts = SuggestionCounts(all: 5, open: 5)
        let clients = StubClients { _ in SuggestionListAnswer(suggestions: [], outside: 0, counts: counts) }
        let model = SuggestionListModel(server: "1", session: makeSignedInSession(clients: clients))
        #expect(model.counts == nil)
        await model.load()
        #expect(model.counts == counts)
    }
}

@Suite("Usage counters")
struct UsageCounterTests {
    @Test("A 5.2 reminders list says how many a server may have")
    func reminders() throws {
        #expect(try decode(RemindersPage.self, #"{"reminders":[],"maxReminders":50}"#).maxReminders == 50)
        #expect(try decode(RemindersPage.self, #"{"reminders":[]}"#).maxReminders == nil)
    }

    @Test("The shop's picture quota, in KB under a megabyte")
    func pictures() throws {
        let list = try decode(ShopItemList.self, #"""
            {"items":[],"roles":[],"maxItems":50,"pictures":{"count":3,"bytes":5242880,"maxCount":200,"maxBytes":26214400}}
            """#)
        let usage = try #require(list.pictures)
        #expect(usage.summary == "3 / 200 pictures \u{00B7} 5 MB / 25 MB")
        #expect(!usage.isFull)
        #expect(ShopPictureUsage(count: 2, bytes: 512 * 1024).summary == "2 / 200 pictures \u{00B7} 512 KB / 25 MB")
        #expect(ShopPictureUsage(count: 200, bytes: 0).isFull)
        #expect(ShopPictureUsage(count: 1, bytes: 25 * 1024 * 1024).isFull)
        #expect(try decode(ShopItemList.self, #"{"items":[],"roles":[]}"#).pictures == nil)
        // The answer of a change carries it too.
        let answer = try decode(ShopItemsAnswer.self, #"{"items":[],"pictures":{"count":1,"bytes":1,"maxCount":200,"maxBytes":100}}"#)
        #expect(answer.pictures?.count == 1)
        #expect(try decode(ShopItemsAnswer.self, #"{"items":[]}"#).pictures == nil)
    }

    @Test("Custom commands past the Discord limit are flagged")
    func customCommands() throws {
        let page = try decode(CustomCommandsPage.self, #"""
            {"commands":[{"id":"1","name":"a","actions":[],"beyondLimit":false},{"id":"2","name":"b","actions":[],"beyondLimit":true}],
             "registeredLimit":100,"overLimit":1,"channels":[],"roles":[]}
            """#)
        #expect(page.registeredLimit == 100)
        #expect(page.overLimit == 1)
        #expect(page.commands.map(\.beyondLimit) == [false, true])
        // Fluxer has no slash commands: no limit.
        let fluxer = try decode(CustomCommandsPage.self, #"{"commands":[],"registeredLimit":null,"overLimit":0}"#)
        #expect(fluxer.registeredLimit == nil)
        let old = try decode(CustomCommandsPage.self, #"{"commands":[{"id":"1","name":"a","actions":[]}]}"#)
        #expect(old.registeredLimit == nil)
        #expect(old.overLimit == 0)
        #expect(old.commands[0].beyondLimit == false)
    }

    @Test("beyondLimit is never sent back when a command is saved")
    func notSent() throws {
        let command = CustomCommand(id: "1", name: "a", beyondLimit: true)
        let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(command)) as? [String: Any])
        #expect(json["beyondLimit"] == nil)
        #expect(json["reserved"] == nil)
    }
}

@Suite("Inbox content hidden")
struct ContentHiddenTests {
    @Test("A View-only person gets the ticket list with blank previews and a flag")
    func tickets() throws {
        let list = try decode(TicketList.self, #"{"open":[],"closed":[],"contentHidden":true}"#)
        #expect(list.contentHidden)
        #expect(!(try decode(TicketList.self, #"{"open":[],"closed":[]}"#).contentHidden))
    }

    @Test("Appeals: blank answers and reasons")
    func appeals() throws {
        #expect(try decode(AppealsReview.self, #"{"appeals":[],"contentHidden":true}"#).contentHidden)
        #expect(!(try decode(AppealsReview.self, #"{"appeals":[]}"#).contentHidden))
    }

    @Test("Applications: blank reasons")
    func applications() throws {
        #expect(try decode(ApplicationSubmissionList.self, #"{"submissions":[],"contentHidden":true}"#).contentHidden)
        #expect(!(try decode(ApplicationSubmissionList.self, #"{"submissions":[]}"#).contentHidden))
    }

    @Test("A suggestion whose author is hidden still reads")
    func suggestions() throws {
        let item = try decode(SuggestionSummary.self, #"{"id":1,"number":1,"text":"Hi","anonymous":true,"author":null}"#)
        #expect(item.author == nil)
        #expect(item.isAnonymous)
    }

    @Test("What each level sees of an inbox")
    func levels() {
        #expect(!DashboardAccess.view.seesInboxContent)
        #expect(DashboardAccess.inbox.seesInboxContent)
        #expect(DashboardAccess.edit.seesInboxContent)
    }
}
