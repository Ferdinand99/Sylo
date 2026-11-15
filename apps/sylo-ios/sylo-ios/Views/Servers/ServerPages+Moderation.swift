import SwiftUI
import SyloKit

extension ServerPages {
    /// The pages of the moderation work. Add one line per page; see ServerPages.
    static let moderationPages: [ServerPage] = [
        // Changing a command's limits is Edit work (Sylo 5.2 access levels).
        ServerPage("commands") { server, session in CommandsView(server: server, session: session).lockedBelow() },
    ]
}
