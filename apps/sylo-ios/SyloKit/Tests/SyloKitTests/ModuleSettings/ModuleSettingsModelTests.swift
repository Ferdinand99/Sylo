import Foundation
import Testing
@testable import SyloKit

/// A minimal module page for testing the shared settings model.
struct SamplePage: ModuleSettingsPage {
    static let moduleID: ModuleID = "sample"
    let settings: SampleSettings
    let channels: [ChannelOption]

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels
    }
}

struct SampleSettings: Codable, Sendable, Equatable {
    var channelId: String
    var limit: Int
}

@MainActor
@Suite("Module settings model")
struct ModuleSettingsModelTests {
    nonisolated static let page = SamplePage(
        settings: SampleSettings(channelId: "1", limit: 5), channels: [ChannelOption(id: "1", name: "general")])

    /// Answers the page, and saves by echoing what was sent (or with `save`).
    static func clients(
        save: @escaping @Sendable (SampleSettings) throws -> SampleSettings = { $0 }
    ) -> StubClients {
        StubClients { endpoint in
            if let saving = endpoint as? Endpoints.SaveModuleSettings<SamplePage> {
                return SavedModuleSettings(settings: try save(saving.settings))
            }
            return Self.page
        }
    }

    func loaded(_ clients: StubClients) async -> ModuleSettingsModel<SamplePage> {
        let model = ModuleSettingsModel<SamplePage>(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        return model
    }

    @Test("the endpoints use the module's config path")
    func paths() {
        let load = Endpoints.LoadModuleSettings<SamplePage>(server: "fluxer:9")
        #expect(load.path == "/api/v2/guilds/fluxer%3A9/modules/sample/config")
        #expect(load.method == .get)
        let save = Endpoints.SaveModuleSettings<SamplePage>(server: "9", settings: Self.page.settings)
        #expect(save.path == "/api/v2/guilds/9/modules/sample/config")
        #expect(save.method == .post)
        #expect(save.body != nil)
    }

    @Test("a saved answer is read from its config key")
    func decodesSaved() throws {
        let json = Data(#"{"config":{"channelId":"2","limit":7}}"#.utf8)
        let saved = try JSONDecoder().decode(SavedModuleSettings<SampleSettings>.self, from: json)
        #expect(saved.settings == SampleSettings(channelId: "2", limit: 7))
    }

    @Test("loading gives the page and a draft equal to it, with nothing to save")
    func loads() async {
        let model = await loaded(Self.clients())
        #expect(model.page?.channels.count == 1)
        #expect(model.draft == Self.page.settings)
        #expect(!model.hasChanges)
    }

    @Test("editing the draft is a change; discarding goes back")
    func editsAndDiscards() async {
        let model = await loaded(Self.clients())
        model.draft?.limit = 9
        #expect(model.hasChanges)
        model.discardChanges()
        #expect(model.draft?.limit == 5)
        #expect(!model.hasChanges)
    }

    @Test("saving sends the draft and keeps what the server made of it")
    func saves() async throws {
        let clients = Self.clients { sent in SampleSettings(channelId: sent.channelId, limit: min(sent.limit, 10)) }
        let model = await loaded(clients)
        model.draft?.limit = 50
        let ok = await model.save()
        #expect(ok)
        #expect(model.draft?.limit == 10)
        #expect(!model.hasChanges)
        #expect(model.saveCount == 1)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.SaveModuleSettings<SamplePage>)
        #expect(sent.settings.limit == 50)
        #expect(sent.server == "9")
    }

    @Test("a failed save keeps the draft and explains")
    func failedSave() async {
        let model = await loaded(Self.clients { _ in throw NetworkError.badRequest(message: "nope") })
        model.draft?.limit = 6
        let ok = await model.save()
        #expect(!ok)
        #expect(model.draft?.limit == 6)
        #expect(model.hasChanges)
        #expect(model.saveError == NetworkError.badRequest(message: "nope").userMessage)
        #expect(model.saveCount == 0)
    }

    @Test("reloading with unsaved changes keeps the draft")
    func reloadKeepsDraft() async {
        let model = await loaded(Self.clients())
        model.draft?.limit = 8
        await model.load()
        #expect(model.draft?.limit == 8)
        #expect(model.hasChanges)
    }

    @Test("a failed load explains, and a later load clears it")
    func failedLoad() async {
        let clients = StubClients { _ in throw NetworkError.offline }
        let model = ModuleSettingsModel<SamplePage>(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.page == nil)
        #expect(model.errorMessage == NetworkError.offline.userMessage)
        clients.setHandler { _ in Self.page }
        await model.load()
        #expect(model.errorMessage == nil)
        #expect(model.draft == Self.page.settings)
    }

    @Test("nothing is sent without changes")
    func saveWithoutChanges() async {
        let clients = Self.clients()
        let model = await loaded(clients)
        let ok = await model.save()
        #expect(ok)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.SaveModuleSettings<SamplePage> })
    }
}
