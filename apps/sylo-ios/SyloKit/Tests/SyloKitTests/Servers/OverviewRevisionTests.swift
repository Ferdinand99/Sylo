import Foundation
import Testing
@testable import SyloKit

/// The overview's 10 second reload throttle must never keep a summary from before a save.
@MainActor
@Suite("Overview after a save")
struct OverviewRevisionTests {
    static func clients() -> StubClients {
        StubClients { endpoint in
            if let saving = endpoint as? Endpoints.SaveModuleSettings<SamplePage> {
                return SavedModuleSettings(settings: saving.settings)
            }
            if endpoint is Endpoints.LoadModuleSettings<SamplePage> { return ModuleSettingsModelTests.page }
            return OverviewModelTests.overview
        }
    }

    @Test("a saved module makes the next appearance load again, however recent the last load was")
    func savedModuleForcesReload() async {
        let clients = Self.clients()
        let session = makeSignedInSession(clients: clients)
        let overview = OverviewModel(server: "1", session: session)
        await overview.load()
        let calls = clients.calls.count

        // Nothing changed: a load a moment ago is enough.
        await overview.loadIfStale()
        #expect(clients.calls.count == calls)

        let settings = ModuleSettingsModel<SamplePage>(server: "1", session: session)
        await settings.load()
        settings.draft?.limit = 9
        let saved = await settings.save()
        #expect(saved)

        let before = clients.calls.count
        await overview.loadIfStale()
        #expect(clients.calls.count == before + 1)
        #expect(clients.calls.last?.endpoint is Endpoints.Overview)

        // The reload caught up with the save, so the throttle applies again.
        await overview.loadIfStale()
        #expect(clients.calls.count == before + 1)
    }

    @Test("a save that failed leaves the throttle alone")
    func failedSaveDoesNot() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.SaveModuleSettings<SamplePage> { throw NetworkError.badRequest(message: nil) }
            if endpoint is Endpoints.LoadModuleSettings<SamplePage> { return ModuleSettingsModelTests.page }
            return OverviewModelTests.overview
        }
        let session = makeSignedInSession(clients: clients)
        let overview = OverviewModel(server: "1", session: session)
        await overview.load()
        let settings = ModuleSettingsModel<SamplePage>(server: "1", session: session)
        await settings.load()
        settings.draft?.limit = 9
        let saved = await settings.save()
        #expect(!saved)
        let before = clients.calls.count
        await overview.loadIfStale()
        #expect(clients.calls.count == before)
    }

    @Test("a change to the server's own settings does the same")
    func noteChange() async {
        let clients = Self.clients()
        let session = makeSignedInSession(clients: clients)
        let overview = OverviewModel(server: "1", session: session)
        await overview.load()
        session.noteModulesChanged()
        let before = clients.calls.count
        await overview.loadIfStale()
        #expect(clients.calls.count == before + 1)
    }
}
