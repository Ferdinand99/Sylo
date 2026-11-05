import Foundation
import Testing
@testable import SyloKit

@Suite("Reminders")
struct RemindersModuleTests {
    /// `GET /api/v2/guilds/:id/modules/reminders/list`, shaped like the server sends it.
    static let pageJSON = #"""
    {"reminders": [
       {"id": 1, "name": "Stand-up", "channelId": "222222222222222222",
        "spec": {"content": "Time for stand-up", "embeds": []},
        "mode": "multiple", "intervalMinutes": 1440, "days": [1, 2, 3, 4, 5],
        "startAt": 1730000000000, "endAt": null, "runAt": null, "enabled": true, "lastRunAt": 1730100000000},
       {"id": 2, "name": "Launch", "channelId": "222222222222222222",
        "spec": {"content": "Heads up", "embeds": [{"kind": "embed", "title": "Launch day", "description": "Go!", "color": "#5865f2",
                                                      "image": "", "thumbnail": "", "authorName": "", "authorIcon": "",
                                                      "footerText": "", "footerIcon": "", "timestamp": false, "fields": []}]},
        "mode": "single", "intervalMinutes": 60, "days": [0, 1, 2, 3, 4, 5, 6],
        "startAt": null, "endAt": null, "runAt": 1735000000000, "enabled": false, "lastRunAt": null}
     ],
     "allowPings": false,
     "channels": [{"id": "222222222222222222", "name": "announcements"}],
     "schedulePresets": [["1", "Every minute"], ["60", "Every hour"], ["1440", "Every day"]],
     "weekdays": [[0, "Sun"], [1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"]],
     "minIntervalMinutes": 1, "maxIntervalMinutes": 40320}
    """#

    @Test("the page decodes reminders, the schedule choices and the weekdays")
    func decodes() throws {
        let page = try JSONDecoder().decode(RemindersPage.self, from: Data(Self.pageJSON.utf8))
        #expect(page.reminders.count == 2)
        let standUp = page.reminders[0]
        #expect(standUp.name == "Stand-up")
        #expect(standUp.content == "Time for stand-up")
        #expect(standUp.embed == nil)
        #expect(standUp.mode == .multiple)
        #expect(standUp.intervalMinutes == 1440)
        #expect(standUp.days == [1, 2, 3, 4, 5])
        #expect(standUp.startAt == Date(timeIntervalSince1970: 1_730_000_000))
        #expect(standUp.endAt == nil)
        #expect(standUp.isEnabled)
        let launch = page.reminders[1]
        #expect(launch.mode == .single)
        #expect(launch.embed?.title == "Launch day")
        #expect(launch.content == "Heads up")
        #expect(launch.runAt == Date(timeIntervalSince1970: 1_735_000_000))
        #expect(!launch.isEnabled)
        #expect(page.schedulePresets.map(\.minutes) == [1, 60, 1440])
        #expect(page.schedulePresets[1].name == "Every hour")
        #expect(page.weekdays.count == 7)
        #expect(page.weekdays[1] == WeekdayOption(number: 1, name: "Mon"))
        #expect(!page.allowPings)
        #expect(page.maxIntervalMinutes == 40_320)
    }

    @Test("a list row says when the reminder runs")
    func summaries() throws {
        let page = try JSONDecoder().decode(RemindersPage.self, from: Data(Self.pageJSON.utf8))
        let repeating = page.reminders[0].scheduleSummary(
            presets: page.schedulePresets, weekdays: page.weekdays, once: { _ in "never" })
        #expect(repeating == "every day · Mon/Tue/Wed/Thu/Fri")
        let once = page.reminders[1].scheduleSummary(
            presets: page.schedulePresets, weekdays: page.weekdays, once: { _ in "Dec 24" })
        #expect(once == "once, Dec 24")
        let odd = Reminder(id: 3, name: "x", channelId: "1", intervalMinutes: 45)
        #expect(odd.scheduleSummary(presets: page.schedulePresets, weekdays: page.weekdays, once: { _ in "" })
            == "every 45m")
    }

    @Test("a text reminder sends its text, an embed reminder its embed with the text above")
    func encodes() throws {
        let page = try JSONDecoder().decode(RemindersPage.self, from: Data(Self.pageJSON.utf8))
        let now = Date(timeIntervalSince1970: 1_730_000_000)
        let text = ReminderDraft(reminder: page.reminders[0], now: now)
        let save = Endpoints.SaveReminder(server: "1", draft: text)
        #expect(save.path == "/api/v2/guilds/1/modules/reminders/1")
        #expect(save.method == .post)
        let body = try bodyObject(save)
        #expect(Set(body.keys) == [
            "name", "channelId", "msgType", "content", "embedSpec", "mode", "runAt", "intervalMinutes",
            "enableStart", "startAt", "enableEnd", "endAt", "days",
        ])
        #expect(body["msgType"] as? String == "text")
        #expect(body["content"] as? String == "Time for stand-up")
        #expect(body["mode"] as? String == "multiple")
        #expect(body["enableStart"] as? Bool == true)
        #expect(body["enableEnd"] as? Bool == false)
        #expect(body["startAt"] as? String == "2024-10-27T03:33:20Z")
        #expect(body["days"] as? [Int] == [1, 2, 3, 4, 5])

        let embed = ReminderDraft(reminder: page.reminders[1], now: now)
        #expect(embed.isEmbed)
        let embedBody = try bodyObject(Endpoints.SaveReminder(server: "1", draft: embed))
        #expect(embedBody["msgType"] as? String == "embed")
        let spec = try #require(embedBody["embedSpec"] as? [String: Any])
        #expect(spec["content"] as? String == "Heads up")
        #expect(spec["title"] as? String == "Launch day")
        #expect(spec["kind"] as? String == "embed")
    }

    @Test("a new reminder posts to the 'new' path and needs a channel and a message")
    func newReminder() {
        var draft = ReminderDraft(now: Date(timeIntervalSince1970: 0))
        #expect(Endpoints.SaveReminder(server: "1", draft: draft).path == "/api/v2/guilds/1/modules/reminders/new")
        #expect(draft.problem == "Choose a channel.")
        draft.channelId = "222"
        #expect(draft.problem == "Add a message or an embed.")
        draft.content = "Hello"
        #expect(draft.problem == nil)
        draft.days = []
        #expect(draft.problem == "Choose at least one day of the week.")
        draft.mode = .single
        #expect(draft.problem == nil)
        draft.isEmbed = true
        draft.content = ""
        #expect(draft.problem == "Add a message or an embed.")
        draft.embed.title = "Title"
        #expect(draft.problem == nil)
    }

    @Test("the other calls use the dashboard's paths")
    func paths() {
        #expect(Endpoints.ToggleReminder(server: "1", id: 4).path == "/api/v2/guilds/1/modules/reminders/4/toggle")
        #expect(Endpoints.DeleteReminder(server: "1", id: 4).path == "/api/v2/guilds/1/modules/reminders/4/delete")
        let pings = Endpoints.SetReminderPings(server: "1", allowPings: true)
        #expect(pings.path == "/api/v2/guilds/1/modules/reminders/settings")
        #expect(Endpoints.TestReminder(server: "1", draft: ReminderDraft()).path
            == "/api/v2/guilds/1/modules/reminders/test")
    }

    @MainActor
    @Test("sending a test does not reload the list or count as a change")
    func test() async throws {
        let page = try JSONDecoder().decode(RemindersPage.self, from: Data(Self.pageJSON.utf8))
        let clients = StubClients { endpoint in
            endpoint is Endpoints.TestReminder ? OKResponse() : page
        }
        let session = makeSignedInSession(clients: clients)
        let model = RecordListModel<RemindersPage>(reminders: "1", session: session)
        await model.load()
        let before = session.modulesRevision
        let sent = await model.sendTest(ReminderDraft())
        #expect(sent)
        #expect(clients.calls.count == 2)
        #expect(model.changeCount == 0)
        #expect(session.modulesRevision == before)
    }
}

@Suite("Channel cleanup")
struct ChannelCleanupModuleTests {
    /// `GET /api/v2/guilds/:id/modules/channel-cleanup/schedules`.
    static let pageJSON = #"""
    {"schedules": [
       {"id": 3, "channelId": "222222222222222222", "days": [0, 6], "timeHhmm": "04:30", "maxAgeHours": 72,
        "skipPinned": true, "enabled": true, "lastRunDate": "2026-11-01", "lastRunCount": 41},
       {"id": 4, "channelId": "333333333333333333", "days": [0, 1, 2, 3, 4, 5, 6], "timeHhmm": "03:00",
        "maxAgeHours": 36, "skipPinned": false, "enabled": false, "lastRunDate": null, "lastRunCount": null}
     ],
     "channels": [{"id": "222222222222222222", "name": "memes"}, {"id": "333333333333333333", "name": "spam"}],
     "weekdays": [[0, "Sun"], [1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"]],
     "maxAgeHoursCap": 2160}
    """#

    @Test("the page decodes the schedules and the age cap")
    func decodes() throws {
        let page = try JSONDecoder().decode(ChannelCleanupPage.self, from: Data(Self.pageJSON.utf8))
        #expect(page.schedules.count == 2)
        let weekend = page.schedules[0]
        #expect(weekend.days == [0, 6])
        #expect(weekend.timeHhmm == "04:30")
        #expect(weekend.maxAgeHours == 72)
        #expect(weekend.skipPinned)
        #expect(weekend.lastRunDate == "2026-11-01")
        #expect(weekend.lastRunCount == 41)
        #expect(weekend.ageSummary == "3d")
        #expect(page.schedules[1].ageSummary == "36h")
        #expect(!page.schedules[1].isEnabled)
        #expect(page.schedules[1].lastRunDate == nil)
        #expect(page.maxAgeHoursCap == 2160)
        #expect(WeekdayOption.summary(of: weekend.days, in: page.weekdays) == "Sun/Sat")
        #expect(WeekdayOption.summary(of: page.schedules[1].days, in: page.weekdays) == "every day")
    }

    @Test("saving sends the form's five fields, with the time as HH:MM")
    func encodes() throws {
        let page = try JSONDecoder().decode(ChannelCleanupPage.self, from: Data(Self.pageJSON.utf8))
        var draft = CleanupScheduleDraft(schedule: page.schedules[0])
        #expect(draft.hour == 4 && draft.minute == 30)
        draft.hour = 5
        draft.minute = 7
        let save = Endpoints.SaveCleanupSchedule(server: "1", draft: draft)
        #expect(save.path == "/api/v2/guilds/1/modules/channel-cleanup/schedules/3")
        let body = try bodyObject(save)
        #expect(Set(body.keys) == ["channelId", "days", "timeHhmm", "maxAgeHours", "skipPinned"])
        #expect(body["timeHhmm"] as? String == "05:07")
        #expect(body["days"] as? [Int] == [0, 6])
        #expect(body["maxAgeHours"] as? Int == 72)
        #expect(Endpoints.SaveCleanupSchedule(server: "1", draft: CleanupScheduleDraft()).path
            == "/api/v2/guilds/1/modules/channel-cleanup/schedules")
    }

    @Test("a schedule needs a channel, a day and an age in range")
    func problems() {
        var draft = CleanupScheduleDraft()
        #expect(draft.problem(maxAgeHoursCap: 2160) == "Choose a channel.")
        draft.channelId = "222"
        #expect(draft.problem(maxAgeHoursCap: 2160) == nil)
        draft.days = []
        #expect(draft.problem(maxAgeHoursCap: 2160) == "Choose at least one day.")
        draft.days = [1]
        draft.maxAgeHours = 3000
        #expect(draft.problem(maxAgeHoursCap: 2160) == "Messages can be kept for 1 to 2160 hours.")
        draft.maxAgeHours = 0
        #expect(draft.problem(maxAgeHoursCap: 2160) != nil)
    }

    @Test("an unreadable time falls back to 03:00")
    func oddTime() {
        let draft = CleanupScheduleDraft(schedule: CleanupSchedule(id: 1, channelId: "1", timeHhmm: "soon"))
        #expect(draft.timeHhmm == "03:00")
    }
}

@Suite("GitHub alerts")
struct GithubModuleTests {
    /// `GET /api/v2/guilds/:id/modules/github/watches`.
    static let pageJSON = #"""
    {"watches": [
       {"id": 5, "repo": "Ferdinand99/Sylo", "channelId": "222222222222222222", "roleId": "333333333333333333",
        "changelogPath": "CHANGELOG.md", "events": ["push", "release"], "enabled": true,
        "secret": "s3cr3t", "webhookUrl": "https://sylo.example.com/webhooks/github/abc123"},
       {"id": 6, "repo": "octo/cat", "channelId": "222222222222222222", "roleId": "", "changelogPath": "",
        "events": ["issues"], "enabled": false, "secret": "other", "webhookUrl": null}
     ],
     "channels": [{"id": "222222222222222222", "name": "dev"}],
     "roles": [{"id": "333333333333333333", "name": "Devs"}],
     "eventTypes": [{"key": "push", "label": "Commits pushed"}, {"key": "release", "label": "Release published"},
                    {"key": "issues", "label": "Issue opened / closed"}],
     "dashboardUrlSet": true}
    """#

    @Test("the page decodes the watches, the roles and the event types")
    func decodes() throws {
        let page = try JSONDecoder().decode(GithubPage.self, from: Data(Self.pageJSON.utf8))
        #expect(page.watches.count == 2)
        let first = page.watches[0]
        #expect(first.repo == "Ferdinand99/Sylo")
        #expect(first.roleId == "333333333333333333")
        #expect(first.changelogPath == "CHANGELOG.md")
        #expect(first.events == ["push", "release"])
        #expect(first.secret == "s3cr3t")
        #expect(first.webhookURL == "https://sylo.example.com/webhooks/github/abc123")
        #expect(page.watches[1].webhookURL == nil)
        #expect(!page.watches[1].isEnabled)
        #expect(page.eventTypes.map(\.key) == ["push", "release", "issues"])
        #expect(page.hasPublicAddress)
    }

    @Test("a server without an event list gets the standard six")
    func standardEvents() throws {
        let page = try JSONDecoder().decode(GithubPage.self, from: Data(#"{"watches": []}"#.utf8))
        #expect(page.eventTypes.count == 6)
        #expect(page.eventTypes.first?.key == "push")
    }

    @Test("saving sends the form's five fields")
    func encodes() throws {
        let page = try JSONDecoder().decode(GithubPage.self, from: Data(Self.pageJSON.utf8))
        var draft = GithubWatchDraft(watch: page.watches[0])
        draft.setEvent("star", on: true)
        draft.setEvent("push", on: false)
        let save = Endpoints.SaveGithubWatch(server: "1", draft: draft)
        #expect(save.path == "/api/v2/guilds/1/modules/github/watches/5")
        let body = try bodyObject(save)
        #expect(Set(body.keys) == ["repo", "channelId", "roleId", "changelogPath", "events"])
        #expect(body["events"] as? [String] == ["release", "star"])
        #expect(body["repo"] as? String == "Ferdinand99/Sylo")
        #expect(Endpoints.SaveGithubWatch(server: "1", draft: GithubWatchDraft()).path
            == "/api/v2/guilds/1/modules/github/watches")
    }

    @Test("a watch needs a repository, a channel and something to post")
    func problems() {
        var draft = GithubWatchDraft()
        #expect(draft.events == ["push", "release"])
        #expect(draft.problem == "Enter a repository as owner/repo or its github.com address.")
        draft.repo = "owner/repo"
        #expect(draft.problem == "Choose a channel.")
        draft.channelId = "222"
        #expect(draft.problem == nil)
        draft.events = []
        #expect(draft.problem == "Choose at least one event to post, or a changelog file.")
        draft.changelogPath = "CHANGELOG.md"
        #expect(draft.problem == nil)
        draft.setEvent("push", on: true)
        draft.setEvent("push", on: true)
        #expect(draft.events == ["push"])
    }

    @Test("the other calls use the dashboard's paths")
    func paths() {
        #expect(Endpoints.ToggleGithubWatch(server: "1", id: 5).path == "/api/v2/guilds/1/modules/github/watches/5/toggle")
        #expect(Endpoints.DeleteGithubWatch(server: "1", id: 5).path == "/api/v2/guilds/1/modules/github/watches/5/delete")
        #expect(Endpoints.RegenerateGithubSecret(server: "1", id: 5).path
            == "/api/v2/guilds/1/modules/github/watches/5/regen-secret")
    }
}

@Suite("Server insights")
struct InsightsTests {
    /// `GET /api/v2/guilds/:id/insights?range=7`.
    static let pageJSON = #"""
    {"range": 3, "granularity": "day",
     "series": [
       {"label": "2026-11-03", "joins": 4, "leaves": 1, "messages": 120, "activeMembers": 20, "voiceMinutes": 30, "voiceActiveMembers": 2, "voicePeak": 2},
       {"label": "2026-11-04", "joins": 0, "leaves": 3, "messages": 80, "activeMembers": 15, "voiceMinutes": 0, "voiceActiveMembers": 0, "voicePeak": 0},
       {"label": "2026-11-05", "joins": 5, "leaves": 0, "messages": 200, "activeMembers": 31, "voiceMinutes": 125, "voiceActiveMembers": 5, "voicePeak": 4}],
     "totals": {"messages": 400, "joins": 9, "leaves": 4, "net": 5, "peakActive": 31, "voiceMinutes": 155, "voicePeak": 4},
     "topChannels": [{"name": "general", "messages": 250}, {"name": "memes", "messages": 150}],
     "topVoice": [{"name": "Lounge", "minutes": 120}]}
    """#

    @Test("the page decodes the series, totals and top channels")
    func decodes() throws {
        let page = try JSONDecoder().decode(InsightsPage.self, from: Data(Self.pageJSON.utf8))
        #expect(!page.isHourly)
        #expect(page.series.count == 3)
        #expect(page.series[2].messages == 200)
        #expect(page.series[2].voiceMinutes == 125)
        #expect(page.totals.messages == 400)
        #expect(page.totals.net == 5)
        #expect(page.totals.voicePeak == 4)
        #expect(page.topChannels.map(\.name) == ["general", "memes"])
        #expect(page.topChannels.map(\.amount) == [250, 150])
        #expect(page.topVoice.first?.amount == 120)
        #expect(page.memberGrowth == [3, 0, 5])
    }

    @Test("an hourly range says so")
    func hourly() throws {
        let page = try JSONDecoder().decode(
            InsightsPage.self, from: Data(#"{"range": 24, "granularity": "hour", "series": [], "totals": {}}"#.utf8))
        #expect(page.isHourly)
        #expect(page.totals == InsightsTotals())
        #expect(InsightsRange.day.isHourly && InsightsRange.twoDays.isHourly)
        #expect(!InsightsRange.week.isHourly)
        #expect(InsightsRange.allCases.map(\.rawValue) == [24, 48, 7, 30, 90])
    }

    @Test("the range goes in the query")
    func query() {
        let load = Endpoints.Insights(server: "fluxer:1", range: .week)
        #expect(load.path == "/api/v2/guilds/fluxer%3A1/insights")
        #expect(load.query == [URLQueryItem(name: "range", value: "7")])
        let refresh = Endpoints.RefreshInsights(server: "1")
        #expect(refresh.path == "/api/v2/guilds/1/insights/refresh")
        #expect(refresh.method == .post)
    }

    @MainActor
    @Test("choosing a range loads it, and refresh loads again")
    func model() async throws {
        let page = try JSONDecoder().decode(InsightsPage.self, from: Data(Self.pageJSON.utf8))
        let clients = StubClients { endpoint in
            endpoint is Endpoints.RefreshInsights ? OKResponse() : page
        }
        let model = InsightsModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.page?.totals.messages == 400)
        await model.select(.week)
        #expect(model.range == .week)
        let loads = clients.calls.compactMap { $0.endpoint as? Endpoints.Insights }
        #expect(loads.map(\.range) == [.month, .week])
        await model.select(.week)
        #expect(clients.calls.count == 2)
        await model.refresh()
        #expect(clients.calls.last?.endpoint is Endpoints.Insights)
        #expect(clients.calls.contains { $0.endpoint is Endpoints.RefreshInsights })
    }
}

@Suite("Game stats")
struct GameStatsTests {
    @Test("an operator sees the recent lookups")
    func decodesOperator() throws {
        let json = #"""
        {"operator": true, "recent": [
          {"game": "bf4", "title": "Battlefield 4", "username": "Soldier", "platform": "xboxone", "ago": "3m ago"},
          {"game": "osrs", "title": "", "username": "Zezima", "platform": "", "ago": "1h ago"}]}
        """#
        let page = try JSONDecoder().decode(GameStatsPage.self, from: Data(json.utf8))
        #expect(page.isOperator)
        #expect(page.recent.count == 2)
        #expect(page.recent[0].heading == "Battlefield 4")
        #expect(page.recent[0].platformName == "Xbox One")
        #expect(page.recent[1].heading == "osrs")
        #expect(page.recent[1].platformName.isEmpty)
        #expect(GameStatsLookup(game: "g", username: "u", platform: "switch").platformName == "Switch")
    }

    @Test("anyone else gets no lookups")
    func decodesMember() throws {
        let page = try JSONDecoder().decode(GameStatsPage.self, from: Data(#"{"operator": false, "recent": []}"#.utf8))
        #expect(!page.isOperator)
        #expect(page.recent.isEmpty)
        #expect(Endpoints.LoadGameStats(server: "1").path == "/api/v2/guilds/1/modules/game-stats/config")
    }
}
