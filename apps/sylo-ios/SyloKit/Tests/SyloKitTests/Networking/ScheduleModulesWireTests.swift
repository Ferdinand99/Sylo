import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import SyloKit

// What Reminders, Channel cleanup, GitHub alerts and Game stats put on the wire, through the real
// client and the mock URL protocol. They extend `APIClientTests` so they run one after another: the
// mock's state is shared.
extension APIClientTests {
    private func scheduleClient() throws -> URLSessionAPIClient {
        URLSessionAPIClient(
            server: try ServerURL("https://example.com/sylo"), session: MockURLProtocol.session(),
            decoder: JSONDecoder(), retryDelays: [.zero, .zero], token: { "sylo_secret" })
    }

    private func firstJSONBody(_ mock: MockState) throws -> [String: Any] {
        let body = try #require(mock.requests.first?.body)
        return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    private static let scheduleChannel = "222222222222222222"

    // MARK: Reminders

    @Test("Creating a reminder posts the form to /reminders/new, with the time as an instant")
    func createsReminder() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"reminder": {"id": 9, "name": "Launch", "channelId": "222222222222222222", "mode": "single"}}"#)])
        var draft = ReminderDraft()
        draft.name = "Launch"
        draft.channelId = Self.scheduleChannel
        draft.content = "We are live."
        draft.mode = .single
        draft.runAt = Date(timeIntervalSince1970: 1_794_000_000)

        let answer = try await scheduleClient().send(Endpoints.SaveReminder(server: "1", draft: draft))

