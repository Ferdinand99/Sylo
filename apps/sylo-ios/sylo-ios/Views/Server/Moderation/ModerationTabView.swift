import SwiftUI
import SyloKit

/// The Moderation tab of a server: Infractions (cases, bans, lockdown), Appeals and Commands behind
/// a segmented switch. Titles live in ``ServerView``; each part is the same screen the overview's
/// link cards and the module settings open on their own.
struct ModerationTabView: View {
    let server: ServerID
    let session: AppSession
    /// Called with the number of open appeals whenever the appeals load or one is decided, so the
    /// tab's badge stays right without reloading the overview.
    let onOpenAppeals: @MainActor (Int) -> Void

    @State private var part: Part = .infractions

    enum Part: Hashable {
        case infractions, appeals, commands
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Section", selection: $part) {
                Text("Infractions").tag(Part.infractions)
                Text("Appeals").tag(Part.appeals)
                Text("Commands").tag(Part.commands)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 8)

            switch part {
            case .infractions:
                ModerationView(server: server, session: session)
            case .appeals:
                AppealsReviewView(server: server, session: session, isEmbedded: true, onOpenCount: onOpenAppeals)
            case .commands:
                CommandsView(server: server, session: session, isEmbedded: true)
            }
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn)
    NavigationStack {
        ModerationTabView(server: "1", session: session) { _ in }
    }
    .environment(session)
}
