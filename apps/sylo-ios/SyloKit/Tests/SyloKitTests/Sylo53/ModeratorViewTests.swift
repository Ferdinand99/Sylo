import Foundation
import Testing
@testable import SyloKit

// The focused moderator view (Sylo 5.3, `moderator-view`): who gets it, what it lists, where a server opens. The app
// also talks to servers on 5.2 and older and self-hosted ones, which do not announce the feature: they keep the full
// app for everyone, so each rule is checked against both shapes.

private func card(_ id: String, on: Bool? = true, toggle: Bool = true) -> OverviewCard {
    OverviewCard(
        kind: .module, id: id, name: id.capitalized, hasToggle: toggle, isEnabled: toggle ? on : nil,
        status: on == true ? .on : .off)
}

private func overview(
    tickets: Bool? = true, appeals: Bool? = true, applications: Bool? = true, suggestions: Bool? = true,
    omit: Set<String> = []
) -> ServerOverview {
    let cards = [
        ("tickets", tickets), ("appeals", appeals), ("applications", applications), ("suggestions", suggestions),
        ("leveling", true), ("welcome", false),
    ]
    .filter { !omit.contains($0.0) }
    .map { card($0.0, on: $0.1) }
    return ServerOverview(
        server: OverviewServer(id: "1", name: "HQ"),
        groups: [OverviewGroup(title: "Everything", cards: cards)])
}

@Suite("Moderator view: who gets it")
struct ModeratorViewModeTests {
    @Test("Inbox on a 5.3 server gets the focused view, unless they chose to see everything")
    func inboxFocused() {
        #expect(ModeratorView.mode(access: .inbox, supports: true, showEverything: false) == .focused)
        #expect(ModeratorView.mode(access: .inbox, supports: true, showEverything: true) == .full)
    }

    @Test("View and Edit keep the full app, and so does a server without levels")
    func othersFull() {
        for access in [DashboardAccess.view, .edit, .other("manager")] {
            #expect(ModeratorView.mode(access: access, supports: true, showEverything: false) == .full)
            #expect(ModeratorView.mode(access: access, supports: nil, showEverything: false) == .full)
        }
        #expect(ModeratorView.mode(access: nil, supports: true, showEverything: false) == .full)
        #expect(ModeratorView.mode(access: nil, supports: nil, showEverything: false) == .full)
    }

    @Test("A server that does not announce the feature (5.2, self-hosted) keeps the full app, also for Inbox")
    func olderServer() {
        #expect(ModeratorView.mode(access: .inbox, supports: false, showEverything: false) == .full)
        #expect(ModeratorView.mode(access: .inbox, supports: false, showEverything: true) == .full)
    }

    @Test("An Inbox person waits while the features are not known, so the full app never flashes")
    func undecided() {
        #expect(ModeratorView.mode(access: .inbox, supports: nil, showEverything: false) == .undecided)
        // Nobody else waits for anything.
        #expect(ModeratorView.mode(access: .edit, supports: nil, showEverything: false) == .full)
    }

    @Test("Only an Inbox person on a 5.3 server may switch views")
    func canChoose() {
        #expect(ModeratorView.canChoose(access: .inbox, supports: true))
        #expect(!ModeratorView.canChoose(access: .inbox, supports: false))
        #expect(!ModeratorView.canChoose(access: .inbox, supports: nil))
        #expect(!ModeratorView.canChoose(access: .view, supports: true))
        #expect(!ModeratorView.canChoose(access: .edit, supports: true))
        #expect(!ModeratorView.canChoose(access: nil, supports: true))
    }

    @Test("The feature string is `moderator-view`")
    func featureString() {
        #expect(ServerFeature.moderatorView.rawValue == "moderator-view")
        #expect(ModeratorView.showEverythingKey == "moderatorView.showEverything")
    }

