import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

@Suite("Dashboard access levels")
struct DashboardAccessLevelTests {
    @Test("The three levels read from their words, and an unknown one is kept")
    func levels() throws {
        #expect(try decode(DashboardAccess.self, #""view""#) == .view)
        #expect(try decode(DashboardAccess.self, #""inbox""#) == .inbox)
        #expect(try decode(DashboardAccess.self, #""edit""#) == .edit)
        #expect(try decode(DashboardAccess.self, #""owner""#) == .other("owner"))
        #expect(DashboardAccess.other("owner").rawValue == "owner")
    }

    @Test("Each level reaches what is at or below it")
    func allows() {
        #expect(DashboardAccess.view.allows(.view))
        #expect(!DashboardAccess.view.allows(.inbox))
        #expect(!DashboardAccess.view.allows(.edit))
        #expect(DashboardAccess.inbox.allows(.view))
        #expect(DashboardAccess.inbox.allows(.inbox))
        #expect(!DashboardAccess.inbox.allows(.edit))
        #expect(DashboardAccess.edit.allows(.view))
        #expect(DashboardAccess.edit.allows(.inbox))
        #expect(DashboardAccess.edit.allows(.edit))
    }

    @Test("What each level may do in the app")
    func gating() {
        #expect(!DashboardAccess.view.canActOnInbox)
        #expect(!DashboardAccess.view.canEdit)
        #expect(!DashboardAccess.view.seesInboxContent)
        #expect(DashboardAccess.inbox.canActOnInbox)
        #expect(!DashboardAccess.inbox.canEdit)
        #expect(DashboardAccess.inbox.seesInboxContent)
        #expect(DashboardAccess.edit.canActOnInbox)
        #expect(DashboardAccess.edit.canEdit)
        // A level a newer Sylo adds hides nothing: the server still enforces what it means.
        #expect(DashboardAccess.other("owner").canEdit)
    }

    @Test("A level below Edit has a badge and a sentence, Edit has neither")
    func badges() {
        #expect(DashboardAccess.view.badgeTitle == "View only")
        #expect(DashboardAccess.inbox.badgeTitle == "Inbox only")
        #expect(DashboardAccess.edit.badgeTitle == nil)
        #expect(DashboardAccess.view.limitNote != nil)
        #expect(DashboardAccess.inbox.limitNote != nil)
        #expect(DashboardAccess.edit.limitNote == nil)
    }
}

