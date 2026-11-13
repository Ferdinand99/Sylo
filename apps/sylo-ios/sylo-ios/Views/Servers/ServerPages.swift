import SwiftUI
import SyloKit

/// Which of the overview's link cards (the ones without a switch: Commands, Embed messages,
/// Insights, Leaderboard, ...) have a native screen in the app, and the screen for each. A card
/// without one still opens its page in the web dashboard, so nothing disappears until its screen
/// ships. Like ``ModuleScreens``, but for pages that belong to the server rather than to a module.
///
/// Every package registers its pages in a file of its own, so two packages never edit the same
/// file: `ServerPages+Moderation.swift` (commands), `ServerPages+Messages.swift` (embed messages)
/// and `ServerPages+Closeout.swift` (the rest). Each holds one static list, already included in
/// ``all``. To add a page, add a line to your list:
///
/// ```swift
/// extension ServerPages {
///     static let moderationPages: [ServerPage] = [
///         ServerPage("commands") { server, session in CommandsView(server: server, session: session) },
///     ]
/// }
/// ```
///
/// The card id is `card.id` from the overview. The destination is registered once in `ServerView`.
enum ServerPages {
    /// Every registered page: the lists of all packages, one per line. Do not edit.
    static let all: [ServerPage] = [
        moderationPages,
        messagesPages,
        closeoutPages,
    ].flatMap { $0 }

    static func hasScreen(_ cardID: String) -> Bool { page(for: cardID) != nil }

    @ViewBuilder
    static func screen(for cardID: String, server: ServerID, session: AppSession) -> some View {
        if let page = page(for: cardID) {
            page.screen(server, session)
        } else {
            ContentUnavailableView(
                "Not in the App Yet", systemImage: "square.grid.2x2",
                description: Text("This page isn't available in the app yet."))
        }
    }

    private static func page(for cardID: String) -> ServerPage? {
        assert(Set(all.map(\.cardID)).count == all.count, "a server page is registered twice")
        return all.first { $0.cardID == cardID }
    }
}

/// One server page: the overview card it opens from, and how to build it.
struct ServerPage {
    let cardID: String
    private let make: (ServerID, AppSession) -> AnyView

    init<Content: View>(_ cardID: String, @ViewBuilder screen: @escaping (ServerID, AppSession) -> Content) {
        self.cardID = cardID
        make = { server, session in AnyView(screen(server, session)) }
    }

    func screen(_ server: ServerID, _ session: AppSession) -> AnyView {
        make(server, session)
    }
}

/// A server page to push from the overview.
struct ServerPageRoute: Hashable {
    let cardID: String
}

/// The row of a link card whose page is in the app: icon and name, with the disclosure arrow that
/// the surrounding `NavigationLink` adds.
struct ServerPageRow: View {
    let card: OverviewCard

    @ScaledMetric(relativeTo: .body) private var iconWidth = 28

    var body: some View {
        Label {
            Text(card.name)
        } icon: {
            Image(systemName: ModuleSymbol.name(forIcon: card.icon))
                .foregroundStyle(.tint)
                .frame(width: iconWidth)
        }
    }
}
