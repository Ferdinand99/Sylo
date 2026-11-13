import SwiftUI
import SyloKit

/// The Moderation tab of a server: Infractions (cases, bans, lockdown), Appeals and Commands behind
/// a segmented switch. Titles live in ``ServerView``; each part is the same screen the overview's
/// link cards and the module settings open on their own.
struct ModerationTabView: View {
    let server: ServerID
    let session: AppSession

    /// The open appeals, kept by ``ServerView`` for the tab's badge; the Appeals segment shows it too.
    @Environment(OpenAppealsModel.self) private var openAppeals: OpenAppealsModel?
    @State private var part: Part = .infractions

    enum Part: Hashable {
        case infractions, appeals, commands
    }

    /// "Appeals (2)": what the tab's badge counts.
    private var appealsTitle: LocalizedStringKey {
        if let count = openAppeals?.count, count > 0 { return "Appeals (\(count))" }
        return "Appeals"
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Section", selection: $part) {
                Text("Infractions").tag(Part.infractions)
                Text(appealsTitle).tag(Part.appeals)
                Text("Commands").tag(Part.commands)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 8)

            switch part {
            case .infractions:
                ModerationView(server: server, session: session)
            case .appeals:
                AppealsReviewView(server: server, session: session, isEmbedded: true)
            case .commands:
                CommandsView(server: server, session: session, isEmbedded: true)
            }
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn)
    NavigationStack {
        ModerationTabView(server: "1", session: session)
    }
    .environment(session)
}
