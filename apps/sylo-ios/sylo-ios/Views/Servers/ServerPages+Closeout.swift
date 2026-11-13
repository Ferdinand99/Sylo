import SwiftUI
import SyloKit

extension ServerPages {
    /// The pages of the closeout work. Add one line per page; see ServerPages.
    static let closeoutPages: [ServerPage] = [
        // The Insights module's card has a switch and no settings, so it opens the page like the
        // web card does (the Server tools section opens the same screen).
        ServerPage("insights") { server, session in InsightsView(server: server, session: session) },
    ]
}
