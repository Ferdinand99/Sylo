import SwiftUI
import SyloKit

/// The Modules tab of a server: its header, then its modules grouped like the web overview, each
/// with a switch. A module with a settings screen in the app opens it (``ModuleRoute``, handled by
/// ``ServerView``); other cards without a switch (Commands, Embed messages) open in the web
/// dashboard. The server's general settings are their own tab, so that card is left out here.
struct OverviewView: View {
    let summary: ServerSummary
    let model: OverviewModel

    @Environment(AppSession.self) private var session

    var body: some View {
        content
            .task { if model.overview == nil { await model.load() } }
            // Back from a module's settings or another tab: summary lines may have changed.
            .onAppear {
                if model.overview != nil { Task { await model.load() } }
            }
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
                ForEach(overview.groups.filter { $0.cards.contains { $0.id != Self.settingsCardID } }) { group in
                    Section(group.title) {
                        ForEach(group.cards.filter { $0.id != Self.settingsCardID }) { card in
                            if card.hasToggle, ModuleScreens.hasScreen(card.id) {
                                NavigationLink(value: ModuleRoute(moduleID: card.id)) {
                                    moduleRow(card)
                                }
                            } else if card.hasToggle {
                                moduleRow(card)
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

    /// The "Settings" card: the Settings tab instead.
    private static let settingsCardID = "general"

    private func moduleRow(_ card: OverviewCard) -> some View {
        ModuleRow(card: card, isPending: model.isPending(card.id)) { enabled in
            model.setModule(card.id, enabled: enabled)
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
        OverviewView(summary: PreviewData.servers[0], model: OverviewModel(server: PreviewData.servers[0].id, session: session))
    }
    .environment(session)
}

#Preview("Largest text, dark") {
    let session = AppSession.preview(.signedIn)
    NavigationStack {
        OverviewView(summary: PreviewData.servers[0], model: OverviewModel(server: PreviewData.servers[0].id, session: session))
    }
    .environment(session)
    .dynamicTypeSize(.accessibility3)
    .preferredColorScheme(.dark)
}
