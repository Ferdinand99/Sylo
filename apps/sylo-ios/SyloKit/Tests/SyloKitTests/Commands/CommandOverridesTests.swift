import Foundation
import Testing
@testable import SyloKit

@Suite("Command limits")
struct CommandOverridesDecodingTests {
    /// `GET /commands` as src/web/routes/v2Staff.js sends it.
    static let json = #"""
    {
      "commands": [
        {"name": "afk", "description": "Set yourself as away", "enabled": true, "allowedChannels": [], "allowedRoles": []},
        {"name": "ban", "description": "Ban a member", "enabled": false,
         "allowedChannels": ["830000000000000001"], "allowedRoles": ["850000000000000001", "850000000000000002"]}
      ],
      "channels": [{"id": "830000000000000001", "name": "mods"}],
      "roles": [{"id": "850000000000000001", "name": "Moderator"}, {"id": "850000000000000002", "name": "Admin"}]
    }
    """#

    @Test("the page decodes the commands with their limits, and the channels and roles to pick from")
    func decodes() throws {
        let page = try JSONDecoder().decode(CommandsPage.self, from: Data(Self.json.utf8))
        #expect(page.commands.map(\.name) == ["afk", "ban"])
        let afk = page.commands[0]
        #expect(afk.enabled)
        #expect(!afk.isLimited)
        #expect(afk.description == "Set yourself as away")
        let ban = page.commands[1]
        #expect(!ban.enabled)
        #expect(ban.isLimited)
        #expect(ban.allowedChannels == ["830000000000000001"])
        #expect(ban.allowedRoles == ["850000000000000001", "850000000000000002"])
        #expect(page.channels == [ChannelOption(id: "830000000000000001", name: "mods")])
        #expect(page.roles.map(\.name) == ["Moderator", "Admin"])
    }

    @Test("a command with only a name is on and unlimited; a broken entry is dropped")
    func lenient() throws {
        let bare = try JSONDecoder().decode(ManagedCommand.self, from: Data(#"{"name":"x"}"#.utf8))
        #expect(bare.enabled)
        #expect(bare.allowedChannels.isEmpty)
        #expect(bare.allowedRoles.isEmpty)
        let page = try JSONDecoder().decode(
            CommandsPage.self, from: Data(#"{"commands":[{"description":"no name"},{"name":"y","newKey":1}]}"#.utf8))
        #expect(page.commands.map(\.name) == ["y"])
        #expect(page.channels.isEmpty)
    }

    @Test("a save answers with the command as stored, with no description")
    func savedCommand() throws {
        let saved = try JSONDecoder().decode(SavedCommand.self, from: Data(#"""
        {"ok": true, "command": {"name": "ban", "enabled": true, "allowedChannels": ["1"], "allowedRoles": []}}
        """#.utf8))
        #expect(saved.command == ManagedCommand(name: "ban", enabled: true, allowedChannels: ["1"]))
    }

    @Test("search matches the name or the description, ignoring case and accents")
    func search() {
        let command = ManagedCommand(name: "afk", description: "Set yourself as away")
        #expect(command.matches(""))
        #expect(command.matches("  "))
        #expect(command.matches("AF"))
        #expect(command.matches("yourself"))
        #expect(!command.matches("warn"))
        #expect(ManagedCommand(name: "caf\u{00E9}").matches("cafe"))
    }
}

@Suite("Command endpoints")
struct CommandEndpointsTests {
    @Test("the list is a GET")
    func load() {
        let e = Endpoints.LoadCommands(server: "fluxer:1")
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/commands")
        #expect(e.method == .get)
        #expect(e.body == nil)
    }

    @Test("a save posts the switch, the channels and the roles under the command's name")
    func save() throws {
        let e = Endpoints.SaveCommand(
            server: "fluxer:1", name: "ban", enabled: false, channels: ["830000000000000001"],
            roles: ["850000000000000001"])
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/commands/ban")
        #expect(e.method == .post)
        #expect(e.requiresAuth)
        let body = try #require(e.body)
        let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        #expect(Set(json.keys) == ["enabled", "channels", "roles"])
        #expect(json["enabled"] as? Bool == false)
        #expect(json["channels"] as? [String] == ["830000000000000001"])
        #expect(json["roles"] as? [String] == ["850000000000000001"])
    }

    @Test("no limits go out as empty lists, and an odd name is one encoded path segment")
    func emptyAndEncoded() throws {
        let e = Endpoints.SaveCommand(server: "1", name: "a/b c", enabled: true)
        #expect(e.path == "/api/v2/guilds/1/commands/a%2Fb%20c")
        let body = try #require(e.body)
        let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        #expect(json["channels"] as? [String] == [])
        #expect(json["roles"] as? [String] == [])
    }
}

@MainActor
@Suite("Commands model")
struct CommandsModelTests {
    private func stub() -> StubClients {
        StubClients { endpoint in
            if let call = endpoint as? Endpoints.SaveCommand {
                return SavedCommand(command: ManagedCommand(
                    name: call.name, enabled: call.enabled, allowedChannels: call.channels, allowedRoles: call.roles))
            }
            return CommandsPage(
                commands: [
                    ManagedCommand(name: "afk", description: "Set yourself as away"),
                    ManagedCommand(name: "ban", description: "Ban a member"),
                ],
                channels: [ChannelOption(id: "c1", name: "mods")], roles: [RoleOption(id: "r1", name: "Moderator")])
        }
    }

    @Test("the list loads, and search narrows it")
    func loadsAndSearches() async {
        let model = CommandsModel(server: "9", session: makeSignedInSession(clients: stub()))
        #expect(!model.hasLoaded)
        await model.load()
        #expect(model.hasLoaded)
        #expect(model.shown.map(\.name) == ["afk", "ban"])
        #expect(model.channels.map(\.id) == ["c1"])
        #expect(model.roles.map(\.id) == ["r1"])
        model.searchText = "ban"
        #expect(model.shown.map(\.name) == ["ban"])
        model.searchText = "zzz"
        #expect(model.shown.isEmpty)
    }

    @Test("saving sends the whole override, and the list keeps the description")
    func saves() async throws {
        let clients = stub()
        let model = CommandsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        let ok = await model.save("ban", enabled: false, channels: ["c1"], roles: ["r1"])
        #expect(ok)
        let ban = try #require(model.command(named: "ban"))
        #expect(!ban.enabled)
        #expect(ban.allowedChannels == ["c1"])
        #expect(ban.allowedRoles == ["r1"])
        #expect(ban.description == "Ban a member")
        #expect(model.saveCount == 1)
        #expect(model.saving.isEmpty)
        let sent = try #require(clients.calls.compactMap { $0.endpoint as? Endpoints.SaveCommand }.first)
        #expect(sent.name == "ban")
        #expect(sent.enabled == false)
        #expect(sent.channels == ["c1"])
        #expect(sent.roles == ["r1"])
    }

    @Test("a refused save keeps the command as it was and shows the server's words")
    func refusedSave() async {
        let clients = stub()
        let model = CommandsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        clients.setHandler { _ in throw NetworkError.notFound(message: "Unknown command") }
        let ok = await model.save("ban", enabled: false, channels: [], roles: [])
        #expect(!ok)
        #expect(model.command(named: "ban")?.enabled == true)
        #expect(model.actionError == "Unknown command")
        #expect(model.saveCount == 0)
    }

    @Test("a failed refresh keeps the list and explains")
    func failedLoad() async {
        let clients = stub()
        let model = CommandsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        clients.setHandler { _ in throw NetworkError.forbidden(message: "You need Manage Server.") }
        await model.load()
        #expect(model.commands.count == 2)
        #expect(model.errorMessage == "You need Manage Server.")
    }
}
