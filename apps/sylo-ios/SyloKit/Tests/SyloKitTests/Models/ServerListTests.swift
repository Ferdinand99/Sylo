import Foundation
import Testing
@testable import SyloKit

@Suite("Server list details")
struct ServerListTests {
    /// `GET /api/v2/guilds` for the app, shaped like src/web/routes/v2Api.js sends it.
    static let json = #"""
    {"guilds": [
      {"id": "900000000000000201", "name": "Sylo HQ", "icon": null, "platform": "discord",
       "memberCount": 1284, "messagesToday": 312, "openTickets": 2, "unreadTickets": 1},
      {"id": "fluxer:900000000000000202", "name": "Quiet", "icon": null, "platform": "fluxer",
       "memberCount": 1, "messagesToday": null, "openTickets": 0, "unreadTickets": 0},
      {"id": "900000000000000203", "name": "Old server", "icon": null, "platform": "discord"}
    ]}
    """#

    static let us = Locale(identifier: "en_US")

    @Test("member count and messages today decode; an older server sends neither")
    func decodes() throws {
        let list = try JSONDecoder().decode(ServerList.self, from: Data(Self.json.utf8))
        #expect(list.servers[0].memberCount == 1284)
        #expect(list.servers[0].messagesToday == 312)
        #expect(list.servers[1].memberCount == 1)
        #expect(list.servers[1].messagesToday == nil)
        #expect(list.servers[2].memberCount == nil)
        #expect(list.servers[2].messagesToday == nil)
        #expect(list.servers[2].openTickets == 0)
    }

    @Test("the subtitle joins members, open tickets and messages today with thousands separators")
    func subtitle() throws {
        let list = try JSONDecoder().decode(ServerList.self, from: Data(Self.json.utf8))
        #expect(list.servers[0].subtitle(locale: Self.us) == "1,284 members · 2 open tickets · 312 messages today")
    }

    @Test("open tickets only when there are some, one is singular, nothing to show is nil")
    func subtitleParts() throws {
        let list = try JSONDecoder().decode(ServerList.self, from: Data(Self.json.utf8))
        #expect(list.servers[1].subtitle(locale: Self.us) == "1 member")
        #expect(list.servers[2].subtitle(locale: Self.us) == nil)
        let one = ServerSummary(id: "1", name: "x", platform: .discord, openTickets: 1, memberCount: 24, messagesToday: 1)
        #expect(one.subtitle(locale: Self.us) == "24 members · 1 open ticket · 1 message today")
        let none = ServerSummary(id: "1", name: "x", platform: .discord, memberCount: 24, messagesToday: 0)
        #expect(none.subtitle(locale: Self.us) == "24 members · 0 messages today")
    }
}

@Suite("Module search")
struct ModuleSearchTests {
    static func card(_ id: String, _ name: String, _ description: String?) -> OverviewCard {
        OverviewCard(kind: .module, id: id, name: name, description: description, hasToggle: true, isEnabled: true,
                     status: .on)
    }

    static let overview = ServerOverview(
        server: OverviewServer(id: "1", name: "HQ"),
        groups: [
            OverviewGroup(title: "Moderation", cards: [
                card("automod", "Auto-moderation", "Filters spam, invites and bad words"),
                card("logging", "Server logging", "Posts member and message events"),
            ]),
            OverviewGroup(title: "Engagement", cards: [
                card("leveling", "Leveling", "XP and rank roles"),
                card("birthdays", "Birthdays", nil),
            ]),
        ])

    @Test("an empty search keeps everything")
    func empty() {
        #expect(Self.overview.groups(matching: "").count == 2)
        #expect(Self.overview.groups(matching: "   ").flatMap(\.cards).count == 4)
    }

    @Test("a search matches the name or the description, ignoring case")
    func matches() {
        #expect(Self.overview.groups(matching: "LEVEL").flatMap(\.cards).map(\.id) == ["leveling"])
        #expect(Self.overview.groups(matching: "spam").flatMap(\.cards).map(\.id) == ["automod"])
        #expect(Self.overview.groups(matching: " log ").flatMap(\.cards).map(\.id) == ["logging"])
    }

    @Test("groups with no match are dropped, a card without a description still matches by name")
    func dropsEmptyGroups() {
        let groups = Self.overview.groups(matching: "birth")
        #expect(groups.map(\.title) == ["Engagement"])
        #expect(groups.first?.cards.map(\.id) == ["birthdays"])
        #expect(Self.overview.groups(matching: "zzz").isEmpty)
    }

    @Test("accents do not get in the way")
    func accents() {
        let overview = ServerOverview(
            server: OverviewServer(id: "1", name: "HQ"),
            groups: [OverviewGroup(title: "A", cards: [Self.card("x", "Café", nil)])])
        #expect(overview.groups(matching: "cafe").count == 1)
    }
}

@Suite("Platform notes")
struct PlatformNoteTests {
    @Test("the notes for a Fluxer server decode, and a module without one has none")
    func decodes() throws {
        let json = #"""
        {"platform": "fluxer", "capabilities": {"threads": false}, "commandPrefix": "!",
         "webAppUrl": "https://web.fluxer.app",
         "notes": {"auto-threads": "Fluxer has no threads yet, so this module does nothing on a Fluxer server."}}
        """#
        let info = try JSONDecoder().decode(PlatformInfo.self, from: Data(json.utf8))
        #expect(info.platform == .fluxer)
        #expect(info.note(for: "auto-threads")?.contains("no threads") == true)
        #expect(info.note(for: "events") == nil)
    }

    @Test("Discord has no notes")
    func discord() throws {
        let info = try JSONDecoder().decode(PlatformInfo.self, from: Data(#"{"platform":"discord","notes":{}}"#.utf8))
        #expect(info.platform == .discord)
        #expect(info.note(for: "auto-threads") == nil)
        #expect(try JSONDecoder().decode(PlatformInfo.self, from: Data("{}".utf8)).platform == .discord)
    }

    @Test("the endpoint uses the server's path")
    func paths() {
        #expect(Endpoints.LoadPlatformInfo(server: "fluxer:9").path == "/api/v2/guilds/fluxer%3A9/platform")
    }

    @MainActor
    @Test("the note model asks the server once and keeps the note")
    func model() async {
        let clients = StubClients { _ in
            PlatformInfo(platform: .fluxer, notes: ["auto-threads": "No threads."])
        }
        let model = ModulePlatformNoteModel(
            server: "fluxer:9", module: "auto-threads", session: makeSignedInSession(clients: clients))
        await model.load()
        await model.load()
        #expect(model.note == "No threads.")
        #expect(model.platform == .fluxer)
        #expect(clients.calls.count == 1)
    }

    @MainActor
    @Test("a failed lookup means no note, not an error")
    func failure() async {
        let clients = StubClients { _ in throw NetworkError.offline }
        let model = ModulePlatformNoteModel(
            server: "1", module: "auto-threads", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.note == nil)
    }
}
