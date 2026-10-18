import Foundation
import Testing
@testable import SyloKit

/// Health and the dev log for Sylo's operators: what the server sends, the deep link of a dev-log
/// notification, and the models behind the Health page and the dev-log notification setting.
@Suite("Health and dev log")
struct HealthDecodingTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    @Test("The account says whether this person is an operator; missing means no")
    func accountOperator() throws {
        #expect(try decode(AccountInfo.self, #"{"open":false,"operator":true,"platforms":[],"devices":[]}"#).isOperator)
        #expect(try !decode(AccountInfo.self, #"{"platforms":[],"devices":[]}"#).isOperator)
    }

    @Test("Push settings carry the dev-log level for an operator only")
    func pushDevLog() throws {
        let op = try decode(PushSettingsInfo.self, #"{"enabled":true,"mutedServers":[],"devLog":"warnings"}"#)
        #expect(op.devLog == .warnings)
        #expect(try decode(PushSettingsInfo.self, #"{"enabled":true}"#).devLog == nil)
        #expect(try decode(PushSettingsInfo.self, #"{"enabled":true,"devLog":"loud"}"#).devLog == nil)
    }

    @Test("A health report reads, and missing parts stay empty")
    func healthReport() throws {
        let json = #"""
            {"ready":true,"botTag":"Sylo#0001","version":"4.4.0","uptime":"2d 3h","guildCount":12,
             "memberReach":3400,"gatewayPing":42,"pingHistory":[40,42],
             "stats":{"openTickets":3,"ticketsTotal":40,"warningsWeek":2,"warningsTotal":9},
             "modules":[{"name":"Tickets","guilds":5}],
             "db":{"size":"12 MB","wal":"1 MB","postgres":false,"intervalHours":24,"retention":7,"offsite":"WebDAV"},
             "backups":[{"name":"sylo-1.db","size":"12 MB","ago":"3h ago"}],
             "devLogConfigured":false}
            """#
        let report = try decode(HealthReport.self, json)
        #expect(report.isReady)
        #expect(report.version == "4.4.0")
        #expect(report.serverCount == 12)
        #expect(report.gatewayPing == 42)
        #expect(report.openTickets == 3)
        #expect(report.modules == [HealthReport.ModuleUse(name: "Tickets", servers: 5)])
        #expect(report.database?.size == "12 MB")
        #expect(report.database?.offsite == "WebDAV")
        #expect(report.backups.first?.name == "sylo-1.db")
        #expect(!report.isDevLogChannelSet)

        let bare = try decode(HealthReport.self, #"{"ready":false}"#)
        #expect(!bare.isReady)
        #expect(bare.modules.isEmpty)
        #expect(bare.gatewayPing == nil)
    }

    @Test("Dev-log entries read with their time")
    func devLogEntries() throws {
        let page = try decode(
            DevLogPage.self,
            #"{"entries":[{"id":7,"level":"error","scope":"db","message":"gone","at":1700000000000},{"id":6,"level":"warn","scope":"push","message":"slow","at":1699999999000}]}"#)
        #expect(page.entries.count == 2)
        #expect(page.entries[0].level == .error)
        #expect(page.entries[1].level == .warning)
        #expect(page.entries[0].date == Date(timeIntervalSince1970: 1_700_000_000))
    }

    @Test("The dev-log calls go where the server expects")
    func endpoints() throws {
        #expect(Endpoints.Health().path == "/api/v2/health")
        let errors = Endpoints.DevLog(errorsOnly: true)
        #expect(errors.path == "/api/v2/dev-log")
        #expect(errors.query.contains(URLQueryItem(name: "level", value: "error")))
        #expect(!Endpoints.DevLog(errorsOnly: false).query.contains { $0.name == "level" })
        #expect(Endpoints.SendDevLogTest().method == .post)
        let set = Endpoints.SetDevLogNotifications(level: .off)
        #expect(set.path == "/api/mobile/push/dev-log")
        #expect(set.method == .put)
        let body = try JSONDecoder().decode([String: String].self, from: JSONEncoder().encode(Encoded(set.body)))
        #expect(body == ["level": "off"])
    }

    @Test("A dev-log notification names its Sylo server and level; a ticket one is not one")
    func notification() throws {
        let info: [AnyHashable: Any] = ["sylo": ["kind": "devlog", "server": "https://sylo.example.com", "level": "warn"]]
        let note = try #require(DevLogNotification(userInfo: info))
        #expect(note.server == (try ServerURL("https://sylo.example.com")))
        #expect(note.level == .warning)
        let ticket: [AnyHashable: Any] = ["sylo": ["kind": "ticket", "server": "https://sylo.example.com"]]
        #expect(DevLogNotification(userInfo: ticket) == nil)
    }
}

/// Encodes whatever `any Encodable` an endpoint body is.
private struct Encoded: Encodable {
    let value: (any Encodable)?
    init(_ value: (any Encodable)?) { self.value = value }
    func encode(to encoder: any Encoder) throws { try value?.encode(to: encoder) }
}

@MainActor
@Suite("Health model")
struct HealthModelTests {
    nonisolated static let report = HealthReport(isReady: true, version: "4.4.0", serverCount: 3)
    nonisolated static let all = DevLogPage(entries: [
        DevLogEntry(id: 2, level: .warning, scope: "push", message: "slow", date: Date(timeIntervalSince1970: 2)),
        DevLogEntry(id: 1, level: .error, scope: "db", message: "gone", date: Date(timeIntervalSince1970: 1)),
    ])

    static func clients(test: @escaping @Sendable () throws -> DevLogTestResult = { DevLogTestResult(ok: true) }) -> StubClients {
        StubClients { endpoint in
            switch endpoint {
            case is Endpoints.Health: return report
            case let log as Endpoints.DevLog:
                return log.errorsOnly ? DevLogPage(entries: all.entries.filter { $0.level == .error }) : all
            case is Endpoints.SendDevLogTest: return try test()
            default: throw NetworkError.notFound
            }
        }
    }

    @Test("Loading fetches the report and the whole log")
    func loads() async {
        let model = HealthModel(session: makeSignedInSession(clients: Self.clients()))
        await model.load()
        #expect(model.report == Self.report)
        #expect(model.entries.map(\.id) == [2, 1])
        #expect(model.errorMessage == nil)
    }

    @Test("Errors only asks the server for errors")
    func errorsOnly() async {
        let model = HealthModel(session: makeSignedInSession(clients: Self.clients()))
        model.errorsOnly = true
        await model.loadLog()
        #expect(model.entries.map(\.id) == [1])
    }

    @Test("Sending a test reports the server's reason when it fails")
    func sendTest() async {
        let ok = HealthModel(session: makeSignedInSession(clients: Self.clients()))
        await ok.sendTest()
        #expect(ok.testResult == .sent)
        let failing = HealthModel(session: makeSignedInSession(clients: Self.clients {
            DevLogTestResult(ok: false, error: "DEV_LOG_CHANNEL_ID is not set.")
        }))
        await failing.sendTest()
        #expect(failing.testResult == .failed("DEV_LOG_CHANNEL_ID is not set."))
    }

    @Test("A person who is not an operator gets a plain message, not a crash")
    func forbidden() async {
        let clients = StubClients { _ in throw NetworkError.forbidden }
        let model = HealthModel(session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.report == nil)
        #expect(model.errorMessage != nil)
    }
}

@MainActor
@Suite("Dev-log notification setting")
struct DevLogSettingTests {
    @Test("Choosing a level sends it, and goes back when the server refuses")
    func setsLevel() async {
        let refuse = LockedFlag()
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.ServerInfo: return ServerInfo(features: [.appLogin, .liveAccess, .push])
            case is Endpoints.PushSettings:
                return PushSettingsInfo(isEnabled: true, mutedServers: [], devLog: .errors)
            case let set as Endpoints.SetDevLogNotifications:
                if refuse.value { throw NetworkError.forbidden }
                return DevLogSettingResult(devLog: set.level)
            default: throw NetworkError.notFound
            }
        }
        let model = NotificationSettingsModel(session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.devLog == .errors)
        await model.setDevLog(.warnings)
        #expect(model.devLog == .warnings)
        refuse.value = true
        await model.setDevLog(.off)
        #expect(model.devLog == .warnings)
        #expect(model.errorMessage != nil)
    }
}

/// A Bool a @Sendable stub can read while a test flips it.
final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    var value: Bool {
        get { lock.withLock { flag } }
        set { lock.withLock { flag = newValue } }
    }
}
