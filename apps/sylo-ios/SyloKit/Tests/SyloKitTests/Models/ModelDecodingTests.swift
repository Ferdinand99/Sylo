import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Fixtures.data(json))
}

@Suite("Model decoding")
struct ModelDecodingTests {
    @Test("Server info, with unknown platforms and features kept")
    func serverInfo() throws {
        let info = try decode(ServerInfo.self, Fixtures.info)
        #expect(info.name == "Sylo")
        #expect(info.isSylo)
        #expect(info.version == "4.0.0")
        #expect(info.apiVersion == 1)
        #expect(info.isLoginEnabled)
        #expect(info.loginProviders == [.discord, .fluxer])
        #expect(info.platforms == [.discord, .other("matrix")])
        #expect(info.features == [.appLogin, .liveAccess, ServerFeature(rawValue: "time-travel")])
        #expect(info.supports(.liveAccess))
        #expect(!info.supports(ServerFeature(rawValue: "missing")))
    }

    @Test("Server info in open mode has no login")
    func serverInfoOpenMode() throws {
        let info = try decode(ServerInfo.self, Fixtures.infoOpenMode)
        #expect(!info.isLoginEnabled)
        #expect(info.loginProviders.isEmpty)
    }

    @Test("Any JSON object decodes as server info, so the app can tell it is not a Sylo")
    func serverInfoForeign() throws {
        let info = try decode(ServerInfo.self, #"{"status":"ok"}"#)
        #expect(!info.isSylo)
        #expect(info.apiVersion == 0)
        #expect(!info.isLoginEnabled)
    }

    @Test("Token grant with an epoch-ms expiry and the account")
    func tokenGrant() throws {
        let grant = try decode(TokenGrant.self, Fixtures.token)
        #expect(grant.token == "sylo_dGhpcyBpcyBub3QgYSByZWFsIHRva2VuIGF0IGFsbA")
        #expect(abs(grant.expiresAt.timeIntervalSince1970 - 1_799_999_999.999) < 0.0005)
        #expect(grant.account.name == "ferdi")
        #expect(grant.account.avatarURL?.absoluteString == "https://cdn.discordapp.com/avatars/123/abc.png?size=128")
        #expect(grant.account.platforms == [.discord, .fluxer, .other("matrix")])
        #expect(!grant.account.isOwner)
    }

    @Test("Token grant without an avatar")
    func tokenGrantNoAvatar() throws {
        let grant = try decode(TokenGrant.self, Fixtures.tokenNoAvatar)
        #expect(grant.account.avatarURL == nil)
        #expect(grant.account.isOwner)
        #expect(grant.expiresAt == Date(timeIntervalSince1970: 1_760_000_000))
    }

    @Test("A token grant never prints the token")
    func tokenGrantRedacted() throws {
        let grant = try decode(TokenGrant.self, Fixtures.token)
        #expect(!String(describing: grant).contains("sylo_"))
        #expect(!String(reflecting: grant).contains("sylo_"))
    }

    @Test("Server list, skipping an entry that cannot be read")
    func servers() throws {
        let list = try decode(ServerList.self, Fixtures.servers)
        #expect(list.servers.map(\.id) == ["123456789012345678", "fluxer:223456789012345678", "9"])
        #expect(list.servers[0].iconURL?.host == "cdn.discordapp.com")
        #expect(list.servers[0].platform == .discord)
        #expect(list.servers[1].iconURL == nil)
        #expect(list.servers[1].platform == .fluxer)
        #expect(list.servers[2].platform == .other("matrix"))
        #expect(list.servers[2].platform.displayName == "matrix")
        #expect(Platform.fluxer.displayName == "Fluxer")
    }

    @Test("Server overview: header, groups, module and link cards")
    func overview() throws {
        let overview = try decode(ServerOverview.self, Fixtures.overview)
        #expect(overview.server.id == "fluxer:223456789012345678")
        #expect(overview.server.name == "Beta")
        #expect(overview.server.iconURL == nil)
        #expect(overview.server.memberCount == 42)
        #expect(overview.openTickets == 2)
        #expect(overview.openAppeals == 1)
        #expect(overview.groups.map(\.title) == ["Core", "Engagement", "Social alerts"])

        let core = overview.groups[0].cards
        #expect(core.map(\.id) == ["general", "commands", "moderation"])
        let settings = try #require(core.first)
        #expect(settings.kind == .link)
        #expect(settings.status == .link)
        #expect(!settings.hasToggle)
        #expect(settings.isEnabled == nil)
        #expect(settings.moduleID == nil)
        #expect(settings.webPath == "/guilds/fluxer:223456789012345678/settings")
        #expect(settings.lines == [StatusLine(label: "Mod-log channel", value: "not set", state: .off)])

        let moderation = core[2]
        #expect(moderation.kind == .module)
        #expect(moderation.moduleID == "moderation")
        #expect(moderation.name == "Moderation")
        #expect(moderation.icon == "shield")
        #expect(moderation.description == "Warn, timeout, kick and ban.")
        #expect(moderation.hasToggle)
        #expect(moderation.isEnabled == true)
        #expect(!moderation.isBeta)
        #expect(moderation.status == .on)
        #expect(moderation.lines.map(\.state) == [.on, .off])
    }

    @Test("Unknown kinds, statuses and line states keep their raw value; unreadable cards are skipped")
    func overviewUnknownValues() throws {
        let overview = try decode(ServerOverview.self, Fixtures.overview)
        let cards = overview.groups[1].cards
        #expect(cards.map(\.id) == ["welcome", "auto-react", "chart"])

        let welcome = cards[0]
        #expect(welcome.isBeta)
        #expect(welcome.status == .blocked)
        #expect(welcome.missingIntents == ["GuildMembers"])
        #expect(welcome.isEnabled == false)

        let autoReact = cards[1]
        #expect(autoReact.status == .other("paused"))
        #expect(autoReact.status.rawValue == "paused")
        #expect(autoReact.lines.first?.state == .other("warning"))
        #expect(autoReact.description == nil)
        #expect(autoReact.missingIntents.isEmpty)
        #expect(!autoReact.isBeta)
        #expect(autoReact.webPath == nil)

        #expect(cards[2].kind == .other("widget"))
        #expect(cards[2].moduleID == nil)
        #expect(overview.groups[2].cards.isEmpty)
    }

    @Test("Module toggle answer")
    func toggle() throws {
        #expect(try decode(ModuleToggleResult.self, Fixtures.toggle).isEnabled)
    }

    @Test("Account with platforms and devices, dates from epoch ms")
    func account() throws {
        let account = try decode(AccountInfo.self, Fixtures.account)
        #expect(!account.isOpen)
        #expect(account.platforms.map(\.platform) == [.discord, .fluxer])
        let discord = account.platforms[0]
        #expect(discord.label == "Discord")
        #expect(discord.isConnected)
        #expect(discord.username == "ferdi")
        #expect(discord.serverCount == 12)
        #expect(discord.connectPath == nil)
        #expect(discord.canDisconnect)
        #expect(account.platforms[1].connectPath == "/auth/connect/fluxer")
        #expect(account.platforms[1].username == nil)

        #expect(account.devices.count == 2)
        let phone = account.devices[0]
        #expect(phone.id == "6f1c2a8e-0b7d-4a51-9a63-2d4e5f6a7b8c")
        #expect(phone.name == "iPhone — Sylo app")
        #expect(phone.createdAt == Date(timeIntervalSince1970: 1_760_000_000))
        #expect(abs(phone.lastUsedAt.timeIntervalSince1970 - 1_760_600_000.5) < 0.0005)
        #expect(phone.isCurrent)
        #expect(!account.devices[1].isCurrent)
    }

    @Test("Account in open mode")
    func accountOpenMode() throws {
        let account = try decode(AccountInfo.self, Fixtures.accountOpenMode)
        #expect(account.isOpen)
        #expect(account.platforms.isEmpty)
        #expect(account.devices.isEmpty)
    }

    @Test("Plain ok answer")
    func ok() throws {
        #expect(try decode(OKResponse.self, Fixtures.ok).ok)
    }
}

@Suite("Epoch milliseconds")
struct EpochMillisecondsTests {
    private struct Stamp: Decodable {
        let at: Date
        let maybe: Date?
        let label: String

