import Foundation
import Testing
@testable import SyloKit

@Suite("Command prefix")
struct CommandPrefixTests {
    /// `GET /api/v2/guilds/:id/settings` for a Fluxer server, shaped like src/web/routes/v2Api.js.
    static let fluxerJSON = #"""
    {
      "guild": {"id": "fluxer:9", "name": "Sylo HQ", "icon": null},
      "platform": "fluxer",
      "commandPrefix": "?",
      "defaultCommandPrefix": "!",
      "commandPrefixMaxLength": 5,
      "effectiveCommandPrefix": "?",
      "modlogChannelId": "222",
      "embedColorHex": "#ff8000",
      "channels": [{"id": "222", "name": "mod-log"}],
      "roles": [{"id": "444", "name": "Admins"}],
      "botMasterRoleIds": []
    }
    """#

    static func body(_ settings: GuildSettings) throws -> [String: Any] {
        let data = try JSONEncoder().encode(settings)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("a Fluxer page carries the prefix, the default, the one in use and the limit")
    func decodesFluxer() throws {
        let page = try JSONDecoder().decode(GuildSettingsPage.self, from: Data(Self.fluxerJSON.utf8))
        #expect(page.platform == .fluxer)
        #expect(page.hasCommandPrefix)
        #expect(page.settings.commandPrefix == "?")
        #expect(page.defaultCommandPrefix == "!")
        #expect(page.effectiveCommandPrefix == "?")
        #expect(page.commandPrefixMaxLength == 5)
    }

    @Test("a server on its default prefix sends an empty one")
    func decodesDefault() throws {
        let json = Self.fluxerJSON.replacingOccurrences(of: #""commandPrefix": "?""#, with: #""commandPrefix": """#)
        let page = try JSONDecoder().decode(GuildSettingsPage.self, from: Data(json.utf8))
        #expect(page.settings.commandPrefix == "")
        #expect(page.hasCommandPrefix)
    }

    @Test("a Discord server has no prefix to set, whatever the answer carries")
    func discordHasNone() throws {
        let json = Self.fluxerJSON.replacingOccurrences(of: #""platform": "fluxer""#, with: #""platform": "discord""#)
        let page = try JSONDecoder().decode(GuildSettingsPage.self, from: Data(json.utf8))
        #expect(!page.hasCommandPrefix)
        #expect(page.settings.commandPrefix == nil)
        let body = try Self.body(page.settings)
        #expect(body["commandPrefix"] == nil, "nothing is sent for Discord")
    }

    @Test("an older Sylo that sends no platform or prefix reads as before")
    func olderServer() throws {
        let page = try JSONDecoder().decode(GuildSettingsPage.self, from: Data("{}".utf8))
        #expect(!page.hasCommandPrefix)
        #expect(page.settings.commandPrefix == nil)
        #expect(page.commandPrefixMaxLength == 5)
    }

    @Test("saving sends the trimmed prefix next to the web form's fields, and an empty one resets it")
    func encodes() throws {
        let body = try Self.body(GuildSettings(modlogChannelId: "222", embedColorHex: "#112233", commandPrefix: "  ?? "))
        #expect(Set(body.keys) == ["modlogChannelId", "botMasterRoleIds", "embedColor", "commandPrefix"])
        #expect(body["commandPrefix"] as? String == "??")
        let reset = try Self.body(GuildSettings(embedColorHex: "#112233", commandPrefix: ""))
        #expect(reset["commandPrefix"] as? String == "")
    }

    @Test("a prefix round-trips through the save body")
    func roundTrips() throws {
        let settings = GuildSettings(modlogChannelId: "1", embedColorHex: "#010203", commandPrefix: "$")
        let data = try JSONEncoder().encode(settings)
        #expect(try JSONDecoder().decode(GuildSettings.self, from: data) == settings)
    }

    @Test("prefixes the server accepts", arguments: ["", "!", "?", "$", "@", "/", ".", "sy!", "!!!!!", "🙂", "🙂🙂", "é", "!?"])
    func valid(prefix: String) {
        #expect(GuildSettings(commandPrefix: prefix).commandPrefixProblem() == nil)
    }

    @Test("an emoji counts as two, so three do not fit in five")
    func emojiCountsAsTwo() {
        #expect(GuildSettings(commandPrefix: "🙂🙂").commandPrefixProblem() == nil)
        #expect(GuildSettings(commandPrefix: "🙂🙂🙂").commandPrefixProblem()?.contains("count as two") == true)
    }

    @Test("too long, spaces inside, a backtick and invisible characters are refused")
    func invalid() {
        #expect(GuildSettings(commandPrefix: "!!!!!!").commandPrefixProblem()?.contains("at most 5") == true)
        #expect(GuildSettings(commandPrefix: "! !").commandPrefixProblem()?.contains("spaces") == true)
        #expect(GuildSettings(commandPrefix: "a\tb").commandPrefixProblem()?.contains("spaces") == true)
        #expect(GuildSettings(commandPrefix: "`").commandPrefixProblem()?.contains("backtick") == true)
        #expect(GuildSettings(commandPrefix: "!\u{200B}").commandPrefixProblem()?.contains("invisible") == true)
        #expect(GuildSettings(commandPrefix: "!\u{0007}").commandPrefixProblem()?.contains("invisible") == true)
        #expect(GuildSettings(commandPrefix: "!\u{202E}").commandPrefixProblem()?.contains("invisible") == true)
        #expect(GuildSettings(commandPrefix: "\u{E000}").commandPrefixProblem()?.contains("invisible") == true)
    }

    @Test("spaces around the prefix are trimmed, like the web form; a shorter limit from the server counts")
    func trimsAndLimit() {
        #expect(GuildSettings(commandPrefix: "  !  ").commandPrefixProblem() == nil)
        #expect(GuildSettings(commandPrefix: "   ").commandPrefixProblem() == nil)
        #expect(GuildSettings(commandPrefix: "abc").commandPrefixProblem(max: 2)?.contains("at most 2") == true)
        #expect(GuildSettings(commandPrefix: nil).commandPrefixProblem() == nil)
        #expect(GuildSettings(commandPrefix: "  ! ").normalised.commandPrefix == "!")
        #expect(GuildSettings.trimmed("\u{00A0}!\u{3000}") == "!")
        #expect(GuildSettings.trimmed("\u{FEFF}!") == "!")
        #expect(GuildSettings.trimmed("!\u{200B}") == "!\u{200B}", "a zero-width space is not trimmed, so it is refused")
    }
}

