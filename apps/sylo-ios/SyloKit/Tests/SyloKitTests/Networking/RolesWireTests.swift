import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import SyloKit

// What reaction roles and custom commands put on the wire, through the real client and the mock URL
// protocol. They extend `APIClientTests` so they run one after another: the mock's state is shared.
extension APIClientTests {
    private func rolesClient() throws -> URLSessionAPIClient {
        URLSessionAPIClient(
            server: try ServerURL("https://example.com/sylo"), session: MockURLProtocol.session(),
            decoder: JSONDecoder(), retryDelays: [.zero, .zero], token: { "sylo_secret" })
    }

    private func sentBody(_ mock: MockState) throws -> [String: Any] {
        let body = try #require(mock.requests.first?.body)
        return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    @Test("Saving a reaction-role set POSTs the dashboard's body and reads the set and a post error")
    func savesReactionRole() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"""
        {"reactionMessage":{"id":"1794000000009","channelId":"222222222222222222","messageId":"","style":"buttons",
          "pairs":[{"key":"1","display":"<:gamer:111>","roleId":"333333333333333333","label":"Gamer","btnStyle":"primary"}]},
         "error":"Missing Access"}
        """#)])
        var set = ReactionRoleMessage(
            channelId: "222222222222222222", style: "buttons", message: "Pick!",
            pairs: [ReactionRolePair(emoji: "<:gamer:111>", label: "Gamer", roleId: "333333333333333333",
                                     buttonStyle: "primary")])
        set.exclusive = true

        let saved = try await rolesClient().send(Endpoints.SaveReactionRole(server: "1", message: set))

        #expect(saved.error == "Missing Access")
        #expect(saved.reactionMessage?.id == "1794000000009")
        #expect(saved.reactionMessage?.isPublished == false)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/roles/rr")
        #expect(request.method == "POST")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
        let json = try sentBody(mock)
        #expect(Set(json.keys) == [
            "id", "channelId", "style", "message", "embed", "exclusive", "mode", "placeholder", "selMin", "selMax",
            "pairs",
        ])
        #expect(json["id"] as? String == "")
        #expect(json["exclusive"] as? Bool == true)
        // An untouched embed goes out empty, so the server's own look stays.
        #expect((json["embed"] as? [String: Any])?.isEmpty == true)
        let pairs = try #require(json["pairs"] as? [[String: Any]])
        #expect(pairs.count == 1)
        #expect(Set(pairs[0].keys) == ["emoji", "label", "roleId", "btnStyle"])
        #expect(pairs[0]["emoji"] as? String == "<:gamer:111>")
    }

    @Test("A role the person may not hand out comes back as a 403 with the server's words")
    func roleGrantRefusal() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(403, #"{"error":"Admin is above or equal to your highest role, so you can't hand it out."}"#)])

        let error = await #expect(throws: NetworkError.self) {
            _ = try await rolesClient().send(Endpoints.SaveReactionRole(
                server: "1", message: ReactionRoleMessage(channelId: "1", pairs: [ReactionRolePair(emoji: "🎮", roleId: "2")])))
        }

        #expect(error?.userMessage == "Admin is above or equal to your highest role, so you can't hand it out.")
        #expect(mock.requests.count == 1)
    }

    @Test("The list, the autoroles save, the delete and the emoji list use their own paths")
    func rolesPaths() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, RolesSettingsTests.pageJSON)])
        let page = try await rolesClient().send(Endpoints.LoadRoles(server: "1"))
        #expect(page.reactionMessages.count == 2)
        var request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/roles/list")
        #expect(request.method == "GET")

        mock.reset([.json(200, #"{"autoroles":["5","6"]}"#)])
        let autoroles = try await rolesClient().send(Endpoints.SaveAutoroles(server: "1", autoroles: ["5", "6", "5"]))
        #expect(autoroles.autoroles == ["5", "6"])
        request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/roles/autoroles")
        #expect(request.method == "POST")
        let body = try sentBody(mock)
        #expect(Set(body.keys) == ["autoroles"])
        #expect(body["autoroles"] as? [String] == ["5", "6", "5"])

        mock.reset([.json(200, #"{"ok":true}"#)])
        _ = try await rolesClient().send(Endpoints.DeleteReactionRole(server: "1", id: "1794000000001"))
        request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/roles/rr/1794000000001/delete")
        #expect(request.method == "POST")
        #expect(try sentBody(mock).isEmpty)

        mock.reset([.json(200, #"{"custom":[{"name":"gamer","display":"<:gamer:111>","url":"https://cdn.example.com/e.webp"}]}"#)])
        let emojis = try await rolesClient().send(Endpoints.LoadGuildEmojis(server: "1"))
        #expect(emojis.custom.map(\.display) == ["<:gamer:111>"])
        request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/emojis")
        #expect(request.method == "GET")
    }

    @Test("A server without the emoji list answers 404, which is a missing route")
    func emojiListMissing() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(404, #"{"error":"Not found"}"#)])
        let error = await #expect(throws: NetworkError.self) {
            _ = try await rolesClient().send(Endpoints.LoadGuildEmojis(server: "1"))
        }
        #expect(error == .notFound)
    }

    @Test("Saving a command POSTs the dashboard's body, unknown actions included, and reads the command")
    func savesCustomCommand() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"command":{"id":"1794000000007","name":"hello","description":"","actions":[]}}"#)])
        let stored = try #require(try JSONDecoder().decode(CustomCommandsPage.self, from: Data(CustomCommandsSettingsTests.pageJSON.utf8)).commands.first)
        var command = stored
        command.id = ""
        command.name = "Hello"

        let saved = try await rolesClient().send(Endpoints.SaveCustomCommand(server: "1", command: command))

        #expect(saved.command?.id == "1794000000007")
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/custom-commands/cmd")
        #expect(request.method == "POST")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
        let json = try sentBody(mock)
        #expect(Set(json.keys) == ["id", "name", "description", "actions", "allowedRoles", "allowedChannels", "cooldownSeconds"])
        #expect(json["name"] as? String == "hello")
        let actions = try #require(json["actions"] as? [[String: Any]])
        #expect(actions.map { $0["type"] as? String } == ["reply", "timeout", "send", "add-role", "remove-role"])
        #expect(actions[1]["minutes"] as? Int == 5)
    }

    @Test("A name the server refuses comes back as a 400 with its words")
    func commandRefused() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(400, #"{"error":"/ban is reserved by a built-in command."}"#)])
        let error = await #expect(throws: NetworkError.self) {
            _ = try await rolesClient().send(Endpoints.SaveCustomCommand(server: "1", command: CustomCommand(name: "ban")))
        }
        #expect(error?.userMessage == "/ban is reserved by a built-in command.")
    }

    @Test("The command list and the delete use their own paths")
    func commandPaths() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, CustomCommandsSettingsTests.pageJSON)])
        let page = try await rolesClient().send(Endpoints.LoadCustomCommands(server: "1"))
        #expect(page.commands.count == 2)
        var request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/custom-commands/list")
        #expect(request.method == "GET")

        mock.reset([.json(200, #"{"ok":true}"#)])
        _ = try await rolesClient().send(Endpoints.DeleteCustomCommand(server: "1", id: "1794000000001"))
        request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/custom-commands/cmd/1794000000001/delete")
        #expect(request.method == "POST")
        #expect(try sentBody(mock).isEmpty)
    }
}