@Suite("Access on the server list")
struct ServerListAccessTests {
    @Test("A 5.2 server sends a level per server")
    func fiveTwo() throws {
        let list = try decode(ServerList.self, #"""
            {"guilds":[
              {"id":"1","name":"Alpha","platform":"discord","access":"edit"},
              {"id":"2","name":"Beta","platform":"discord","access":"inbox"},
              {"id":"3","name":"Gamma","platform":"fluxer","access":"view"}]}
            """#)
        #expect(list.servers.map(\.access) == [.edit, .inbox, .view])
        #expect(list.servers.map(\.effectiveAccess) == [.edit, .inbox, .view])
    }

    @Test("A 5.1 server sends none, which is Edit")
    func fiveOne() throws {
        let list = try decode(ServerList.self, #"{"guilds":[{"id":"1","name":"Alpha","platform":"discord"}]}"#)
        #expect(list.servers[0].access == nil)
        #expect(list.servers[0].effectiveAccess == .edit)
        #expect(list.servers[0].effectiveAccess.canEdit)
    }

    @Test("A level of an odd shape reads as none and never drops the server")
    func oddShape() throws {
        let list = try decode(ServerList.self, #"{"guilds":[{"id":"1","name":"Alpha","platform":"discord","access":{"x":1}}]}"#)
        #expect(list.servers.count == 1)
        #expect(list.servers[0].access == nil)
    }
}

@Suite("Dashboard access settings")
struct DashboardAccessSettingsTests {
    @Test("The answer of GET .../access")
    func decodes() throws {
        let settings = try decode(DashboardAccessSettings.self, #"""
            {"level":"edit","editRoleIds":["10"],"inboxRoleIds":["20","21"],"viewRoleIds":[],"canChangeEditRoles":false}
            """#)
        #expect(settings.level == .edit)
        #expect(settings.editRoleIds == ["10"])
        #expect(settings.inboxRoleIds == ["20", "21"])
        #expect(settings.viewRoleIds.isEmpty)
        #expect(!settings.canChangeEditRoles)
        #expect(settings.roles == DashboardAccessRoles(inboxRoleIds: ["20", "21"], viewRoleIds: []))
    }

    @Test("Missing fields read as an empty, changeable setup")
    func minimal() throws {
        let settings = try decode(DashboardAccessSettings.self, "{}")
        #expect(settings.level == .edit)
        #expect(settings.canChangeEditRoles)
        #expect(settings.roles == DashboardAccessRoles())
    }

    @Test("The roles are the same in any order")
    func sameRoles() {
        let a = DashboardAccessRoles(inboxRoleIds: ["1", "2"], viewRoleIds: ["3"])
        #expect(a.sameRoles(as: DashboardAccessRoles(inboxRoleIds: ["2", "1"], viewRoleIds: ["3"])))
        #expect(!a.sameRoles(as: DashboardAccessRoles(inboxRoleIds: ["1"], viewRoleIds: ["3"])))
        // A role that moved from one list to the other is a change.
        #expect(!a.sameRoles(as: DashboardAccessRoles(inboxRoleIds: ["1", "2", "3"], viewRoleIds: [])))
    }

    @Test("A role in two lists, or with Edit already, is noted")
    func overlap() {
        #expect(DashboardAccessRoles(inboxRoleIds: ["1"], viewRoleIds: ["2"]).conflict(editRoleIds: ["3"]) == nil)
        #expect(DashboardAccessRoles(inboxRoleIds: ["1"], viewRoleIds: ["1"]).conflict(editRoleIds: []) != nil)
        #expect(DashboardAccessRoles(inboxRoleIds: ["3"], viewRoleIds: []).conflict(editRoleIds: ["3"]) != nil)
        #expect(DashboardAccessRoles(inboxRoleIds: [], viewRoleIds: ["3"]).conflict(editRoleIds: ["3"]) != nil)
    }

    @Test("The calls go where the server expects")
    func endpoints() throws {
        #expect(Endpoints.LoadDashboardAccess(server: "fluxer:9").path == "/api/v2/guilds/fluxer%3A9/access")
        let save = Endpoints.SaveDashboardAccess(server: "1", roles: DashboardAccessRoles(inboxRoleIds: ["a"], viewRoleIds: []))
        #expect(save.path == "/api/v2/guilds/1/access")
        #expect(save.method == .post)
        let body = try #require(save.body)
        let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        // Only the Inbox and View roles: the Edit roles go with the server settings.
        #expect(Set(json.keys) == ["inboxRoleIds", "viewRoleIds"])
    }

    @Test("Errors tell a refused level and a missing route from other failures")
    func errors() {
        #expect(NetworkError.notFound.isMissingRoute)
        #expect(NetworkError.notFound(message: "Not found").isMissingRoute)
        #expect(!NetworkError.notFound(message: "Unknown or unavailable server.").isMissingRoute)
        #expect(!NetworkError.forbidden.isMissingRoute)
        let refusal = NetworkError.forbidden(message: "Your dashboard access in this server is View only, so you can't do this.")
        #expect(refusal.isAccessRefusal)
        #expect(refusal.userMessage.contains("View only"))
        #expect(!NetworkError.forbidden(message: "You do not manage this server.").isAccessRefusal)
        #expect(!NetworkError.forbidden.isAccessRefusal)
    }
}

@MainActor
@Suite("Server settings and access")
struct GuildSettingsAccessTests {
    static let settingsJSON = #"""
        {"modlogChannelId":"","botMasterRoleIds":["10"],"embedColorHex":"#7aa2f7","channels":[],"roles":[
          {"id":"10","name":"Admins"},{"id":"20","name":"Mods"},{"id":"30","name":"Guests"}],"platform":"discord"}
        """#

    static func clients(access: String? = #"{"level":"edit","editRoleIds":["10"],"inboxRoleIds":["20"],"viewRoleIds":[],"canChangeEditRoles":true}"#) -> StubClients {
        let page = try! decode(GuildSettingsPage.self, settingsJSON)
        let settings = access.flatMap { try? decode(DashboardAccessSettings.self, $0) }
        return StubClients { endpoint in
            switch endpoint {
            case is Endpoints.LoadGuildSettings: return page
            case is Endpoints.SaveGuildSettings: return OKResponse()
            case is Endpoints.LoadDashboardAccess:
                if let settings { return settings }
                throw NetworkError.notFound
            case let save as Endpoints.SaveDashboardAccess:
                return DashboardAccessSettings(
                    level: .edit, editRoleIds: ["10"], inboxRoleIds: save.roles.inboxRoleIds,
                    viewRoleIds: save.roles.viewRoleIds)
            default: throw NetworkError.notFound
            }
        }
    }

    @Test("A server with levels loads the access roles next to the settings")
    func loads() async {
        let clients = Self.clients()
        let model = GuildSettingsModel(server: "1", session: makeSignedInSession(clients: clients), hasAccessLevels: true)
        await model.load()
        #expect(model.access?.canChangeEditRoles == true)
        #expect(model.accessDraft == DashboardAccessRoles(inboxRoleIds: ["20"], viewRoleIds: []))
        #expect(!model.hasChanges)
    }

    @Test("A 5.1 server gets no access call at all")
    func olderServer() async {
        let clients = Self.clients()
        let model = GuildSettingsModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.access == nil)
        #expect(model.accessDraft == nil)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.LoadDashboardAccess })
    }

    @Test("A server that has the levels but not the route simply has no section")
    func missingRoute() async {
        let model = GuildSettingsModel(
            server: "1", session: makeSignedInSession(clients: Self.clients(access: nil)), hasAccessLevels: true)
        await model.load()
        #expect(model.page != nil)
        #expect(model.access == nil)
        #expect(model.errorMessage == nil)
    }

    @Test("Changing only the Inbox roles saves them on their own route and not the settings")
    func savesAccessOnly() async throws {
        let clients = Self.clients()
        let model = GuildSettingsModel(server: "1", session: makeSignedInSession(clients: clients), hasAccessLevels: true)
        await model.load()
        model.accessDraft = DashboardAccessRoles(inboxRoleIds: ["20", "30"], viewRoleIds: [])
        #expect(model.hasChanges)
        #expect(await model.save())
        let endpoints = clients.calls.map(\.endpoint)
        #expect(!endpoints.contains { $0 is Endpoints.SaveGuildSettings })
        let sent = try #require(endpoints.compactMap { $0 as? Endpoints.SaveDashboardAccess }.first)
        #expect(sent.roles.inboxRoleIds == ["20", "30"])
        #expect(!model.hasChanges)
    }

    @Test("Changing the settings alone does not post the access roles")
    func savesSettingsOnly() async {
        let clients = Self.clients()
        let model = GuildSettingsModel(server: "1", session: makeSignedInSession(clients: clients), hasAccessLevels: true)
        await model.load()
        model.draft?.modlogChannelId = "c1"
        #expect(await model.save())
        let endpoints = clients.calls.map(\.endpoint)
        #expect(endpoints.contains { $0 is Endpoints.SaveGuildSettings })
        #expect(!endpoints.contains { $0 is Endpoints.SaveDashboardAccess })
    }

    @Test("Discard puts the access roles back too")
    func discard() async {
        let model = GuildSettingsModel(
            server: "1", session: makeSignedInSession(clients: Self.clients()), hasAccessLevels: true)
        await model.load()
        model.accessDraft = DashboardAccessRoles(inboxRoleIds: [], viewRoleIds: ["30"])
        #expect(model.hasChanges)
        model.discardChanges()
        #expect(!model.hasChanges)
        #expect(model.accessDraft == model.savedAccess)
    }

    @Test("Only the owner or Manage Server may change the Edit roles")
    func editRolesLocked() async throws {
        let locked = #"{"level":"edit","editRoleIds":["10"],"inboxRoleIds":[],"viewRoleIds":[],"canChangeEditRoles":false}"#
        let model = GuildSettingsModel(
            server: "1", session: makeSignedInSession(clients: Self.clients(access: locked)), hasAccessLevels: true)
        await model.load()
        #expect(!model.canChangeEditRoles)
        // An older server does not say, and lets every admin.
        let older = GuildSettingsModel(server: "1", session: makeSignedInSession(clients: Self.clients()))
        #expect(older.canChangeEditRoles)
    }

    @Test("A failed access save says the settings were saved")
    func accessSaveFails() async {
        let page = try! decode(GuildSettingsPage.self, Self.settingsJSON)
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.LoadGuildSettings: return page
            case is Endpoints.LoadDashboardAccess: return DashboardAccessSettings(inboxRoleIds: ["20"])
            case is Endpoints.SaveGuildSettings: return OKResponse()
            default: throw NetworkError.forbidden(message: "Your dashboard access in this server is View only, so you can't do this.")
            }
        }
        let model = GuildSettingsModel(server: "1", session: makeSignedInSession(clients: clients), hasAccessLevels: true)
        await model.load()
        model.draft?.modlogChannelId = "c1"
        model.accessDraft = DashboardAccessRoles(inboxRoleIds: [], viewRoleIds: ["30"])
        #expect(await model.save() == false)
        let message = model.saveError ?? ""
        #expect(message.contains("settings were saved"))
        #expect(message.contains("View only"))
        // The access roles stay in the draft so the person can try again.
        #expect(model.accessDraft?.viewRoleIds == ["30"])
    }
}

@MainActor
@Suite("Server features")
struct ServerFeaturesTests {
    @Test("Features are asked once per sign-in and kept")
    func cached() async {
        let info = ServerInfo(features: [.appLogin, .accessLevels, .health])
        let clients = StubClients { _ in info }
        let session = makeSignedInSession(clients: clients)
        #expect(await session.supports(.accessLevels))
        #expect(await session.supports(.health))
        #expect(!(await session.supports(.setupWizard)))
        #expect(clients.calls.filter { $0.endpoint is Endpoints.ServerInfo }.count == 1)
    }

    @Test("A 5.1 server has none of the 5.2 features")
    func fiveOne() async {
        let clients = StubClients { _ in ServerInfo(features: [.appLogin, .liveAccess, .changelog]) }
        let session = makeSignedInSession(clients: clients)
        #expect(!(await session.supports(.accessLevels)))
        #expect(!(await session.supports(.health)))
    }

    @Test("A server that cannot be asked has no features, and is asked again next time")
    func unreachable() async {
        let clients = StubClients { _ in throw NetworkError.offline }
        let session = makeSignedInSession(clients: clients)
        #expect(await session.serverFeatures().isEmpty)
        clients.setHandler { _ in ServerInfo(features: [.health]) }
        #expect(await session.supports(.health))
    }
}