@MainActor
@Suite("Command prefix in the server settings model")
struct CommandPrefixModelTests {
    nonisolated static let page = GuildSettingsPage(
        settings: GuildSettings(modlogChannelId: "1", embedColorHex: "#ff8000", commandPrefix: "?"),
        channels: [ChannelOption(id: "1", name: "mod-log")], roles: [],
        platform: .fluxer, defaultCommandPrefix: "!", effectiveCommandPrefix: "?", commandPrefixMaxLength: 5)

    func loaded(_ clients: StubClients) async -> GuildSettingsModel {
        let model = GuildSettingsModel(server: "fluxer:9", session: makeSignedInSession(clients: clients))
        await model.load()
        return model
    }

    @Test("a bad prefix blocks the save and says why; nothing is sent")
    func badPrefixBlocks() async {
        let clients = StubClients { _ in Self.page }
        let model = await loaded(clients)
        model.draft?.commandPrefix = "a b"
        #expect(model.hasChanges)
        #expect(model.draftProblem?.contains("spaces") == true)
        let ok = await model.save()
        #expect(!ok)
        #expect(model.saveError?.contains("spaces") == true)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.SaveGuildSettings })
    }

    @Test("a good prefix is saved trimmed and the page is read again")
    func savesTrimmed() async throws {
        let clients = StubClients { _ in Self.page }
        let model = await loaded(clients)
        // From now on the server answers like one that has stored the new prefix.
        clients.setHandler { endpoint in
            if endpoint is Endpoints.SaveGuildSettings { return OKResponse() }
            return GuildSettingsPage(
                settings: GuildSettings(modlogChannelId: "1", embedColorHex: "#ff8000", commandPrefix: "$"),
                channels: Self.page.channels, roles: [], platform: .fluxer, defaultCommandPrefix: "!",
                effectiveCommandPrefix: "$")
        }
        model.draft?.commandPrefix = " $ "
        #expect(model.draftProblem == nil)
        let ok = await model.save()
        #expect(ok)
        let sent = try #require(clients.calls.compactMap { $0.endpoint as? Endpoints.SaveGuildSettings }.last)
        #expect(sent.settings.commandPrefix == "$")
        #expect(model.page?.effectiveCommandPrefix == "$")
        #expect(!model.hasChanges)
    }

    @Test("spaces alone are not a change")
    func spacesAreNoChange() async {
        let model = await loaded(StubClients { _ in Self.page })
        model.draft?.commandPrefix = " ? "
        #expect(!model.hasChanges)
    }

    @Test("the server's own error for a prefix is shown")
    func serverError() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.SaveGuildSettings {
                throw NetworkError.badRequest(message: "The command prefix can not contain spaces.")
            }
            return Self.page
        }
        let model = await loaded(clients)
        model.draft?.commandPrefix = "!"
        let ok = await model.save()
        #expect(!ok)
        #expect(model.saveError == NetworkError.badRequest(message: "The command prefix can not contain spaces.").userMessage)
        #expect(model.draft?.commandPrefix == "!")
    }
}
