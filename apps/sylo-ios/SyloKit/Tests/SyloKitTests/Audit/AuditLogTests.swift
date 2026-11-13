import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

/// 2023-11-14 00:00:00 UTC.
private let day = 1_699_920_000.0

private var utc: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .gmt
    return calendar
}

@Suite("Audit log")
struct AuditLogDecodingTests {
    static let json = #"""
        {"kept":500,"entries":[
          {"id":3,"actor":"Ferdi (dashboard)","action":"module:starboard","detail":"enabled","at":\#((day + 7200) * 1000),"ago":"2h ago"},
          {"id":"2","actor":"Dashboard","action":"settings:server","detail":"","at":\#((day + 3600) * 1000),"ago":"3h ago"},
          {"id":1,"actor":"Ferdi (dashboard)","action":"module:bulk","detail":"disabled 3 module(s)","at":\#((day - 3600) * 1000),"ago":"1d ago"},
          {"actor":"nobody","action":"broken","at":0}]}
        """#

    @Test("Entries read with numeric or text ids, and a broken one is dropped")
    func decodes() throws {
        let page = try decode(AuditLogPage.self, Self.json)
        #expect(page.kept == 500)
        #expect(page.entries.map(\.id) == ["3", "2", "1"])
        #expect(page.entries[0].actor == "Ferdi (dashboard)")
        #expect(page.entries[0].detail == "enabled")
        #expect(page.entries[1].detail == nil)
        #expect(page.entries[0].date == Date(timeIntervalSince1970: day + 7200))
    }

    @Test("An answer with nothing in it is an empty log")
    func empty() throws {
        let page = try decode(AuditLogPage.self, "{}")
        #expect(page.entries.isEmpty)
        #expect(page.days(calendar: utc).isEmpty)
    }

    @Test("Entries are grouped by day, the newest day and entry first")
    func groupsByDay() throws {
        let page = try decode(AuditLogPage.self, Self.json)
        let days = page.days(calendar: utc)
        #expect(days.count == 2)
        #expect(days[0].day == Date(timeIntervalSince1970: day))
        #expect(days[0].entries.map(\.id) == ["3", "2"])
        #expect(days[1].day == Date(timeIntervalSince1970: day - 86_400))
        #expect(days[1].entries.map(\.id) == ["1"])
    }

    @Test("Actions read like the dashboard words them")
    func titles() {
        let names = ["starboard": "Starboard", "welcome": "Welcome"]
        #expect(AuditAction.title(for: "module:starboard", moduleNames: names) == "Starboard")
        #expect(AuditAction.title(for: "module:bulk", moduleNames: names) == "Several modules")
        #expect(AuditAction.title(for: "module:auto-react") == "Auto react")
        #expect(AuditAction.title(for: "settings:server") == "Server settings")
        #expect(AuditAction.title(for: "warned") == "Warning")
        #expect(AuditAction.title(for: "appeal:accepted") == "Appeal accepted")
        #expect(AuditAction.title(for: "moderation:case-delete") == "Case delete")
        #expect(AuditAction.title(for: "moderation:lockdown") == "Lockdown")
        #expect(AuditAction.title(for: "command:ban") == "Command ban")
        #expect(AuditAction.title(for: "some-new:thing") == "Some new thing")
        #expect(AuditAction.title(for: ":::") == ":::")
    }

    @Test("The call goes where the server expects")
    func endpoint() {
        #expect(Endpoints.AuditLog(server: "fluxer:9").path == "/api/v2/guilds/fluxer%3A9/audit")
    }
}

@MainActor
@Suite("Audit log model")
struct AuditLogModelTests {
    nonisolated static let page = try! decode(AuditLogPage.self, AuditLogDecodingTests.json)
    nonisolated static let overview = ServerOverview(
        server: OverviewServer(id: "1", name: "Alpha"),
        groups: [OverviewGroup(title: "Fun", cards: [
            OverviewCard(kind: .module, id: "starboard", name: "Starboard", hasToggle: true, isEnabled: true, status: .on),
        ])])

    @Test("Loading shows the entries, named with the modules' own names")
    func loads() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.Overview { return Self.overview }
            return Self.page
        }
        let model = AuditLogModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.page == Self.page)
        #expect(model.errorMessage == nil)
        #expect(model.title(for: Self.page.entries[0]) == "Starboard")
        #expect(model.title(for: Self.page.entries[1]) == "Server settings")
    }

    @Test("Without the overview an entry still reads from its id")
    func overviewFails() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.Overview { throw NetworkError.forbidden }
            return Self.page
        }
        let model = AuditLogModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.page == Self.page)
        #expect(model.errorMessage == nil)
        #expect(model.title(for: Self.page.entries[0]) == "Starboard")
    }

    @Test("A failed load explains, and a later one clears it")
    func failedLoad() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.AuditLog { throw NetworkError.offline }
            throw NetworkError.notFound
        }
        let model = AuditLogModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.page == nil)
        #expect(model.errorMessage == NetworkError.offline.userMessage)

        clients.setHandler { _ in Self.page }
        await model.load()
        #expect(model.errorMessage == nil)
        #expect(model.page == Self.page)
    }
}
