import SwiftUI
import SyloKit

extension ServerPages {
    /// The pages of the messages work. Add one line per page; see ServerPages.
    static let messagesPages: [ServerPage] = [
        ServerPage("messages") { server, session in MessagesView(server: server, session: session) },
    ]
}
