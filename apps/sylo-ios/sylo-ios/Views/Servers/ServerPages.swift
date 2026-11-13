import SwiftUI
import SyloKit

/// Which of the overview's link cards (the ones without a switch: Commands, Embed messages,
/// Insights, Leaderboard, ...) have a native screen in the app, and the screen for each. A card
/// without one still opens its page in the web dashboard, so nothing disappears until its screen
/// ships. Like ``ModuleScreens``, but for pages that belong to the server rather than to a module.
///
/// To add a page: put the card's id (`card.id` from the overview, e.g. `"commands"`) in ``ids``
/// and a `case` in ``screen(for:server:session:)``. That is the only edit outside your own files.
enum ServerPages {
    static func hasScreen(_ cardID: String) -> Bool { ids.contains(cardID) }

    private static let ids: Set<String> = []

    @ViewBuilder
    static func screen(for cardID: String, server: ServerID, session: AppSession) -> some View {
        switch cardID {
        default:
            ContentUnavailableView(
                "Not in the App Yet", systemImage: "square.grid.2x2",
                description: Text("Open this page in the web dashboard for now."))
        }
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
