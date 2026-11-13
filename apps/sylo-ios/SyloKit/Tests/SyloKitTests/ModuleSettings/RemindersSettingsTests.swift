import Foundation
import Testing
@testable import SyloKit

// Reminders: the list page (a 5.2 shaped one and a 5.1 shaped one), the form's draft, what the form
// sends, and the screen's model. The dashboard's form is web-v2/src/moduleForms/Reminders.jsx.

private func jsonObject(of value: some Encodable) throws -> [String: Any] {
    let data = try JSONEncoder().encode(value)
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

private let channel = "222222222222222222"

enum RemindersFixtures {
    /// `GET .../modules/reminders/list` from a current server.
    static let page52 = #"""
    {
      "reminders": [
        {"id": 7, "name": "Stand-up", "channelId": "222222222222222222",
         "spec": {"content": "Stand-up in five.", "embeds": []},
         "mode": "multiple", "intervalMinutes": 1440, "days": [1, 2, 3, 4, 5],
         "startAt": 1793000000000, "endAt": null, "runAt": null, "enabled": true, "lastRunAt": 1794000000000},
        {"id": 8, "name": "Launch", "channelId": "222222222222222222",
         "spec": {"content": "Above", "embeds": [
           {"kind": "embed", "title": "Hello", "description": "D", "color": "#57f287", "image": "", "thumbnail": "",
            "authorName": "", "authorIcon": "", "footerText": "", "footerIcon": "", "timestamp": true, "fields": [],
            "futureKey": 5}]},
         "mode": "single", "intervalMinutes": 60, "days": [0, 1, 2, 3, 4, 5, 6],
         "startAt": null, "endAt": null, "runAt": 1794000000000, "enabled": false, "lastRunAt": null}
      ],
      "allowPings": false,
      "channels": [{"id": "222222222222222222", "name": "announcements"}],
      "schedulePresets": [["1", "Every minute"], ["60", "Every hour"], ["1440", "Every day"]],
      "weekdays": [[0, "Sun"], [1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"]],
      "minIntervalMinutes": 1,
      "maxIntervalMinutes": 40320
    }
    """#

    /// A server from before the pings setting and the shared lists: just reminders and channels.
    static let page51 = #"""
    {
      "reminders": [
        {"id": 1, "name": "Old", "channelId": "222222222222222222", "spec": {"content": "Hi", "embeds": []},
         "mode": "multiple", "intervalMinutes": 60, "days": [0, 1, 2, 3, 4, 5, 6],
         "startAt": null, "endAt": null, "runAt": null, "enabled": true}
      ],
      "channels": [{"id": "222222222222222222", "name": "announcements"}]
    }
    """#

    static func decode(_ json: String) throws -> RemindersPage {
        try JSONDecoder().decode(RemindersPage.self, from: Data(json.utf8))
    }
}

@Suite("Reminders: decoding")
struct RemindersDecodingTests {
    @Test("a current page: reminders, pings, channels, the server's presets and weekdays")
    func decodesCurrentPage() throws {
        let page = try RemindersFixtures.decode(RemindersFixtures.page52)

        #expect(page.reminders.map(\.id) == [7, 8])
        #expect(page.allowPings == false)
        #expect(page.channels.map(\.name) == ["announcements"])
        #expect(page.schedulePresets.map(\.minutes) == [1, 60, 1440])
        #expect(page.schedulePresets[1].label == "Every hour")
        #expect(page.weekdays.count == 7)
        #expect(page.weekdays[1] == ScheduleWeekday(number: 1, label: "Mon"))
        #expect(page.minIntervalMinutes == 1)
        #expect(page.maxIntervalMinutes == 40320)

        let standUp = page.reminders[0]
        #expect(standUp.mode == .multiple)
        #expect(standUp.content == "Stand-up in five.")
        #expect(standUp.embed == nil)
        #expect(standUp.days == [1, 2, 3, 4, 5])
        #expect(standUp.startAt == Date(timeIntervalSince1970: 1_793_000_000))
        #expect(standUp.endAt == nil)
        #expect(standUp.lastRunAt == Date(timeIntervalSince1970: 1_794_000_000))
        #expect(standUp.enabled)

        let launch = page.reminders[1]
        #expect(launch.mode == .single)
        #expect(launch.runAt == Date(timeIntervalSince1970: 1_794_000_000))
        #expect(launch.content == "Above")
        #expect(launch.embed?.title == "Hello")
        #expect(launch.embed?.timestamp == true)
        #expect(launch.embed?.extra["futureKey"] == .int(5))
        #expect(!launch.enabled)
    }

    @Test("a 5.1 page has no pings switch, and the standard presets and weekdays stand in")
    func decodesOlderPage() throws {
        let page = try RemindersFixtures.decode(RemindersFixtures.page51)

        #expect(page.reminders.count == 1)
        #expect(page.allowPings == nil)
        #expect(page.schedulePresets == ReminderPreset.standard)
        #expect(page.weekdays == ScheduleWeekday.standard)
        #expect(page.minIntervalMinutes == 1)
        #expect(page.maxIntervalMinutes == 40320)
    }

    @Test("a reminder that cannot be read is dropped, odd values fall back")
    func lossyReminders() throws {
        let page = try RemindersFixtures.decode(#"""
        {"reminders": [
          {"id": "not a number"},
          {"id": 3, "name": 5, "mode": "someday", "days": [], "spec": null, "intervalMinutes": "soon", "enabled": null},
          {"id": 4, "days": [9, 2, -1]}
        ]}
        """#)

        #expect(page.reminders.map(\.id) == [3, 4])
        let odd = page.reminders[0]
        #expect(odd.name == "")
        #expect(odd.mode == .multiple)
        #expect(odd.days == Array(0...6))
        #expect(odd.content == "")
        #expect(odd.embed == nil)
        #expect(odd.intervalMinutes == 60)
        #expect(odd.enabled)
        #expect(page.reminders[1].days == [2])
    }

    @Test("presets may come as numbers, and a bad pair is skipped")
    func numericPresets() throws {
        let page = try RemindersFixtures.decode(#"""
        {"schedulePresets": [[5, "Every 5 minutes"], ["x", "Bad"], [60, "Every hour"]], "weekdays": [[1, "Mon"], "bad"]}
        """#)

        #expect(page.schedulePresets.map(\.minutes) == [5, 60])
        #expect(page.weekdays == [ScheduleWeekday(number: 1, label: "Mon")])
    }

    @Test("a stored message with several embeds counts them and shows the first")
    func severalEmbeds() throws {
        let page = try RemindersFixtures.decode(#"""
        {"reminders": [{"id": 1, "spec": {"content": "", "embeds": [{"title": "A"}, {"title": "B"}]}}]}
        """#)

        let reminder = try #require(page.reminders.first)
        #expect(reminder.embed?.title == "A")
        #expect(reminder.embedCount == 2)
        #expect(ReminderDraft(editing: reminder).droppedEmbeds == 1)
    }

    @Test("the answers of a save, a toggle and the pings switch")
    func answers() throws {
        let saved = try JSONDecoder().decode(
            ReminderAnswer.self, from: Data(#"{"reminder": {"id": 9, "name": "New"}}"#.utf8))
        #expect(saved.reminder?.id == 9)
        let gone = try JSONDecoder().decode(ReminderAnswer.self, from: Data(#"{"reminder": null}"#.utf8))
        #expect(gone.reminder == nil)
        let pings = try JSONDecoder().decode(ReminderPingsAnswer.self, from: Data(#"{"allowPings": true}"#.utf8))
        #expect(pings.allowPings == true)
    }
}

@Suite("Reminders: schedule words")
struct ReminderScheduleWordsTests {
    @Test("days read as every day, or the short names in week order")
    func dayLabels() {
        #expect(ScheduleDays.label(for: Array(0...6)) == "every day")
        #expect(ScheduleDays.label(for: [3, 1]) == "Mon/Wed")
        #expect(ScheduleDays.label(for: [9, 2]) == "Tue")
    }

    @Test("a repeating reminder reads as its preset and its days")
    func repeatingSummary() {
        let hourly = Reminder(id: 1, intervalMinutes: 60)
        #expect(hourly.scheduleSummary() == "Every hour")

        let weekdays = Reminder(id: 2, intervalMinutes: 1440, days: [1, 3])
        #expect(weekdays.scheduleSummary() == "Every day \u{00B7} Mon/Wed")

        let custom = Reminder(id: 3, intervalMinutes: 45)
        #expect(custom.scheduleSummary() == "Every 45 min")
    }

    @Test("a single reminder reads as once, with its time when it has one")
    func singleSummary() {
        let none = Reminder(id: 1, mode: .single)
        #expect(none.scheduleSummary() == "Once, no time set")

        let timed = Reminder(id: 2, mode: .single, runAt: Date(timeIntervalSince1970: 1_794_000_000))
        let zone = TimeZone(identifier: "UTC")
        let text = timed.scheduleSummary(timeZone: zone)
        #expect(text.hasPrefix("Once, "))
        // 21:20 UTC, as a 24-hour or a 12-hour clock.
        #expect(text.contains("21:20") || text.contains("9:20"))
    }

    @Test("an interval no preset names stays selectable")
    func presetOptions() {
        let standard = ReminderPreset.standard
        #expect(ReminderPreset.options(including: 60, in: standard) == standard)
        let withCustom = ReminderPreset.options(including: 45, in: standard)
        #expect(withCustom.count == standard.count + 1)
        #expect(withCustom.last == ReminderPreset(minutes: 45, label: "Every 45 min"))
    }
}

@Suite("Reminders: the form's draft")
struct ReminderDraftTests {
    static func valid() -> ReminderDraft {
        var draft = ReminderDraft()
        draft.channelId = channel
        draft.content = "Hello"
        return draft
    }

    @Test("a new reminder repeats every hour on every day and is not ready until it has a channel and a message")
    func newDraft() {
        var draft = ReminderDraft()
        #expect(draft.kind == .text)
        #expect(draft.mode == .multiple)
        #expect(draft.intervalMinutes == 60)
        #expect(draft.days == ScheduleDays.all)
        #expect(!draft.enableStart && !draft.enableEnd)
        #expect(draft.problem == "Pick a channel.")

        draft.channelId = channel
        #expect(draft.problem == "Add a message or an embed.")

        draft.content = "   "
        #expect(draft.problem == "Add a message or an embed.")

        draft.content = "Hello"
        #expect(draft.problem == nil)
    }

    @Test("an embed reminder needs something in the embed or the text above it")
    func embedNeedsContent() {
        var draft = Self.valid()
        draft.kind = .embed
        draft.content = ""
        #expect(draft.problem == "Add a message or an embed.")

        draft.embed.title = "Hello"
        #expect(draft.problem == nil)

        draft.embed.title = ""
        draft.embed.content = "Above"
        #expect(draft.problem == nil)
    }

    @Test("an end before the start is refused")
    func endBeforeStart() {
        var draft = Self.valid()
        draft.enableStart = true
        draft.enableEnd = true
        draft.startAt = Date(timeIntervalSince1970: 2_000)
        draft.endAt = Date(timeIntervalSince1970: 1_000)
        #expect(draft.problem == "The end time must be after the start time.")

        draft.endAt = Date(timeIntervalSince1970: 3_000)
        #expect(draft.problem == nil)

        // A single reminder has no window.
        draft.endAt = Date(timeIntervalSince1970: 1_000)
        draft.mode = .single
        #expect(draft.problem == nil)
    }

    @Test("a single reminder in the past is posted at once, one in the future is not")
    func postsImmediately() {
        var draft = Self.valid()
        draft.mode = .single
        let now = Date(timeIntervalSince1970: 1_000_000)
        draft.runAt = now.addingTimeInterval(-60)
        #expect(draft.postsImmediately(now: now))
        draft.runAt = now.addingTimeInterval(60)
        #expect(!draft.postsImmediately(now: now))
        draft.mode = .multiple
        draft.runAt = now.addingTimeInterval(-60)
        #expect(!draft.postsImmediately(now: now))
    }

    @Test("editing a stored text reminder and an embed reminder")
    func editing() throws {
        let page = try RemindersFixtures.decode(RemindersFixtures.page52)

        let text = ReminderDraft(editing: page.reminders[0])
        #expect(text.kind == .text)
        #expect(text.content == "Stand-up in five.")
        #expect(text.mode == .multiple)
        #expect(text.days == [1, 2, 3, 4, 5])
        #expect(text.enableStart)
        #expect(text.startAt == Date(timeIntervalSince1970: 1_793_000_000))
        #expect(!text.enableEnd)

        let embed = ReminderDraft(editing: page.reminders[1])
        #expect(embed.kind == .embed)
        // The text above the embed lives on the embed, as in the dashboard's editor.
        #expect(embed.embed.content == "Above")
        #expect(embed.content == "")
        #expect(embed.embed.title == "Hello")
        #expect(embed.mode == .single)
        #expect(embed.runAt == Date(timeIntervalSince1970: 1_794_000_000))
    }
}

@Suite("Reminders: what the form sends")
struct ReminderBodyTests {
    private static let allKeys: Set<String> = [
        "name", "channelId", "msgType", "content", "embedSpec", "mode", "runAt", "intervalMinutes",
        "enableStart", "startAt", "enableEnd", "endAt", "days",
    ]

    @Test("a repeating text reminder sends the dashboard's keys, with no time for a single run")
    func repeatingText() throws {
        var draft = ReminderDraftTests.valid()
        draft.name = "  Stand-up  "
        draft.intervalMinutes = 1440
        draft.days = [5, 1, 3]
        let body = try jsonObject(of: ReminderBody(draft: draft))

        #expect(Set(body.keys) == Self.allKeys)
        #expect(body["name"] as? String == "Stand-up")
        #expect(body["channelId"] as? String == channel)
        #expect(body["msgType"] as? String == "text")
        #expect(body["content"] as? String == "Hello")
        #expect(body["mode"] as? String == "multiple")
        #expect(body["runAt"] as? String == "")
        #expect(body["intervalMinutes"] as? Int == 1440)
        #expect(body["enableStart"] as? Bool == false)
        #expect(body["startAt"] as? String == "")
        #expect(body["enableEnd"] as? Bool == false)
        #expect(body["endAt"] as? String == "")
        #expect(body["days"] as? [Int] == [1, 3, 5])
    }

    @Test("a single reminder sends its time as an exact instant, cut to the minute")
    func singleTime() throws {
        var draft = ReminderDraftTests.valid()
        draft.mode = .single
        draft.runAt = Date(timeIntervalSince1970: 1_794_000_045)
        let body = try jsonObject(of: ReminderBody(draft: draft))

        #expect(body["mode"] as? String == "single")
        #expect(body["runAt"] as? String == "2026-11-06T21:20:00Z")
    }

    @Test("a start and an end go as instants only when they are on")
    func window() throws {
        var draft = ReminderDraftTests.valid()
        draft.enableStart = true
        draft.startAt = Date(timeIntervalSince1970: 1_793_000_000)
        draft.endAt = Date(timeIntervalSince1970: 1_794_000_000)
        let body = try jsonObject(of: ReminderBody(draft: draft))

        #expect(body["enableStart"] as? Bool == true)
        #expect(body["startAt"] as? String == "2026-10-26T07:33:00Z")
        #expect(body["enableEnd"] as? Bool == false)
        #expect(body["endAt"] as? String == "")
    }

    @Test("an embed reminder sends the embed with the text above it, its timestamp and keys the app does not know")
    func embedSpec() throws {
        var draft = ReminderDraftTests.valid()
        draft.kind = .embed
        draft.embed = EmbedDraft(
            content: "Above", color: "#57f287", title: "Hello", timestamp: true, extra: ["futureKey": .int(5)])
        let body = try jsonObject(of: ReminderBody(draft: draft))

        #expect(body["msgType"] as? String == "embed")
        let spec = try #require(body["embedSpec"] as? [String: Any])
        #expect(spec["kind"] as? String == "embed")
        #expect(spec["content"] as? String == "Above")
        #expect(spec["title"] as? String == "Hello")
        #expect(spec["color"] as? String == "#57f287")
        #expect(spec["timestamp"] as? Bool == true)
        #expect(spec["futureKey"] as? Int == 5)
    }

    @Test("a stored embed goes back with its kind, its timestamp and its unknown keys")
    func storedEmbedRoundTrip() throws {
        let page = try RemindersFixtures.decode(RemindersFixtures.page52)
        let draft = ReminderDraft(editing: page.reminders[1])
        let body = try jsonObject(of: ReminderBody(draft: draft))

        let spec = try #require(body["embedSpec"] as? [String: Any])
        #expect(spec["kind"] as? String == "embed")
        #expect(spec["content"] as? String == "Above")
        #expect(spec["timestamp"] as? Bool == true)
        #expect(spec["futureKey"] as? Int == 5)
        #expect(body["mode"] as? String == "single")
        #expect(body["runAt"] as? String == "2026-11-06T21:20:00Z")
    }

    @Test("the calls go where the dashboard's go: /reminders/new for a new one, never /reminders")
    func paths() {
        let draft = ReminderDraft()
        let base = "/api/v2/guilds/1/modules/reminders"
        #expect(Endpoints.LoadReminders(server: "1").path == base + "/list")
        #expect(Endpoints.SaveReminder(server: "1", draft: draft).path == base + "/new")
        #expect(Endpoints.SaveReminder(server: "1", id: 7, draft: draft).path == base + "/7")
        #expect(Endpoints.DeleteReminder(server: "1", id: 7).path == base + "/7/delete")
        #expect(Endpoints.ToggleReminder(server: "1", id: 7).path == base + "/7/toggle")
        #expect(Endpoints.SetReminderPings(server: "1", allowPings: true).path == base + "/settings")
        #expect(Endpoints.TestReminder(server: "1", draft: draft).path == base + "/test")
        #expect(Endpoints.LoadReminders(server: "1").method == .get)
        #expect(Endpoints.SaveReminder(server: "1", draft: draft).method == .post)
        #expect(Endpoints.SetReminderPings(server: "1", allowPings: true).method == .post)
    }
}

/// The server's side of the reminders for the model tests.
final class FakeRemindersServer: @unchecked Sendable {
    // @unchecked: every field is only touched while holding `lock`.
    private let lock = NSLock()
    private var _calls: [String] = []
    private var _reminders: [Reminder]
    private var _allowPings: Bool?
    private var _failure: NetworkError?
    private var nextID = 20

    init(reminders: [Reminder] = [], allowPings: Bool? = false) {
        _reminders = reminders
        _allowPings = allowPings
    }

    var calls: [String] { lock.withLock { _calls } }
    var reminders: [Reminder] { lock.withLock { _reminders } }

    func fail(with error: NetworkError?) { lock.withLock { _failure = error } }
    func removeAll() { lock.withLock { _reminders = [] } }

    private func record(_ call: String) { lock.withLock { _calls.append(call) } }

    func clients() -> StubClients {
        StubClients { [self] endpoint in
            if endpoint is Endpoints.LoadReminders {
                record("list")
                return RemindersPage(
                    reminders: reminders, allowPings: lock.withLock { _allowPings },
                    channels: [ChannelOption(id: channel, name: "announcements")])
            }
            if let save = endpoint as? Endpoints.SaveReminder {
                record("save:\(save.id.map(String.init) ?? "new")")
                if let error = lock.withLock({ _failure }) { throw error }
                return lock.withLock {
                    let id = save.id ?? nextID
                    if save.id == nil { nextID += 1 }
                    let draft = save.draft
                    let reminder = Reminder(
                        id: id, name: draft.name, channelId: draft.channelId,
                        content: draft.kind == .text ? draft.content : draft.embed.content,
                        embed: draft.kind == .embed ? draft.embed : nil, mode: draft.mode,
                        intervalMinutes: draft.intervalMinutes, days: draft.days.sorted(), enabled: true)
                    if let index = _reminders.firstIndex(where: { $0.id == id }) {
                        _reminders[index] = reminder
                    } else {
                        _reminders.insert(reminder, at: 0)
                    }
                    return ReminderAnswer(reminder: reminder)
                }
            }
            if let toggle = endpoint as? Endpoints.ToggleReminder {
                record("toggle:\(toggle.id)")
                if let error = lock.withLock({ _failure }) { throw error }
                return lock.withLock {
                    guard let index = _reminders.firstIndex(where: { $0.id == toggle.id }) else {
                        return ReminderAnswer(reminder: nil)
                    }
                    let old = _reminders[index]
                    let flipped = Reminder(
                        id: old.id, name: old.name, channelId: old.channelId, content: old.content, embed: old.embed,
                        mode: old.mode, intervalMinutes: old.intervalMinutes, days: old.days, enabled: !old.enabled)
                    _reminders[index] = flipped
                    return ReminderAnswer(reminder: flipped)
                }
            }
            if let delete = endpoint as? Endpoints.DeleteReminder {
                record("delete:\(delete.id)")
                if let error = lock.withLock({ _failure }) { throw error }
                lock.withLock { _reminders.removeAll { $0.id == delete.id } }
                return EmptyResponse()
            }
            if let pings = endpoint as? Endpoints.SetReminderPings {
                record("pings:\(pings.allowPings)")
                if let error = lock.withLock({ _failure }) { throw error }
                lock.withLock { _allowPings = pings.allowPings }
                return ReminderPingsAnswer(allowPings: pings.allowPings)
            }
            if endpoint is Endpoints.TestReminder {
                record("test")
                if let error = lock.withLock({ _failure }) { throw error }
                return EmptyResponse()
            }
            throw NetworkError.notFound
        }
    }
}

@MainActor
@Suite("Reminders: the screen's model")
struct RemindersModelTests {
    static let stored = Reminder(id: 7, name: "Stand-up", channelId: channel, content: "Hi", intervalMinutes: 60)

    func make(
        _ server: FakeRemindersServer, load: Bool = true
    ) async -> RemindersModel {
        let model = RemindersModel(server: "9", session: makeSignedInSession(clients: server.clients()))
        if load { await model.load() }
        return model
    }

    @Test("loading fills the list, the channels and the pings switch")
    func loads() async {
        let server = FakeRemindersServer(reminders: [Self.stored], allowPings: true)
        let model = await make(server)

        #expect(model.hasLoaded)
        #expect(model.reminders.map(\.id) == [7])
        #expect(model.channels.map(\.name) == ["announcements"])
        #expect(model.allowPings == true)
        #expect(model.hasPingSwitch)
        #expect(model.errorMessage == nil)
    }

    @Test("a page that cannot be loaded says why")
    func loadFails() async {
        let model = RemindersModel(
            server: "9", session: makeSignedInSession(clients: StubClients { _ in throw NetworkError.notFound }))
        await model.load()
        #expect(!model.hasLoaded)
        #expect(model.errorMessage != nil)
    }

    @Test("a new reminder goes first in the list and is created through /new")
    func creates() async {
        let server = FakeRemindersServer(reminders: [Self.stored])
        let model = await make(server)

        let done = await model.save(ReminderDraftTests.valid(), editing: nil)

        #expect(done)
        #expect(server.calls == ["list", "save:new"])
        #expect(model.reminders.map(\.id) == [20, 7])
        #expect(model.saveError == nil)
    }

    @Test("a draft that is not ready is not sent")
    func refusesBeforeSending() async {
        let server = FakeRemindersServer()
        let model = await make(server)

        let done = await model.save(ReminderDraft(), editing: nil)

        #expect(!done)
        #expect(model.saveError == "Pick a channel.")
        #expect(server.calls == ["list"])
    }

    @Test("an edit replaces the reminder in the list")
    func updates() async {
        let server = FakeRemindersServer(reminders: [Self.stored])
        let model = await make(server)
        var draft = ReminderDraft(editing: Self.stored)
        draft.name = "Daily"

        #expect(await model.save(draft, editing: 7))

        #expect(server.calls == ["list", "save:7"])
        #expect(model.reminders.map(\.name) == ["Daily"])
    }

    @Test("a refused save keeps the list and the server's words")
    func saveFails() async {
        let server = FakeRemindersServer(reminders: [Self.stored])
        let model = await make(server)
        server.fail(with: .badRequest(message: "Pick a date and time to send at."))

        let done = await model.save(ReminderDraftTests.valid(), editing: nil)

        #expect(!done)
        #expect(model.saveError == "Pick a date and time to send at.")
        #expect(model.reminders.map(\.id) == [7])
        #expect(!model.isSaving)
    }

    @Test("pause and resume flip the reminder from the server's answer")
    func toggles() async {
        let server = FakeRemindersServer(reminders: [Self.stored])
        let model = await make(server)

        await model.toggle(7)
        #expect(model.reminder(id: 7)?.enabled == false)
        await model.toggle(7)
        #expect(model.reminder(id: 7)?.enabled == true)
        #expect(server.calls == ["list", "toggle:7", "toggle:7"])
    }

    @Test("a toggle of a reminder that is gone removes it from the list")
    func toggleGone() async {
        let server = FakeRemindersServer(reminders: [Self.stored])
        let model = await make(server)
        // Someone deletes it elsewhere: the list still shows it, the server answers `{reminder: null}`.
        server.removeAll()

        await model.toggle(7)

        #expect(model.reminders.isEmpty)
        #expect(model.actionError == nil)
    }

    @Test("a delete removes the reminder, a refused one keeps it and says why")
    func deletes() async {
        let server = FakeRemindersServer(reminders: [Self.stored])
        let model = await make(server)

        server.fail(with: .forbidden(message: "You can't change reminders."))
        await model.delete(7)
        #expect(model.reminders.count == 1)
        #expect(model.actionError == "You can't change reminders.")

        server.fail(with: nil)
        await model.delete(7)
        #expect(model.reminders.isEmpty)
        #expect(server.reminders.isEmpty)
    }

    @Test("the pings switch is sent once, and never on a server without it")
    func pings() async {
        let server = FakeRemindersServer(allowPings: false)
        let model = await make(server)

        await model.setAllowPings(true)
        #expect(model.allowPings == true)
        await model.setAllowPings(true)
        #expect(server.calls == ["list", "pings:true"])

        let old = FakeRemindersServer(allowPings: nil)
        let oldModel = await make(old)
        #expect(!oldModel.hasPingSwitch)
        await oldModel.setAllowPings(true)
        #expect(old.calls == ["list"])
    }

    @Test("a refused pings change leaves the switch where it was and says why")
    func pingsRefused() async {
        let server = FakeRemindersServer(allowPings: false)
        let model = await make(server)
        server.fail(with: .forbidden(message: "Only the server owner or someone with Manage Server can change this."))

        await model.setAllowPings(true)

        #expect(model.allowPings == false)
        #expect(model.actionError == "Only the server owner or someone with Manage Server can change this.")
    }

    @Test("a test message reports that it was sent, or why not, and needs a channel and a message")
    func testMessage() async {
        let server = FakeRemindersServer()
        let model = await make(server)

        await model.sendTest(ReminderDraft())
        #expect(model.testOutcome == .failed("Pick a channel."))
        #expect(server.calls == ["list"])

        await model.sendTest(ReminderDraftTests.valid())
        #expect(model.testOutcome == .sent)

        server.fail(with: .badRequest(message: "The bot lacks Send Messages there."))
        await model.sendTest(ReminderDraftTests.valid())
        #expect(model.testOutcome == .failed("The bot lacks Send Messages there."))

        model.clearTestOutcome()
        #expect(model.testOutcome == nil)
    }
}
