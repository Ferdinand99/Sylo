import SwiftUI
import SyloKit

extension ServerPages {
    /// The pages of the moderation work. Add one line per page; see ServerPages.
    static let moderationPages: [ServerPage] = [
        ServerPage("commands") { server, session in CommandsView(server: server, session: session) },
    ]
}