        #expect(answer.reminder?.id == 9)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/reminders/new")
        #expect(request.method == "POST")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
        let json = try firstJSONBody(mock)
        #expect(Set(json.keys) == [
            "name", "channelId", "msgType", "content", "embedSpec", "mode", "runAt", "intervalMinutes",
            "enableStart", "startAt", "enableEnd", "endAt", "days",
        ])
        #expect(json["msgType"] as? String == "text")
        #expect(json["mode"] as? String == "single")
        #expect(json["runAt"] as? String == "2026-11-06T21:20:00Z")
        #expect(json["days"] as? [Int] == Array(0...6))
    }

    @Test("Saving a stored reminder posts to its id, and a refusal comes back in the server's words")
    func savesReminder() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(400, #"{"error": "Pick a date and time to send at."}"#)])
        var draft = ReminderDraft()
        draft.channelId = Self.scheduleChannel
        draft.content = "Hi"

        let error = await #expect(throws: NetworkError.self) {
            _ = try await scheduleClient().send(Endpoints.SaveReminder(server: "1", id: 7, draft: draft))
        }

        #expect(error?.userMessage == "Pick a date and time to send at.")
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/reminders/7")
        #expect(mock.requests.count == 1)
    }

    @Test("Pings, toggle, delete and test go to their own paths, with the bodies the dashboard sends")
    func reminderActions() async throws {
        let mock = MockURLProtocol.state

        mock.reset([.json(200, #"{"allowPings": true}"#)])
        let pings = try await scheduleClient().send(Endpoints.SetReminderPings(server: "1", allowPings: true))
        #expect(pings.allowPings == true)
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/reminders/settings")
        let pingsBody = try firstJSONBody(mock)
        #expect(Set(pingsBody.keys) == ["allowPings"])
        #expect(pingsBody["allowPings"] as? Bool == true)

        mock.reset([.json(200, #"{"reminder": null}"#)])
        let toggled = try await scheduleClient().send(Endpoints.ToggleReminder(server: "1", id: 7))
        #expect(toggled.reminder == nil)
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/reminders/7/toggle")
        #expect(mock.requests.first?.method == "POST")
        #expect(try firstJSONBody(mock).isEmpty)

        mock.reset([.json(200, #"{"ok": true}"#)])
        _ = try await scheduleClient().send(Endpoints.DeleteReminder(server: "1", id: 7))
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/reminders/7/delete")
        #expect(try firstJSONBody(mock).isEmpty)

        mock.reset([.json(200, #"{"ok": true}"#)])
        var draft = ReminderDraft()
        draft.channelId = Self.scheduleChannel
        draft.content = "Hi"
        _ = try await scheduleClient().send(Endpoints.TestReminder(server: "1", draft: draft))
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/reminders/test")
        #expect(try firstJSONBody(mock)["channelId"] as? String == Self.scheduleChannel)
    }

    // MARK: Channel cleanup

    @Test("A cleanup schedule is created and edited with the same five keys, and toggled with an empty body")
    func cleanupSchedules() async throws {
        let mock = MockURLProtocol.state
        var draft = CleanupDraft()
        draft.channelId = "333333333333333333"
        draft.days = [3, 1]
        draft.timeHhmm = "18:30"
        draft.maxAgeHours = 36
        draft.skipPinned = false

        mock.reset([.json(200, #"{"schedule": {"id": 5, "channelId": "333333333333333333", "days": [1, 3], "timeHhmm": "18:30", "maxAgeHours": 36, "skipPinned": false, "enabled": true}}"#)])
        let created = try await scheduleClient().send(Endpoints.SaveCleanupSchedule(server: "1", draft: draft))
        #expect(created.schedule?.id == 5)
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/channel-cleanup/schedules")
        #expect(mock.requests.first?.method == "POST")
        let json = try firstJSONBody(mock)
        #expect(Set(json.keys) == ["channelId", "days", "timeHhmm", "maxAgeHours", "skipPinned"])
        #expect(json["days"] as? [Int] == [1, 3])
        #expect(json["timeHhmm"] as? String == "18:30")
        #expect(json["maxAgeHours"] as? Int == 36)
        #expect(json["skipPinned"] as? Bool == false)

        mock.reset([.json(200, #"{"schedule": {"id": 5}}"#)])
        _ = try await scheduleClient().send(Endpoints.SaveCleanupSchedule(server: "1", id: 5, draft: draft))
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/channel-cleanup/schedules/5")

        mock.reset([.json(200, #"{"schedule": {"id": 5, "enabled": false}}"#)])
        let toggled = try await scheduleClient().send(Endpoints.ToggleCleanupSchedule(server: "1", id: 5))
        #expect(toggled.schedule?.enabled == false)
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/channel-cleanup/schedules/5/toggle")
        #expect(try firstJSONBody(mock).isEmpty)

        mock.reset([.json(200, #"{"schedule": null}"#)])
        let gone = try await scheduleClient().send(Endpoints.ToggleCleanupSchedule(server: "1", id: 5))
        #expect(gone.schedule == nil)

        mock.reset([.json(200, #"{"ok": true}"#)])
        _ = try await scheduleClient().send(Endpoints.DeleteCleanupSchedule(server: "1", id: 5))
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/channel-cleanup/schedules/5/delete")
    }

    @Test("Loading the schedules is a plain GET")
    func loadsCleanup() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, CleanupFixtures.page)])

        let page = try await scheduleClient().send(Endpoints.LoadCleanupSchedules(server: "1"))

        #expect(page.schedules.count == 2)
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/channel-cleanup/schedules")
        #expect(mock.requests.first?.method == "GET")
    }

    // MARK: GitHub alerts

    @Test("A watch is created and edited with the five keys, and a new secret answers with the watch")
    func githubWatches() async throws {
        let mock = MockURLProtocol.state
        var draft = GithubWatchDraft()
        draft.repo = "owner/repo"
        draft.channelId = "444444444444444444"
        draft.roleId = "555555555555555555"
        draft.changelogPath = "CHANGELOG.md"
        draft.events = ["release", "push"]

        mock.reset([.json(200, #"{"watch": {"id": 3, "repo": "owner/repo", "secret": "abc", "webhookUrl": "https://x.example/w/t"}}"#)])
        let created = try await scheduleClient().send(Endpoints.SaveGithubWatch(server: "1", draft: draft))
        #expect(created.watch?.secret == "abc")
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/github/watches")
        #expect(mock.requests.first?.method == "POST")
        let json = try firstJSONBody(mock)
        #expect(Set(json.keys) == ["repo", "channelId", "roleId", "changelogPath", "events"])
        #expect(json["events"] as? [String] == ["push", "release"])

        mock.reset([.json(200, #"{"watch": {"id": 3, "repo": "owner/repo", "secret": "fresh-secret"}}"#)])
        let regenerated = try await scheduleClient().send(Endpoints.RegenerateGithubSecret(server: "1", id: 3))
        #expect(regenerated.watch?.secret == "fresh-secret")
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/github/watches/3/regen-secret")
        #expect(mock.requests.first?.method == "POST")
        #expect(try firstJSONBody(mock).isEmpty)

        mock.reset([.json(200, #"{"watch": {"id": 3, "enabled": false}}"#)])
        _ = try await scheduleClient().send(Endpoints.ToggleGithubWatch(server: "1", id: 3))
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/github/watches/3/toggle")

        mock.reset([.json(200, #"{"ok": true}"#)])
        _ = try await scheduleClient().send(Endpoints.DeleteGithubWatch(server: "1", id: 3))
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/github/watches/3/delete")
    }

    @Test("A watch the server refuses comes back with its words, and the list is a plain GET")
    func githubRefusalAndList() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(400, #"{"error": "Pick at least one event to announce, or set a changelog file path."}"#)])
        var draft = GithubWatchDraft()
        draft.repo = "owner/repo"
        draft.channelId = "444444444444444444"

        let error = await #expect(throws: NetworkError.self) {
            _ = try await scheduleClient().send(Endpoints.SaveGithubWatch(server: "1", id: 3, draft: draft))
        }
        #expect(error?.userMessage == "Pick at least one event to announce, or set a changelog file path.")

        mock.reset([.json(200, GithubFixtures.page)])
        let page = try await scheduleClient().send(Endpoints.LoadGithubWatches(server: "1"))
        #expect(page.watches.count == 2)
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/github/watches")
        #expect(mock.requests.first?.method == "GET")
    }

    // MARK: Game stats

    @Test("Game stats is one GET with no body")
    func gameStatsLoad() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, GameStatsDecodingTests.operatorPage)])

        let info = try await scheduleClient().send(Endpoints.LoadGameStats(server: "1"))

        #expect(info.isOperator)
        #expect(info.recent.count == 2)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/game-stats/config")
        #expect(request.method == "GET")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
        #expect(request.body == nil || request.body?.isEmpty == true)
    }
}
