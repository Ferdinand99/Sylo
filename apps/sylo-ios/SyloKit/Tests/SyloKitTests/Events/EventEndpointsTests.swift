import Foundation
import Testing
@testable import SyloKit

@Suite("Event time")
struct EventTimeTests {
    /// 2026-11-06 22:00 UTC.
    static let tenPM = Date(timeIntervalSince1970: 1_794_002_400)

    @Test("a floating date reads as the wall clock text the server expects")
    func wallClockText() {
        #expect(EventTime.wallClockText(Self.tenPM) == "2026-11-06T22:00")
        #expect(EventTime.wallClockText(Date(timeIntervalSince1970: 0)) == "1970-01-01T00:00")
    }

    @Test("text with a T or a space reads back to the same floating date; nonsense reads as nil")
    func parsing() {
        #expect(EventTime.floating(fromText: "2026-11-06T22:00") == Self.tenPM)
        #expect(EventTime.floating(fromText: "2026-11-06 22:00") == Self.tenPM)
        #expect(EventTime.floating(fromText: "2026-11-06T22:00:30") == Self.tenPM)
        #expect(EventTime.floating(fromText: "") == nil)
        #expect(EventTime.floating(fromText: "tomorrow") == nil)
        #expect(EventTime.floating(fromText: "2026-13-06T22:00") == nil)
        #expect(EventTime.floating(fromText: "2026-11-06T25:00") == nil)
    }

    @Test("the wall clock of an instant depends on the zone, and a floating date does not")
    func zones() throws {
        // 21:00 UTC is 22:00 in Oslo (CET) and 21:00 in UTC.
        let instant = Date(timeIntervalSince1970: 1_793_998_800)
        let oslo = try #require(TimeZone(identifier: "Europe/Oslo"))
        #expect(EventTime.floating(of: instant, in: oslo) == Self.tenPM)
        #expect(EventTime.floating(of: instant, in: try #require(TimeZone(identifier: "UTC")))
            == Self.tenPM.addingTimeInterval(-3600))
    }

    @Test("a new event starts at the next full hour at least an hour away, on the zone's wall clock")
    func nextFullHour() throws {
        // 19:30 UTC: an hour on is 20:30, so 21:00 UTC; 22:00 in Oslo.
        let now = Date(timeIntervalSince1970: 1_793_993_400)
        let utc = try #require(TimeZone(identifier: "UTC"))
        let oslo = try #require(TimeZone(identifier: "Europe/Oslo"))
        #expect(EventTime.wallClockText(EventTime.nextFullHour(after: now, in: utc)) == "2026-11-06T21:00")
        #expect(EventTime.wallClockText(EventTime.nextFullHour(after: now, in: oslo)) == "2026-11-06T22:00")
        // Exactly on the hour stays there.
        let onTheHour = Date(timeIntervalSince1970: 1_793_995_200)
        #expect(EventTime.wallClockText(EventTime.nextFullHour(after: onTheHour, in: utc)) == "2026-11-06T21:00")
    }
}

@Suite("Event drafts and endpoints")
struct EventEndpointsTests {
    let fluxer: ServerID = "fluxer:1"

