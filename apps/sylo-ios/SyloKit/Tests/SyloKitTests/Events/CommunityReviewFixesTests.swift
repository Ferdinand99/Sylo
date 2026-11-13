import Foundation
import Testing
@testable import SyloKit

/// Holds a stubbed call until the test lets it go, so an action can be asked for while another one runs.
private final class Gate: @unchecked Sendable {
    private let semaphore = DispatchSemaphore(value: 0)

    func wait() { _ = semaphore.wait(timeout: .now() + 10) }
    func open() { semaphore.signal() }
}

@Suite("Event times around a clock change")
struct EventClockChangeTests {
    static let oslo = TimeZone(identifier: "Europe/Oslo")!

    @Test("a wall-clock time that a spring-forward night skips does not exist, one that happens twice does")
    func existence() throws {
        // Europe/Oslo: 2026-03-29 02:00 jumps to 03:00; 2026-10-25 03:00 falls back to 02:00.
        let skipped = try #require(EventTime.floating(fromText: "2026-03-29T02:30"))
        let after = try #require(EventTime.floating(fromText: "2026-03-29T03:00"))
        let twice = try #require(EventTime.floating(fromText: "2026-10-25T02:30"))
        #expect(!EventTime.exists(skipped, in: Self.oslo))
        #expect(EventTime.exists(after, in: Self.oslo))
        #expect(EventTime.exists(twice, in: Self.oslo))
        #expect(EventTime.exists(skipped, in: TimeZone(identifier: "UTC")!))
    }

    @Test("a default start that lands in the skipped hour moves on to the next one that exists")
    func defaultStartSnaps() {
        // 23:30 UTC on the 28th: an hour on is 01:30 in Oslo, which rounds up to the skipped 02:00.
        let now = Date(timeIntervalSince1970: 1_774_740_600)
        let start = EventTime.nextFullHour(after: now, in: Self.oslo)
        #expect(EventTime.wallClockText(start) == "2026-03-29T03:00")
        #expect(EventTime.exists(start, in: Self.oslo))
        let settings = EventsSettings()
        let draft = EventDraft(defaults: settings, now: now, deviceZone: "Europe/Oslo")
        #expect(EventTime.wallClockText(draft.start) == "2026-03-29T03:00")
    }

    @Test("the form says so when a typed time falls in the skipped hour, for the start and for the end")
    func problemInTheGap() throws {
        let skipped = try #require(EventTime.floating(fromText: "2026-03-29T02:30"))
        let fine = try #require(EventTime.floating(fromText: "2026-03-29T04:00"))
        var draft = EventDraft(title: "Quiz", start: skipped, timeZone: "Europe/Oslo", channelID: "1")
        #expect(draft.problem(creating: true)?.hasPrefix("The start time does not exist in Europe/Oslo") == true)
        draft.start = try #require(EventTime.floating(fromText: "2026-03-29T01:00"))
        draft.end = skipped
        #expect(draft.problem(creating: true)?.hasPrefix("The end time does not exist in Europe/Oslo") == true)
        draft.end = fine
        #expect(draft.problem(creating: true) == nil)
        // The same wall-clock time is fine in a zone without that change.
        draft.start = skipped
        draft.end = nil
        draft.timeZone = "UTC"
        #expect(draft.problem(creating: true) == nil)
    }
}

@MainActor
@Suite("Community actions while another one runs")
struct CommunityBusyTests {
    @Test("an event action asked for while another runs says so, and the first one still finishes")
    func events() async {
        let gate = Gate()
        let clients = StubClients { _ in
            gate.wait()
            return EventListAnswer()
        }
        let model = EventActionsModel(server: "9", session: makeSignedInSession(clients: clients))
        let first = Task { await model.cancel(id: 1) }
        while !model.isWorking { await Task.yield() }
        #expect(await model.cancel(id: 2) == false)
        #expect(model.errorMessage == CommunityMessage.busy)
        gate.open()
        #expect(await first.value)
        #expect(model.doneCount == 1)
    }

    @Test("the same for a suggestion")
    func suggestions() async {
        let gate = Gate()
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.DeleteSuggestion {
                gate.wait()
                return OKResponse()
            }
            return SuggestionListAnswer()
        }
        let model = SuggestionListModel(server: "9", session: makeSignedInSession(clients: clients))
        let one = SuggestionSummary(id: 1, number: 1, text: "x")
        let first = Task { await model.delete(one) }
        while !model.isWorking { await Task.yield() }
        #expect(await model.delete(one) == false)
        #expect(model.actionError == CommunityMessage.busy)
        await model.moveAllBack()
        #expect(model.actionError == CommunityMessage.busy)
        gate.open()
        #expect(await first.value)
    }

    @Test("the same for a quote")
    func quotes() async {
        let gate = Gate()
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.DeleteQuote {
                gate.wait()
                return OKResponse()
            }
            return QuoteListAnswer()
        }
        let model = QuoteListModel(server: "9", session: makeSignedInSession(clients: clients))
        let quote = QuoteSummary(number: 1)
        let first = Task { await model.delete(quote) }
        while !model.isWorking { await Task.yield() }
        #expect(await model.delete(quote) == false)
        #expect(model.actionError == CommunityMessage.busy)
        gate.open()
        #expect(await first.value)
    }

    @Test("the same for a giveaway")
    func giveaways() async {
        let gate = Gate()
        let clients = StubClients { _ in
            gate.wait()
            return GiveawayListAnswer()
        }
        let model = GiveawayActionsModel(server: "9", session: makeSignedInSession(clients: clients))
        let giveaway = GiveawaysGiveaway(id: 1, prize: "x", endsAt: Date(timeIntervalSince1970: 1_794_000_000))
        let first = Task { await model.end(giveaway) }
        while model.busyID == nil { await Task.yield() }
        #expect(await model.reroll(giveaway, count: 1) == false)
        #expect(model.errorMessage == CommunityMessage.busy)
        gate.open()
        #expect(await first.value)
    }
}

@MainActor
@Suite("Role refusals")
struct CommunityRoleRefusalTests {
    @Test("a 403 on an event that hands out a role explains the role rule, and stays generic without one")
    func forbiddenRole() async {
        let clients = StubClients { _ in throw NetworkError.forbidden }
        let model = EventActionsModel(server: "9", session: makeSignedInSession(clients: clients))
        let start = EventTime.floating(fromText: "2026-11-06T22:00")!
        var draft = EventDraft(title: "Quiz", start: start, timeZone: "UTC", channelID: "1", roleID: "5")
        #expect(await model.create(draft) == false)
        #expect(model.errorMessage?.hasPrefix("You can't hand out that role") == true)

        draft.roleID = ""
        #expect(await model.create(draft) == false)
        #expect(model.errorMessage == NetworkError.forbidden.userMessage)
        #expect(NetworkError.forbidden.communityMessage(grantingRole: false) == NetworkError.forbidden.userMessage)
        #expect(NetworkError.rateLimited.communityMessage(grantingRole: true) == NetworkError.rateLimited.userMessage)
    }
}
