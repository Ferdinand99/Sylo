import Foundation
import Testing
@testable import SyloKit

@MainActor
@Suite("Overview model")
struct OverviewModelTests {
    nonisolated static let logging = OverviewCard(
        kind: .module, id: "logging", name: "Logging", icon: "file-text", hasToggle: true,
        isEnabled: false, status: .off)
    nonisolated static let settings = OverviewCard(
        kind: .link, id: "general", name: "Settings", icon: "gear", hasToggle: false,
        isEnabled: nil, status: .link)
    nonisolated static let overview = ServerOverview(
        server: OverviewServer(id: "1", name: "Alpha", memberCount: 42),
        groups: [OverviewGroup(title: "Core", cards: [settings, logging])])

    /// Answers the overview, and toggles with `toggle` (default: the server agrees).
    static func clients(
        toggle: @escaping @Sendable (Endpoints.SetModule) throws -> ModuleToggleResult = {
            ModuleToggleResult(isEnabled: $0.enabled)
        }
    ) -> StubClients {
        StubClients { endpoint in
            if let set = endpoint as? Endpoints.SetModule { return try toggle(set) }
            return Self.overview
        }
    }

    func loadedModel(_ clients: StubClients) async -> OverviewModel {
        let model = OverviewModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        return model
    }

    @Test("loading shows the overview")
    func loads() async {
        let model = await loadedModel(Self.clients())
        #expect(model.overview == Self.overview)
        #expect(model.errorMessage == nil)
    }

    @Test("a failed load explains, and a later load clears it")
    func failedLoad() async {
        let clients = StubClients { _ in throw NetworkError.forbidden }
        let model = OverviewModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.overview == nil)
        #expect(model.errorMessage == NetworkError.forbidden.userMessage)

        clients.setHandler { _ in Self.overview }
        await model.load()
        #expect(model.overview == Self.overview)
        #expect(model.errorMessage == nil)
    }

    @Test("switching a module on shows at once, then keeps what the server says")
    func switchesOn() async throws {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        let task = try #require(model.setModule("logging", enabled: true))
        #expect(model.card("logging")?.isEnabled == true)
        #expect(model.card("logging")?.status == .on)
        #expect(model.isPending("logging"))
        await task.value
        #expect(model.card("logging")?.isEnabled == true)
        #expect(!model.isPending("logging"))
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.SetModule)
        #expect(sent.server == "1")
        #expect(sent.module == "logging")
        #expect(sent.enabled)
    }

    @Test("a failed switch goes back and explains")
    func rollsBack() async throws {
        let model = await loadedModel(Self.clients { _ in throw NetworkError.offline })
        await model.setModule("logging", enabled: true)?.value
        #expect(model.card("logging")?.isEnabled == false)
        #expect(model.card("logging")?.status == .off)
        #expect(model.toggleError == NetworkError.offline.userMessage)
    }

    @Test("the server's answer wins over what was asked")
    func serverWins() async {
        let model = await loadedModel(Self.clients { _ in ModuleToggleResult(isEnabled: false) })
        await model.setModule("logging", enabled: true)?.value
        #expect(model.card("logging")?.isEnabled == false)
    }

    @Test("a module that can't run stays marked so, whichever way it is switched")
    func blockedStaysBlocked() async {
        let blocked = OverviewCard(
            kind: .module, id: "welcome", name: "Welcome", hasToggle: true, isEnabled: false,
            missingIntents: ["GuildMembers"], status: .blocked)
        let overview = ServerOverview(
            server: OverviewServer(id: "1", name: "Alpha"), groups: [OverviewGroup(title: "Core", cards: [blocked])])
        let clients = StubClients { endpoint in
            if let set = endpoint as? Endpoints.SetModule { return ModuleToggleResult(isEnabled: set.enabled) }
            return overview
        }
        let model = await loadedModel(clients)
        await model.setModule("welcome", enabled: true)?.value
        #expect(model.card("welcome")?.isEnabled == true)
        #expect(model.card("welcome")?.status == .blocked)
    }

    @Test("a second switch while one is on its way, or of a card without a toggle, is ignored")
    func ignoresWhilePending() async {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        let first = model.setModule("logging", enabled: true)
        #expect(model.setModule("logging", enabled: false) == nil)
        #expect(model.setModule("general", enabled: true) == nil)
        await first?.value
        #expect(clients.calls.filter { $0.endpoint is Endpoints.SetModule }.count == 1)
    }

    @Test("starting a new switch clears the last switch error")
    func clearsToggleError() async {
        let clients = Self.clients { _ in throw NetworkError.offline }
        let model = await loadedModel(clients)
        await model.setModule("logging", enabled: true)?.value
        #expect(model.toggleError != nil)
        clients.setHandler { endpoint in
            if let set = endpoint as? Endpoints.SetModule { return ModuleToggleResult(isEnabled: set.enabled) }
            return Self.overview
        }
        await model.setModule("logging", enabled: true)?.value
        #expect(model.toggleError == nil)
    }
}
