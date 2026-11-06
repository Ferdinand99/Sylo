import Foundation
import Testing
@testable import SyloKit

/// The ban appeals (`src/web/routes/v2Staff.js`, `/appeals` and `/appeals/:id/decide`).
@Suite("Appeals")
struct AppealsTests {
    /// `GET /api/v2/guilds/:id/appeals`, shaped like the server sends it.
    static let pageJSON = #"""
    {"appeals": [
       {"id": 12, "user": "ada#0001", "userId": "111111111111111111", "banReason": "Spam",
        "answers": [{"q": "Why were you banned?", "a": "I posted links."}, {"q": "Why unban you?", "a": ""}],
        "status": "open", "decidedBy": null, "decisionReason": null, "ago": "2h ago", "decidedAgo": null,
        "at": 1730000000000, "decidedAt": null},
       {"id": 9, "user": "grace", "userId": "222222222222222222", "banReason": "—", "answers": [],
        "status": "denied", "decidedBy": "Alex (dashboard)", "decisionReason": "Not this time.", "ago": "3d ago",
        "decidedAgo": "2d ago", "at": 1729000000000, "decidedAt": 1729100000000}
     ],
     "open": 1, "moduleEnabled": true, "configured": false}
    """#

    @Test("the page decodes open and decided appeals with their answers")
    func decodes() throws {
        let page = try JSONDecoder().decode(AppealsInboxPage.self, from: Data(Self.pageJSON.utf8))
        #expect(page.appeals.count == 2)
        #expect(page.open == 1)
        #expect(page.moduleEnabled)
        #expect(!page.configured)
        let open = try #require(page.appeal(id: 12))
        #expect(open.user == "ada#0001")
        #expect(open.status == .open)
        #expect(open.originalBanReason == "Spam")
        #expect(open.answers.count == 2)
        #expect(open.answers[0].question == "Why were you banned?")
        #expect(open.answers[0].answer == "I posted links.")
        #expect(open.answers[1].answer == "")
        #expect(open.submittedAt == Date(timeIntervalSince1970: 1_730_000_000))
        #expect(open.decidedAt == nil)
        let denied = try #require(page.appeal(id: 9))
        #expect(denied.status == .denied)
        #expect(denied.originalBanReason == nil)
        #expect(denied.decidedBy == "Alex (dashboard)")
        #expect(denied.decisionReason == "Not this time.")
        #expect(denied.decidedAt == Date(timeIntervalSince1970: 1_729_100_000))
        #expect(page.openAppeals.map(\.id) == [12])
        #expect(page.decidedAppeals.map(\.id) == [9])
    }

    @Test("an unknown status is kept, not an error")
    func unknownStatus() throws {
        let json = #"{"appeals": [{"id": 1, "user": "x", "status": "withdrawn", "answers": []}]}"#
        let page = try JSONDecoder().decode(AppealsInboxPage.self, from: Data(json.utf8))
        #expect(page.appeals[0].status == .other("withdrawn"))
        #expect(page.open == 0)
    }

    @Test("deciding posts the decision and the note to the appeal's path")
    func encodes() throws {
        let accept = Endpoints.DecideAppeal(server: "1", id: 12, decision: .accept, reason: "Welcome back")
        #expect(accept.path == "/api/v2/guilds/1/appeals/12/decide")
        #expect(accept.method == .post)
        let body = try bodyObject(accept)
        #expect(Set(body.keys) == ["decision", "reason"])
        #expect(body["decision"] as? String == "accept")
        #expect(body["reason"] as? String == "Welcome back")
        let deny = try bodyObject(Endpoints.DecideAppeal(server: "fluxer:9", id: 3, decision: .deny, reason: ""))
        #expect(deny["decision"] as? String == "deny")
        #expect(Endpoints.DecideAppeal(server: "fluxer:9", id: 3, decision: .deny, reason: "").path
            == "/api/v2/guilds/fluxer%3A9/appeals/3/decide")
        let long = try bodyObject(
            Endpoints.DecideAppeal(server: "1", id: 1, decision: .deny, reason: String(repeating: "a", count: 1500)))
        #expect((long["reason"] as? String)?.count == 1000)
        #expect(Endpoints.Appeals(server: "1").path == "/api/v2/guilds/1/appeals")
    }

    @Test("the answer says what to tell staff")
    func result() throws {
        let ok = try JSONDecoder().decode(
            AppealDecisionResult.self, from: Data(#"{"ok": true, "status": "accepted", "dmDelivered": true, "unbanned": true}"#.utf8))
        #expect(ok.status == .accepted)
        #expect(ok.summary == "Appeal accepted.")
        #expect(!ok.needsAttention)
        let stuck = try JSONDecoder().decode(
            AppealDecisionResult.self, from: Data(#"{"ok": true, "status": "accepted", "dmDelivered": false, "unbanned": false}"#.utf8))
        #expect(stuck.summary == "Appeal accepted. The ban could not be lifted. Unban them manually. The member could not be sent a DM.")
        #expect(stuck.needsAttention)
        let denied = AppealDecisionResult(status: .denied, dmDelivered: true, unbanned: false)
        #expect(denied.summary == "Appeal denied.")
        #expect(!denied.needsAttention)
    }

    @MainActor
    @Test("deciding reloads the list and counts as a module change")
    func decide() async throws {
        let page = try JSONDecoder().decode(AppealsInboxPage.self, from: Data(Self.pageJSON.utf8))
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.DecideAppeal { return AppealDecisionResult(status: .accepted, dmDelivered: true, unbanned: true) }
            return page
        }
        let session = makeSignedInSession(clients: clients)
        let model = RecordListModel<AppealsInboxPage>(appeals: "1", session: session)
        await model.load()
        let before = session.modulesRevision
        let result = await model.decide(try #require(page.appeal(id: 12)), .accept, reason: "ok")
        #expect(result?.status == .accepted)
        #expect(clients.calls.count == 3)
        #expect(session.modulesRevision == before + 1)
        #expect(model.changeCount == 1)
    }

    @MainActor
    @Test("an appeal someone else decided (409) shows a clear reason and loads the list again")
    func alreadyDecided() async throws {
        let page = try JSONDecoder().decode(AppealsInboxPage.self, from: Data(Self.pageJSON.utf8))
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.DecideAppeal { throw NetworkError.http(status: 409) }
            return page
        }
        let model = RecordListModel<AppealsInboxPage>(appeals: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        let result = await model.decide(try #require(page.appeal(id: 12)), .deny, reason: "")
        #expect(result == nil)
        #expect(model.actionError == "This appeal has already been decided.")
        #expect(clients.calls.count == 3)
        #expect(model.changeCount == 0)
    }
}

/// The moderation hub (`/moderation`, `/moderation/warn` ...).
@Suite("Moderation hub")
struct ModerationHubTests {
    static let pageJSON = #"""
    {"cases": [
       {"caseNumber": 7, "action": "warn", "active": true, "user": "ada#0001", "userId": "111111111111111111",
        "moderator": "Dashboard", "reason": "Spam", "detail": null, "ago": "1h ago", "at": 1730000000000},
       {"caseNumber": 6, "action": "ban", "active": false, "user": "grace", "userId": "222222222222222222",
        "moderator": "AutoMod", "reason": null, "detail": "7 days", "ago": "2d ago", "at": 1729000000000}
     ],
     "caseTotal": 250,
     "bans": [{"id": "333333333333333333", "tag": "eve#0001", "reason": "Raid"}],
     "bansTotal": 1, "bansError": null, "banLimit": 200,
     "channelLocks": [{"channelId": "444444444444444444", "name": "general", "lockedBy": "Alex (dashboard)",
                       "lockdown": true, "ago": "5m ago", "at": 1730000000000}],
     "tempBans": [{"userId": "555555555555555555", "tag": "mallory", "reason": "Cooling off", "remaining": "2h 5m"}],
     "lockdownActive": true}
    """#

    @Test("the page decodes cases, bans, temporary bans and locks")
    func decodes() throws {
        let page = try JSONDecoder().decode(ModerationHubPage.self, from: Data(Self.pageJSON.utf8))
        #expect(page.cases.map(\.caseNumber) == [7, 6])
        #expect(page.cases[0].isActive)
        #expect(page.cases[0].reason == "Spam")
        #expect(page.cases[0].detail == "")
        #expect(page.cases[0].at == Date(timeIntervalSince1970: 1_730_000_000))
        #expect(!page.cases[1].isActive)
        #expect(page.cases[1].reason == "")
        #expect(page.cases[1].detail == "7 days")
        #expect(page.caseTotal == 250)
        #expect(page.bans == [BannedMember(id: "333333333333333333", tag: "eve#0001", reason: "Raid")])
        #expect(page.bansError == nil)
        #expect(page.tempBans.first?.remaining == "2h 5m")
        #expect(page.channelLocks.first?.name == "general")
        #expect(page.channelLocks.first?.isLockdown == true)
        #expect(page.lockdownActive)
    }

    @Test("a missing ban permission arrives as the ban list's error")
    func bansError() throws {
        let json = #"{"cases": [], "caseTotal": 0, "bans": [], "bansTotal": 0, "bansError": "The bot is missing the Ban Members permission in this server.", "banLimit": 200, "channelLocks": [], "tempBans": [], "lockdownActive": false}"#
        let page = try JSONDecoder().decode(ModerationHubPage.self, from: Data(json.utf8))
        #expect(page.bansError == "The bot is missing the Ban Members permission in this server.")
        #expect(page.bans.isEmpty)
        #expect(!page.lockdownActive)
    }

    @Test("every call uses the dashboard's path and body")
    func endpoints() throws {
        #expect(Endpoints.Moderation(server: "1").path == "/api/v2/guilds/1/moderation")
        let unban = Endpoints.Unban(server: "1", userId: "333333333333333333")
        #expect(unban.path == "/api/v2/guilds/1/moderation/unban")
        #expect(try bodyObject(unban)["userId"] as? String == "333333333333333333")
        #expect(Endpoints.LockAllChannels(server: "1").path == "/api/v2/guilds/1/moderation/lock-all")
        #expect(Endpoints.UnlockAllChannels(server: "1").path == "/api/v2/guilds/1/moderation/unlock-all")
        let unlock = Endpoints.UnlockChannel(server: "1", channelId: "444444444444444444")
        #expect(unlock.path == "/api/v2/guilds/1/moderation/unlock-channel")
        #expect(try bodyObject(unlock)["channelId"] as? String == "444444444444444444")
        let warn = Endpoints.WarnMember(server: "1", userId: "111111111111111111", reason: "Spam")
        #expect(warn.path == "/api/v2/guilds/1/moderation/warn")
        let body = try bodyObject(warn)
        #expect(Set(body.keys) == ["userId", "reason"])
        #expect(body["reason"] as? String == "Spam")
        #expect(Endpoints.ClearWarnings(server: "1", userId: "1").path == "/api/v2/guilds/1/moderation/warnings/clear")
        let reason = Endpoints.EditCaseReason(server: "1", caseNumber: 7, reason: "Better")
        #expect(reason.path == "/api/v2/guilds/1/moderation/cases/7/reason")
        #expect(try bodyObject(reason)["reason"] as? String == "Better")
        #expect(Endpoints.SetCaseDeleted(server: "1", caseNumber: 7, isDeleted: true).path
            == "/api/v2/guilds/1/moderation/cases/7/delete")
        #expect(Endpoints.SetCaseDeleted(server: "1", caseNumber: 7, isDeleted: false).path
            == "/api/v2/guilds/1/moderation/cases/7/restore")
    }

    @Test("a user is an id of 17 to 20 digits or a mention")
    func userReference() {
        #expect(ModerationInput.isUserReference("111111111111111111"))
        #expect(ModerationInput.isUserReference("<@111111111111111111>"))
        #expect(ModerationInput.isUserReference(" <@!111111111111111111> "))
        #expect(ModerationInput.userID(from: "<@!111111111111111111>") == "111111111111111111")
        #expect(!ModerationInput.isUserReference("1234"))
        #expect(!ModerationInput.isUserReference("ada"))
        #expect(!ModerationInput.isUserReference(""))
        #expect(!ModerationInput.isUserReference("<@abc>"))
    }

    @Test("the answers say what to tell staff")
    func results() throws {
        let warned = try JSONDecoder().decode(
            WarnResult.self, from: Data(#"{"ok": true, "warnings": 3, "dmDelivered": false, "logged": true}"#.utf8))
        #expect(warned.summary == "Warned. They now have 3 warnings. They could not be sent a DM.")
        #expect(WarnResult(warnings: 1, dmDelivered: true).summary == "Warned. They now have 1 warning.")
        #expect(try JSONDecoder().decode(CountResult.self, from: Data(#"{"ok": true, "removed": 4}"#.utf8)).count == 4)
        #expect(try JSONDecoder().decode(CountResult.self, from: Data(#"{"ok": true, "locked": 12}"#.utf8)).count == 12)
        #expect(try JSONDecoder().decode(CountResult.self, from: Data(#"{"ok": true, "unlocked": 2}"#.utf8)).count == 2)
    }

    @MainActor
    @Test("warning trims the reason, finds the id in a mention and reloads the page")
    func warn() async throws {
        let page = try JSONDecoder().decode(ModerationHubPage.self, from: Data(Self.pageJSON.utf8))
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.WarnMember { return WarnResult(warnings: 2, dmDelivered: true) }
            return page
        }
        let model = RecordListModel<ModerationHubPage>(moderation: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        let result = await model.warn(userId: "<@111111111111111111>", reason: "  spam  ")
        #expect(result?.warnings == 2)
        let sent = try #require(clients.calls.compactMap { $0.endpoint as? Endpoints.WarnMember }.first)
        #expect(sent.userId == "111111111111111111")
        #expect(sent.reason == "spam")
        #expect(clients.calls.count == 3)
    }

    @MainActor
    @Test("a refused change keeps the page and shows the server's sentence")
    func refused() async throws {
        let page = try JSONDecoder().decode(ModerationHubPage.self, from: Data(Self.pageJSON.utf8))
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.Unban { throw NetworkError.badRequest(message: "That is not a user ID or mention.") }
            return page
        }
        let model = RecordListModel<ModerationHubPage>(moderation: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(await model.unban(userId: "x") == false)
        #expect(model.actionError == "That is not a user ID or mention.")
        #expect(model.page == page)
    }
}

/// Commands, audit log, member data, leaderboard and export.
@Suite("Server tools")
struct ServerToolsTests {
    @Test("the commands page decodes limits and the save sends the dashboard's body")
    func commands() throws {
        let json = #"""
        {"commands": [
           {"name": "ban", "description": "Ban a member", "enabled": true, "allowedChannels": ["c1"], "allowedRoles": []},
           {"name": "stats", "description": "Game stats", "enabled": false, "allowedChannels": [], "allowedRoles": ["r1", "r2"]}],
         "channels": [{"id": "c1", "name": "mods"}], "roles": [{"id": "r1", "name": "Mod"}]}
        """#
        let page = try JSONDecoder().decode(CommandsPage.self, from: Data(json.utf8))
        #expect(page.commands.map(\.name) == ["ban", "stats"])
        #expect(page.commands[0].isLimited)
        #expect(!page.commands[1].isEnabled)
        #expect(page.commands(matching: "game").map(\.name) == ["stats"])
        #expect(page.commands(matching: "  ").count == 2)
        let save = Endpoints.SaveCommand(server: "fluxer:9", command: page.commands[1])
        #expect(save.path == "/api/v2/guilds/fluxer%3A9/commands/stats")
        let body = try bodyObject(save)
        #expect(Set(body.keys) == ["enabled", "channels", "roles"])
        #expect(body["enabled"] as? Bool == false)
        #expect(body["roles"] as? [String] == ["r1", "r2"])
        #expect(body["channels"] as? [String] == [])
        let saved = try JSONDecoder().decode(
            SavedCommand.self,
            from: Data(#"{"ok": true, "command": {"name": "stats", "enabled": true, "allowedChannels": [], "allowedRoles": []}}"#.utf8))
        #expect(saved.command.isEnabled)
    }

    @Test("audit entries get readable names like the dashboard's")
    func audit() throws {
        let json = #"{"kept": 500, "entries": [{"id": 3, "actor": "Alex (dashboard)", "action": "module:starboard", "detail": "settings saved", "at": 1730000000000, "ago": "1h ago"}]}"#
        let page = try JSONDecoder().decode(AuditPage.self, from: Data(json.utf8))
        #expect(page.kept == 500)
        let entry = try #require(page.entries.first)
        #expect(entry.label(moduleNames: ["starboard": "Starboard"]) == "Starboard")
        #expect(entry.label() == "Starboard")
        #expect(AuditEntry.label(for: "settings:server") == "Server settings")
        #expect(AuditEntry.label(for: "module:bulk") == "Several modules")
        #expect(AuditEntry.label(for: "appeal:accepted") == "Appeal accepted")
        #expect(AuditEntry.label(for: "moderation:case-delete") == "Case delete")
        #expect(AuditEntry.label(for: "command:/ban") == "Command /ban")
        #expect(AuditEntry.label(for: "some:new-thing") == "Some new thing")
        #expect(Endpoints.Audit(server: "1").path == "/api/v2/guilds/1/audit")
    }

    @Test("member data decodes a lookup and the delete sends the confirmation")
    func memberData() throws {
        let json = #"""
        {"lookup": {"profile": {"id": "111111111111111111", "tag": "ada#0001", "avatar": "https://cdn.example/a.png"},
                    "data": {"items": [{"key": "xp", "label": "Leveling XP", "count": 3, "kept": false},
                                       {"key": "warnings", "label": "Moderation cases", "count": 0, "kept": true},
                                       {"key": "tempBans", "label": "Temporary ban", "count": 1, "kept": true}],
                             "total": 4, "erasable": 3}},
         "unaffected": "Messages already posted are not affected."}
        """#
        let page = try JSONDecoder().decode(MemberDataPage.self, from: Data(json.utf8))
        let lookup = try #require(page.lookup)
        #expect(lookup.profile.displayName == "ada#0001")
        #expect(lookup.profile.avatarURL?.host == "cdn.example")
        #expect(lookup.total == 4)
        #expect(lookup.erasable == 3)
        #expect(lookup.shownItems.map(\.key) == ["xp", "tempBans"])
        #expect(page.unaffected == "Messages already posted are not affected.")
        let none = try JSONDecoder().decode(
            MemberDataPage.self, from: Data(#"{"lookup": null, "unaffected": "x"}"#.utf8))
        #expect(none.lookup == nil)

        let lookupCall = Endpoints.MemberData(server: "1", user: "<@111111111111111111>")
        #expect(lookupCall.path == "/api/v2/guilds/1/member-data")
        #expect(lookupCall.query == [URLQueryItem(name: "user", value: "<@111111111111111111>")])
        let forget = Endpoints.ForgetMember(server: "1", userId: "111111111111111111", reason: "At your request")
        #expect(forget.path == "/api/v2/guilds/1/member-data/forget")
        let body = try bodyObject(forget)
        #expect(Set(body.keys) == ["userId", "reason", "confirm"])
        #expect(body["confirm"] as? Bool == true)
        #expect(ForgetResult(dmDelivered: false).summary.contains("could not DM"))
    }

    @MainActor
    @Test("looking up refuses a malformed id before sending, and deleting reads the member again")
    func memberDataModel() async throws {
        let json = #"{"lookup": {"profile": {"id": "111111111111111111", "tag": null, "avatar": null}, "data": {"items": [{"key": "xp", "label": "XP", "count": 2}], "total": 2, "erasable": 2}}, "unaffected": ""}"#
        let page = try JSONDecoder().decode(MemberDataPage.self, from: Data(json.utf8))
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.ForgetMember { return ForgetResult(dmDelivered: true) }
            return page
        }
        let model = MemberDataModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.look(up: "nonsense")
        #expect(model.errorMessage == "That is not a user ID or mention.")
        #expect(clients.calls.isEmpty)
        await model.look(up: "111111111111111111")
        #expect(model.lookup?.total == 2)
        await model.forget(note: "  done ")
        #expect(model.deletionNotice?.contains("DM'd") == true)
        #expect(model.deleteCount == 1)
        #expect(clients.calls.compactMap { $0.endpoint as? Endpoints.ForgetMember }.first?.reason == "done")
        #expect(clients.calls.count == 3)
    }

    @Test("the leaderboard decodes, and the public path prefers the vanity link")
    func leaderboard() throws {
        let json = #"""
        {"guild": {"id": "900", "name": "S", "icon": null}, "levelingEnabled": true, "publicLeaderboard": true,
         "period": "week", "vanitySlug": "my-server", "total": 40,
         "rows": [{"rank": 1, "name": "ada", "level": null, "xp": 1200, "voiceMinutes": 3, "messages": 80}]}
        """#
        let page = try JSONDecoder().decode(LeaderboardPage.self, from: Data(json.utf8))
        #expect(page.period == .week)
        #expect(page.isPublic)
        #expect(page.rows.first?.level == nil)
        #expect(page.rows.first?.xp == 1200)
        #expect(page.total == 40)
        #expect(page.publicPath == "lb/my-server")
        var plain = page
        plain.vanitySlug = nil
        #expect(plain.publicPath == "leaderboard/900")
        plain.isPublic = false
        #expect(plain.publicPath == nil)
        let endpoint = Endpoints.Leaderboard(server: "1", period: .month)
        #expect(endpoint.query == [URLQueryItem(name: "period", value: "month")])
        let publicCall = Endpoints.SetLeaderboardPublic(server: "1", isPublic: true)
        #expect(publicCall.path == "/api/v2/guilds/1/leaderboard/public")
        #expect(try bodyObject(publicCall)["publicLeaderboard"] as? Bool == true)
        let vanity = Endpoints.SetLeaderboardVanity(server: "1", slug: "my-server")
        #expect(vanity.path == "/api/v2/guilds/1/leaderboard/vanity")
        #expect(try bodyObject(vanity)["slug"] as? String == "my-server")
    }

    @MainActor
    @Test("a refused vanity link shows the server's reason and keeps the page")
    func leaderboardModel() async throws {
        let page = LeaderboardPage(levelingEnabled: true, isPublic: true, vanitySlug: nil, total: 1, rows: [], guildID: "900")
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.SetLeaderboardVanity { throw NetworkError.badRequest(message: "That link is taken.") }
            return page
        }
        let model = LeaderboardModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.page?.guildID == "900")
        let ok = await model.setVanity("taken")
        #expect(!ok)
        #expect(model.actionError == "That link is taken.")
    }

    @MainActor
    @Test("the export is written as a pretty JSON file named like the dashboard's")
    func export() async throws {
        let config: JSONValue = .object(["guildId": .string("fluxer:9"), "modules": .object(["afk": .object(["enabled": .bool(true)])])])
        let clients = StubClients { _ in config }
        let model = ConfigExportModel(server: "fluxer:9", session: makeSignedInSession(clients: clients))
        await model.export()
        let url = try #require(model.fileURL)
        #expect(url.lastPathComponent == "sylo-fluxer-9-config.json")
        let text = try String(contentsOf: url, encoding: .utf8)
        #expect(text.contains("\"guildId\" : \"fluxer:9\""))
        try? FileManager.default.removeItem(at: url)
        #expect(Endpoints.ExportConfig(server: "1").path == "/api/v2/guilds/1/export")
    }
}

/// Module page actions.
@Suite("Module actions")
struct ModuleActionsTests {
    @Test("the one-off actions use the dashboard's paths and bodies")
    func oneOff() throws {
        let test = Endpoints.SendModuleTest(server: "1", module: "starboard")
        #expect(test.path == "/api/v2/guilds/1/modules/starboard/test")
        #expect(test.method == .post)
        let count = Endpoints.SetCount(server: "1", count: 41)
        #expect(count.path == "/api/v2/guilds/1/modules/counting/count")
        #expect(try bodyObject(count) as NSDictionary == ["current": 41])
        #expect(try bodyObject(Endpoints.SetCount(server: "1", count: nil)) as NSDictionary == ["reset": true])
        let release = Endpoints.ReleaseCountingPenalty(server: "1", userId: "111111111111111111")
        #expect(release.path == "/api/v2/guilds/1/modules/counting/penalty/release")
        #expect(try bodyObject(release)["userId"] as? String == "111111111111111111")
        let xp = Endpoints.SetLevelingXP(server: "1", userId: "111111111111111111", xp: 500)
        #expect(xp.path == "/api/v2/guilds/1/modules/leveling/xp")
        #expect(try bodyObject(xp) as NSDictionary == ["userId": "111111111111111111", "xp": 500])
        #expect(try bodyObject(Endpoints.SetLevelingXP.resetAll(server: "1")) as NSDictionary == ["reset": true])
        let bonus = Endpoints.SetInviteBonus(server: "1", userId: "111111111111111111", bonus: -3)
        #expect(bonus.path == "/api/v2/guilds/1/modules/invite-tracker/bonus")
        #expect(try bodyObject(bonus) as NSDictionary == ["userId": "111111111111111111", "bonus": -3])
        #expect(Endpoints.EndGiveaway(server: "1", id: 12).path == "/api/v2/guilds/1/modules/giveaways/12/end")
        let reroll = Endpoints.RerollGiveaway(server: "1", id: 12, count: 2)
        #expect(reroll.path == "/api/v2/guilds/1/modules/giveaways/12/reroll")
        #expect(try bodyObject(reroll) as NSDictionary == ["count": 2])
        let immunity = Endpoints.SetAutomodImmunity(server: "1", roles: ["r1"])
        #expect(immunity.path == "/api/v2/guilds/1/modules/automod/immunity")
        #expect(try bodyObject(immunity) as NSDictionary == ["exemptRoles": ["r1"]])
    }

    @Test("the welcome channel actions send the settings like a save")
    func welcomeChannel() throws {
        let settings = WelcomeChannelSettings()
        let publish = Endpoints.PublishWelcomeChannel(server: "1", settings: settings)
        #expect(publish.path == "/api/v2/guilds/1/modules/welcome-channel/publish")
        let body = try bodyObject(publish)
        #expect(body["channelId"] != nil)
        #expect(body["spec"] != nil)
        #expect(Endpoints.UnpublishWelcomeChannel(server: "1").path == "/api/v2/guilds/1/modules/welcome-channel/unpublish")
        #expect(Endpoints.CreateWelcomeChannel(server: "1").path == "/api/v2/guilds/1/modules/welcome-channel/create-channel")
    }

    @Test("a test message answers in the dashboard's words")
    func testResult() throws {
        let ok = try JSONDecoder().decode(ModuleTestResult.self, from: Data(#"{"ok": true, "channelName": "general"}"#.utf8))
        #expect(ok.message == "Test sent to #general")
        let none = try JSONDecoder().decode(ModuleTestResult.self, from: Data(#"{"ok": false, "reason": "no-channel"}"#.utf8))
        #expect(none.message == "Set a channel for this module first.")
        let failed = try JSONDecoder().decode(ModuleTestResult.self, from: Data(#"{"ok": false, "reason": "send-failed"}"#.utf8))
        #expect(failed.message == "Send failed. Check the bot has access to that channel.")
        #expect(ModuleTest.supports("welcome"))
        #expect(ModuleTest.supports("free-games"))
        #expect(!ModuleTest.supports("afk"))
    }

    @Test("suggestions, quotes and temporary roles use the dashboard's calls")
    func lists() throws {
        let list = Endpoints.SuggestionsList(server: "1", status: .approved, sortByVotes: true)
        #expect(list.path == "/api/v2/guilds/1/modules/suggestions/list")
        #expect(list.query == [URLQueryItem(name: "status", value: "approved"), URLQueryItem(name: "sort", value: "top")])
        let decide = Endpoints.DecideSuggestion(server: "1", number: 12, action: .implement, reason: "Shipped")
        #expect(decide.path == "/api/v2/guilds/1/modules/suggestions/12/decision")
        #expect(try bodyObject(decide) as NSDictionary == ["action": "implement", "reason": "Shipped"])
        #expect(Endpoints.DeleteSuggestion(server: "1", number: 12).path == "/api/v2/guilds/1/modules/suggestions/12/delete")
        #expect(SuggestionAction.allCases.map(\.rawValue) == ["consider", "approve", "deny", "implement"])

        let quotes = Endpoints.QuotesList(server: "1", search: "meant")
        #expect(quotes.path == "/api/v2/guilds/1/modules/quote-board/list")
        #expect(quotes.query == [URLQueryItem(name: "q", value: "meant")])
        #expect(Endpoints.DeleteQuote(server: "1", number: 7).path == "/api/v2/guilds/1/modules/quote-board/7/delete")

        let temp = Endpoints.TempRolesList(server: "1", search: "ada", roleId: "r1")
        #expect(temp.path == "/api/v2/guilds/1/modules/temp-roles/list")
        #expect(temp.query == [URLQueryItem(name: "q", value: "ada"), URLQueryItem(name: "roleId", value: "r1")])
        let add = Endpoints.AddTempRole(server: "1", userId: "111111111111111111", roleId: "r1", duration: "1d12h", reason: "Trial")
        #expect(add.path == "/api/v2/guilds/1/modules/temp-roles/add")
        #expect(try bodyObject(add) as NSDictionary == ["userId": "111111111111111111", "roleId": "r1", "duration": "1d12h", "reason": "Trial"])
        let remove = Endpoints.RemoveTempRole(server: "1", userId: "111111111111111111", roleId: "r1")
        #expect(remove.path == "/api/v2/guilds/1/modules/temp-roles/remove")
        #expect(try bodyObject(remove)["reason"] as? String == "")
        #expect(Endpoints.TempRoleMembers(server: "1", search: "ad").query == [URLQueryItem(name: "q", value: "ad")])
    }

    @Test("quotes, suggestions and temporary roles decode")
    func decodes() throws {
        let quotes = try JSONDecoder().decode(
            QuoteList.self,
            from: Data(#"{"total": 3, "quotes": [{"number": 7, "author": "Alex", "text": "Hi", "attachments": 0, "channel": "general", "messageAt": 1730000000000, "publicSource": true, "url": null}]}"#.utf8))
        #expect(quotes.total == 3)
        #expect(quotes.quotes.first?.number == 7)
        let suggestions = try JSONDecoder().decode(
            SuggestionList.self,
            from: Data(#"{"suggestions": [{"id": 1, "number": 12, "title": "", "text": "Movie night", "status": "open", "reason": "", "up": 3, "down": 0, "anonymous": false, "author": "Alex", "createdAt": 1730000000000}]}"#.utf8))
        #expect(suggestions.suggestions.first?.number == 12)
        let temp = try JSONDecoder().decode(
            TempRolesListResult.self,
            from: Data(#"{"list": {"total": 1, "matching": 1, "rows": [{"userId": "1", "roleId": "2", "member": "ada", "role": "Trial", "expiresAt": 1730000000000, "addedByName": null, "reason": ""}]}}"#.utf8))
        #expect(temp.list.rows.first?.role == "Trial")
        let members = try JSONDecoder().decode(
            MemberChoices.self, from: Data(#"{"members": [{"id": "1", "name": "Ada", "username": "ada"}]}"#.utf8))
        #expect(members.members.first?.name == "Ada")
        let added = try JSONDecoder().decode(
            TempRoleAdded.self, from: Data(#"{"replaced": true, "alreadyHadRole": false, "dm": false, "expiresAt": 1}"#.utf8))
        #expect(added.replaced && !added.dm)
        let removed = try JSONDecoder().decode(
            TempRoleRemoved.self, from: Data(#"{"roleRemoved": false, "warning": "Could not remove the role."}"#.utf8))
        #expect(!removed.roleRemoved)
        #expect(removed.warning == "Could not remove the role.")
    }

    @Test("an event decodes with everything the form needs and sends the dashboard's body")
    func events() throws {
        let json = #"""
        {"config": {"channel": "c1", "reminderMinutes": 30}, "channels": [{"id": "c1", "name": "events"}],
         "roles": [{"id": "r1", "name": "Going"}],
         "events": [
          {"id": 12, "title": "Game night", "description": "Bring snacks", "location": "Voice", "imageUrl": "",
           "startAt": 1794000000000, "endAt": null, "start": "2026-11-08T19:00", "end": "", "timeZone": "Europe/Oslo",
           "capacity": 12, "roleId": "r1", "reminderMinutes": 30, "channelId": "c1", "channel": "events",
           "state": "scheduled", "joined": 4, "maybe": 1},
          {"id": 11, "title": "Old", "state": "ended", "joined": 2, "maybe": 0, "timeZone": "UTC", "channelId": "c1", "channel": "events"}]}
        """#
        let page = try JSONDecoder().decode(EventsManagePage.self, from: Data(json.utf8))
        #expect(page.upcoming.map(\.id) == [12])
        #expect(page.past.map(\.id) == [11])
        let event = page.upcoming[0]
        #expect(event.capacity == 12)
        #expect(event.roleId == "r1")
        #expect(event.zone.identifier == "Europe/Oslo")

        var draft = EventDraft(event: event)
        #expect(draft.eventID == 12)
        #expect(draft.hasCapacity)
        #expect(draft.hasEnd == false)
        let save = Endpoints.SaveEvent(server: "1", draft: draft)
        #expect(save.path == "/api/v2/guilds/1/modules/events/events/12")
        let body = try bodyObject(save)
        #expect(Set(body.keys) == [
            "title", "description", "start", "end", "timeZone", "channelId", "roleId", "location", "imageUrl", "capacity",
            "reminderMinutes",
        ])
        // 1794000000 s is 2026-11-07 15:20 UTC, which is 16:20 in Oslo (CET).
        #expect(body["start"] as? String == EventDraft.localText(Date(timeIntervalSince1970: 1_794_000_000), in: draft.zone))
        #expect((body["start"] as? String)?.count == 16)
        #expect((body["start"] as? String)?.contains("T") == true)
        #expect(body["end"] as? String == "")
        #expect(body["capacity"] as? Int == 12)
        draft.hasCapacity = false
        #expect(try bodyObject(Endpoints.SaveEvent(server: "1", draft: draft))["capacity"] is NSNull)

        let fresh = EventDraft(settings: EventsSettings(channel: "c1", reminderMinutes: 15), now: Date(timeIntervalSince1970: 1_730_000_000))
        #expect(fresh.channelId == "c1")
        #expect(fresh.reminderMinutes == 15)
        #expect(Endpoints.SaveEvent(server: "1", draft: fresh).path == "/api/v2/guilds/1/modules/events/events")
        #expect(fresh.problem(now: Date(timeIntervalSince1970: 1_730_000_000)) == "Give the event a title.")
        #expect(Endpoints.CancelEvent(server: "1", id: 12).path == "/api/v2/guilds/1/modules/events/events/12/cancel")
        #expect(Endpoints.LoadEventsManage(server: "1").path == "/api/v2/guilds/1/modules/events/config")
    }

    @Test("an event needs a title, a channel, a future start and an end after the start")
    func eventProblems() {
        let now = Date(timeIntervalSince1970: 1_730_000_000)
        var draft = EventDraft(settings: EventsSettings(), now: now)
        draft.title = "Game night"
        #expect(draft.problem(now: now) == "Pick a text channel.")
        draft.channelId = "c1"
        #expect(draft.problem(now: now) == nil)
        draft.start = now.addingTimeInterval(-60)
        #expect(draft.problem(now: now) == "The start time must be in the future.")
        draft.start = now.addingTimeInterval(3600)
        draft.hasEnd = true
        draft.end = now.addingTimeInterval(60)
        #expect(draft.problem(now: now) == "The end time must be after the start time.")
        draft.hasEnd = false
        draft.imageUrl = "http://example.com/a.png"
        #expect(draft.problem(now: now) == "The image must be an https link.")
        draft.imageUrl = ""
        draft.timeZone = "Not/AZone"
        #expect(draft.problem(now: now) == "Pick a time zone.")
    }

    @MainActor
    @Test("the action runner counts successes, keeps the server's reason and refuses a second action")
    func runner() async throws {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.SetInviteBonus { throw NetworkError.badRequest(message: "Invalid member id or bonus value.") }
            return OKResponse()
        }
        let session = makeSignedInSession(clients: clients)
        let runner = ActionRunner(session: session)
        let before = session.modulesRevision
        #expect(await runner.run(Endpoints.UnpublishWelcomeChannel(server: "1")) == nil)
        // The stub answers OKResponse, which is the wrong type for that call, so nothing counts.
        #expect(runner.successCount == 0)
        let ok = await runner.run(Endpoints.ReleaseCountingPenalty(server: "1", userId: "111111111111111111"))
        #expect(ok?.ok == true)
        #expect(runner.successCount == 1)
        #expect(session.modulesRevision == before + 1)
        let refused = await runner.run(Endpoints.SetInviteBonus(server: "1", userId: "1", bonus: 5), changesModules: false)
        #expect(refused == nil)
        #expect(runner.errorMessage == "Invalid member id or bonus value.")
        #expect(session.modulesRevision == before + 1)
    }

    @MainActor
    @Test("a query list keeps only the newest answer")
    func queryList() async throws {
        let first = QuoteList(total: 1, quotes: [])
        let second = QuoteList(total: 2, quotes: [])
        let clients = StubClients { endpoint in
            guard let list = endpoint as? Endpoints.QuotesList else { throw NetworkError.cancelled }
            return list.search == "slow" ? first : second
        }
        clients.setGate { endpoint in
            if (endpoint as? Endpoints.QuotesList)?.search == "slow" { try? await Task.sleep(for: .milliseconds(150)) }
        }
        let model = QueryListModel<QuoteList>(session: makeSignedInSession(clients: clients))
        async let slow: Void = model.load(Endpoints.QuotesList(server: "1", search: "slow")) { $0 }
        try await Task.sleep(for: .milliseconds(30))
        await model.load(Endpoints.QuotesList(server: "1", search: "fast")) { $0 }
        await slow
        #expect(model.value?.total == 2)
        #expect(!model.isLoading)
    }
}

/// The bot-wide pages: personalizer, roadmap, command list, stats, backups, invites.
@Suite("Operator tools")
struct OwnerToolsTests {
    @Test("the personalizer pages decode")
    func personalizer() throws {
        let identity = try JSONDecoder().decode(
            PersonalizerIdentityPage.self,
            from: Data(#"{"bot": {"tag": "Sylo#9455", "username": "Sylo", "id": "1", "avatar": "https://cdn.example/a.png", "banner": null}}"#.utf8))
        #expect(identity.bot?.tag == "Sylo#9455")
        #expect(identity.bot?.bannerURL == nil)
        #expect(try JSONDecoder().decode(PersonalizerIdentityPage.self, from: Data(#"{"bot": null}"#.utf8)).bot == nil)
        let presence = try JSONDecoder().decode(
            PersonalizerPresencePage.self,
            from: Data(#"{"presence": {"status": "idle", "type": "Watching", "text": "servers"}, "types": ["Playing", "Watching"], "statuses": ["online", "idle"], "announcementSeverities": ["info", "critical"]}"#.utf8))
        #expect(presence.presence == PresenceConfig(status: "idle", type: "Watching", text: "servers"))
        #expect(presence.severities == ["info", "critical"])
    }

    @Test("the personalizer saves send the dashboard's bodies")
    func personalizerBodies() throws {
        var identity = IdentityDraft()
        #expect(identity.isEmpty)
        identity.username = " Sylo Dev "
        identity.avatarUrl = "https://cdn.example/a.png"
        let save = Endpoints.SaveIdentity(draft: identity)
        #expect(save.path == "/api/v2/personalizer/identity")
        let body = try bodyObject(save)
        #expect(Set(body.keys) == ["username", "avatarUrl", "bannerUrl", "resetAvatar"])
        #expect(body["username"] as? String == "Sylo Dev")
        #expect(body["bannerUrl"] as? String == "")
        #expect(body["resetAvatar"] as? Bool == false)
        #expect(identity.problem == nil)
        identity.avatarUrl = "http://cdn.example/a.png"
        #expect(identity.problem == "The avatar must be an https image link.")
        identity.avatarUrl = ""
        identity.username = "x"
        #expect(identity.problem == "The name is 2 to 32 characters.")
        let presence = Endpoints.SavePresence(presence: PresenceConfig(status: "dnd", type: "Custom", text: "Back soon"))
        #expect(presence.path == "/api/v2/personalizer/presence")
        #expect(try bodyObject(presence) as NSDictionary == ["status": "dnd", "type": "Custom", "text": "Back soon"])
        let announcement = Endpoints.SaveAnnouncement(draft: AnnouncementDraft(title: "Incident", body: "Fixing", severity: "warning"))
        #expect(announcement.path == "/api/v2/personalizer/announcement")
        #expect(try bodyObject(announcement) as NSDictionary == ["title": "Incident", "body": "Fixing", "severity": "warning"])
        #expect(Endpoints.ClearAnnouncement().path == "/api/v2/personalizer/announcement/clear")
        let result = try JSONDecoder().decode(
            IdentityResult.self, from: Data(#"{"done": ["username"], "failed": ["avatar (could not load that image)"]}"#.utf8))
        #expect(result.summary == "Updated username. Failed: avatar (could not load that image).")
    }

    @MainActor
    @Test("the personalizer model loads three calls and saves the status")
    func personalizerModel() async throws {
        let presencePage = try JSONDecoder().decode(
            PersonalizerPresencePage.self,
            from: Data(#"{"presence": {"status": "online", "type": "Listening", "text": "a"}, "types": ["Listening", "Custom"], "statuses": ["online"], "announcementSeverities": ["info"]}"#.utf8))
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.PersonalizerIdentity {
                return PersonalizerIdentityPage(bot: nil)
            }
            if endpoint is Endpoints.Announcement {
                return AnnouncementResult(announcement: AnnouncementDraft(title: "Hi", body: "", severity: "info"))
            }
            if endpoint is Endpoints.SavePresence { return SavedPresence(presence: PresenceConfig(status: "online", type: "Custom", text: "b")) }
            return presencePage
        }
        let model = PersonalizerModel(session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.presence.text == "a")
        #expect(model.hasAnnouncement)
        #expect(!model.presenceHasChanges)
        model.presence.text = "b"
        #expect(model.presenceHasChanges)
        await model.savePresence()
        #expect(model.notice == "Presence updated.")
        #expect(!model.presenceHasChanges)
        #expect(model.successCount == 1)
    }

    @Test("the roadmap board decodes, a vote replaces one post's count, and limits are checked")
    func roadmap() throws {
        let json = #"""
        {"groups": {"planned": [{"id": 1, "title": "Dark mode", "description": "Soon", "descriptionHtml": "<p>Soon</p>", "status": "planned", "votes": 4, "createdAt": 1730000000000, "voted": false}],
                    "started": [], "completed": [{"id": 2, "title": "Appeals", "description": "Done", "status": "completed", "votes": 9, "createdAt": 1720000000000, "voted": true}]},
         "mine": [{"id": 3, "title": "Idea", "description": "x", "descriptionHtml": "<p>x</p>", "ago": "1h ago"}],
         "isOwner": true, "signedIn": true, "open": false}
        """#
        let board = try JSONDecoder().decode(RoadmapBoard.self, from: Data(json.utf8))
        #expect(board.planned.map(\.id) == [1])
        #expect(board.completed.first?.hasVoted == true)
        #expect(board.mine.first?.title == "Idea")
        #expect(board.isOwner)
        #expect(!board.isEmpty)
        let voted = board.applying(vote: RoadmapVoteResult(hasVoted: true, votes: 5), to: 1)
        #expect(voted.planned.first?.votes == 5)
        #expect(voted.planned.first?.hasVoted == true)
        #expect(voted.completed.first?.votes == 9)
        #expect(RoadmapLimits.problem(title: "ab", description: "x") == "The title is 3 to 100 characters.")
        #expect(RoadmapLimits.problem(title: "Good title", description: " ") == "Add a description.")
        #expect(RoadmapLimits.problem(title: "Good title", description: "Body") == nil)
        let admin = try JSONDecoder().decode(
            RoadmapAdminPage.self,
            from: Data(#"{"statuses": ["planned"], "pending": [{"id": 3, "title": "Idea", "description": "x", "status": "pending", "createdAt": 1730000000000, "ago": "1h ago"}], "posts": []}"#.utf8))
        #expect(admin.pending.first?.ago == "1h ago")
    }

    @Test("the roadmap calls use the dashboard's paths and bodies")
    func roadmapCalls() throws {
        #expect(Endpoints.Roadmap().path == "/api/v2/roadmap")
        #expect(Endpoints.VoteRoadmapPost(id: 4).path == "/api/v2/roadmap/4/vote")
        let suggest = Endpoints.SuggestRoadmapPost(title: "Idea", description: "Body")
        #expect(suggest.path == "/api/v2/roadmap/suggest")
        #expect(try bodyObject(suggest) as NSDictionary == ["title": "Idea", "description": "Body"])
        #expect(Endpoints.RoadmapAdmin().path == "/api/v2/roadmap/admin")
        #expect(Endpoints.CreateRoadmapPost(title: "a", description: "b").path == "/api/v2/roadmap/admin")
        #expect(Endpoints.ApproveRoadmapPost(id: 3).path == "/api/v2/roadmap/admin/3/approve")
        #expect(Endpoints.RejectRoadmapPost(id: 3).path == "/api/v2/roadmap/admin/3/reject")
        let status = Endpoints.SetRoadmapStatus(id: 3, status: .started)
        #expect(status.path == "/api/v2/roadmap/admin/3/status")
        #expect(try bodyObject(status) as NSDictionary == ["status": "started"])
        #expect(Endpoints.EditRoadmapPost(id: 3, title: "a", description: "b").path == "/api/v2/roadmap/admin/3/edit")
        #expect(Endpoints.DeleteRoadmapPost(id: 3).path == "/api/v2/roadmap/admin/3/delete")
    }

    @Test("the command list and the stats cache decode")
    func commandListAndStats() throws {
        let commands = try JSONDecoder().decode(
            CommandListPage.self,
            from: Data(#"{"commands": [{"signature": "/ban <user> [reason]", "description": "Ban a member", "permissions": ["Ban Members"], "options": [{"name": "user", "required": true, "description": "Who", "choices": []}, {"name": "days", "required": false, "description": "", "choices": ["1", "7"]}]}, {"signature": "/ping", "description": "Pong", "permissions": null, "options": []}]}"#.utf8))
        #expect(commands.commands.count == 2)
        #expect(commands.commands[0].permissions == ["Ban Members"])
        #expect(commands.commands[0].options[1].choices == ["1", "7"])
        #expect(commands.commands[1].permissions == nil)
        #expect(commands.commands(matching: "pong").map(\.signature) == ["/ping"])
        #expect(Endpoints.CommandList().path == "/api/v2/public/commands")
        let stats = try JSONDecoder().decode(
            StatsPage.self,
            from: Data(#"{"rows": [{"game": "bf", "title": "Battlefield", "username": "ada", "platform": "pc", "ago": "1h ago", "fresh": true, "kd": 1.4, "winRate": "52%", "timePlayed": 1483200}, {"game": "bf", "title": "BF", "username": "x", "platform": "psn", "fresh": false, "kd": "—", "winRate": "—", "timePlayed": "—"}], "ttlMinutes": 30}"#.utf8))
        #expect(stats.ttlMinutes == 30)
        #expect(stats.rows[0].isFresh)
        #expect(stats.rows[0].facts == "K/D 1.4 \u{00B7} Win 52% \u{00B7} 412 h played")
        #expect(stats.rows[1].facts == "")
        #expect(Endpoints.Stats().path == "/api/v2/stats")
    }

    @Test("backups use the health paths, the import sends the raw file and a download is raw bytes")
    func backups() throws {
        #expect(Endpoints.CreateBackup().path == "/api/v2/health/backups")
        #expect(Endpoints.DownloadBackup(name: "sylo-1.db").path == "/api/v2/health/backups/sylo-1.db")
        #expect(Endpoints.DeleteBackup(name: "sylo-1.db").path == "/api/v2/health/backups/sylo-1.db/delete")
        #expect(Endpoints.RestoreBackup(name: "sylo-1.db").path == "/api/v2/health/backups/sylo-1.db/restore")
        let data = Data([1, 2, 3])
        let upload = Endpoints.ImportBackup(data: data)
        #expect(upload.path == "/api/v2/health/backups/import")
        #expect(upload.method == .post)
        #expect(upload.rawBody == data)
        #expect(upload.body == nil)
        #expect(Endpoints.CreateBackup().rawBody == nil)
        #expect(Endpoints.SendDevLogErrorTest().path == "/api/v2/health/dev-log-error-test")
        #expect(Endpoints.DisconnectPlatform(platform: "discord").path == "/api/v2/account/disconnect/discord")
        let url = try BackupFiles.write(RawBytes(data: data), name: "../sylo 1.db")
        #expect(url.lastPathComponent == "..-sylo-1.db")
        #expect(try Data(contentsOf: url) == data)
        try? FileManager.default.removeItem(at: url)
    }

    @Test("the health report reads the bot audit log and the session secret")
    func healthExtras() throws {
        let json = #"{"ready": true, "botAudit": [{"actor": "Alex (dashboard)", "action": "personalizer:presence", "detail": "online", "ago": "5m ago"}], "sessionSecret": "generated-ephemeral"}"#
        let report = try JSONDecoder().decode(HealthReport.self, from: Data(json.utf8))
        #expect(report.botAudit.count == 1)
        #expect(report.botAudit[0].action == "personalizer:presence")
        #expect(report.hasEphemeralSessionSecret)
        let plain = try JSONDecoder().decode(HealthReport.self, from: Data(#"{"ready": true}"#.utf8))
        #expect(plain.botAudit.isEmpty)
        #expect(!plain.hasEphemeralSessionSecret)
    }

    @Test("the add-Sylo links keep https links only")
    func invites() throws {
        let json = #"{"invites": [{"platform": "discord", "label": "Discord", "url": "https://discord.com/oauth2/authorize?client_id=1"}, {"platform": "fluxer", "label": "Fluxer", "url": "javascript:alert(1)"}]}"#
        let invites = try JSONDecoder().decode(BotInvites.self, from: Data(json.utf8))
        #expect(invites.invites.map(\.label) == ["Discord"])
        #expect(Endpoints.Invites().path == "/api/v2/invites")
    }
}