        enum CodingKeys: String, CodingKey { case at, maybe, label }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            at = try c.decodeEpochMilliseconds(forKey: .at)
            maybe = try c.decodeEpochMillisecondsIfPresent(forKey: .maybe)
            label = try c.decode(String.self, forKey: .label)
        }
    }

    @Test("Reads milliseconds since 1970 without touching other fields")
    func decodes() throws {
        let stamp = try decode(Stamp.self, #"{"at":1700000000123,"maybe":0,"label":"2024-01-01"}"#)
        #expect(abs(stamp.at.timeIntervalSince1970 - 1_700_000_000.123) < 0.0005)
        #expect(stamp.maybe == Date(timeIntervalSince1970: 0))
        #expect(stamp.label == "2024-01-01")
    }

    @Test("Missing or null optional dates are nil")
    func optional() throws {
        #expect(try decode(Stamp.self, #"{"at":1,"label":"x"}"#).maybe == nil)
        #expect(try decode(Stamp.self, #"{"at":1,"maybe":null,"label":"x"}"#).maybe == nil)
    }

    @Test("A date that is not a number is a decoding error")
    func rejectsStrings() {
        #expect(throws: DecodingError.self) { try decode(Stamp.self, #"{"at":"yesterday","label":"x"}"#) }
    }
}
