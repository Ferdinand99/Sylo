import SwiftUI
import SyloKit

/// The Moderation tab of a server: Infractions (cases, bans, lockdown), Appeals and Commands behind
/// a segmented switch. Titles live in ``ServerView``; each part is the same screen the overview's
/// link cards and the module settings open on their own. In the focused moderator view (Sylo 5.3, an Inbox-level
/// person) it has no Commands part, which is Edit work, and no Appeals part while the Appeals module is off.
struct ModerationTabView: View {
    let server: ServerID
    let session: AppSession
    private let showsAppeals: Bool
    private let showsCommands: Bool
    private let initialPart: Part

    /// The open appeals, kept by ``ServerView`` for the tab's badge; the Appeals segment shows it too.
    @Environment(OpenAppealsModel.self) private var openAppeals: OpenAppealsModel?
    @State private var part: Part

    enum Part: Hashable {
        case infractions, appeals, commands
    }

    init(
        server: ServerID, session: AppSession, showsAppeals: Bool = true, showsCommands: Bool = true,
        initialPart: Part = .infractions
    ) {
        self.server = server
        self.session = session
        self.showsAppeals = showsAppeals
        self.showsCommands = showsCommands
        self.initialPart = initialPart
        _part = State(initialValue: initialPart)
    }

    /// "Appeals (2)": what the tab's badge counts.
    private var appealsTitle: LocalizedStringKey {
        if let count = openAppeals?.count, count > 0 { return "Appeals (\(count))" }
        return "Appeals"
    }

    /// The part shown: the chosen one, unless it is not offered here.
    private var visiblePart: Part {
        switch part {
        case .appeals where !showsAppeals: .infractions
        case .commands where !showsCommands: .infractions
        default: part
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            if showsAppeals || showsCommands {
                Picker("Section", selection: $part) {
                    Text("Infractions").tag(Part.infractions)
                    if showsAppeals { Text(appealsTitle).tag(Part.appeals) }
                    if showsCommands { Text("Commands").tag(Part.commands) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.vertical, 8)
            }

            switch visiblePart {
            case .infractions:
                ModerationView(server: server, session: session)
            case .appeals:
                AppealsReviewView(server: server, session: session, isEmbedded: true)
            case .commands:
                // Changing a command's limits is Edit work (Sylo 5.2 access levels).
                CommandsView(server: server, session: session, isEmbedded: true).disabledBelow()
            }
        }
        // The focused view starts on Appeals when that is where the server opens; the overview that decides it may
        // arrive after this view was made, so the start is applied again when it changes.
        .onChange(of: initialPart) { _, start in part = start }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn)
    NavigationStack {
        ModerationTabView(server: "1", session: session)
    }
    .environment(session)
}
