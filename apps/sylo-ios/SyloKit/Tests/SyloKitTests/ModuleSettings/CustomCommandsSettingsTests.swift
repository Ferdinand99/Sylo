import Foundation
import Testing
@testable import SyloKit

@Suite("Custom commands")
struct CustomCommandsSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/custom-commands/list`, shaped like the server sends it. The
    /// second action of `hello` is of a kind this app does not know.
    static let pageJSON = #"""
    {
      "commands": [
        {"id": "1794000000001", "name": "hello", "description": "Says hello",
         "actions": [
           {"type": "reply", "private": true,
            "messages": [{"content": "Hi {user}", "embed": null},
                         {"content": "", "embed": {"kind": "embed", "title": "Hello", "description": "{username}", "color": "#5865f2",
                                                   "image": "", "authorName": "", "authorIcon": "", "thumbnail": "",
                                                   "footerText": "", "footerIcon": "", "timestamp": true, "fields": []}}]},
           {"type": "timeout", "minutes": 5, "nested": {"a": [1, 2.5, null, true, "x"]}},
           {"type": "send", "channelId": "222222222222222222", "messages": [{"content": "Posted", "embed": null}]},
           {"type": "add-role", "roleId": "333333333333333333"},
           {"type": "remove-role", "roleId": "444444444444444444"}],
         "allowedRoles": ["333333333333333333"], "allowedChannels": [], "cooldownSeconds": 30, "reserved": false},
        {"id": "1794000000002", "name": "ban", "description": "",
         "actions": [{"type": "reply", "private": false, "messages": [{"content": "x", "embed": null}]}],
         "allowedRoles": [], "allowedChannels": [], "cooldownSeconds": 0, "reserved": true}
      ],
      "channels": [{"id": "222222222222222222", "name": "general"}],
      "roles": [{"id": "333333333333333333", "name": "Member"}, {"id": "444444444444444444", "name": "Muted"}],
      "placeholders": ["{user}", "{username}", "{server}", "{channel}", "{args}"]
    }
    """#

    private func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func page() throws -> CustomCommandsPage {
        try JSONDecoder().decode(CustomCommandsPage.self, from: Data(Self.pageJSON.utf8))
    }

    // MARK: - Decoding

    @Test("The page decodes the commands, the actions in order, the lists and the placeholders")
    func decodesPage() throws {
        let page = try page()
        #expect(page.commands.map(\.name) == ["hello", "ban"])
        #expect(page.channels.map(\.name) == ["general"])
        #expect(page.roles.map(\.name) == ["Member", "Muted"])
        #expect(page.placeholders == ["{user}", "{username}", "{server}", "{channel}", "{args}"])

        let hello = page.commands[0]
        #expect(hello.id == "1794000000001")
        #expect(hello.description == "Says hello")
        #expect(hello.allowedRoles == ["333333333333333333"])
        #expect(hello.allowedChannels.isEmpty)
        #expect(hello.cooldownSeconds == 30)
        #expect(!hello.reserved)
        #expect(hello.actions.count == 5)
        #expect(hello.actions[0].kind == .reply)
        #expect(hello.actions[0].isPrivate)
        #expect(hello.actions[0].messages.count == 2)
        #expect(hello.actions[0].messages[0].content == "Hi {user}")
        #expect(hello.actions[0].messages[0].embed == nil)
        #expect(hello.actions[0].messages[1].embed?.draft.title == "Hello")
        #expect(hello.actions[0].messages[1].embed?.draft.timestamp == true)
        #expect(hello.actions[2].kind == .send)
        #expect(hello.actions[2].channelId == "222222222222222222")
        #expect(hello.actions[3].kind == .addRole)
        #expect(hello.actions[3].roleId == "333333333333333333")
        #expect(hello.actions[4].kind == .removeRole)
        #expect(page.commands[1].reserved)
    }

    @Test("An action of an unknown kind stays at its place and goes back unchanged")
    func unknownActionKept() throws {
        let hello = try page().commands[0]
        let unknown = hello.actions[1]
        #expect(unknown.isUnknown)
        #expect(unknown.unknownType == "timeout")
        #expect(unknown.hasEffect)
        #expect(hello.actions.map(\.isUnknown) == [false, true, false, false, false])

        let body = try json(hello)
        let actions = try #require(body["actions"] as? [[String: Any]])
        #expect(actions.map { $0["type"] as? String } == ["reply", "timeout", "send", "add-role", "remove-role"])
        let kept = actions[1]
        #expect(Set(kept.keys) == ["type", "minutes", "nested"])
        #expect(kept["minutes"] as? Int == 5)
        let nested = try #require(kept["nested"] as? [String: Any])
        let list = try #require(nested["a"] as? [Any])
        #expect(list.count == 5)
    }

    @Test("Moving actions changes the order that is sent, unknown ones included")
    func order() throws {
        var hello = try page().commands[0]
        let moved = hello.actions.remove(at: 1)
        hello.actions.append(moved)
        let body = try json(hello)
        let types = try #require(body["actions"] as? [[String: Any]]).map { $0["type"] as? String }
        #expect(types == ["reply", "send", "add-role", "remove-role", "timeout"])
    }

    @Test("An action with no type is a reply, as the server reads it; one with a non-text type is kept")
    func missingType() throws {
        let json = #"""
        {"commands": [{"id": "1", "name": "a", "actions": [{"messages": [{"content": "x"}]}, {"type": 7, "z": 1}, 5]}]}
        """#
        let command = try JSONDecoder().decode(CustomCommandsPage.self, from: Data(json.utf8)).commands[0]
        // The number 5 is not an object: it is kept raw too.
        #expect(command.actions.count == 3)
        #expect(command.actions[0].kind == .reply)
        #expect(!command.actions[0].isUnknown)
        #expect(command.actions[0].messages[0].content == "x")
        #expect(command.actions[1].isUnknown)
        #expect(command.actions[2].isUnknown)
    }

    @Test("A server that sends less, or other types, still loads")
    func lenientDecoding() throws {
        let json = #"""
        {"commands": [{"id": 12, "name": "a", "cooldownSeconds": 5.0, "allowedRoles": "junk",
                       "actions": [{"type": "reply", "messages": [{"content": 5}, "junk"]}, {"type": "add-role"}]}, "junk"]}
        """#
        let page = try JSONDecoder().decode(CustomCommandsPage.self, from: Data(json.utf8))
        #expect(page.channels.isEmpty)
        #expect(page.roles.isEmpty)
        #expect(page.placeholders.isEmpty)
        #expect(page.commands.count == 1)
        let command = page.commands[0]
        #expect(command.id == "12")
        #expect(command.cooldownSeconds == 5)
        #expect(command.allowedRoles.isEmpty)
        #expect(!command.reserved)
        #expect(command.actions[0].messages.count == 1)
        #expect(command.actions[0].messages[0].content.isEmpty)
        #expect(command.actions[1].roleId.isEmpty)
    }

    // MARK: - Encoding

    @Test("The save body has exactly the keys the dashboard sends, and never `reserved`")
    func saveKeys() throws {
        let hello = try page().commands[0]
        let body = try json(hello)
        #expect(Set(body.keys) == ["id", "name", "description", "actions", "allowedRoles", "allowedChannels", "cooldownSeconds"])
        let actions = try #require(body["actions"] as? [[String: Any]])
        #expect(Set(actions[0].keys) == ["type", "messages", "private"])
        #expect(Set(actions[2].keys) == ["type", "messages", "channelId"])
        #expect(Set(actions[3].keys) == ["type", "roleId"])
        #expect(Set(actions[4].keys) == ["type", "roleId"])
        let messages = try #require(actions[0]["messages"] as? [[String: Any]])
        #expect(Set(messages[0].keys) == ["content", "embed"])
        #expect(messages[0]["embed"] is NSNull)
        let embed = try #require(messages[1]["embed"] as? [String: Any])
        #expect(embed["title"] as? String == "Hello")
        #expect(embed["timestamp"] as? Bool == true)
    }

    @Test("A new command goes out with an empty id, and the name trimmed and in lower case")
    func newCommand() throws {
        var command = CustomCommand(name: "  Hello ")
        command.actions = [CommandAction(kind: .reply, messages: [CommandMessage(content: "Hi")])]
        let body = try json(command)
        #expect(body["id"] as? String == "")
        #expect(body["name"] as? String == "hello")
        #expect(body["cooldownSeconds"] as? Int == 0)
    }

    @Test("Keys the app does not know inside an action or a message come back")
    func extraKeys() throws {
        let stored = #"""
        {"id": "1", "name": "a", "actions": [
          {"type": "reply", "private": false, "ephemeralDelay": 5,
           "messages": [{"content": "x", "embed": null, "tts": true}]}]}
        """#
        let command = try JSONDecoder().decode(CustomCommand.self, from: Data(stored.utf8))
        let body = try json(command)
        let action = try #require((body["actions"] as? [[String: Any]])?.first)
        #expect(action["ephemeralDelay"] as? Int == 5)
        let message = try #require((action["messages"] as? [[String: Any]])?.first)
        #expect(message["tts"] as? Bool == true)
    }

    @Test("A new action has the fields its kind needs")
    func blankActions() {
        #expect(CommandAction.blank(.reply).messages.count == 1)
        #expect(CommandAction.blank(.send).messages.count == 1)
        #expect(CommandAction.blank(.addRole).messages.isEmpty)
        #expect(!CommandAction.blank(.reply).hasEffect)
        #expect(!CommandAction.blank(.removeRole).hasEffect)
        var role = CommandAction.blank(.addRole)
        role.roleId = "5"
        #expect(role.hasEffect)
        var reply = CommandAction.blank(.reply)
        reply.messages[0].content = "  "
        #expect(!reply.hasEffect)
        reply.messages[0].embed = EmbedItem(EmbedDraft(title: "T"))
        #expect(reply.hasEffect)
        // An embed with only a colour says nothing: the server drops it.
        reply.messages[0].embed = EmbedItem(EmbedDraft(color: "#ff0000"))
        #expect(!reply.hasEffect)
    }

    @Test("A copy of an action has its own ids and keeps an unknown action raw")
    func duplicate() throws {
        let hello = try page().commands[0]
        let copy = hello.actions[0].duplicated()
        #expect(copy == hello.actions[0])
        #expect(copy.id != hello.actions[0].id)
        #expect(copy.messages[0].id != hello.actions[0].messages[0].id)
        #expect(hello.actions[1].duplicated().isUnknown)
    }

    // MARK: - Names

    @Test("A name is lowercase letters, digits, - and _, up to 32 characters")
    func names() {
        #expect(CustomCommandName.isValid("my-command_2"))
        #expect(CustomCommandName.isValid(" Hello "))
        #expect(CustomCommandName.normalised(" Hello ") == "hello")
        #expect(!CustomCommandName.isValid(""))
        #expect(!CustomCommandName.isValid("   "))
        #expect(!CustomCommandName.isValid("two words"))
        #expect(!CustomCommandName.isValid("dot.name"))
        #expect(!CustomCommandName.isValid("slash/name"))
        #expect(!CustomCommandName.isValid("café"))
        #expect(CustomCommandName.isValid(String(repeating: "a", count: 32)))
        #expect(!CustomCommandName.isValid(String(repeating: "a", count: 33)))
        #expect(CustomCommandName.isValid(String(repeating: "a", count: 40), maxLength: 50))
    }

    @Test("The checks of the server: a bad name, a taken name, and a command with nothing in it")
    func problems() throws {
        let others = try page().commands
        var command = CustomCommand(
            name: "fresh", actions: [CommandAction(kind: .reply, messages: [CommandMessage(content: "Hi")])])
        #expect(command.problems(others: others).isEmpty)

        command.name = "bad name"
        #expect(command.problems(others: others) == ["Invalid name — lowercase letters, numbers, - and _ only."])

        command.name = "Hello"
        #expect(command.problems(others: others) == ["/hello already exists."])
        // The command's own name is not a clash.
        command.id = others[0].id
        #expect(command.problems(others: others).isEmpty)

        command.id = ""
        command.name = "fresh"
        command.actions = [CommandAction.blank(.reply), CommandAction.blank(.addRole)]
        #expect(command.problems(others: others) == ["Every action was empty — add at least one message, role, etc."])
    }

    // MARK: - Placeholders

    @Test("Tokens are found in the text, in order, once each")
    func tokens() {
        #expect(CommandPlaceholders.tokens(in: "Hi {user}, welcome to {server}! {user}") == ["{user}", "{server}"])
        #expect(CommandPlaceholders.tokens(in: "{user.tag} {a_b} {1x} {} { user } {") == ["{user.tag}", "{a_b}"])
        #expect(CommandPlaceholders.tokens(in: "no tokens").isEmpty)
        #expect(CommandPlaceholders.tokens(in: "").isEmpty)
    }

    @Test("Tokens the command does not fill in are reported")
    func unknownTokens() {
        let known = CommandPlaceholders.standard
        #expect(CommandPlaceholders.unknownTokens(in: "{user} {args}", known: known).isEmpty)
        #expect(CommandPlaceholders.unknownTokens(in: "{user} {nope} {memberCount}", known: known) == ["{nope}", "{memberCount}"])
        #expect(CommandPlaceholders.hint(for: "{args}") == "The text typed after the command")
        #expect(CommandPlaceholders.hint(for: "{other}").isEmpty)
    }

    // MARK: - Endpoints

    @Test("Endpoint paths and methods")
    func endpoints() {
        let list = Endpoints.LoadCustomCommands(server: "9")
        #expect(list.path == "/api/v2/guilds/9/modules/custom-commands/list")
        #expect(list.method == .get)
        let save = Endpoints.SaveCustomCommand(server: "9", command: CustomCommand())
        #expect(save.path == "/api/v2/guilds/9/modules/custom-commands/cmd")
        #expect(save.method == .post)
        let delete = Endpoints.DeleteCustomCommand(server: "9", id: "1794000000001")
        #expect(delete.path == "/api/v2/guilds/9/modules/custom-commands/cmd/1794000000001/delete")
        #expect(delete.method == .post)
    }

    @Test("The save answer carries the command; a missing one is none")
    func saveAnswer() throws {
        let saved = try JSONDecoder().decode(
            CustomCommandSaved.self, from: Data(#"{"command":{"id":"3","name":"a","actions":[]}}"#.utf8))
        #expect(saved.command?.id == "3")
        #expect(try JSONDecoder().decode(CustomCommandSaved.self, from: Data("{}".utf8)).command == nil)
    }
}

/// The server's side of the custom commands for the model tests.
final class FakeCommandsServer: @unchecked Sendable {
    // @unchecked: every field is only touched while holding `lock`.
    private let lock = NSLock()
    private var _calls: [String] = []
    private var _commands: [CustomCommand]
    private var _saveError: NetworkError?
    private var _settings: GuildSettingsPage?
    private var _bodies: [CustomCommand] = []
    private var nextID = 50

    init(commands: [CustomCommand] = [], settings: GuildSettingsPage? = GuildSettingsPage(settings: GuildSettings(), platform: .discord)) {
        _commands = commands
        _settings = settings
    }

    var calls: [String] { lock.withLock { _calls } }
    var commands: [CustomCommand] { lock.withLock { _commands } }
    var bodies: [CustomCommand] { lock.withLock { _bodies } }

    func failSave(with error: NetworkError?) { lock.withLock { _saveError = error } }

    func clients() -> StubClients {
        StubClients { [self] endpoint in
            if endpoint is Endpoints.LoadCustomCommands {
                lock.withLock { _calls.append("load") }
                return lock.withLock {
                    CustomCommandsPage(
                        commands: _commands, channels: [ChannelOption(id: "c1", name: "general")],
                        roles: [RoleOption(id: "r1", name: "Member")])
                }
            }
            if endpoint is Endpoints.LoadGuildSettings {
                guard let settings = lock.withLock({ _settings }) else { throw NetworkError.notFound }
                return settings
            }
            if let saving = endpoint as? Endpoints.SaveCustomCommand {
                let body = saving.command
                lock.withLock {
                    _calls.append("save:\(body.id.isEmpty ? "new" : body.id):\(body.name)")
                    _bodies.append(body)
                }
                if let error = lock.withLock({ _saveError }) { throw error }
                return lock.withLock {
                    var stored = body
                    stored.name = CustomCommandName.normalised(body.name)
                    if stored.id.isEmpty {
                        stored.id = String(nextID)
                        nextID += 1
                    }
                    if let index = _commands.firstIndex(where: { $0.id == stored.id }) {
                        _commands[index] = stored
                    } else {
                        _commands.append(stored)
                    }
                    return CustomCommandSaved(command: stored)
                }
            }
            if let deleting = endpoint as? Endpoints.DeleteCustomCommand {
                lock.withLock {
                    _calls.append("delete:\(deleting.id)")
                    _commands.removeAll { $0.id == deleting.id }
                }
                return EmptyResponse()
            }
            throw NetworkError.notFound
        }
    }
}

@MainActor
@Suite("Custom commands model")
struct CustomCommandsModelTests {
    static let hello = CustomCommand(
        id: "1", name: "hello", description: "Says hello",
        actions: [CommandAction(kind: .reply, messages: [CommandMessage(content: "Hi {user}")])])

    func make(_ server: FakeCommandsServer) async -> CustomCommandsModel {
        let model = CustomCommandsModel(server: "9", session: makeSignedInSession(clients: server.clients()))
        await model.load()
        return model
    }

    @Test("loading fills the commands, channels, roles and the standard tokens")
    func loads() async {
        let server = FakeCommandsServer(commands: [Self.hello])
        let model = await make(server)
        #expect(model.hasLoaded)
        #expect(model.commands.map(\.name) == ["hello"])
        #expect(model.channels.map(\.name) == ["general"])
        #expect(model.roles.map(\.name) == ["Member"])
        #expect(model.placeholders == CommandPlaceholders.standard)
        #expect(model.displayName("hello") == "/hello")
        #expect(model.platform == .discord)
        #expect(model.maxCommands == 200)
        #expect(model.maxActions == 10)
        #expect(model.cooldownRange == 0...86_400)
    }

    @Test("a Fluxer server types commands with its own prefix")
    func fluxerPrefix() async {
        let settings = GuildSettingsPage(
            settings: GuildSettings(commandPrefix: ""), platform: .fluxer, defaultCommandPrefix: "!",
            effectiveCommandPrefix: "!")
        let model = await make(FakeCommandsServer(settings: settings))
        #expect(model.platform == .fluxer)
        #expect(model.displayName("hello") == "!hello")
    }

    @Test("when the settings cannot be read the name is shown without a prefix, and the page still loads")
    func prefixUnknown() async {
        let model = await make(FakeCommandsServer(settings: nil))
        #expect(model.hasLoaded)
        #expect(model.displayName("hello") == "hello")
    }

    @Test("a page that cannot be loaded says why")
    func loadFails() async {
        let model = CustomCommandsModel(
            server: "9", session: makeSignedInSession(clients: StubClients { _ in throw NetworkError.notFound }))
        await model.load()
        #expect(!model.hasLoaded)
        #expect(model.errorMessage != nil)
    }

    @Test("a new command is saved with an empty id and added; an existing one is replaced in place")
    func saves() async {
        let server = FakeCommandsServer(commands: [Self.hello])
        let model = await make(server)
        var fresh = CustomCommand(
            name: "Bye", actions: [CommandAction(kind: .reply, messages: [CommandMessage(content: "Bye")])])
        #expect(model.problems(for: fresh).isEmpty)
        #expect(await model.save(fresh))
        #expect(server.calls.contains("save:new:Bye"))
        #expect(model.commands.map(\.name) == ["hello", "bye"])
        #expect(model.commands[1].id == "50")

        fresh = model.commands[1]
        fresh.description = "Waves"
        #expect(await model.save(fresh))
        #expect(model.commands.count == 2)
        #expect(model.commands[1].description == "Waves")
        #expect(model.successCount == 2)
    }

    @Test("a refused save keeps the list and shows the server's words")
    func saveRefused() async {
        let server = FakeCommandsServer(commands: [Self.hello])
        server.failSave(with: .badRequest(message: "/ban is reserved by a built-in command."))
        let model = await make(server)
        let command = CustomCommand(
            name: "ban", actions: [CommandAction(kind: .reply, messages: [CommandMessage(content: "x")])])
        #expect(!(await model.save(command)))
        #expect(model.actionError == "/ban is reserved by a built-in command.")
        #expect(model.commands.count == 1)
        #expect(model.successCount == 0)
    }

    @Test("a command with a role the person may not hand out is refused with the server's words")
    func roleGrantRefused() async {
        let server = FakeCommandsServer()
        server.failSave(with: .forbidden(message: "Admin is above or equal to your highest role, so you can't hand it out."))
        let model = await make(server)
        let command = CustomCommand(name: "admin", actions: [CommandAction(kind: .addRole, roleId: "r1")])
        #expect(!(await model.save(command)))
        #expect(model.actionError == "Admin is above or equal to your highest role, so you can't hand it out.")
    }

    @Test("the other commands are checked for a taken name")
    func duplicateName() async {
        let model = await make(FakeCommandsServer(commands: [Self.hello]))
        let clash = CustomCommand(
            name: "Hello", actions: [CommandAction(kind: .reply, messages: [CommandMessage(content: "x")])])
        #expect(model.problems(for: clash) == ["/hello already exists."])
    }

    @Test("deleting a command removes it from the list")
    func deletes() async {
        let server = FakeCommandsServer(commands: [Self.hello])
        let model = await make(server)
        #expect(await model.delete("1"))
        #expect(model.commands.isEmpty)
        #expect(server.calls.contains("delete:1"))
    }
}
