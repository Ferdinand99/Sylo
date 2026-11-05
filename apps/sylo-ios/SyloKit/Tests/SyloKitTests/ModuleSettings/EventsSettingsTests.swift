import Foundation
import Testing
@testable import SyloKit

@Suite("Events settings")
struct EventsSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/events/config`, shaped like src/web/routes/v2Events.js sends it.
    static let pageJSON = #"""
    {
      "config": {
        "channel": "222222222222222222",
        "reminderMinutes": 30,
        "staffRoles": ["111111111111111111"],
        "dmReminders": true,
        "timeZone": "Europe/Oslo",
        "publicPages": true
      },
      "channels": [{"id": "222222222222222222", "name": "events"}],
      "roles": [{"id": "111111111111111111", "name": "Moderators"}],
      "events": [
        {"id": 12, "title": "Game night", "description": "Bring snacks", "location": "Voice 1", "imageUrl": "",
         "startAt": 1794000000000, "endAt": null, "start": "2026-11-06T22:00", "end": "", "timeZone": "Europe/Oslo",
         "capacity": 12, "roleId": "", "reminderMinutes": 30, "channelId": "222222222222222222", "channel": "events",
         "state": "scheduled", "joined": 4, "maybe": 1, "pagePath": "/events/abc", "pageAudience": "public",
         "pageHidden": false},
        {"id": 11, "title": "Quiz", "startAt": 1790000000000, "timeZone": "UTC", "channel": "events",
         "state": "cancelled", "joined": 0, "maybe": 0, "capacity": null}
      ]
    }
    """#

    @Test("the page decodes settings, options and the event list")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(EventsPage.self, from: Data(Self.pageJSON.utf8))
        #expect(EventsPage.moduleID == "events")
        #expect(page.settings == EventsSettings(
            channel: "222222222222222222", reminderMinutes: 30, staffRoles: ["111111111111111111"],
            dmReminders: true, timeZone: "Europe/Oslo", publicPages: true))
        #expect(page.channels.map(\.name) == ["events"])
        #expect(page.roles.map(\.name) == ["Moderators"])
        #expect(page.events.map(\.id) == [12, 11])
        #expect(page.upcoming.map(\.title) == ["Game night"])
        #expect(page.past.map(\.state) == [.cancelled])
        let event = try #require(page.events.first)
        #expect(event.joined == 4)
        #expect(event.maybe == 1)
        #expect(event.capacity == 12)
        #expect(event.startDate == Date(timeIntervalSince1970: 1_794_000_000))
        #expect(event.zone.identifier == "Europe/Oslo")
        #expect(page.events.last?.capacity == nil)
    }

    @Test("missing fields fall back to the server's defaults, an odd event is skipped")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{},"events":[{"title":"no id"},{"id":1,"title":"ok","state":"paused"}]}"#.utf8)
        let page = try JSONDecoder().decode(EventsPage.self, from: json)
        #expect(page.settings == EventsSettings())
        #expect(page.settings.reminderMinutes == 60)
        #expect(!page.settings.dmReminders)
        #expect(!page.settings.publicPages)
        #expect(page.events.map(\.id) == [1])
        #expect(page.events.first?.state == .other("paused"))
        #expect(page.channels.isEmpty)
    }

    @Test("saving sends exactly the fields the web form sends")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(EventsPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["channel", "reminderMinutes", "staffRoles", "dmReminders", "timeZone", "publicPages"])
        #expect(body["reminderMinutes"] as? Int == 30)
        #expect(body["timeZone"] as? String == "Europe/Oslo")
        #expect(body["publicPages"] as? Bool == true)
        let again = try JSONDecoder().decode(EventsSettings.self, from: data)
        #expect(again == page.settings)
    }

    @Test("the reminder choices keep an unusual value the server holds")
    func reminderOptions() {
        #expect(EventsSettings.reminderOptions(including: 60) == EventsSettings.reminderChoices)
        #expect(EventsSettings.reminderOptions(including: 45) == [0, 5, 10, 15, 30, 45, 60, 120, 360, 720, 1440])
        #expect(EventsSettings.reminderRange == 5...1440)
    }

    @Test("an event reads in its own time zone")
    func zone() {
        #expect(EventSummary(id: 1, title: "x", timeZone: "Not/AZone").zone == TimeZone.current)
        #expect(EventSummary(id: 1, title: "x", timeZone: "Asia/Tokyo").zone.identifier == "Asia/Tokyo")
    }
}
