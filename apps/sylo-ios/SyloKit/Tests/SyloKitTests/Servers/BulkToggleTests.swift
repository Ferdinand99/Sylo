import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

/// Encodes whatever `any Encodable` an endpoint body is.
private struct EncodedBody: Encodable {
    let value: (any Encodable)?
    init(_ value: (any Encodable)?) { self.value = value }
    func encode(to encoder: any Encoder) throws { try value?.encode(to: encoder) }
}

@Suite("Bulk module switch")
struct BulkToggleDecodingTests {
    @Test("The answer says how many modules changed")
    func decodes() throws {
        let result = try decode(BulkToggleResult.self, #"{"ok":true,"count":3,"enabled":true}"#)
        #expect(result == BulkToggleResult(count: 3, isEnabled: true))
        #expect(try decode(BulkToggleResult.self, "{}") == BulkToggleResult(count: 0, isEnabled: false))
    }

    @Test("The call sends the ids and the switch, and nothing else")
    func body() throws {
        let call = Endpoints.SetModulesBulk(server: "fluxer:1", modules: ["welcome", "logging"], enabled: false)
        #expect(call.path == "/api/v2/guilds/fluxer%3A1/modules/bulk")
        #expect(call.method == .post)
        let data = try JSONEncoder().encode(EncodedBody(call.body))
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(json.keys) == ["ids", "enabled"])
        #expect(json["ids"] as? [String] == ["welcome", "logging"])
        #expect(json["enabled"] as? Bool == false)
    }
}

@MainActor
@Suite("Overview model: bulk switch")
struct BulkToggleModelTests {
    nonisolated static func card(_ id: String, on: Bool, hasToggle: Bool = true) -> OverviewCard {
        OverviewCard(
            kind: hasToggle ? .module : .link, id: id, name: id.capitalized, hasToggle: hasToggle,
            isEnabled: hasToggle ? on : nil, status: hasToggle ? (on ? .on : .off) : .link)
    }

    nonisolated static let overview = ServerOverview(
        server: OverviewServer(id: "1", name: "Alpha"),
        groups: [
            OverviewGroup(title: "Core", cards: [
                card("general", on: false, hasToggle: false), card("logging", on: false), card("welcome", on: true),
            ]),
            OverviewGroup(title: "Fun", cards: [card("polls", on: false)]),
        ])

    static func clients(
        bulk: @escaping @Sendable (Endpoints.SetModulesBulk) throws -> BulkToggleResult = {
            BulkToggleResult(count: $0.modules.count, isEnabled: $0.enabled)
        }
    ) -> StubClients {
        StubClients { endpoint in
            if let call = endpoint as? Endpoints.SetModulesBulk { return try bulk(call) }
            return Self.overview
        }
    }

    func loadedModel(_ clients: StubClients) async -> OverviewModel {
        let model = OverviewModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        return model
    }

    @Test("Only module cards with a switch can be picked")
    func switchable() async {
        let model = await loadedModel(Self.clients())
        #expect(model.switchableModuleIDs == ["logging", "welcome", "polls"])
    }

    @Test("Switching several on shows at once, sends one call with every id, and keeps the answer")
    func switchesOn() async throws {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        let task = try #require(model.setModules(["logging", "polls"], enabled: true))
        #expect(model.card("logging")?.isEnabled == true)
        #expect(model.card("polls")?.status == .on)
        #expect(model.card("welcome")?.isEnabled == true)
        #expect(model.isBulkSwitching)
        #expect(model.isPending("logging"))
        await task.value
        #expect(!model.isBulkSwitching)
        #expect(!model.isPending("logging"))
        #expect(model.card("logging")?.isEnabled == true)
        #expect(model.bulkNotice == nil)
        let sent = clients.calls.compactMap { $0.endpoint as? Endpoints.SetModulesBulk }
        #expect(sent.count == 1)
        #expect(sent[0].modules == ["logging", "polls"])
        #expect(sent[0].enabled)
    }

    @Test("Switching off turns the cards off")
    func switchesOff() async {
        let model = await loadedModel(Self.clients())
        await model.setModules(["welcome"], enabled: false)?.value
        #expect(model.card("welcome")?.isEnabled == false)
        #expect(model.card("welcome")?.status == .off)
    }

    @Test("A failed switch puts every card back and explains")
    func failure() async {
        let model = await loadedModel(Self.clients(bulk: { _ in throw NetworkError.offline }))
        await model.setModules(["logging", "welcome"], enabled: true)?.value
        #expect(model.card("logging")?.isEnabled == false)
        #expect(model.card("welcome")?.isEnabled == true)
        #expect(model.toggleError == NetworkError.offline.userMessage)
        #expect(!model.isBulkSwitching)
    }

    @Test("When the server changes fewer modules than asked, the overview is read again and the person is told")
    func partial() async {
        let clients = Self.clients(bulk: { BulkToggleResult(count: $0.modules.count - 1, isEnabled: $0.enabled) })
        let model = await loadedModel(clients)
        await model.setModules(["logging", "polls"], enabled: true)?.value
        #expect(model.bulkNotice == "1 of 2 modules changed. The rest can't be switched from here.")
        // The overview is read again, so the cards show what the server really has.
        #expect(clients.calls.filter { $0.endpoint is Endpoints.Overview }.count == 2)
        #expect(model.card("logging")?.isEnabled == false)
    }

    @Test("Link cards, unknown ids and repeats are left out; nothing to switch sends nothing")
    func filtersIds() async throws {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        #expect(model.setModules(["general", "missing"], enabled: true) == nil)
        #expect(model.setModules([], enabled: true) == nil)
        let task = try #require(model.setModules(["logging", "general", "logging", "missing"], enabled: true))
        await task.value
        let sent = clients.calls.compactMap { $0.endpoint as? Endpoints.SetModulesBulk }
        #expect(sent.map(\.modules) == [["logging"]])
    }

    @Test("A second bulk switch while one is on its way is ignored")
    func oneAtATime() async {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        let first = model.setModules(["logging"], enabled: true)
        #expect(model.setModules(["polls"], enabled: true) == nil)
        await first?.value
        #expect(clients.calls.filter { $0.endpoint is Endpoints.SetModulesBulk }.count == 1)
    }

    @Test("Starting a new switch clears the last notice and error")
    func clearsNotices() async {
        let clients = Self.clients(bulk: { _ in throw NetworkError.offline })
        let model = await loadedModel(clients)
        await model.setModules(["logging"], enabled: true)?.value
        #expect(model.toggleError != nil)
        clients.setHandler { endpoint in
            if let call = endpoint as? Endpoints.SetModulesBulk { return BulkToggleResult(count: call.modules.count, isEnabled: call.enabled) }
            return Self.overview
        }
        await model.setModules(["logging"], enabled: true)?.value
        #expect(model.toggleError == nil)
        #expect(model.bulkNotice == nil)
    }
}
