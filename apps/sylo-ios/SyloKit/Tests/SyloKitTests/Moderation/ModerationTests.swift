import Foundation
import Testing
@testable import SyloKit

@Suite("Moderation hub")
struct ModerationDecodingTests {
    /// `GET /moderation` as src/web/routes/v2Staff.js sends it.
    static let overviewJSON = #"""
    {
      "cases": [
        {"caseNumber": 12, "action": "warn", "active": true, "user": "Alex", "userId": "810000000000000001",
         "moderator": "Dashboard", "reason": "Spam", "detail": "", "ago": "3m ago", "at": 1794000000000},
        {"caseNumber": 11, "action": "ban", "active": false, "user": "810000000000000002",
         "userId": "810000000000000002", "moderator": "AutoMod", "reason": "", "detail": "7d", "ago": "1d ago",
         "at": 1793900000000}
      ],
      "caseTotal": 340,
      "bans": [{"id": "820000000000000001", "tag": "troll#0", "reason": "Raid"},
               {"id": "820000000000000002", "tag": "bot#0", "reason": "—"}],
      "bansTotal": 2, "bansError": null, "banLimit": 200,
      "channelLocks": [
        {"channelId": "830000000000000001", "name": "general", "lockedBy": "Mod", "lockdown": true,
         "ago": "1m ago", "at": 1794000000000},
        {"channelId": "830000000000000002", "name": null, "lockedBy": "Dashboard", "lockdown": false,
         "ago": "1h ago", "at": 1793990000000}
      ],
      "tempBans": [{"userId": "840000000000000001", "tag": "Sam#0", "reason": "Flood", "remaining": "3 hours"}],
      "lockdownActive": true
    }
    """#

    @Test("the overview decodes cases, bans, locks and scheduled unbans")
    func decodesOverview() throws {
        let overview = try JSONDecoder().decode(ModerationOverview.self, from: Data(Self.overviewJSON.utf8))
        #expect(overview.caseTotal == 340)
        #expect(overview.cases.map(\.caseNumber) == [12, 11])
        let warn = overview.cases[0]
        #expect(warn.action == "warn")
        #expect(warn.active)
        #expect(warn.memberName == "Alex")
        #expect(warn.moderator == "Dashboard")
        #expect(warn.date == Date(timeIntervalSince1970: 1_794_000_000))
        let ban = overview.cases[1]
        #expect(!ban.active)
        #expect(ban.reason.isEmpty)
        #expect(ban.detail == "7d")
        #expect(overview.bans.map(\.name) == ["troll#0", "bot#0"])
        #expect(overview.bans[0].reason == "Raid")
        // The server's dash for "no reason" is not shown as a reason.
        #expect(overview.bans[1].reason.isEmpty)
        #expect(overview.bansError == nil)
        #expect(overview.banLimit == 200)
        #expect(overview.lockdownActive)
        #expect(overview.channelLocks.map(\.channelId) == ["830000000000000001", "830000000000000002"])
        #expect(overview.channelLocks[0].name == "general")
        #expect(overview.channelLocks[0].lockdown)
        #expect(overview.channelLocks[1].name == nil)
        #expect(overview.tempBans == [
            ModerationTempBan(userId: "840000000000000001", tag: "Sam#0", reason: "Flood", remaining: "3 hours"),
        ])
    }

    @Test("a missing bot permission comes as the server's words in bansError, and the bans are empty")
    func bansError() throws {
        let json = #"""
        {"cases": [], "caseTotal": 0, "bans": [], "bansTotal": 0,
         "bansError": "The bot is missing the \"Ban Members\" permission in this server.",
         "banLimit": 200, "channelLocks": [], "tempBans": [], "lockdownActive": false}
        """#
        let overview = try JSONDecoder().decode(ModerationOverview.self, from: Data(json.utf8))
        #expect(overview.bansError == "The bot is missing the \"Ban Members\" permission in this server.")
        #expect(overview.bans.isEmpty)
        #expect(!overview.lockdownActive)
    }

    @Test("an empty answer reads, a broken entry is dropped, and the lockdown is worked out when not sent")
    func lenient() throws {
        let empty = try JSONDecoder().decode(ModerationOverview.self, from: Data("{}".utf8))
        #expect(empty.cases.isEmpty)
        #expect(empty.caseTotal == 0)
        #expect(empty.banLimit == 200)
        #expect(!empty.lockdownActive)

        let odd = try JSONDecoder().decode(ModerationOverview.self, from: Data(#"""
        {"cases": [{"action": "warn"}, {"caseNumber": 3, "action": "future-action", "extra": 1}],
         "channelLocks": [{"channelId": "1", "lockdown": true}, {"name": "x"}], "someNewKey": true}
        """#.utf8))
        #expect(odd.cases.map(\.caseNumber) == [3])
        #expect(odd.cases[0].action == "future-action")
        #expect(odd.cases[0].active)
        #expect(odd.channelLocks.map(\.channelId) == ["1"])
        #expect(odd.lockdownActive)
    }

    @Test("the warn answer carries the count and whether the DM went out")
    func warnResult() throws {
        let result = try JSONDecoder().decode(
            WarnResult.self, from: Data(#"{"ok": true, "warnings": 3, "dmDelivered": false, "logged": true}"#.utf8))
        #expect(result == WarnResult(warnings: 3, dmDelivered: false, logged: true))
        let old = try JSONDecoder().decode(WarnResult.self, from: Data(#"{"ok": true, "warnings": 1}"#.utf8))
        #expect(old.dmDelivered)
    }

    @Test("the small answers decode: cleared, locked, unlocked and case active")
    func smallAnswers() throws {
        #expect(try JSONDecoder().decode(ClearWarningsResult.self, from: Data(#"{"ok":true,"removed":4}"#.utf8)).removed == 4)
        #expect(try JSONDecoder().decode(LockAllResult.self, from: Data(#"{"ok":true,"locked":12}"#.utf8)).locked == 12)
        #expect(try JSONDecoder().decode(UnlockAllResult.self, from: Data(#"{"ok":true,"unlocked":9}"#.utf8)).unlocked == 9)
        #expect(!(try JSONDecoder().decode(CaseActiveResult.self, from: Data(#"{"ok":true,"active":false}"#.utf8)).active))
    }
}

@Suite("Moderation endpoints")
struct ModerationEndpointsTests {
    let fluxer: ServerID = "fluxer:1"

    private func sent<E: APIEndpoint>(_ endpoint: E) throws -> [String: Any] {
        let body = try #require(endpoint.body)
        return try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
    }

    @Test("the overview is a GET")
    func load() {
        let e = Endpoints.LoadModeration(server: fluxer)
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/moderation")
        #expect(e.method == .get)
        #expect(e.body == nil)
        #expect(e.requiresAuth)
    }

    @Test("unban, unlock and clear post the key the server reads")
    func idCalls() throws {
        let unban = Endpoints.UnbanMember(server: fluxer, userId: "820000000000000001")
        #expect(unban.path == "/api/v2/guilds/fluxer%3A1/moderation/unban")
        #expect(unban.method == .post)
        #expect(try sent(unban) as? [String: String] == ["userId": "820000000000000001"])

        let unlock = Endpoints.UnlockChannel(server: "1", channelId: "830000000000000001")
        #expect(unlock.path == "/api/v2/guilds/1/moderation/unlock-channel")
        #expect(unlock.method == .post)
        #expect(try sent(unlock) as? [String: String] == ["channelId": "830000000000000001"])

        let clear = Endpoints.ClearWarnings(server: "1", userId: "810000000000000001")
        #expect(clear.path == "/api/v2/guilds/1/moderation/warnings/clear")
        #expect(clear.method == .post)
        #expect(try sent(clear) as? [String: String] == ["userId": "810000000000000001"])
    }

    @Test("a warning posts the member and the reason")
    func warn() throws {
        let e = Endpoints.WarnMember(server: fluxer, userId: "810000000000000001", reason: "Spam")
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/moderation/warn")
        #expect(e.method == .post)
        #expect(e.requiresAuth)
        #expect(try sent(e) as? [String: String] == ["userId": "810000000000000001", "reason": "Spam"])
    }

    @Test("lock all and unlock all post an empty object, like the dashboard")
    func lockdown() throws {
        let lock = Endpoints.LockAllChannels(server: "1")
        #expect(lock.path == "/api/v2/guilds/1/moderation/lock-all")
        #expect(lock.method == .post)
        #expect(try sent(lock).isEmpty)
        let unlock = Endpoints.UnlockAllChannels(server: "1")
        #expect(unlock.path == "/api/v2/guilds/1/moderation/unlock-all")
        #expect(unlock.method == .post)
        #expect(try sent(unlock).isEmpty)
    }

    @Test("a case reason is a POST with the reason; delete and restore pick the path")
    func cases() throws {
        let reason = Endpoints.EditCaseReason(server: "1", caseNumber: 12, reason: "Spam, again")
        #expect(reason.path == "/api/v2/guilds/1/moderation/cases/12/reason")
        #expect(reason.method == .post)
        #expect(try sent(reason) as? [String: String] == ["reason": "Spam, again"])

        let delete = Endpoints.SetCaseActive(server: "1", caseNumber: 12, active: false)
        #expect(delete.path == "/api/v2/guilds/1/moderation/cases/12/delete")
        #expect(delete.method == .post)
        #expect(try sent(delete).isEmpty)
        let restore = Endpoints.SetCaseActive(server: "1", caseNumber: 12, active: true)
        #expect(restore.path == "/api/v2/guilds/1/moderation/cases/12/restore")
    }
}

@MainActor
@Suite("Moderation model")
struct ModerationModelTests {
    nonisolated static let alex = MemberChoice(id: "810000000000000001", name: "Alex")

    /// Answers every call; remembers nothing, so tests read `clients.calls`.
    private func clients(
        overview: ModerationOverview = ModerationOverview(cases: [ModerationCase(caseNumber: 12, reason: "Spam")])
    ) -> StubClients {
        StubClients { endpoint in
            switch endpoint {
            case is Endpoints.LoadModeration: return overview
            case is Endpoints.WarnMember: return WarnResult(warnings: 2, dmDelivered: true)
            case is Endpoints.ClearWarnings: return ClearWarningsResult(removed: 1)
            case is Endpoints.UnbanMember: return OKResponse()
            case is Endpoints.LockAllChannels: return LockAllResult(locked: 5)
            case is Endpoints.UnlockAllChannels: return UnlockAllResult(unlocked: 1)
            case is Endpoints.UnlockChannel: return OKResponse()
            case is Endpoints.EditCaseReason: return OKResponse()
            case let call as Endpoints.SetCaseActive: return CaseActiveResult(active: call.active)
            default: throw NetworkError.notFound
            }
        }
    }

    @Test("loading keeps the lists, and a failed refresh explains and keeps them")
    func loads() async {
        let stub = clients()
        let model = ModerationModel(server: "9", session: makeSignedInSession(clients: stub))
        #expect(!model.hasLoaded)
        await model.load()
        #expect(model.hasLoaded)
        #expect(model.moderationCase(12)?.reason == "Spam")
        #expect(model.moderationCase(99) == nil)
        stub.setHandler { _ in throw NetworkError.forbidden(message: "You need Manage Server.") }
        await model.load()
        #expect(model.overview?.cases.count == 1)
        #expect(model.errorMessage == "You need Manage Server.")
    }

    @Test("a warning trims and cuts the reason, says how many warnings there are, and reloads")
    func warns() async throws {
        let stub = clients()
        let model = ModerationModel(server: "9", session: makeSignedInSession(clients: stub))
        let long = "  " + String(repeating: "x", count: 450) + "  "
        let ok = await model.warn(Self.alex, reason: long)
        #expect(ok)
        #expect(model.notice == "Warned. They now have 2 warnings.")
        #expect(model.actionCount == 1)
        #expect(model.hasLoaded)
        let call = try #require(stub.calls.first?.endpoint as? Endpoints.WarnMember)
        #expect(call.userId == Self.alex.id)
        #expect(call.reason.count == 400)
        #expect(stub.calls.last?.endpoint is Endpoints.LoadModeration)
    }

    @Test("a warning without a reason sends nothing")
    func warnNeedsReason() async {
        let stub = clients()
        let model = ModerationModel(server: "9", session: makeSignedInSession(clients: stub))
        let ok = await model.warn(Self.alex, reason: " \n ")
        #expect(!ok)
        #expect(stub.calls.isEmpty)
    }

    @Test("a warning the member could not be told about says so")
    func warnWithoutDM() async {
        let stub = StubClients { endpoint in
            if endpoint is Endpoints.WarnMember { return WarnResult(warnings: 1, dmDelivered: false) }
            return ModerationOverview()
        }
        let model = ModerationModel(server: "9", session: makeSignedInSession(clients: stub))
        await model.warn(Self.alex, reason: "Spam")
        #expect(model.notice == "Warned. They now have 1 warning. They could not be sent a DM.")
    }

    @Test("the server's refusal is shown as it came, and nothing counts as done")
    func refusal() async {
        let stub = StubClients { endpoint in
            if endpoint is Endpoints.WarnMember {
                throw NetworkError.forbidden(message: "You can't warn someone with a higher role than yours.")
            }
            return ModerationOverview()
        }
        let model = ModerationModel(server: "9", session: makeSignedInSession(clients: stub))
        let ok = await model.warn(Self.alex, reason: "Spam")
        #expect(!ok)
        #expect(model.actionError == "You can't warn someone with a higher role than yours.")
        #expect(model.notice == nil)
        #expect(model.actionCount == 0)
    }

    @Test("a 404 reloads the lists, so a ban that is already gone disappears")
    func notFoundReloads() async {
        let stub = StubClients { endpoint in
            if endpoint is Endpoints.UnbanMember { throw NetworkError.notFound(message: "That user is not banned.") }
            return ModerationOverview(bans: [])
        }
        let model = ModerationModel(server: "9", session: makeSignedInSession(clients: stub))
        let ok = await model.unban(userId: "820000000000000001", name: "troll")
        #expect(!ok)
        #expect(model.actionError == "That user is not banned.")
        #expect(model.hasLoaded)
        #expect(stub.calls.last?.endpoint is Endpoints.LoadModeration)
    }

    @Test("unban, lockdown and unlock word their outcome")
    func outcomes() async throws {
        let stub = clients()
        let model = ModerationModel(server: "9", session: makeSignedInSession(clients: stub))
        #expect(await model.unban(userId: "820000000000000001", name: "troll#0"))
        #expect(model.notice == "troll#0 unbanned.")
        #expect(await model.lockAllChannels())
        #expect(model.notice == "Locked 5 channels.")
        #expect(await model.endLockdown())
        #expect(model.notice == "Unlocked 1 channel.")
        let lock = ChannelLock(channelId: "830000000000000001", name: "general")
        #expect(await model.unlockChannel(lock))
        #expect(model.notice == "Channel unlocked.")
        let unlock = try #require(stub.calls.compactMap { $0.endpoint as? Endpoints.UnlockChannel }.first)
        #expect(unlock.channelId == "830000000000000001")
        #expect(await model.clearWarnings(of: Self.alex))
        #expect(model.notice == "Removed 1 warning.")
    }

    @Test("a case reason is required and cut at 1000 characters; delete and restore name the case")
    func caseActions() async throws {
        let stub = clients()
        let model = ModerationModel(server: "9", session: makeSignedInSession(clients: stub))
        await model.load()
        let moderationCase = try #require(model.moderationCase(12))

        #expect(await model.editReason(of: moderationCase, to: "   ") == false)
        #expect(stub.calls.compactMap { $0.endpoint as? Endpoints.EditCaseReason }.isEmpty)

        #expect(await model.editReason(of: moderationCase, to: String(repeating: "y", count: 1200)))
        let edit = try #require(stub.calls.compactMap { $0.endpoint as? Endpoints.EditCaseReason }.first)
        #expect(edit.reason.count == 1000)
        #expect(edit.caseNumber == 12)
        #expect(model.notice == "Reason updated.")

        #expect(await model.setActive(false, for: moderationCase))
        #expect(model.notice == "Case #12 deleted.")
        #expect(await model.setActive(true, for: moderationCase))
        #expect(model.notice == "Case #12 restored.")
        let paths = stub.calls.compactMap { ($0.endpoint as? Endpoints.SetCaseActive)?.path }
        #expect(paths == ["/api/v2/guilds/9/moderation/cases/12/delete", "/api/v2/guilds/9/moderation/cases/12/restore"])
    }

    @Test("an expired token signs out and shows nothing")
    func unauthorized() async {
        let stub = StubClients { _ in throw NetworkError.unauthorized }
        let model = ModerationModel(server: "9", session: makeSignedInSession(clients: stub))
        #expect(await model.lockAllChannels() == false)
        #expect(model.actionError == nil)
    }
}
