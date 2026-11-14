import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

/// The answer of `GET .../health`, as Sylo 5.2 sends it.
private let healthJSON = #"""
    {"guildId":"1","available":true,"platform":"discord","checkedAt":1760000000000,
     "summary":{"errors":1,"warnings":1},
     "checks":[
       {"module":"verification","moduleName":"Verification","severity":"error","code":"role-above","kind":"role-hierarchy",
        "message":"Sylo can't give Verified: Sylo's role is not above it.",
        "fix":"In the server's role settings, move Sylo's role above Verified.",
        "href":"/v2/guilds/1/m/verification","targetKind":"role","targetId":"200","targetName":"Verified"},
       {"module":"welcome","moduleName":"Welcome","severity":"warning","code":"missing-channel-permission","kind":"channel-permission",
        "message":"Sylo can't post in #welcome.","fix":"Give Sylo Send Messages there.","targetKind":"channel","targetId":"300"},
       {"module":"verification","moduleName":"Verification","severity":"warning","code":"ping","kind":"channel-permission",
        "message":"Sylo can't ping there.","fix":"Allow it."}],
     "targets":{"roles":{"blockedAll":null,"blocked":{"200":"above","201":"managed"}},
                "channels":{"blocked":{"300":["View Channel","Send Messages"]},"noEmbed":["301"]}}}
    """#

@Suite("Server health")
struct ServerHealthDecodingTests {
    @Test("The 5.2 answer reads: summary, checks and picker targets")
    func decodes() throws {
        let report = try decode(ServerHealthReport.self, healthJSON)
        #expect(report.available)
        #expect(report.platform == .discord)
        #expect(report.errorCount == 1)
        #expect(report.warningCount == 1)
        #expect(report.checks.count == 3)
        #expect(report.checks[0].severity == .error)
        #expect(report.checks[0].targetID == "200")
        #expect(report.checks[0].targetName == "Verified")
        #expect(report.checkedAt == Date(timeIntervalSince1970: 1_760_000_000))
        #expect(!report.isClean)
    }

    @Test("A module's checks come errors first")
    func perModule() throws {
        let report = try decode(ServerHealthReport.self, healthJSON)
        let checks = report.checks(forModule: "verification")
        #expect(checks.map(\.severity) == [.error, .warning])
        #expect(report.checks(forModule: "welcome").count == 1)
        #expect(report.checks(forModule: "leveling").isEmpty)
    }

    @Test("The overview's copy has no targets and reads the same")
    func attentionCopy() throws {
        let report = try decode(ServerHealthReport.self, #"{"available":true,"summary":{"errors":0,"warnings":0},"checks":[]}"#)
        #expect(report.isClean)
        #expect(report.targets == HealthTargets.none)
    }

    @Test("A broken check is dropped and an empty answer is an unavailable check")
    func lenient() throws {
        let report = try decode(ServerHealthReport.self, #"{"checks":[{"nope":1},{"module":"x","message":"m"}]}"#)
        #expect(report.checks.count == 1)
        #expect(report.checks[0].severity == .warning)
        // The summary was not sent, so it is counted from the checks.
        #expect(report.warningCount == 1)
        #expect(report.errorCount == 0)
        let empty = try decode(ServerHealthReport.self, "{}")
        #expect(empty.checks.isEmpty)
    }

    @Test("A role the picker would choose gets the dashboard's sentence")
    func roleWarnings() throws {
        let targets = try decode(ServerHealthReport.self, healthJSON).targets
        #expect(targets.roleWarning("200") == "Sylo can't give this role: move Sylo's role above it in the server's role settings.")
        #expect(targets.roleWarning("201") == "Sylo can't give this role: it is managed by an integration, so pick another role.")
        #expect(targets.roleWarning("999") == nil)
        #expect(targets.roleWarning("") == nil)
    }

    @Test("When Sylo can give no role at all, every role says so")
    func allRolesBlocked() throws {
        let targets = try decode(HealthTargets.self, #"{"roles":{"blockedAll":"Sylo can't give roles: it is missing Manage Roles.","blocked":{}}}"#)
        #expect(targets.roleWarning("5") == "Sylo can't give roles: it is missing Manage Roles.")
        #expect(targets.roleWarning("") == nil)
    }

    @Test("A channel Sylo cannot post in names what is missing; Embed Links only matters to an embed")
    func channelWarnings() throws {
        let targets = try decode(ServerHealthReport.self, healthJSON).targets
        #expect(targets.channelWarning("300") == "Sylo can't post in this channel: it is missing View Channel, Send Messages.")
        #expect(targets.channelWarning("301") == nil)
        #expect(targets.channelWarning("301", embed: true) == "Sylo can't send embeds in this channel: it is missing Embed Links.")
        #expect(targets.channelWarning("302", embed: true) == nil)
    }

    @Test("A list of picks names each one that fails")
    func listWarnings() throws {
        let targets = try decode(ServerHealthReport.self, healthJSON).targets
        let roles = targets.warnings(forRoles: ["200", "999", "201"], names: ["200": "Verified"])
        #expect(roles.count == 2)
        #expect(roles[0].hasPrefix("@Verified: Sylo can't give this role"))
        let channels = targets.warnings(forChannels: ["300", "1"], names: ["300": "welcome"])
        #expect(channels == ["#welcome: Sylo can't post in this channel: it is missing View Channel, Send Messages."])
    }

    @Test("An odd targets block never fails the report")
    func oddTargets() throws {
        let report = try decode(ServerHealthReport.self, #"{"available":true,"checks":[],"targets":{"roles":5,"channels":{"blocked":"x"}}}"#)
        #expect(report.targets.blockedRoles.isEmpty)
        #expect(report.targets.blockedChannels.isEmpty)
    }

    @Test("The call and its refresh")
    func endpoint() {
        let plain = Endpoints.LoadServerHealth(server: "fluxer:9")
        #expect(plain.path == "/api/v2/guilds/fluxer%3A9/health")
        #expect(plain.query.isEmpty)
        let fresh = Endpoints.LoadServerHealth(server: "1", refresh: true)
        #expect(fresh.query == [URLQueryItem(name: "refresh", value: "1")])
    }
}

@MainActor
@Suite("Server health model")
struct ServerHealthModelTests {
    nonisolated static let info52 = ServerInfo(features: [.appLogin, .health])
    nonisolated static let report = try! decode(ServerHealthReport.self, healthJSON)

    @Test("A server that announces health is read, and each module sees its own checks")
    func loads() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.ServerInfo { return Self.info52 }
            return Self.report
        }
        let model = ServerHealthModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.report == Self.report)
        #expect(model.checks(forModule: "welcome").count == 1)
        #expect(model.targets.roleWarning("200") != nil)
    }

    @Test("A Sylo 5.1 is never asked: no health feature, nothing to show")
    func olderServer() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.ServerInfo { return ServerInfo(features: [.appLogin]) }
            throw NetworkError.notFound
        }
        let model = ServerHealthModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(!model.isSupported)
        #expect(model.report == nil)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.LoadServerHealth })
        #expect(model.checks(forModule: "welcome").isEmpty)
        #expect(model.targets == HealthTargets.none)
    }

    @Test("Check again asks for a fresh look")
    func recheck() async throws {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.ServerInfo { return Self.info52 }
            return Self.report
        }
        let model = ServerHealthModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        await model.recheck()
        let reads = clients.calls.compactMap { $0.endpoint as? Endpoints.LoadServerHealth }
        #expect(reads.map(\.refresh) == [false, true])
        #expect(model.notice == nil)
    }

    @Test("A refusal for asking too soon keeps the last answer and says so")
    func tooSoon() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.ServerInfo { return Self.info52 }
            if let health = endpoint as? Endpoints.LoadServerHealth, health.refresh { throw NetworkError.rateLimited }
            return Self.report
        }
        let model = ServerHealthModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        await model.recheck()
        #expect(model.notice == ServerHealthModel.tooSoon)
        // The old answer is not mistaken for "all fixed".
        #expect(model.report == Self.report)
        #expect(!model.isRechecking)
    }

    @Test("A failed read never empties the list")
    func failureKeepsAnswer() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.ServerInfo { return Self.info52 }
            return Self.report
        }
        let model = ServerHealthModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        clients.setHandler { endpoint in
            if endpoint is Endpoints.ServerInfo { return Self.info52 }
            throw NetworkError.offline
        }
        await model.refreshAfterSave()
        #expect(model.report == Self.report)
        await model.recheck()
        #expect(model.notice == NetworkError.offline.userMessage)
        #expect(model.report == Self.report)
    }
}

@Suite("Needs attention")
struct AttentionItemTests {
    private func overview(attention: String?, tickets: Int = 0, appeals: Int = 0, cards: String = "") throws -> ServerOverview {
        let attentionKey = attention.map { #","attention":\#($0)"# } ?? ""
        let json = #"""
            {"guild":{"id":"1","name":"Alpha","memberCount":3},"openTickets":\#(tickets),"openAppeals":\#(appeals),
             "groups":[{"title":"Core","cards":[
               {"kind":"module","id":"verification","name":"Verification","hasToggle":true,"enabled":true,"status":"on"},
               {"kind":"module","id":"welcome","name":"Welcome","hasToggle":true,"enabled":false,"status":"off"}\#(cards)]}]\#(attentionKey)}
            """#
        return try decode(ServerOverview.self, json)
    }

    @Test("A 5.1 server has only the two totals")
    func fiveOne() throws {
        let items = try overview(attention: nil, tickets: 2, appeals: 1).attentionItems
        #expect(items.map(\.id) == ["tickets", "appeals"])
        #expect(items[0].title == "2 open tickets")
        #expect(items[1].title == "1 open ban appeal")
        #expect(items[0].destination == .tickets)
        #expect(items[1].destination == .appeals)
    }

    @Test("A 5.2 server adds waiting work per module, setup problems and health, in the dashboard's order")
    func fiveTwo() throws {
        let attention = #"""
            {"problems":[{"id":"verification","name":"Verification","issues":["The verified role is not set"]}],
             "waitingForOwner":[],"platform":"discord","missingPermissions":[],
             "waiting":{"tickets":1,"appeals":0,"applications":2,"suggestions":3},
             "health":{"available":true,"summary":{"errors":1,"warnings":1},"checks":[
               {"module":"welcome","moduleName":"Welcome","severity":"warning","message":"w1","fix":"f1"},
               {"module":"verification","moduleName":"Verification","severity":"error","message":"v1","fix":"g1"},
               {"module":"verification","moduleName":"Verification","severity":"warning","message":"v2","fix":"g2"}]}}
            """#
        let items = try overview(attention: attention, tickets: 9).attentionItems
        // Waiting work, then setup, then health with the error first. Welcome is off, so its row is not shown.
        #expect(items.map(\.id) == ["tickets", "applications", "suggestions", "setup-verification", "health-verification"])
        #expect(items[0].title == "1 open ticket")
        #expect(items[3].title == "Verification is on but not set up")
        #expect(items[3].detail == "The verified role is not set")
        let health = items[4]
        #expect(health.kind == .health)
        #expect(health.severity == .error)
        #expect(health.title == "Verification: Sylo can't do everything it needs")
        #expect(health.detail == "v1 And 1 more.")
        #expect(health.lines.map(\.message) == ["v1", "v2"])
        #expect(health.destination == .module("verification"))
    }

    @Test("Errors come before warnings across modules")
    func errorsFirst() throws {
        let attention = #"""
            {"health":{"available":true,"checks":[
               {"module":"verification","moduleName":"Verification","severity":"warning","message":"a","fix":""},
               {"module":"leveling","moduleName":"Leveling","severity":"error","message":"b","fix":""}]}}
            """#
        let cards = #",{"kind":"module","id":"leveling","name":"Leveling","hasToggle":true,"enabled":true,"status":"on"}"#
        let items = try overview(attention: attention, cards: cards).attentionItems
        #expect(items.map(\.id) == ["health-leveling", "health-verification"])
    }

    @Test("A permission the missing-permissions row names is not repeated per module")
    func permissionOnce() throws {
        let attention = #"""
            {"missingPermissions":["Manage Roles"],"platform":"fluxer",
             "health":{"available":true,"checks":[
               {"module":"verification","moduleName":"Verification","severity":"error","kind":"guild-permission",
                "permissionLabel":"Manage Roles","message":"needs it","fix":""}]}}
            """#
        let items = try overview(attention: attention).attentionItems
        #expect(items.map(\.id) == ["permissions"])
        #expect(items[0].title == "Sylo is missing 1 permission")
        #expect(items[0].detail == "Give Sylo's role in Fluxer: Manage Roles.")
    }

    @Test("A module switched off since is never a problem, and a blocked module cannot run")
    func offAndBlocked() throws {
        let attention = #"""
            {"problems":[{"id":"welcome","name":"Welcome","issues":["x"]}],
             "waitingForOwner":[{"id":"welcome","name":"Welcome","keys":"API keys"},{"id":"verification","name":"Verification","keys":"API keys"}]}
            """#
        let cards = #",{"kind":"module","id":"automod","name":"Auto-moderation","hasToggle":true,"enabled":true,"status":"blocked"}"#
        let items = try overview(attention: attention, cards: cards).attentionItems
        #expect(items.map(\.id) == ["owner-verification", "blocked-automod"])
        #expect(items[1].title == "Auto-moderation cannot run")
    }

    @Test("An attention block of an odd shape leaves the overview intact")
    func oddShape() throws {
        let overview = try overview(attention: #"{"problems":"nope","waiting":5,"health":7}"#, tickets: 1)
        #expect(overview.groups.count == 1)
        #expect(overview.attentionItems.map(\.id) == ["tickets"])
    }
}

@Suite("Picker notes are opt-in")
struct PickerHealthOptInTests {
    private let targets = try! decode(ServerHealthReport.self, healthJSON).targets

    @Test("A picker that is not opted in shows no note, whatever Sylo cannot do")
    func notOptedIn() {
        // An access role, a staff role or an ignore list: Sylo does not give it, so it must not say "move Sylo's role".
        #expect(targets.notes(for: .role("200"), optedIn: false).isEmpty)
        #expect(targets.notes(for: .channel("300", embed: true), optedIn: false).isEmpty)
        #expect(targets.notes(for: .roles(["200", "201"], names: ["200": "Admins"]), optedIn: false).isEmpty)
        #expect(targets.notes(for: .channels(["300"], names: [:], embed: false), optedIn: false).isEmpty)
    }

    @Test("A role Sylo cannot give shows no note on a picker that is not opted in, even when Sylo lacks Manage Roles")
    func manageRolesMissing() throws {
        let none = try decode(HealthTargets.self, #"{"roles":{"blockedAll":"Sylo can't give roles: it is missing Manage Roles.","blocked":{}}}"#)
        #expect(none.notes(for: .role("5"), optedIn: false).isEmpty)
        #expect(none.notes(for: .role("5"), optedIn: true) == ["Sylo can't give roles: it is missing Manage Roles."])
    }

    @Test("An opted-in picker gets the same notes as before")
    func optedIn() {
        #expect(targets.notes(for: .role("200"), optedIn: true).count == 1)
        #expect(targets.notes(for: .channel("300", embed: false), optedIn: true).count == 1)
        #expect(targets.notes(for: .channel("301", embed: false), optedIn: true).isEmpty)
        #expect(targets.notes(for: .channel("301", embed: true), optedIn: true).count == 1)
        #expect(targets.notes(for: .roles(["200", "999"], names: ["200": "Verified"]), optedIn: true).count == 1)
    }
}
