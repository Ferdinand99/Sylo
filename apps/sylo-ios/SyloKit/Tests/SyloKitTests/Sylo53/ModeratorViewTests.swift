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

@Suite("Moderator view: round two")
struct ModeratorViewRoundTwoTests {
    @Test("An Inbox person waits only while nothing says whether the server has the feature")
    func supportsTable() {
        // The feature is announced: true, whatever else is known.
        #expect(ModeratorView.supports(hasFeature: true, featuresRead: false, serverInfoKnown: false, waited: false) == true)
        // Nothing is known yet: wait.
        #expect(ModeratorView.supports(hasFeature: false, featuresRead: false, serverInfoKnown: false, waited: false) == nil)
        // A 5.2 server whose info the sign-in read already: no spinner at all.
        #expect(ModeratorView.supports(hasFeature: false, featuresRead: false, serverInfoKnown: true, waited: false) == false)
        // The read of the features finished (it worked, or it failed): decided.
        #expect(ModeratorView.supports(hasFeature: false, featuresRead: true, serverInfoKnown: false, waited: false) == false)
        // The short wait is over: the app draws as it does without the feature.
        #expect(ModeratorView.supports(hasFeature: false, featuresRead: false, serverInfoKnown: false, waited: true) == false)
    }

    @Test("The wait is short, and an Inbox person on a server without the feature gets the full app at once")
    func boundedWait() {
        #expect(ModeratorView.featureWait <= .seconds(5))
        let known52 = ModeratorView.supports(hasFeature: false, featuresRead: false, serverInfoKnown: true, waited: false)
        #expect(ModeratorView.mode(access: .inbox, supports: known52, showEverything: false) == .full)
        let waiting = ModeratorView.supports(hasFeature: false, featuresRead: false, serverInfoKnown: false, waited: false)
        #expect(ModeratorView.mode(access: .inbox, supports: waiting, showEverything: false) == .undecided)
        let expired = ModeratorView.supports(hasFeature: false, featuresRead: false, serverInfoKnown: false, waited: true)
        #expect(ModeratorView.mode(access: .inbox, supports: expired, showEverything: false) == .full)
        // Nobody below Inbox ever waits.
        #expect(ModeratorView.mode(access: .edit, supports: waiting, showEverything: false) == .full)
    }

    @Test("The Moderation tab opens on Appeals when that is where the server lands, and on Infractions otherwise")
    func moderationStart() {
        func cards(tickets: Bool, appeals: Bool) -> ServerOverview {
            func card(_ id: String, _ on: Bool) -> OverviewCard {
                OverviewCard(kind: .module, id: id, name: id, hasToggle: true, isEnabled: on, status: on ? .on : .off)
            }
            return ServerOverview(
                server: OverviewServer(id: "1", name: "HQ"),
                groups: [OverviewGroup(title: "G", cards: [card("tickets", tickets), card("appeals", appeals)])])
        }
        // Before the overview is known the server lands on tickets, so Infractions.
        #expect(ModeratorView.moderationStart(overview: nil) == .infractions)
        #expect(ModeratorView.moderationStart(overview: cards(tickets: true, appeals: true)) == .infractions)
        #expect(ModeratorView.moderationStart(overview: cards(tickets: false, appeals: true)) == .appeals)
        // Appeals off as well: the hub, on Infractions.
        #expect(ModeratorView.moderationStart(overview: cards(tickets: false, appeals: false)) == .infractions)
        // The start changes when the overview arrives: that change is what the Moderation tab applies again.
        #expect(
            ModeratorView.moderationStart(overview: nil) != ModeratorView.moderationStart(overview: cards(tickets: false, appeals: true)))
        // Appeals as a landing only lands on the Moderation tab, which is where the start applies.
        #expect(ModeratorView.landing(overview: cards(tickets: false, appeals: true)).tab == .moderation)
    }
}

@Suite("Public pages: round two")
struct AccentColourRoundTwoTests {
    @Test("The raw ratio decides, as on the server: 2.995:1 falls back although it shows as 3:1")
    func rawRatio() {
        // #959595 on the white card is 2.9953:1, which rounds to 3.00 for display.
        #expect(AccentColour.ratio(of: "#959595", dark: false) == 3.0)
        #expect(AccentColour.fallbackThemes("#959595") == ["light"])
        #expect(AccentColour.effective("#959595", dark: false) == AccentColour.syloAccent.light)
        #expect(AccentColour.fallbackNote("#959595")?.contains("the light theme") == true)
        // The dark card is fine with it.
        #expect(AccentColour.effective("#959595", dark: true) == "#959595")
    }

    @Test("Mixing two colours rounds halves up, like the server")
    func mix() {
        #expect(AccentColour.mix("#000000", "#ffffff", 0.5) == "#808080")
        #expect(AccentColour.mix("#000000", "#ffffff", 0) == "#000000")
        #expect(AccentColour.mix("#102030", "#ffffff", 1) == "#ffffff")
        #expect(AccentColour.mix("nope", "#ffffff", 0.5) == "nope")
    }

    @Test("Text in the accent is the accent lightened or darkened until it reads, as on the pages")
    func accentText() {
        // Values worked out with the server's algorithm (src/lib/publicLook.js accentText).
        #expect(AccentColour.accentText("#5865f2", dark: true) == "#737ef4")
        #expect(AccentColour.accentText("#5865f2", dark: false) == "#4c57d0")
        #expect(AccentColour.accentText("#ff0000", dark: true) == "#ff3333")
        #expect(AccentColour.accentText("#ff0000", dark: false) == "#c20000")
        // An accent that already reads stays as it is.
        #expect(AccentColour.accentText("#00aa00", dark: true) == "#00aa00")
        #expect(AccentColour.accentText("#00aa00", dark: false) == "#007700")
    }

    @Test("The text colour really used is Sylo's own where the accent is not used")
    func effectiveText() {
        #expect(AccentColour.effectiveText("", dark: true) == AccentColour.syloAccent.dark)
        #expect(AccentColour.effectiveText("#ffff00", dark: false) == AccentColour.syloAccent.light)
        #expect(AccentColour.effectiveText("#5865f2", dark: true) == "#737ef4")
        #expect(AccentColour.effectiveText("not a colour", dark: true) == AccentColour.syloAccent.dark)
    }
}