    @Test("A 5.3 info lists the feature, a 5.2 info does not, and both decode")
    func infoShapes() throws {
        let info53 = try JSONDecoder().decode(
            ServerInfo.self,
            from: Data(#"{"name":"Sylo","version":"5.3.0","apiVersion":1,"login":true,"loginProviders":["discord"],"platforms":["discord"],"features":["app-login","access-levels","moderator-view","update-notice","public-page-look","some-future-feature"]}"#.utf8))
        #expect(info53.supports(.moderatorView))
        #expect(info53.supports(.updateNotice))
        #expect(info53.supports(.publicPageLook))
        let info52 = try JSONDecoder().decode(
            ServerInfo.self,
            from: Data(#"{"name":"Sylo","version":"5.2.0","apiVersion":1,"login":true,"loginProviders":["discord"],"platforms":["discord"],"features":["app-login","access-levels","message-move"]}"#.utf8))
        #expect(!info52.supports(.moderatorView))
        #expect(!info52.supports(.updateNotice))
        #expect(!info52.supports(.publicPageLook))
    }

    @Test("The level of a server comes from the server list; a 5.2 list without one reads as Edit")
    func levelFromList() throws {
        let list = try JSONDecoder().decode(
            ServerList.self,
            from: Data(#"{"guilds":[{"id":"1","name":"Mod","access":"inbox"},{"id":"2","name":"Old"}]}"#.utf8))
        #expect(list.servers[0].access == .inbox)
        #expect(list.servers[1].access == nil)
        #expect(list.servers[1].effectiveAccess == .edit)
        #expect(ModeratorView.mode(access: list.servers[0].access, supports: true, showEverything: false) == .focused)
        #expect(ModeratorView.mode(access: list.servers[1].access, supports: true, showEverything: false) == .full)
    }
}

@Suite("Moderator view: what it lists")
struct ModeratorViewContentTests {
    @Test("With every inbox on: Tickets, Tools and Moderation, in that order")
    func allOn() {
        #expect(ModeratorView.tabs(overview: overview()) == [.tickets, .tools, .moderation])
        #expect(ModeratorView.tools(overview: overview()) == [.applications, .suggestions, .memberData])
        #expect(ModeratorView.showsAppeals(overview: overview()))
    }

    @Test("A switched-off module leaves the view; Member data and the Moderation hub always stay")
    func someOff() {
        let quiet = overview(tickets: false, appeals: false, applications: false, suggestions: false)
        #expect(ModeratorView.tabs(overview: quiet) == [.tools, .moderation])
        #expect(ModeratorView.tools(overview: quiet) == [.memberData])
        #expect(!ModeratorView.showsAppeals(overview: quiet))
        let some = overview(applications: false)
        #expect(ModeratorView.tools(overview: some) == [.suggestions, .memberData])
    }

    @Test("A card the overview does not list counts as on, and so does everything before the overview is known")
    func unknownIsOn() {
        let missing = overview(omit: ["tickets", "suggestions"])
        #expect(ModeratorView.tabs(overview: missing).contains(.tickets))
        #expect(ModeratorView.tools(overview: missing).contains(.suggestions))
        #expect(ModeratorView.tabs(overview: nil) == [.tickets, .tools, .moderation])
        #expect(ModeratorView.tools(overview: nil) == [.applications, .suggestions, .memberData])
        #expect(ModeratorView.landing(overview: nil) == .tickets)
        // A switch that is on but not reported as enabled is off, as on the web.
        let blank = ServerOverview(
            server: OverviewServer(id: "1", name: "HQ"),
            groups: [OverviewGroup(title: "G", cards: [card("tickets", on: nil)])])
        #expect(!ModeratorView.isModuleOn("tickets", in: blank))
    }

    @Test("A server opens on the first inbox that is on: tickets, appeals, applications or suggestions, else the hub")
    func landing() {
        #expect(ModeratorView.landing(overview: overview()) == .tickets)
        #expect(ModeratorView.landing(overview: overview(tickets: false)) == .appeals)
        #expect(ModeratorView.landing(overview: overview(tickets: false, appeals: false)) == .applications)
        #expect(
            ModeratorView.landing(overview: overview(tickets: false, appeals: false, applications: false))
                == .applications)
        #expect(
            ModeratorView.landing(
                overview: overview(tickets: false, appeals: false, applications: false, suggestions: false))
                == .moderationHub)
    }

    @Test("Each landing opens its own tab")
    func landingTabs() {
        #expect(ModeratorView.Landing.tickets.tab == .tickets)
        #expect(ModeratorView.Landing.appeals.tab == .moderation)
        #expect(ModeratorView.Landing.applications.tab == .tools)
        #expect(ModeratorView.Landing.moderationHub.tab == .moderation)
    }

    @Test("The search lists the moderation pages only, never settings, audit log, insights or module settings")
    func search() {
        let pages = ModeratorView.searchPages(overview: overview())
        #expect(pages == [.tickets, .appeals, .moderation, .memberData])
        for forbidden in [SearchPage.settings, .auditLog, .insights, .leaderboard, .commands, .messages] {
            #expect(!pages.contains(forbidden))
        }
        #expect(ModeratorView.searchPages(overview: overview(tickets: false, appeals: false)) == [.moderation, .memberData])

        let scoped = ModeratorView.searchOverview(overview())
        #expect(scoped?.groups.flatMap(\.cards).map(\.id) == ["applications", "suggestions"])
        #expect(ModeratorView.searchOverview(nil) == nil)
        // No module of the server's settings is searchable.
        let items = SearchIndex.items(overview: scoped, pages: pages)
        #expect(!items.contains { $0.id == "module:leveling" || $0.id == "module:welcome" })
        #expect(items.contains { $0.id == "module:applications" })
    }
}
