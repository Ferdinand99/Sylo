import Foundation
import Testing
@testable import SyloKit

// Channel cleanup: the schedule list page (as Sylo 5.0 and 5.1.1 send it, and as a server before 5.0), the form's draft, what
// the form sends, and the screen's model. The dashboard's form is
// web-v2/src/moduleForms/ChannelCleanup.jsx.

private func jsonObject(of value: some Encodable) throws -> [String: Any] {
    let data = try JSONEncoder().encode(value)
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

private let channelID = "333333333333333333"

enum CleanupFixtures {
    /// `GET .../modules/channel-cleanup/schedules` as Sylo 5.0 and 5.1.1 send it (the same shape in
    /// both, checked against the v5.0.0 and v5.1.1 tags): without `timeZone`.
    static let page511 = #"""
    {
      "schedules": [
        {"id": 4, "channelId": "333333333333333333", "days": [0, 1, 2, 3, 4, 5, 6], "timeHhmm": "03:00",
         "maxAgeHours": 24, "skipPinned": true, "enabled": true, "lastRunDate": "2026-11-12", "lastRunCount": 14},
        {"id": 5, "channelId": "333333333333333333", "days": [1, 3], "timeHhmm": "18:30",
         "maxAgeHours": 36, "skipPinned": false, "enabled": false, "lastRunDate": null, "lastRunCount": null}
      ],
      "channels": [{"id": "333333333333333333", "name": "off-topic"}],
      "weekdays": [[0, "Sun"], [1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"]],
      "maxAgeHoursCap": 2160
    }
    """#

    /// A server from before 5.0: only schedules and channels, no weekday list, no cap.
    static let pagePre50 = #"""
    {
      "schedules": [{"id": 1, "channelId": "333333333333333333", "days": [2], "timeHhmm": "04:15", "maxAgeHours": 48,
                     "skipPinned": true, "enabled": true}],
      "channels": [{"id": "333333333333333333", "name": "off-topic"}]
    }
    """#

    /// The same page from a server that also says its zone.
    static let pageWithZone = page511.replacingOccurrences(
        of: "\"maxAgeHoursCap\": 2160", with: "\"maxAgeHoursCap\": 2160, \"timeZone\": \"Europe/Oslo\"")

    static func decode(_ json: String) throws -> CleanupPage {
        try JSONDecoder().decode(CleanupPage.self, from: Data(json.utf8))
    }
}

@Suite("Channel cleanup: decoding and words")
struct CleanupDecodingTests {
    @Test("a current page: schedules, channels, weekdays and the cap")
    func decodesPage() throws {
        let page = try CleanupFixtures.decode(CleanupFixtures.page511)

        #expect(page.schedules.map(\.id) == [4, 5])
        #expect(page.channels.map(\.name) == ["off-topic"])
        #expect(page.weekdays.count == 7)
        #expect(page.maxAgeHoursCap == 2160)

        let daily = page.schedules[0]
        #expect(daily.days == Array(0...6))
        #expect(daily.timeHhmm == "03:00")
        #expect(daily.maxAgeHours == 24)
        #expect(daily.skipPinned)
        #expect(daily.enabled)
        #expect(daily.lastRunDate == "2026-11-12")
        #expect(daily.lastRunCount == 14)

        let paused = page.schedules[1]
        #expect(!paused.enabled)
        #expect(!paused.skipPinned)
        #expect(paused.lastRunDate == nil)
        #expect(paused.lastRunCount == nil)
    }

    @Test("the server's zone is read when it sends one, and a 5.1.1 page has none")
    func timeZone() throws {
        #expect(try CleanupFixtures.decode(CleanupFixtures.page511).timeZone == nil)
        #expect(try CleanupFixtures.decode(CleanupFixtures.pageWithZone).timeZone == "Europe/Oslo")
        #expect(try CleanupFixtures.decode(CleanupFixtures.pagePre50).timeZone == nil)
    }

    @Test("a page from before 5.0 gets the standard weekdays and the 90 day cap")
    func decodesOlderPage() throws {
        let page = try CleanupFixtures.decode(CleanupFixtures.pagePre50)

        #expect(page.schedules.count == 1)
        #expect(page.weekdays == ScheduleWeekday.standard)
        #expect(page.maxAgeHoursCap == 2160)
        #expect(page.schedules[0].lastRunDate == nil)
    }

    @Test("a schedule that cannot be read is dropped, odd values fall back")
    func lossy() throws {
        let page = try CleanupFixtures.decode(#"""
        {"schedules": [{"id": "x"}, {"id": 2, "days": [9, 3], "timeHhmm": 5, "maxAgeHours": "old", "lastRunDate": ""}]}
        """#)

        #expect(page.schedules.map(\.id) == [2])
        let schedule = page.schedules[0]
        #expect(schedule.days == [3])
        #expect(schedule.timeHhmm == "03:00")
        #expect(schedule.maxAgeHours == 24)
        #expect(schedule.lastRunDate == nil)
    }

    @Test("a schedule reads as its days and time, its age and its last run")
    func summaries() throws {
        let page = try CleanupFixtures.decode(CleanupFixtures.page511)

        // The time and days are on the server's clock; with its zone not known the summary says so.
        #expect(page.schedules[0].whenSummary() == "every day at 03:00 (server time)")
        #expect(page.schedules[1].whenSummary() == "Mon/Wed at 18:30 (server time)")

        // The same zone as the phone: as stored, nothing to say.
        let oslo = TimeZone(identifier: "Europe/Oslo")!
        let tokyo = TimeZone(identifier: "Asia/Tokyo")!
        let same = ServerClock(serverZone: "Europe/Oslo", phoneZone: oslo)
        #expect(page.schedules[1].whenSummary(clock: same) == "Mon/Wed at 18:30")

        // Another zone, known: moved to the phone's clock. 18:30 in Oslo is 02:30 the next day in Tokyo.
        let apart = ServerClock(serverZone: "Europe/Oslo", phoneZone: tokyo)
        let now = Date(timeIntervalSince1970: 1_794_000_000)
        #expect(page.schedules[1].whenSummary(clock: apart, now: now) == "Tue/Thu at 02:30")
        #expect(page.schedules[0].whenSummary(clock: apart, now: now) == "every day at 11:00")
        #expect(page.schedules[0].lastRunSummary == "last ran 2026-11-12 (14 deleted)")
        #expect(page.schedules[1].lastRunSummary == nil)
        #expect(CleanupSchedule(id: 1, lastRunDate: "2026-11-01", lastRunCount: 0).lastRunSummary == "last ran 2026-11-01")
    }

    @Test("an age reads as days when it is whole days, else as hours")
    func ageLabels() {
        #expect(CleanupSchedule.ageLabel(hours: 24) == "1d")
        #expect(CleanupSchedule.ageLabel(hours: 48) == "2d")
        #expect(CleanupSchedule.ageLabel(hours: 36) == "36h")
        #expect(CleanupSchedule.ageLabel(hours: 1) == "1h")
    }

    @Test("the answers of a save and a toggle, where a toggle of a deleted schedule is null")
    func answers() throws {
        let toggled = try JSONDecoder().decode(
            CleanupScheduleAnswer.self,
            from: Data(#"{"schedule": {"id": 4, "channelId": "333333333333333333", "enabled": false}}"#.utf8))
        #expect(toggled.schedule?.id == 4)
        #expect(toggled.schedule?.enabled == false)

        let gone = try JSONDecoder().decode(CleanupScheduleAnswer.self, from: Data(#"{"schedule": null}"#.utf8))
        #expect(gone.schedule == nil)
    }
}

@Suite("Channel cleanup: the time of day")
struct CleanupTimeTests {
    @Test("a time reads back as the same text")
    func roundTrip() throws {
        for text in ["00:00", "03:00", "09:05", "18:30", "23:59"] {
            let date = try #require(CleanupTime.date(from: text))
            #expect(CleanupTime.text(from: date) == text)
        }
    }

    @Test("only HH:MM is a time")
    func validity() {
        #expect(CleanupTime.isValid("03:00"))
        for text in ["", "3:00", "03:0", "24:00", "12:60", "ab:cd", "03-00", "03:00:00", " 03:00"] {
            #expect(!CleanupTime.isValid(text), "\(text) should not be valid")
        }
    }
}

@Suite("Channel cleanup: the form's draft")
struct CleanupDraftTests {
    static func valid() -> CleanupDraft {
        var draft = CleanupDraft()
        draft.channelId = channelID
        return draft
    }

    @Test("a new schedule is the dashboard's blank form: every day at 03:00, a day old, pinned kept")
    func newDraft() {
        let draft = CleanupDraft()
        #expect(draft.channelId == "")
        #expect(draft.days == ScheduleDays.all)
        #expect(draft.timeHhmm == "03:00")
        #expect(draft.maxAgeHours == 24)
        #expect(draft.skipPinned)
        #expect(draft.problem() == "Pick a channel.")
    }

    @Test("the problems the form names")
    func problems() {
        var draft = Self.valid()
        #expect(draft.problem() == nil)

        // No day is allowed: the server stores it as every day, as it does for the dashboard's form.
        draft.days = []
        #expect(draft.problem() == nil)
        draft.days = [2]

        draft.timeHhmm = "25:00"
        #expect(draft.problem() == "Pick a valid time.")
        draft.timeHhmm = "03:00"

        draft.maxAgeHours = 0
        #expect(draft.problem()?.hasPrefix("The age is between 1 and") == true)
        draft.maxAgeHours = 2161
        #expect(draft.problem()?.hasPrefix("The age is between 1 and") == true)
        draft.maxAgeHours = 2160
        #expect(draft.problem() == nil)
        #expect(draft.problem(maxAgeHoursCap: 100) != nil)
    }

    @Test("editing copies the stored schedule")
    func editing() throws {
        let page = try CleanupFixtures.decode(CleanupFixtures.page511)
        let draft = CleanupDraft(editing: page.schedules[1])

        #expect(draft.channelId == channelID)
        #expect(draft.days == [1, 3])
        #expect(draft.timeHhmm == "18:30")
        #expect(draft.maxAgeHours == 36)
        #expect(!draft.skipPinned)
    }

    @Test("the body holds exactly the dashboard's five keys, the days in order")
    func bodyKeys() throws {
        var draft = Self.valid()
        draft.days = [5, 1, 3]
        draft.timeHhmm = "18:30"
        draft.maxAgeHours = 36
        draft.skipPinned = false
        let body = try jsonObject(of: CleanupBody(draft: draft))

        #expect(Set(body.keys) == ["channelId", "days", "timeHhmm", "maxAgeHours", "skipPinned"])
        #expect(body["channelId"] as? String == channelID)
        #expect(body["days"] as? [Int] == [1, 3, 5])
        #expect(body["timeHhmm"] as? String == "18:30")
        #expect(body["maxAgeHours"] as? Int == 36)
        #expect(body["skipPinned"] as? Bool == false)
    }

    @Test("the calls go where the dashboard's go")
    func paths() {
        let draft = CleanupDraft()
        let base = "/api/v2/guilds/1/modules/channel-cleanup/schedules"
        #expect(Endpoints.LoadCleanupSchedules(server: "1").path == base)
        #expect(Endpoints.LoadCleanupSchedules(server: "1").method == .get)
        #expect(Endpoints.SaveCleanupSchedule(server: "1", draft: draft).path == base)
        #expect(Endpoints.SaveCleanupSchedule(server: "1", draft: draft).method == .post)
        #expect(Endpoints.SaveCleanupSchedule(server: "1", id: 4, draft: draft).path == base + "/4")
        #expect(Endpoints.DeleteCleanupSchedule(server: "1", id: 4).path == base + "/4/delete")
        #expect(Endpoints.ToggleCleanupSchedule(server: "1", id: 4).path == base + "/4/toggle")
        #expect(Endpoints.ToggleCleanupSchedule(server: "1", id: 4).method == .post)
    }
}

/// The server's side of the cleanup schedules for the model tests.
final class FakeCleanupServer: @unchecked Sendable {
    // @unchecked: every field is only touched while holding `lock`.
    private let lock = NSLock()
    private var _calls: [String] = []
    private var _schedules: [CleanupSchedule]
    private var _failure: NetworkError?
    private var nextID = 30

    private let timeZone: String?

    init(schedules: [CleanupSchedule] = [], timeZone: String? = nil) {
        _schedules = schedules
        self.timeZone = timeZone
    }

    var calls: [String] { lock.withLock { _calls } }
    var schedules: [CleanupSchedule] { lock.withLock { _schedules } }

    func fail(with error: NetworkError?) { lock.withLock { _failure = error } }
    func removeAll() { lock.withLock { _schedules = [] } }

    private func record(_ call: String) { lock.withLock { _calls.append(call) } }

    func clients() -> StubClients {
        StubClients { [self] endpoint in
            if endpoint is Endpoints.LoadCleanupSchedules {
                record("list")
                return CleanupPage(
                    schedules: schedules, channels: [ChannelOption(id: channelID, name: "off-topic")],
                    timeZone: timeZone)
            }
            if let save = endpoint as? Endpoints.SaveCleanupSchedule {
                record("save:\(save.id.map(String.init) ?? "new")")
                if let error = lock.withLock({ _failure }) { throw error }
                // The server answers 404 for a schedule that is gone.
                if let id = save.id, lock.withLock({ !_schedules.contains { $0.id == id } }) {
                    throw NetworkError.notFound(message: "No such schedule")
                }
                return lock.withLock {
                    let id = save.id ?? nextID
                    if save.id == nil { nextID += 1 }
                    let draft = save.draft
                    let schedule = CleanupSchedule(
                        id: id, channelId: draft.channelId, days: draft.days.sorted(), timeHhmm: draft.timeHhmm,
                        maxAgeHours: draft.maxAgeHours, skipPinned: draft.skipPinned, enabled: true)
                    if let index = _schedules.firstIndex(where: { $0.id == id }) {
                        _schedules[index] = schedule
                    } else {
                        _schedules.append(schedule)
                    }
                    return CleanupScheduleAnswer(schedule: schedule)
                }
            }
            if let toggle = endpoint as? Endpoints.ToggleCleanupSchedule {
                record("toggle:\(toggle.id)")
                if let error = lock.withLock({ _failure }) { throw error }
                return lock.withLock {
                    guard let index = _schedules.firstIndex(where: { $0.id == toggle.id }) else {
                        return CleanupScheduleAnswer(schedule: nil)
                    }
                    let old = _schedules[index]
                    let flipped = CleanupSchedule(
                        id: old.id, channelId: old.channelId, days: old.days, timeHhmm: old.timeHhmm,
                        maxAgeHours: old.maxAgeHours, skipPinned: old.skipPinned, enabled: !old.enabled)
                    _schedules[index] = flipped
                    return CleanupScheduleAnswer(schedule: flipped)
                }
            }
            if let delete = endpoint as? Endpoints.DeleteCleanupSchedule {
                record("delete:\(delete.id)")
                if let error = lock.withLock({ _failure }) { throw error }
                lock.withLock { _schedules.removeAll { $0.id == delete.id } }
                return EmptyResponse()
            }
            throw NetworkError.notFound
        }
    }
}

@MainActor
@Suite("Channel cleanup: the screen's model")
struct ChannelCleanupModelTests {
    static let stored = CleanupSchedule(id: 4, channelId: channelID, timeHhmm: "03:00", maxAgeHours: 24)

    func make(_ server: FakeCleanupServer) async -> ChannelCleanupModel {
        let model = ChannelCleanupModel(server: "9", session: makeSignedInSession(clients: server.clients()))
        await model.load()
        return model
    }

    @Test("loading fills the list, the channels, the weekdays and the cap")
    func loads() async {
        let model = await make(FakeCleanupServer(schedules: [Self.stored]))

        #expect(model.hasLoaded)
        #expect(model.schedules.map(\.id) == [4])
        #expect(model.channels.map(\.name) == ["off-topic"])
        #expect(model.weekdays.count == 7)
        #expect(model.maxAgeHoursCap == 2160)
    }

    @Test("a page that cannot be loaded says why")
    func loadFails() async {
        let model = ChannelCleanupModel(
            server: "9", session: makeSignedInSession(clients: StubClients { _ in throw NetworkError.notFound }))
        await model.load()
        #expect(!model.hasLoaded)
        #expect(model.errorMessage != nil)
    }

    @Test("a new schedule is added to the list")
    func creates() async {
        let server = FakeCleanupServer(schedules: [Self.stored])
        let model = await make(server)

        #expect(await model.save(CleanupDraftTests.valid(), editing: nil))

        #expect(server.calls == ["list", "save:new"])
        #expect(model.schedules.map(\.id) == [4, 30])
    }

    @Test("a draft that is not ready is not sent, and one with no day is")
    func refusesBeforeSending() async {
        let server = FakeCleanupServer()
        let model = await make(server)

        #expect(!(await model.save(CleanupDraft(), editing: nil)))
        #expect(model.saveError == "Pick a channel.")
        #expect(server.calls == ["list"])

        var draft = CleanupDraftTests.valid()
        draft.days = []
        #expect(await model.save(draft, editing: nil))
        #expect(server.calls == ["list", "save:new"])
    }

    @Test("an edit of a schedule that is gone (404) removes the stale row and says why")
    func updateGone() async {
        let server = FakeCleanupServer(schedules: [Self.stored])
        let model = await make(server)
        server.removeAll()

        #expect(!(await model.save(CleanupDraft(editing: Self.stored), editing: 4)))

        #expect(model.schedules.isEmpty)
        #expect(model.saveError == "No such schedule")
    }

    @Test("the server's zone gives the clock the screen compares with the phone's")
    func clock() async {
        let unknown = await make(FakeCleanupServer(schedules: [Self.stored]))
        #expect(unknown.clock.needsServerTimeLabel)

        let model = await make(FakeCleanupServer(schedules: [Self.stored], timeZone: "Europe/Oslo"))
        #expect(model.timeZone == "Europe/Oslo")
        #expect(!model.clock.needsServerTimeLabel)
    }

    @Test("an edit replaces the schedule in the list")
    func updates() async {
        let server = FakeCleanupServer(schedules: [Self.stored])
        let model = await make(server)
        var draft = CleanupDraft(editing: Self.stored)
        draft.maxAgeHours = 72

        #expect(await model.save(draft, editing: 4))

        #expect(server.calls == ["list", "save:4"])
        #expect(model.schedule(id: 4)?.maxAgeHours == 72)
    }

    @Test("a refused save keeps the list and the server's words")
    func saveFails() async {
        let server = FakeCleanupServer(schedules: [Self.stored])
        let model = await make(server)
        server.fail(with: .badRequest(message: "Pick a valid time."))

        #expect(!(await model.save(CleanupDraftTests.valid(), editing: nil)))

        #expect(model.saveError == "Pick a valid time.")
        #expect(model.schedules.map(\.id) == [4])
    }

    @Test("pause and resume take the schedule from the server's answer")
    func toggles() async {
        let server = FakeCleanupServer(schedules: [Self.stored])
        let model = await make(server)

        await model.toggle(4)
        #expect(model.schedule(id: 4)?.enabled == false)
        await model.toggle(4)
        #expect(model.schedule(id: 4)?.enabled == true)
        #expect(server.calls == ["list", "toggle:4", "toggle:4"])
    }

    @Test("a toggle answered with null removes the schedule: it was deleted elsewhere")
    func toggleGone() async {
        let server = FakeCleanupServer(schedules: [Self.stored])
        let model = await make(server)
        server.removeAll()

        await model.toggle(4)

        #expect(model.schedules.isEmpty)
        #expect(model.actionError == nil)
    }

    @Test("a delete removes the schedule, a refused one keeps it and says why")
    func deletes() async {
        let server = FakeCleanupServer(schedules: [Self.stored])
        let model = await make(server)

        server.fail(with: .forbidden(message: "You can't change cleanups."))
        await model.delete(4)
        #expect(model.schedules.count == 1)
        #expect(model.actionError == "You can't change cleanups.")

        server.fail(with: nil)
        await model.delete(4)
        #expect(model.schedules.isEmpty)
    }
}
