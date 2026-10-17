import Foundation
import Testing
@testable import SyloKit

@Suite("Server settings")
struct GuildSettingsTests {
    /// `GET /api/v2/guilds/:id/settings`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "guild": {"id": "123", "name": "Sylo HQ", "icon": null},
      "modlogChannelId": "222",
      "embedColorHex": "#ff8000",
      "channels": [{"id": "222", "name": "mod-log"}, {"id": "333", "name": "general"}],
      "roles": [{"id": "444", "name": "Admins"}, {"id": "555", "name": "Mods"}],
      "botMasterRoleIds": ["555"]
    }
    """#

    static func body(_ settings: GuildSettings) throws -> [String: Any] {
        let data = try JSONEncoder().encode(settings)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("the endpoints use the server's settings path")
    func paths() {
        let load = Endpoints.LoadGuildSettings(server: "fluxer:9")
        #expect(load.path == "/api/v2/guilds/fluxer%3A9/settings")
        #expect(load.method == .get)
        let save = Endpoints.SaveGuildSettings(server: "9", settings: GuildSettings())
        #expect(save.path == "/api/v2/guilds/9/settings")
        #expect(save.method == .post)
        #expect(save.body != nil)
    }

    @Test("the page decodes the settings, channels and roles")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(GuildSettingsPage.self, from: Data(Self.pageJSON.utf8))
        #expect(page.settings == GuildSettings(modlogChannelId: "222", botMasterRoleIds: ["555"], embedColorHex: "#ff8000"))
        #expect(page.channels.map(\.name) == ["mod-log", "general"])
        #expect(page.roles.map(\.id) == ["444", "555"])
    }

    @Test("missing fields fall back to off, none and Sylo's colour")
    func lenientDecoding() throws {
        let page = try JSONDecoder().decode(GuildSettingsPage.self, from: Data("{}".utf8))
        #expect(page.settings == GuildSettings())
        #expect(page.settings.modlogChannelId.isEmpty)
        #expect(page.settings.botMasterRoleIds.isEmpty)
        #expect(page.settings.embedColorHex.isEmpty)
        #expect(page.channels.isEmpty)
        #expect(page.roles.isEmpty)
    }

    @Test("a colour without # is read as #rrggbb")
    func normalisesColour() throws {
        let json = Data(#"{"embedColorHex":"AbCdEf"}"#.utf8)
        let page = try JSONDecoder().decode(GuildSettingsPage.self, from: json)
        #expect(page.settings.embedColorHex == "#abcdef")
    }

    @Test("saving sends exactly what the web form sends")
    func encodesBody() throws {
        let body = try Self.body(GuildSettings(modlogChannelId: "222", botMasterRoleIds: ["444", "555"], embedColorHex: "#ff8000"))
        #expect(Set(body.keys) == ["modlogChannelId", "botMasterRoleIds", "embedColor"])
        #expect(body["modlogChannelId"] as? String == "222")
        #expect(body["botMasterRoleIds"] as? [String] == ["444", "555"])
        #expect(body["embedColor"] as? String == "#ff8000")
    }

    @Test("no mod-log channel is sent as an empty id")
    func encodesNoModlog() throws {
        let body = try Self.body(GuildSettings(embedColorHex: "#112233"))
        #expect(body["modlogChannelId"] as? String == "")
        #expect(body["botMasterRoleIds"] as? [String] == [])
    }

    @Test("Sylo's colour is sent as a reset, like the web form's Reset to default")
    func encodesReset() throws {
        let body = try Self.body(GuildSettings(modlogChannelId: "222", embedColorHex: ""))
        #expect(Set(body.keys) == ["modlogChannelId", "botMasterRoleIds", "embedColor", "embedColorReset"])
        #expect(body["embedColorReset"] as? Bool == true)
        #expect(body["embedColor"] as? String == "")
    }

    @Test("the encoded body decodes back to the same settings")
    func roundTrips() throws {
        for settings in [
            GuildSettings(modlogChannelId: "1", botMasterRoleIds: ["2"], embedColorHex: "#010203"),
            GuildSettings(modlogChannelId: "1", botMasterRoleIds: [], embedColorHex: ""),
        ] {
            let data = try JSONEncoder().encode(settings)
            #expect(try JSONDecoder().decode(GuildSettings.self, from: data) == settings)
        }
    }

    @Test("the embed colour converts between hex and RGB, Sylo's colour when unset")
    func colour() {
        var settings = GuildSettings(embedColorHex: "#ff8000")
        let rgb = settings.rgb
        #expect(rgb.red == 1)
        #expect(abs(rgb.green - 128.0 / 255) < 0.0001)
        #expect(rgb.blue == 0)
        #expect(!settings.usesDefaultColor)
        settings.setRGB(red: 0, green: 0.5, blue: 1.2)
        #expect(settings.embedColorHex == "#0080ff")
        settings.useDefaultColor()
        #expect(settings.embedColorHex == "")
        #expect(settings.usesDefaultColor)
        #expect(settings.rgb == GuildSettings(embedColorHex: GuildSettings.defaultColorHex).rgb)
        #expect(GuildSettings(embedColorHex: "nonsense").rgb == GuildSettings().rgb)
        #expect(GuildSettings(embedColorHex: "#7AA2F7").usesDefaultColor)
    }
}

@MainActor
@Suite("Server settings model")
struct GuildSettingsModelTests {
    nonisolated static let page = GuildSettingsPage(
        settings: GuildSettings(modlogChannelId: "1", botMasterRoleIds: ["5"], embedColorHex: "#ff8000"),
        channels: [ChannelOption(id: "1", name: "mod-log"), ChannelOption(id: "2", name: "general")],
        roles: [RoleOption(id: "5", name: "Mods")])

    /// What the stub server stores; a save writes it and a load reads it, like the real server.
    final class Store: @unchecked Sendable {
        // @unchecked: `stored` is only touched while holding `lock`.
        private let lock = NSLock()
        private var stored = GuildSettingsModelTests.page.settings
        var settings: GuildSettings {
            get { lock.withLock { stored } }
            set { lock.withLock { stored = newValue } }
        }
    }

    /// Answers loads from `store`, and saves into it the way the server does (a reset stores
    /// Sylo's colour, which the next load reports as its hex).
    static func clients(
        store: Store = Store(), save: @escaping @Sendable (GuildSettings) throws -> Void = { _ in }
    ) -> StubClients {
        StubClients { endpoint in
            if let saving = endpoint as? Endpoints.SaveGuildSettings {
                try save(saving.settings)
                var stored = saving.settings
                if stored.embedColorHex.isEmpty { stored.embedColorHex = GuildSettings.defaultColorHex }
                store.settings = stored
                return OKResponse()
            }
            return GuildSettingsPage(settings: store.settings, channels: Self.page.channels, roles: Self.page.roles)
        }
    }

    func loaded(_ clients: StubClients) async -> GuildSettingsModel {
        let model = GuildSettingsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        return model
    }

    @Test("loading gives the page and a draft equal to it, with nothing to save")
    func loads() async {
        let model = await loaded(Self.clients())
        #expect(model.page?.channels.count == 2)
        #expect(model.page?.roles.map(\.name) == ["Mods"])
        #expect(model.draft == Self.page.settings)
        #expect(!model.hasChanges)
        #expect(!model.isLoading)
    }

    @Test("editing the draft is a change; discarding goes back")
    func editsAndDiscards() async {
        let model = await loaded(Self.clients())
        model.draft?.modlogChannelId = "2"
        #expect(model.hasChanges)
        model.discardChanges()
        #expect(model.draft?.modlogChannelId == "1")
        #expect(!model.hasChanges)
    }

    @Test("saving sends the draft, then reloads what the server stored")
    func savesAndReloads() async throws {
        let clients = Self.clients()
        let model = await loaded(clients)
        model.draft?.modlogChannelId = "2"
        model.draft?.botMasterRoleIds = []
        let ok = await model.save()
        #expect(ok)
        #expect(!model.isSaving)
        #expect(!model.hasChanges)
        #expect(model.saveCount == 1)
        #expect(model.page?.settings.modlogChannelId == "2")
        #expect(model.draft?.modlogChannelId == "2")
        let calls = clients.calls.map(\.endpoint)
        #expect(calls.count == 3)
        #expect(calls[0] is Endpoints.LoadGuildSettings)
        let sent = try #require(calls[1] as? Endpoints.SaveGuildSettings)
        #expect(sent.server == "9")
        #expect(sent.settings == GuildSettings(modlogChannelId: "2", botMasterRoleIds: [], embedColorHex: "#ff8000"))
        #expect(calls[2] is Endpoints.LoadGuildSettings)
    }

    @Test("using Sylo's colour saves a reset and reloads the colour it stands for")
    func resetsColour() async throws {
        let clients = Self.clients()
        let model = await loaded(clients)
        model.draft?.useDefaultColor()
        #expect(model.hasChanges)
        let ok = await model.save()
        #expect(ok)
        let sent = try #require(clients.calls.compactMap { $0.endpoint as? Endpoints.SaveGuildSettings }.last)
        #expect(sent.settings.embedColorHex == "")
        #expect(model.draft?.embedColorHex == GuildSettings.defaultColorHex)
        #expect(!model.hasChanges)
    }

    @Test("a failed save keeps the draft and explains")
    func failedSave() async {
        let model = await loaded(Self.clients { _ in throw NetworkError.badRequest(message: "Unknown channel") })
        model.draft?.modlogChannelId = "2"
        let ok = await model.save()
        #expect(!ok)
        #expect(model.draft?.modlogChannelId == "2")
        #expect(model.hasChanges)
        #expect(model.saveError == NetworkError.badRequest(message: "Unknown channel").userMessage)
        #expect(model.saveCount == 0)
    }

    @Test("a cancelled save says nothing")
    func cancelledSave() async {
        let model = await loaded(Self.clients { _ in throw NetworkError.cancelled })
        model.draft?.modlogChannelId = "2"
        let ok = await model.save()
        #expect(!ok)
        #expect(model.saveError == nil)
        #expect(model.hasChanges)
    }

    @Test("a save that went through counts even when the reload fails")
    func saveThenFailedReload() async {
        let store = Store()
        let clients = Self.clients(store: store)
        let model = await loaded(clients)
        model.draft?.modlogChannelId = "2"
        clients.setHandler { endpoint in
            if let saving = endpoint as? Endpoints.SaveGuildSettings {
                store.settings = saving.settings
                return OKResponse()
            }
            throw NetworkError.offline
        }
        let ok = await model.save()
        #expect(ok)
        #expect(model.saveCount == 1)
        #expect(!model.hasChanges)
        #expect(model.draft?.modlogChannelId == "2")
        #expect(model.saveError == nil)
    }

    @Test("reloading with unsaved changes keeps the draft")
    func reloadKeepsDraft() async {
        let store = Store()
        let model = await loaded(Self.clients(store: store))
        model.draft?.botMasterRoleIds = ["5", "6"]
        store.settings.modlogChannelId = "2"
        await model.load()
        #expect(model.draft?.botMasterRoleIds == ["5", "6"])
        #expect(model.draft?.modlogChannelId == "1")
        #expect(model.hasChanges)
        #expect(model.page?.settings.modlogChannelId == "2")
    }

    @Test("a failed load explains, and a later load clears it")
    func failedLoad() async {
        let clients = StubClients { _ in throw NetworkError.offline }
        let model = GuildSettingsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.page == nil)
        #expect(model.errorMessage == NetworkError.offline.userMessage)
        clients.setHandler { _ in Self.page }
        await model.load()
        #expect(model.errorMessage == nil)
        #expect(model.draft == Self.page.settings)
    }

    @Test("a cancelled load says nothing")
    func cancelledLoad() async {
        let clients = StubClients { _ in throw NetworkError.cancelled }
        let model = GuildSettingsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.errorMessage == nil)
        #expect(model.page == nil)
    }

    @Test("nothing is sent without changes")
    func saveWithoutChanges() async {
        let clients = Self.clients()
        let model = await loaded(clients)
        let ok = await model.save()
        #expect(ok)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.SaveGuildSettings })
    }
}
