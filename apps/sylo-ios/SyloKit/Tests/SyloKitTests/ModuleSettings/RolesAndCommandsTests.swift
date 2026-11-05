import Foundation
import Testing
@testable import SyloKit

/// Encodes an endpoint's body and reads it back as a dictionary.
func bodyObject(_ endpoint: some APIEndpoint) throws -> [String: Any] {
    guard let body = endpoint.body else { throw NetworkError.encoding("no body") }
    let data = try JSONEncoder().encode(body)
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw NetworkError.encoding("not an object")
    }
    return object
}

@Suite("Reaction roles")
struct RolesModuleTests {
    /// `GET /api/v2/guilds/:id/modules/roles/list`, shaped like the server sends it.
    static let pageJSON = #"""
    {"reactionMessages": [
       {"id": "1730000000000", "channelId": "222222222222222222", "messageId": "999999999999999999",
        "style": "buttons", "message": "Pick your roles!",
        "embed": {"kind": "embed", "title": "Roles", "description": "", "color": "#5865f2", "image": "", "thumbnail": "",
                  "authorName": "", "authorIcon": "", "footerText": "", "footerIcon": "", "timestamp": false, "fields": []},
        "exclusive": true, "mode": "reverse", "placeholder": "", "selMin": 0, "selMax": 0,
        "pairs": [{"key": "🎮", "display": "🎮", "react": "🎮", "roleId": "333333333333333333", "label": "Gamer", "btnStyle": "success"},
                  {"key": "", "display": "", "react": "", "roleId": "444444444444444444", "label": "News", "btnStyle": "secondary"}]},
       {"id": "1730000000001", "channelId": "222222222222222222", "messageId": "", "style": "select",
        "message": "", "embed": {}, "exclusive": false, "mode": "default", "placeholder": "Pick", "selMin": 1, "selMax": 2,
        "pairs": []}
     ],
     "autoroles": ["333333333333333333"],
     "channels": [{"id": "222222222222222222", "name": "roles"}],
     "roles": [{"id": "333333333333333333", "name": "Gamer"}, {"id": "444444444444444444", "name": "News"}]}
    """#

    @Test("the page decodes the sets, the autoroles and the lists")
    func decodes() throws {
        let page = try JSONDecoder().decode(RolesPage.self, from: Data(Self.pageJSON.utf8))
        #expect(page.sets.count == 2)
        let first = page.sets[0]
        #expect(first.id == "1730000000000")
        #expect(first.isPublished)
        #expect(first.style == .buttons)
        #expect(first.mode == .reverse)
        #expect(first.exclusive)
        #expect(first.pairs.count == 2)
        #expect(first.pairs[0].buttonStyle == .success)
        #expect(first.pairs[0].display == "🎮")
        #expect(first.title == "Roles")
        let second = page.sets[1]
        #expect(!second.isPublished)
        #expect(second.style == .select)
        #expect(second.selMin == 1 && second.selMax == 2)
        #expect(second.title == "Reaction role")
        #expect(page.autoroles == ["333333333333333333"])
        #expect(page.roles.map(\.name) == ["Gamer", "News"])
    }

    @Test("an unknown style or button colour reads as the default")
    func unknownValues() throws {
        let json = #"{"reactionMessages": [{"id": 5, "channelId": "1", "style": "carousel", "mode": "weird", "pairs": [{"roleId": "2", "btnStyle": "neon"}]}]}"#
        let page = try JSONDecoder().decode(RolesPage.self, from: Data(json.utf8))
        #expect(page.sets[0].id == "5")
        #expect(page.sets[0].style == .reaction)
        #expect(page.sets[0].mode == .standard)
        #expect(page.sets[0].pairs[0].buttonStyle == .secondary)
        #expect(page.autoroles.isEmpty)
    }

    @Test("saving a set sends the form's fields and one row per role")
    func encodesDraft() throws {
        let page = try JSONDecoder().decode(RolesPage.self, from: Data(Self.pageJSON.utf8))
        let draft = ReactionRoleDraft(set: page.sets[0])
        let save = Endpoints.SaveReactionRoleSet(server: "1", draft: draft)
        #expect(save.path == "/api/v2/guilds/1/modules/roles/rr")
        #expect(save.method == .post)
        let body = try bodyObject(save)
        #expect(Set(body.keys) == [
            "id", "channelId", "style", "message", "embed", "exclusive", "mode", "placeholder", "selMin", "selMax",
            "pairs",
        ])
        #expect(body["id"] as? String == "1730000000000")
        #expect(body["style"] as? String == "buttons")
        #expect(body["mode"] as? String == "reverse")
        let pairs = try #require(body["pairs"] as? [[String: Any]])
        #expect(pairs.count == 2)
        #expect(Set(pairs[0].keys) == ["emoji", "label", "roleId", "btnStyle"])
        #expect(pairs[0]["emoji"] as? String == "🎮")
        #expect(pairs[0]["btnStyle"] as? String == "success")
        // A set made in the default mode is sent as "default", which is what the server stores.
        let other = try bodyObject(Endpoints.SaveReactionRoleSet(server: "1", draft: ReactionRoleDraft(set: page.sets[1])))
        #expect(other["mode"] as? String == "default")
    }

    @Test("a new set needs a channel and a role, and the reaction style an emoji")
    func problems() {
        var draft = ReactionRoleDraft()
        #expect(draft.problem == "Choose a channel.")
        draft.channelId = "222"
        #expect(draft.problem == "Add at least one role.")
        draft.rows = [ReactionRoleDraft.Row(emoji: "🎮", roleId: "")]
        #expect(draft.problem == "Every row needs a role.")
        draft.rows = [ReactionRoleDraft.Row(emoji: "", roleId: "333")]
        #expect(draft.problem == "The Reactions style needs an emoji on every row.")
        draft.style = .buttons
        #expect(draft.problem == nil)
        #expect(ReactionRoleStyle.reaction.maxRoles == 20)
        #expect(ReactionRoleStyle.select.maxRoles == 25)
    }

    @Test("the paths match the dashboard's")
    func paths() {
        #expect(Endpoints.LoadRoles(server: "fluxer:1").path == "/api/v2/guilds/fluxer%3A1/modules/roles/list")
        #expect(Endpoints.DeleteReactionRoleSet(server: "1", setID: "17").path
            == "/api/v2/guilds/1/modules/roles/rr/17/delete")
        #expect(Endpoints.SaveAutoroles(server: "1", autoroles: []).path == "/api/v2/guilds/1/modules/roles/autoroles")
    }

    @Test("a save answer reads the set, and a post that failed after saving")
    func savedAnswer() throws {
        let json = #"{"reactionMessage": {"id": "9", "channelId": "1", "messageId": "", "pairs": []}, "error": "Missing Access"}"#
        let saved = try JSONDecoder().decode(SavedReactionRoleSet.self, from: Data(json.utf8))
        #expect(saved.set.id == "9")
        #expect(saved.publishError == "Missing Access")
        let clean = try JSONDecoder().decode(
            SavedReactionRoleSet.self,
            from: Data(#"{"reactionMessage": {"id": "9", "channelId": "1"}, "error": null}"#.utf8))
        #expect(clean.publishError == nil)
    }

    @MainActor
    @Test("a change reloads the page and tells the overview to load again")
    func performs() async throws {
        let page = try JSONDecoder().decode(RolesPage.self, from: Data(Self.pageJSON.utf8))
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.DeleteReactionRoleSet { return OKResponse() }
            if endpoint is Endpoints.SaveAutoroles { return SavedAutoroles(autoroles: []) }
            return page
        }
        let session = makeSignedInSession(clients: clients)
        let model = RecordListModel<RolesPage>(roles: "1", session: session)
        await model.load()
        #expect(model.page?.sets.count == 2)
        let before = session.modulesRevision
        let ok = await model.delete(page.sets[0])
        #expect(ok)
        #expect(model.changeCount == 1)
        #expect(session.modulesRevision == before + 1)
        // load, delete, load again.
        #expect(clients.calls.count == 3)
        #expect(clients.calls[1].endpoint is Endpoints.DeleteReactionRoleSet)
    }

    @MainActor
    @Test("a refused change keeps the page and shows the server's words")
    func refused() async throws {
        let page = try JSONDecoder().decode(RolesPage.self, from: Data(Self.pageJSON.utf8))
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.SaveReactionRoleSet { throw NetworkError.badRequest(message: "Pick a channel.") }
            return page
        }
        let session = makeSignedInSession(clients: clients)
        let model = RecordListModel<RolesPage>(roles: "1", session: session)
        await model.load()
        let before = session.modulesRevision
        let saved = await model.save(ReactionRoleDraft())
        #expect(saved == nil)
        #expect(model.actionError == "Pick a channel.")
        #expect(model.page?.sets.count == 2)
        #expect(model.changeCount == 0)
        #expect(session.modulesRevision == before)
    }
}

@Suite("Custom commands")
struct CustomCommandsModuleTests {
    /// `GET /api/v2/guilds/:id/modules/custom-commands/list`, shaped like the server sends it.
    static let pageJSON = #"""
    {"commands": [
       {"id": "1730000000000", "name": "rules", "description": "Show the rules",
        "actions": [
          {"type": "reply", "private": true,
           "messages": [{"content": "Read #rules, {user}.", "embed": null},
                        {"content": "", "embed": {"kind": "embed", "title": "Rules", "description": "Be kind", "color": "#5865f2",
                                                  "image": "", "thumbnail": "", "authorName": "", "authorIcon": "",
                                                  "footerText": "", "footerIcon": "", "timestamp": false, "fields": []}}]},
          {"type": "add-role", "roleId": "333333333333333333"},
          {"type": "send", "channelId": "222222222222222222", "messages": [{"content": "Used by {username}", "embed": null}]}],
        "allowedRoles": ["333333333333333333"], "allowedChannels": [], "cooldownSeconds": 30, "reserved": false},
       {"id": "1730000000001", "name": "ping", "description": "", "reserved": true,
        "actions": [{"type": "reply", "private": false, "messages": [{"content": "pong", "embed": null}]}],
        "allowedRoles": [], "allowedChannels": [], "cooldownSeconds": 0}
     ],
     "channels": [{"id": "222222222222222222", "name": "log"}],
     "roles": [{"id": "333333333333333333", "name": "Member"}],
     "placeholders": ["{user}", "{username}", "{server}", "{channel}", "{args}"]}
    """#

    @Test("the page decodes commands, their actions and the placeholders")
    func decodes() throws {
        let page = try JSONDecoder().decode(CustomCommandsPage.self, from: Data(Self.pageJSON.utf8))
        #expect(page.commands.count == 2)
        let rules = page.commands[0]
        #expect(rules.commandID == "1730000000000")
        #expect(rules.name == "rules")
        #expect(rules.actions.map(\.type) == [.reply, .addRole, .send])
        #expect(rules.actions[0].isPrivate)
        #expect(rules.actions[0].messages.count == 2)
        #expect(rules.actions[0].messages[1].embed?.title == "Rules")
        #expect(rules.actions[1].roleId == "333333333333333333")
        #expect(rules.actions[2].channelId == "222222222222222222")
        #expect(rules.allowedRoles == ["333333333333333333"])
        #expect(rules.cooldownSeconds == 30)
        #expect(!rules.isReserved)
        #expect(page.commands[1].isReserved)
        #expect(page.placeholders.contains("{args}"))
    }

    @Test("saving sends the form's body: role actions only the role, message actions their messages")
    func encodes() throws {
        let page = try JSONDecoder().decode(CustomCommandsPage.self, from: Data(Self.pageJSON.utf8))
        let save = Endpoints.SaveCustomCommand(server: "1", command: page.commands[0])
        #expect(save.path == "/api/v2/guilds/1/modules/custom-commands/cmd")
        #expect(save.method == .post)
        let body = try bodyObject(save)
        #expect(Set(body.keys) == [
            "id", "name", "description", "actions", "allowedRoles", "allowedChannels", "cooldownSeconds",
        ])
        #expect(body["id"] as? String == "1730000000000")
        let actions = try #require(body["actions"] as? [[String: Any]])
        #expect(actions.count == 3)
        #expect(Set(actions[0].keys) == ["type", "messages", "private"])
        #expect(Set(actions[1].keys) == ["type", "roleId"])
        #expect(actions[1]["type"] as? String == "add-role")
        #expect(Set(actions[2].keys) == ["type", "messages", "channelId"])
        let messages = try #require(actions[0]["messages"] as? [[String: Any]])
        #expect(messages[0]["embed"] is NSNull)
        #expect((messages[1]["embed"] as? [String: Any])?["title"] as? String == "Rules")
    }

    @Test("a new command has one empty reply and cannot be saved until it has a name and something to do")
    func problems() {
        var command = CustomCommand()
        #expect(command.actions.count == 1)
        #expect(command.actions[0].type == .reply)
        #expect(command.problem == "Give the command a name.")
        command.name = "Bad Name"
        #expect(command.problem == "Names use lowercase letters, numbers, - and _ only.")
        command.name = "good_name-2"
        #expect(command.nameIsValid)
        #expect(command.problem == "Add at least one message or role.")
        command.actions[0].messages[0].content = "Hi"
        #expect(command.problem == nil)
        command.actions.append(CustomCommand.Action(type: .send, messages: [CustomCommand.Action.Message(content: "x")]))
        #expect(command.problem == "Choose a channel for the action that posts to a channel.")
        command.actions[1].channelId = "222"
        #expect(command.problem == nil)
        command.name = String(repeating: "a", count: 33)
        #expect(!command.nameIsValid)
    }

    @Test("the delete path carries the command's id")
    func paths() {
        #expect(Endpoints.LoadCustomCommands(server: "1").path == "/api/v2/guilds/1/modules/custom-commands/list")
        #expect(Endpoints.DeleteCustomCommand(server: "1", commandID: "17").path
            == "/api/v2/guilds/1/modules/custom-commands/cmd/17/delete")
    }
}
