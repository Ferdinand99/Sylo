import Foundation
import Testing
@testable import SyloKit

/// What's New: the server's release notes as `GET /api/v2/changelog` sends them, the call itself,
/// and the model behind the What's New page.
@Suite("Changelog")
struct ChangelogDecodingTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    @Test("A full changelog reads, with its sections, scopes and references")
    func full() throws {
        let json = #"""
            {"version":"4.6.0","releases":[
              {"version":"4.6.0","date":"2026-10-19","url":"https://github.com/Ferdinand99/Sylo/releases/tag/v4.6.0",
               "sections":[
                 {"title":"New","kind":"features","items":[
                   {"scope":"dashboard","text":"Give V2 the look of sylobot.com, see `docs/x.md`",
                    "refs":[{"label":"#266","url":"https://github.com/Ferdinand99/Sylo/issues/266"}]}]},
                 {"title":"Fixes","kind":"fixes","items":[{"scope":null,"text":"Close role-grant gaps","refs":[]}]}]},
              {"version":"4.5.0","date":null,"url":null,"sections":[]}
            ]}
            """#
        let page = try decode(ChangelogPage.self, json)
        #expect(page.version == "4.6.0")
        #expect(page.releases.map(\.id) == ["4.6.0", "4.5.0"])

        let release = page.releases[0]
        #expect(release.date == "2026-10-19")
        #expect(release.url == URL(string: "https://github.com/Ferdinand99/Sylo/releases/tag/v4.6.0"))
        #expect(release.sections.map(\.title) == ["New", "Fixes"])
        #expect(release.sections.map(\.kind) == [.features, .fixes])

        let item = release.sections[0].items[0]
        #expect(item.scope == "dashboard")
        #expect(item.text == "Give V2 the look of sylobot.com, see `docs/x.md`")
        #expect(item.refs == [ChangelogRef(label: "#266", url: URL(string: "https://github.com/Ferdinand99/Sylo/issues/266"))])
        #expect(release.sections[1].items[0].scope == nil)

        #expect(page.releases[1].date == nil)
        #expect(page.releases[1].url == nil)
        #expect(page.releases[1].sections.isEmpty)
    }

    @Test("Missing parts read as empty, and a release without a version is dropped")
    func minimal() throws {
        let page = try decode(
            ChangelogPage.self,
            #"{"releases":[{"version":"1.0.0"},{"date":"2020-01-01"},{"version":"0.9.0","sections":[{"items":[{"text":"First"},{"scope":"x"}]}]}]}"#)
        #expect(page.version == nil)
        #expect(page.releases.map(\.version) == ["1.0.0", "0.9.0"])
        #expect(page.releases[0].sections.isEmpty)
        let section = page.releases[1].sections[0]
        #expect(section.title == "")
        #expect(section.items == [ChangelogItem(text: "First")])
        #expect(try decode(ChangelogPage.self, "{}").releases.isEmpty)
    }

    @Test("A kind the app does not know is kept, not a decoding error")
    func unknownKind() throws {
        let section = try decode(ChangelogSection.self, #"{"title":"Docs","kind":"documentation","items":[]}"#)
        #expect(section.kind == .other("documentation"))
        #expect(section.kind.rawValue == "documentation")
        #expect(ChangelogKind(rawValue: "breaking") == .breaking)
        #expect(ChangelogKind(rawValue: "performance") == .performance)
        #expect(ChangelogKind(rawValue: "other") == .other("other"))
        #expect(try decode(ChangelogSection.self, #"{"title":"Misc"}"#).kind == .other(""))
    }

    @Test("A reference without a usable address keeps its label")
    func refWithoutURL() throws {
        let item = try decode(ChangelogItem.self, ##"{"text":"t","refs":[{"label":"#1"},{"label":"#2","url":""},{"url":"https://x.example"}]}"##)
        #expect(item.refs == [ChangelogRef(label: "#1", url: nil), ChangelogRef(label: "#2", url: nil)])
    }

    @Test("A release's day reads from its YYYY-MM-DD date, in the calendar it is shown in")
    func day() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let release = ChangelogRelease(version: "4.6.0", date: "2026-10-19")
        let day = try #require(release.day(in: calendar))
        let parts = calendar.dateComponents([.year, .month, .day], from: day)
        #expect(parts.year == 2026)
        #expect(parts.month == 10)
        #expect(parts.day == 19)
        #expect(ChangelogRelease(version: "1", date: "soon").day(in: calendar) == nil)
        #expect(ChangelogRelease(version: "1", date: "2026-13-40").day(in: calendar) == nil)
        #expect(ChangelogRelease(version: "1").day(in: calendar) == nil)
    }

    @Test("The changelog call goes where the server expects, signed in")
    func endpoint() {
        let all = Endpoints.Changelog()
        #expect(all.path == "/api/v2/changelog")
        #expect(all.method == .get)
        #expect(all.requiresAuth)
        #expect(all.query.isEmpty)
        #expect(Endpoints.Changelog(limit: 5).query == [URLQueryItem(name: "limit", value: "5")])
    }

    @Test("A server with the changelog route says so in its info")
    func feature() throws {
        #expect(ServerFeature.changelog.rawValue == "changelog")
        let info = try decode(ServerInfo.self, #"{"name":"Sylo","features":["app-login","changelog"]}"#)
        #expect(info.supports(.changelog))
        #expect(!ServerInfo(features: [.appLogin]).supports(.changelog))
    }
}

@MainActor
@Suite("Changelog model")
struct ChangelogModelTests {
    nonisolated static func page(releases count: Int, version: String? = "4.6.0") -> ChangelogPage {
        ChangelogPage(
            version: version,
            releases: (0..<count).map { ChangelogRelease(version: "4.\(count - $0).0") })
    }

    static func clients(_ page: ChangelogPage) -> StubClients {
        StubClients { endpoint in
            switch endpoint {
            case is Endpoints.Changelog: return page
            default: throw NetworkError.notFound
            }
        }
    }

    @Test("Loading fetches the releases and the server's own version")
    func loads() async {
        let page = Self.page(releases: 3)
        let model = ChangelogModel(session: makeSignedInSession(clients: Self.clients(page)))
        #expect(!model.hasLoaded)
        await model.load()
        #expect(model.releases == page.releases)
        #expect(model.serverVersion == "4.6.0")
        #expect(model.hasLoaded)
        #expect(!model.isLoading)
        #expect(model.errorMessage == nil)
    }

    @Test("The release matching the server's version is this version")
    func current() async {
        let model = ChangelogModel(session: makeSignedInSession(clients: Self.clients(Self.page(releases: 3, version: "4.2.0"))))
        await model.load()
        #expect(model.releases.filter(model.isCurrent).map(\.version) == ["4.2.0"])
    }

    @Test("Ten releases show at first, and ten more each time older ones are asked for")
    func paging() async {
        let model = ChangelogModel(session: makeSignedInSession(clients: Self.clients(Self.page(releases: 23))))
        await model.load()
        #expect(model.visibleReleases.count == 10)
        #expect(model.hasOlderReleases)
        model.showOlderReleases()
        #expect(model.visibleReleases.count == 20)
        #expect(model.visibleReleases == Array(model.releases.prefix(20)))
        model.showOlderReleases()
        #expect(model.visibleReleases.count == 23)
        #expect(!model.hasOlderReleases)
    }

    @Test("A failed load says why and keeps nothing it never had")
    func failure() async {
        let model = ChangelogModel(session: makeSignedInSession(clients: StubClients { _ in throw NetworkError.offline }))
        await model.load()
        #expect(model.releases.isEmpty)
        #expect(model.errorMessage == NetworkError.offline.userMessage)
        #expect(model.hasLoaded)
    }

    @Test("A refused or missing changelog is a plain message, not a crash")
    func refused() async {
        for error in [NetworkError.forbidden, .notFound] {
            let model = ChangelogModel(session: makeSignedInSession(clients: StubClients { _ in throw error }))
            await model.load()
            #expect(model.releases.isEmpty)
            #expect(model.errorMessage != nil)
        }
    }

    @Test("Being signed out shows no message of its own")
    func unauthorized() async {
        let model = ChangelogModel(session: makeSignedInSession(clients: StubClients { _ in throw NetworkError.unauthorized }))
        await model.load()
        #expect(model.errorMessage == nil)
    }

    @Test("A refresh that fails keeps the releases already shown, and a later one clears the message")
    func refreshKeepsReleases() async {
        let page = Self.page(releases: 2)
        let clients = Self.clients(page)
        let model = ChangelogModel(session: makeSignedInSession(clients: clients))
        await model.load()
        clients.setHandler { _ in throw NetworkError.timeout }
        await model.load()
        #expect(model.releases == page.releases)
        #expect(model.errorMessage != nil)
        clients.setHandler { _ in page }
        await model.load()
        #expect(model.errorMessage == nil)
    }
}
