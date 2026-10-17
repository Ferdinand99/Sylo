import SwiftUI
import SyloKit

/// One server: its header, then its modules grouped like the web overview, each with a switch.
/// Cards without a switch (Settings, Commands, Embed messages) open in the web dashboard.
struct OverviewView: View {
    let summary: ServerSummary

    @Environment(AppSession.self) private var session
    @State private var model: OverviewModel

    init(summary: ServerSummary, session: AppSession) {
        self.summary = summary
        _model = State(initialValue: OverviewModel(server: summary.id, session: session))
    }

    var body: some View {
        content
            .navigationTitle(summary.name)
            .navigationBarTitleDisplayMode(.inline)
            .task { await model.load() }
            .alert(
                "Couldn't Change Module", isPresented: isShowingToggleError, presenting: model.toggleError
            ) { _ in
                Button("OK") {}
            } message: { message in
                Text(message)
            }
    }

    @ViewBuilder
    private var content: some View {
        if let overview = model.overview {
            List {
                // A refresh that failed: the overview below is the one loaded before.
                if let message = model.errorMessage {
                    Section {
                        StatusMessage(message, kind: .error)
                    }
                }
                Section {
                    OverviewHeader(summary: summary, overview: overview)
                }
                ForEach(overview.groups.filter { !$0.cards.isEmpty }) { group in
                    Section(group.title) {
                        ForEach(group.cards) { card in
                            if card.hasToggle {
                                ModuleRow(card: card, isPending: model.isPending(card.id)) { enabled in
                                    model.setModule(card.id, enabled: enabled)
                                }
                            } else {
                                LinkCardRow(card: card, url: webURL(for: card))
                            }
                        }
                    }
                }
            }
            .refreshable { await model.load() }
        } else if let message = model.errorMessage {
            ContentUnavailableView {
                Label("Can't Load Server", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await model.load() } }
            }
        } else {
            ProgressView()
        }
    }

    private var isShowingToggleError: Binding<Bool> {
        Binding(
            get: { model.toggleError != nil },
            set: { if !$0 { model.toggleError = nil } })
    }

    /// The card's page in the web dashboard on this Sylo server.
    private func webURL(for card: OverviewCard) -> URL? {
        guard let path = card.webPath, !path.contains("?"), let server = session.server else { return nil }
        return server.url(for: path)
    }
}

/// Icon, name, platform, members and open tickets. Stacks vertically at accessibility sizes.
private struct OverviewHeader: View {
    let summary: ServerSummary
    let overview: ServerOverview
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
            : AnyLayout(HStackLayout(spacing: 16))
        layout {
            ServerIcon(url: overview.server.iconURL ?? summary.iconURL, name: summary.name, size: 56)
            VStack(alignment: .leading, spacing: 4) {
                Text(overview.server.name)
                    .font(.headline)
                Text("\(summary.platform.displayName) · ^[\(overview.server.memberCount) member](inflect: true)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if overview.openTickets > 0 {
                    Label("^[\(overview.openTickets) open ticket](inflect: true)", systemImage: "ticket")
                        .font(.subheadline)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    let session = AppSession.preview(.signedIn)
    NavigationStack {
        OverviewView(summary: PreviewData.servers[0], session: session)
    }
    .environment(session)
}

#Preview("Largest text, dark") {
    let session = AppSession.preview(.signedIn)
    NavigationStack {
        OverviewView(summary: PreviewData.servers[0], session: session)
    }
    .environment(session)
    .dynamicTypeSize(.accessibility3)
    .preferredColorScheme(.dark)
}