    /// An event as `eventsView` in src/web/routes/v2Events.js sends it (Sylo 5.2).
    static let eventJSON = #"""
    {"id": 12, "title": "Game night", "description": "Bring snacks", "location": "Voice 1",
     "imageUrl": "https://example.com/a.png", "startAt": 1793998800000, "endAt": 1794007800000,
     "start": "2026-11-06T22:00", "end": "2026-11-07T00:30", "timeZone": "Europe/Oslo", "capacity": 12,
     "roleId": "333333333333333333", "reminderMinutes": 30, "channelId": "222222222222222222", "channel": "events",
     "state": "scheduled", "joined": 4, "maybe": 1, "pagePath": "/events/abc", "pageAudience": "private",
     "pageHidden": false}
    """#

    static func event() throws -> EventSummary {
        try JSONDecoder().decode(EventSummary.self, from: Data(eventJSON.utf8))
    }

    static func json(_ endpoint: some APIEndpoint) throws -> [String: Any] {
        let body = try #require(endpoint.body)
        return try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
    }

    @Test("the event list decodes everything the editor needs, and a 5.0 event without it still reads")
    func decodes() throws {
        let event = try Self.event()
        #expect(event.description == "Bring snacks")
        #expect(event.location == "Voice 1")
        #expect(event.imageUrl == "https://example.com/a.png")
        #expect(event.start == "2026-11-06T22:00")
        #expect(event.end == "2026-11-07T00:30")
        #expect(event.endAt == 1_794_007_800_000)
        #expect(event.roleId == "333333333333333333")
        #expect(event.reminderMinutes == 30)
        #expect(event.channelId == "222222222222222222")
        #expect(event.pagePath == "/events/abc")
        #expect(event.isPageMembersOnly)
        #expect(!event.pageHidden)

        let old = try JSONDecoder().decode(EventSummary.self, from: Data(#"{"id":1,"title":"Quiz"}"#.utf8))
        #expect(old.description.isEmpty)
        #expect(old.start.isEmpty)
        #expect(old.reminderMinutes == nil)
        #expect(old.pagePath == nil)
        #expect(!old.isPageMembersOnly)
    }

    @Test("an event answer is the whole list, and an event that does not read is dropped")
    func answer() throws {
        let json = Data(#"{"events":[{"id":2,"title":"B"},{"title":"no id"},{"id":1,"title":"A","state":"cancelled"}]}"#.utf8)
        let answer = try JSONDecoder().decode(EventListAnswer.self, from: json)
        #expect(answer.events.map(\.id) == [2, 1])
        #expect(answer.events.last?.state == .cancelled)
    }

    @Test("editing starts from what the event holds, on its own wall clock")
    func editingDraft() throws {
        let draft = EventDraft(editing: try Self.event())
        #expect(draft.title == "Game night")
        #expect(draft.timeZone == "Europe/Oslo")
        #expect(EventTime.wallClockText(draft.start) == "2026-11-06T22:00")
        #expect(draft.end.map(EventTime.wallClockText) == "2026-11-07T00:30")
        #expect(draft.capacity == 12)
        #expect(draft.reminderMinutes == 30)
        #expect(draft.channelID == "222222222222222222")
        #expect(draft.roleID == "333333333333333333")
        #expect(draft.problem(creating: false) == nil)
    }

    @Test("an event from a server that sends no wall-clock text falls back to the instant in its zone")
    func editingDraftWithoutText() {
        let event = EventSummary(id: 3, title: "Old", startAt: 1_793_998_800_000, timeZone: "Europe/Oslo")
        let draft = EventDraft(editing: event)
        #expect(EventTime.wallClockText(draft.start) == "2026-11-06T22:00")
        #expect(draft.end == nil)
        #expect(draft.reminderMinutes == 60)
    }

    @Test("a new event takes the default channel and reminder, and the device's zone")
    func newDraft() {
        let settings = EventsSettings(channel: "222222222222222222", reminderMinutes: 15, timeZone: "Europe/Oslo")
        let now = Date(timeIntervalSince1970: 1_793_993_400)
        let draft = EventDraft(defaults: settings, now: now, deviceZone: "Europe/Oslo")
        #expect(draft.timeZone == "Europe/Oslo")
        #expect(draft.channelID == "222222222222222222")
        #expect(draft.reminderMinutes == 15)
        #expect(EventTime.wallClockText(draft.start) == "2026-11-06T22:00")
        #expect(draft.end == nil)
        #expect(draft.capacity == nil)
        // A zone the device reports that Foundation does not know falls back to UTC.
        #expect(EventDraft(defaults: settings, now: now, deviceZone: "Nowhere/Land").timeZone == "GMT")
    }

    @Test("the form checks what it can: a title, an https image, an end after the start, the capacity, a channel")
    func problems() {
        let start = EventTime.floating(fromText: "2026-11-06T22:00")!
        var draft = EventDraft(title: "Quiz", start: start, timeZone: "UTC", channelID: "1")
        #expect(draft.problem(creating: true) == nil)

        draft.title = "   "
        #expect(draft.problem(creating: true) == "Give the event a title.")
        draft.title = "Quiz"

        draft.imageURL = "http://example.com/a.png"
        #expect(draft.problem(creating: true)?.contains("https") == true)
        draft.imageURL = "https://example.com/a b.png"
        #expect(draft.problem(creating: true) != nil)
        draft.imageURL = "https://" + String(repeating: "a", count: 500)
        #expect(draft.problem(creating: true) != nil)
        draft.imageURL = "https://example.com/a.png"
        #expect(draft.problem(creating: true) == nil)

        draft.end = start
        #expect(draft.problem(creating: true) == "The end time must be after the start time.")
        draft.end = start.addingTimeInterval(60)
        #expect(draft.problem(creating: true) == nil)

        draft.capacity = 0
        #expect(draft.problem(creating: true) != nil)
        draft.capacity = 501
        #expect(draft.problem(creating: true) != nil)
        draft.capacity = 500
        #expect(draft.problem(creating: true) == nil)

        draft.channelID = ""
        #expect(draft.problem(creating: true) == "Pick a channel to post in.")
        // An edit never changes the channel, so it needs none.
        #expect(draft.problem(creating: false) == nil)
    }

    @Test("posting an event sends the dashboard's fields and the channel and role, the time as wall-clock text")
    func createBody() throws {
        let draft = EventDraft(
            title: " Game night ", description: "Bring snacks", location: "Voice 1", imageURL: "https://example.com/a.png",
            start: EventTime.floating(fromText: "2026-11-06T22:00")!, end: EventTime.floating(fromText: "2026-11-07T00:30")!,
            timeZone: "Europe/Oslo", capacity: 12, reminderMinutes: 30, channelID: "222222222222222222",
            roleID: "333333333333333333")
        let e = Endpoints.CreateEvent(server: fluxer, draft: draft)
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/modules/events/events")
        #expect(e.method == .post)
        #expect(e.requiresAuth)
        let body = try Self.json(e)
        #expect(Set(body.keys) == [
            "title", "description", "start", "end", "timeZone", "location", "imageUrl", "capacity",
            "reminderMinutes", "channelId", "roleId",
        ])
        #expect(body["title"] as? String == "Game night")
        #expect(body["start"] as? String == "2026-11-06T22:00")
        #expect(body["end"] as? String == "2026-11-07T00:30")
        #expect(body["timeZone"] as? String == "Europe/Oslo")
        #expect(body["capacity"] as? Int == 12)
        #expect(body["reminderMinutes"] as? Int == 30)
        #expect(body["channelId"] as? String == "222222222222222222")
        #expect(body["roleId"] as? String == "333333333333333333")
    }

    @Test("no end and no limit are sent the way the dashboard sends them: an empty end and a null capacity")
    func createBodyWithoutOptionals() throws {
        let draft = EventDraft(
            title: "Quiz", start: EventTime.floating(fromText: "2026-11-06T22:00")!, timeZone: "UTC", channelID: "1")
        let body = try Self.json(Endpoints.CreateEvent(server: "1", draft: draft))
        #expect(body["end"] as? String == "")
        #expect(body["capacity"] is NSNull)
        #expect(body["roleId"] as? String == "")
        #expect(body["imageUrl"] as? String == "")
    }

    @Test("an edit goes to the event's path and leaves the channel and role out")
    func updateBody() throws {
        let draft = EventDraft(editing: try Self.event())
        let e = Endpoints.UpdateEvent(server: fluxer, id: 12, draft: draft)
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/modules/events/events/12")
        #expect(e.method == .post)
        let body = try Self.json(e)
        #expect(Set(body.keys) == [
            "title", "description", "start", "end", "timeZone", "location", "imageUrl", "capacity", "reminderMinutes",
        ])
        #expect(body["start"] as? String == "2026-11-06T22:00")
    }

    @Test("cancelling posts an empty object to the cancel path")
    func cancelBody() throws {
        let e = Endpoints.CancelEvent(server: fluxer, id: 12)
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/modules/events/events/12/cancel")
        #expect(e.method == .post)
        #expect(try Self.json(e).isEmpty)
    }
}

@MainActor
@Suite("Event actions")
struct EventActionsTests {
    static func draft() -> EventDraft {
        EventDraft(title: "Quiz", start: EventTime.floating(fromText: "2026-11-06T22:00")!, timeZone: "UTC", channelID: "1")
    }

    @Test("posting keeps the list the server answers with")
    func create() async throws {
        let clients = StubClients { endpoint in
            guard endpoint is Endpoints.CreateEvent else { throw NetworkError.notFound }
            return EventListAnswer(events: [EventSummary(id: 5, title: "Quiz")])
        }
        let model = EventActionsModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(model.events == nil)
        #expect(await model.create(Self.draft()))
        #expect(model.events?.map(\.id) == [5])
        #expect(model.doneCount == 1)
        #expect(model.errorMessage == nil)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.CreateEvent)
        #expect(sent.draft.title == "Quiz")

        model.forgetAnswer()
        #expect(model.events == nil)
    }

    @Test("a draft the form would refuse is not sent")
    func refusesBadDraft() async {
        let clients = StubClients { _ in EventListAnswer() }
        let model = EventActionsModel(server: "9", session: makeSignedInSession(clients: clients))
        var draft = Self.draft()
        draft.title = ""
        #expect(await model.create(draft) == false)
        #expect(model.errorMessage == "Give the event a title.")
        #expect(await model.update(id: 1, draft) == false)
        #expect(clients.calls.isEmpty)
    }

    @Test("the server's own words are shown when it refuses")
    func serverWords() async {
        let clients = StubClients { _ in
            throw NetworkError.badRequest(message: "The start time must be in the future.")
        }
        let model = EventActionsModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(await model.create(Self.draft()) == false)
        #expect(model.errorMessage == "The start time must be in the future.")
        #expect(model.events == nil)
        #expect(model.doneCount == 0)
    }

    @Test("other failures read like everywhere else in the app")
    func otherFailures() async {
        let clients = StubClients { _ in throw NetworkError.forbidden }
        let model = EventActionsModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(await model.cancel(id: 4) == false)
        #expect(model.errorMessage == NetworkError.forbidden.userMessage)
    }

    @Test("editing and cancelling send the event's id")
    func updateAndCancel() async throws {
        let clients = StubClients { _ in EventListAnswer(events: [EventSummary(id: 4, title: "Quiz", state: .cancelled)]) }
        let model = EventActionsModel(server: "9", session: makeSignedInSession(clients: clients))
        #expect(await model.update(id: 4, Self.draft()))
        let update = try #require(clients.calls.last?.endpoint as? Endpoints.UpdateEvent)
        #expect(update.id == 4)
        #expect(await model.cancel(id: 4))
        let cancel = try #require(clients.calls.last?.endpoint as? Endpoints.CancelEvent)
        #expect(cancel.id == 4)
        #expect(model.events?.first?.state == .cancelled)
        #expect(model.doneCount == 2)
    }
}
