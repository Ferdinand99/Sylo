import Foundation
import Testing
@testable import SyloKit

@MainActor
@Suite("Servers model")
struct ServersModelTests {
    nonisolated static let alpha = ServerSummary(id: "1", name: "Alpha", platform: .discord)
    nonisolated static let beta = ServerSummary(id: "fluxer:2", name: "Beta", platform: .fluxer)
    nonisolated static let gamma = ServerSummary(id: "3", name: "Gamma", platform: .discord)

    @Test("sections follow the platform order, keeping the server's name order inside each")
    func sections() {
        let sections = ServerSection.sections(for: [Self.beta, Self.alpha, Self.gamma])
        #expect(sections.map(\.platform) == [.discord, .fluxer])
        #expect(sections[0].servers == [Self.alpha, Self.gamma])
        #expect(sections[1].servers == [Self.beta])
    }

    @Test("an unknown platform comes last")
    func unknownPlatformLast() {
        let other = ServerSummary(id: "x", name: "X", platform: .other("matrix"))
        let sections = ServerSection.sections(for: [other, Self.beta])
        #expect(sections.map(\.platform) == [.fluxer, .other("matrix")])
    }

    @Test("loading fills the list")
    func loads() async {
        let clients = StubClients { _ in ServerList(servers: [Self.alpha, Self.beta]) }
        let model = ServersModel(session: makeSignedInSession(clients: clients))
        #expect(!model.hasLoaded)
        await model.load()
        #expect(model.servers == [Self.alpha, Self.beta])
        #expect(model.hasLoaded)
        #expect(model.errorMessage == nil)
        #expect(clients.calls.last?.endpoint is Endpoints.Servers)
    }

    @Test("a failed refresh keeps the servers already shown and explains")
    func failedRefreshKeepsList() async {
        let clients = StubClients { _ in ServerList(servers: [Self.alpha]) }
        let model = ServersModel(session: makeSignedInSession(clients: clients))
        await model.load()
        clients.setHandler { _ in throw NetworkError.offline }
        await model.load()
        #expect(model.servers == [Self.alpha])
        #expect(model.errorMessage == NetworkError.offline.userMessage)
    }

    @Test("a cancelled load says nothing")
    func cancelledIsQuiet() async {
        let clients = StubClients { _ in throw NetworkError.cancelled }
        let model = ServersModel(session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.errorMessage == nil)
    }

    @Test("a 401 says nothing here; the session shows sign-in")
    func unauthorizedIsLeftToSession() async {
        let clients = StubClients { _ in throw NetworkError.unauthorized }
        let session = makeSignedInSession(clients: clients)
        let model = ServersModel(session: session)
        await model.load()
        #expect(model.errorMessage == nil)
        #expect(session.notice == NetworkError.unauthorized.userMessage)
    }
}
