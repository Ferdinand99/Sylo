import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

@Suite("Command list")
struct CommandListDecodingTests {
    static let json = #"""
        {"commands":[
          {"signature":"/ban <user> [reason]","description":"Ban a member.","permissions":["Ban Members"],
           "options":[{"name":"user","required":true,"description":"Who","choices":[]},
                      {"name":"reason","required":false,"description":"Why","choices":["Spam","Raid"]}]},
          {"signature":"/ping","description":"Check that Sylo is awake.","permissions":null,"options":[]},
          {"signature":"/avatar","description":"Show an avatar.","permissions":[],"options":[{"nope":1}]},
          {"description":"no signature"}]}
        """#

    @Test("Commands read with their options, and an entry without a signature is dropped")
    func decodes() throws {
        let page = try decode(CommandListPage.self, Self.json)
        #expect(page.commands.map(\.signature) == ["/ban <user> [reason]", "/ping", "/avatar"])
        let ban = page.commands[0]
        #expect(ban.permissions == ["Ban Members"])
        #expect(ban.options.map(\.name) == ["user", "reason"])
        #expect(ban.options[0].isRequired)
        #expect(!ban.options[1].isRequired)
        #expect(ban.options[1].choices == ["Spam", "Raid"])
        // No permissions, or an empty list, means anyone can use it. A broken option is dropped.
        #expect(page.commands[1].permissions == nil)
        #expect(page.commands[2].permissions == nil)
        #expect(page.commands[2].options.isEmpty)
    }

    @Test("The list is public: no token goes with it")
    func endpoint() {
        let call = Endpoints.CommandList()
        #expect(call.path == "/api/v2/public/commands")
        #expect(call.method == .get)
        #expect(!call.requiresAuth)
    }
}

@MainActor
@Suite("Command list model")
struct CommandListModelTests {
    nonisolated static let page = try! decode(CommandListPage.self, CommandListDecodingTests.json)

    func loadedModel() async -> CommandListModel {
        let model = CommandListModel(session: makeSignedInSession(clients: StubClients { _ in Self.page }))
        await model.load()
        return model
    }

    @Test("Loading shows every command")
    func loads() async {
        let model = await loadedModel()
        #expect(model.hasLoaded)
        #expect(model.filtered.count == 3)
        #expect(model.errorMessage == nil)
    }

    @Test("Searching matches the signature or the description, ignoring case")
    func searches() async {
        let model = await loadedModel()
        model.query = "BAN"
        #expect(model.filtered.map(\.signature) == ["/ban <user> [reason]"])
        model.query = "awake"
        #expect(model.filtered.map(\.signature) == ["/ping"])
        model.query = "  "
        #expect(model.filtered.count == 3)
        model.query = "zzz"
        #expect(model.filtered.isEmpty)
    }

    @Test("A Sylo without the public list says so")
    func notFound() async {
        let model = CommandListModel(session: makeSignedInSession(clients: StubClients { _ in throw NetworkError.notFound }))
        await model.load()
        #expect(!model.hasLoaded)
        #expect(model.errorMessage == "This Sylo server has no command list to show.")
    }

    @Test("Another failure explains, and a later load clears it")
    func failedLoad() async {
        let clients = StubClients { _ in throw NetworkError.offline }
        let model = CommandListModel(session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.errorMessage == NetworkError.offline.userMessage)
        clients.setHandler { _ in Self.page }
        await model.load()
        #expect(model.errorMessage == nil)
        #expect(model.hasLoaded)
    }
}
