import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

private let viewOnly = "Your dashboard access in this server is View only, so you can't do this."

@MainActor
@Suite("Saving only the access roles")
struct AccessOnlySaveTests {
    @Test("A failed access-only save says why in the server's words, and plays no success")
    func accessOnlyFails() async {
        let page = try! decode(GuildSettingsPage.self, GuildSettingsAccessTests.settingsJSON)
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.ServerInfo: return ServerInfo(features: [.appLogin, .accessLevels])
            case is Endpoints.LoadGuildSettings: return page
            case is Endpoints.LoadDashboardAccess: return DashboardAccessSettings(inboxRoleIds: ["20"])
            default: throw NetworkError.forbidden(message: viewOnly)
            }
        }
        let model = GuildSettingsModel(server: "1", session: makeSignedInSession(clients: clients), hasAccessLevels: true)
        await model.load()
        let before = model.saveCount
        model.accessDraft = DashboardAccessRoles(inboxRoleIds: [], viewRoleIds: ["30"])
        #expect(await model.save() == false)
        // No settings were sent, so the message must not claim they were saved.
        #expect(model.saveError == viewOnly)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.SaveGuildSettings })
        #expect(model.saveCount == before)
    }

    @Test("When the settings did save and the access roles did not, it says so, still with no success haptic")
    func settingsSavedAccessFailed() async {
        let page = try! decode(GuildSettingsPage.self, GuildSettingsAccessTests.settingsJSON)
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.ServerInfo: return ServerInfo(features: [.appLogin, .accessLevels])
            case is Endpoints.LoadGuildSettings: return page
            case is Endpoints.LoadDashboardAccess: return DashboardAccessSettings(inboxRoleIds: ["20"])
            case is Endpoints.SaveGuildSettings: return OKResponse()
            default: throw NetworkError.forbidden(message: "Not allowed.")
            }
        }
        let model = GuildSettingsModel(server: "1", session: makeSignedInSession(clients: clients), hasAccessLevels: true)
        await model.load()
        let before = model.saveCount
        model.draft?.modlogChannelId = "c1"
        model.accessDraft = DashboardAccessRoles(inboxRoleIds: [], viewRoleIds: ["30"])
        #expect(await model.save() == false)
        #expect(model.saveError?.hasPrefix("The settings were saved, but the dashboard access roles were not.") == true)
        #expect(model.saveCount == before)
    }
}

@MainActor
@Suite("Features are read once and again after a failure")
struct FeatureReadTests {
    @Test("Callers that ask together share one read of the server info")
    func shared() async {
        let clients = StubClients { _ in ServerInfo(features: [.appLogin, .health, .setupWizard]) }
        clients.setHold { _ in try await Task.sleep(for: .milliseconds(60)) }
        let session = makeSignedInSession(clients: clients)
        async let first = session.serverFeatures()
        async let second = session.serverFeatures()
        async let third = session.supports(.health)
        let results = await (first, second, third)
        #expect(results.0.contains(.setupWizard))
        #expect(results.1 == results.0)
        #expect(results.2)
        #expect(clients.calls.filter { $0.endpoint is Endpoints.ServerInfo }.count == 1)
    }

    @Test("A failed read is not kept: the next ask reads again, and nothing is concluded from the failure")
    func retry() async {
        let clients = StubClients { _ in throw NetworkError.offline }
        let session = makeSignedInSession(clients: clients)
        #expect(await session.serverFeatures().isEmpty)
        #expect(!session.featuresKnown)
        #expect(!session.has(.configImport))
        clients.setHandler { _ in ServerInfo(features: [.appLogin, .configImport]) }
        #expect(await session.supports(.configImport))
        #expect(session.featuresKnown)
        #expect(session.has(.configImport))
    }

    @Test("A model does not decide that the Sylo lacks a feature while the read has not answered")
    func notConcluded() async {
        let clients = StubClients { _ in throw NetworkError.offline }
        let session = makeSignedInSession(clients: clients)
        let health = ServerHealthModel(server: "1", session: session)
        await health.load()
        #expect(health.isSupported)
        let wizard = SetupWizardModel(server: "1", session: session)
        await wizard.load()
        #expect(wizard.isAvailable)
        // Once the Sylo has answered without the strings, both are hidden.
        clients.setHandler { _ in ServerInfo(features: [.appLogin]) }
        await health.load()
        await wizard.load()
        #expect(!health.isSupported)
        #expect(!wizard.isAvailable)
    }
}

@Suite("Setup offer rule")
struct SetupOfferRuleTests {
    private func overview(_ cards: String, attention: String = "") throws -> ServerOverview {
        let key = attention.isEmpty ? "" : #","attention":\#(attention)"#
        return try decode(ServerOverview.self, #"{"guild":{"id":"1","name":"A"},"groups":[{"title":"G","cards":[\#(cards)]}]\#(key)}"#)
    }

    private func card(_ id: String, status: String = "on", lines: String = "[]") -> String {
        #"{"kind":"module","id":"\#(id)","name":"\#(id)","hasToggle":true,"enabled":true,"status":"\#(status)","lines":\#(lines)}"#
    }

    @Test("Three modules that are on but whose lines all say off are not set up, as on the web")
    func offLines() throws {
        let off = #"[{"label":"Channel","value":"not set","state":"off"}]"#
        let cards = ["a", "b", "c"].map { card($0, lines: off) }.joined(separator: ",")
        #expect(SetupDraft.shouldOffer(overview: try overview(cards)))
    }

    @Test("A module that waits for the bot owner is not set up")
    func ownerWait() throws {
        let cards = ["a", "b", "c"].map { card($0) }.joined(separator: ",")
        let waiting = #"{"waitingForOwner":[{"id":"c","name":"C","keys":"keys"}]}"#
        #expect(SetupDraft.shouldOffer(overview: try overview(cards, attention: waiting)))
    }

    @Test("Three modules that are on, with a line that is not off, are set up")
    func setUp() throws {
        let mixed = #"[{"label":"Channel","value":"general","state":"on"},{"label":"X","value":"-","state":"off"}]"#
        let cards = ["a", "b", "c"].map { card($0, lines: mixed) }.joined(separator: ",")
        #expect(!SetupDraft.shouldOffer(overview: try overview(cards)))
    }

    @Test("A blocked module is not set up")
    func blocked() throws {
        let cards = [card("a"), card("b"), card("c", status: "blocked")].joined(separator: ",")
        #expect(SetupDraft.shouldOffer(overview: try overview(cards)))
    }
}

@MainActor
@Suite("Setup wizard reset")
struct SetupWizardResetTests {
    @Test("After Done the wizard forgets the run and looks at the server afresh")
    func resetAfterDone() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.ServerInfo { return SetupWizardModelTests.wizardInfo }
            if endpoint is Endpoints.SuggestSetup { return SetupWizardModelTests.proposal }
            return SetupApplyAnswer(results: [SetupResult(id: "welcome", name: "Welcome", status: .applied, message: "Done")])
        }
        let model = SetupWizardModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        model.setGoal("welcome", on: true)
        model.goToGoals()
        model.goToReview()
        await model.apply()
        #expect(model.step == .done)
        model.reset()
        #expect(model.step == .look)
        #expect(model.results.isEmpty)
        #expect(model.draft == nil)
        await model.load()
        #expect(model.draft?.goals.isEmpty == true)
    }
}
