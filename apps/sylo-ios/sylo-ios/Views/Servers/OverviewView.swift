import SwiftUI
import SyloKit

/// The Modules tab of a server: its header, then its modules grouped like the web overview, each
/// with a switch. A module with a settings screen in the app opens it (``ModuleRoute``, handled by
/// ``ServerView``); the cards without a switch (Commands, Embed messages) open their screen from
/// ``ServerPages``. The server's
/// general settings are their own tab, so that card is left out here.
struct OverviewView: View {
    let summary: ServerSummary
    let model: OverviewModel

    @State private var searchText = ""
    /// Select mode: pick modules, then switch them all on or off with one call.
    @State private var isSelecting = false
    @State private var picked: Set<String> = []

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
            .alert(
                "Some Modules Didn’t Change", isPresented: isShowingBulkNotice, presenting: model.bulkNotice
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
                if !isSelecting, !isSearching {
                    ServerToolsSection(server: summary.id) { startSelecting() }
                }
                ForEach(shownGroups(overview)) { group in
                    Section(group.title) {
                        ForEach(group.cards) { card in
                            if isSelecting {
                                // Only modules with a switch can be picked.
                                if card.hasToggle, card.moduleID != nil {
                                    ModuleSelectionRow(card: card, isSelected: picked.contains(card.id)) {
                                        togglePicked(card.id)
                                    }
                                }
                            } else if card.hasToggle, ModuleScreens.hasScreen(card.id) {
                                NavigationLink(value: ModuleRoute(moduleID: card.id)) {
                                    moduleRow(card)
                                }
                            } else if card.hasToggle {
                                moduleRow(card)
                            } else if ServerPages.hasScreen(card.id) {
                                NavigationLink(value: ServerPageRoute(cardID: card.id)) {
                                    ServerPageRow(card: card)
                                }
                            }
                        }
                    }
                }
            }
            .tabBarClearance()
            .safeAreaInset(edge: .bottom) {
                if isSelecting {
                    ModuleSelectionBar(
                        count: picked.count, isBusy: model.isBulkSwitching, cancel: stopSelecting,
                        turnOn: { applyBulk(enabled: true) }, turnOff: { applyBulk(enabled: false) })
                }
            }
            .searchable(text: $searchText, prompt: "Search modules")
            .overlay {
                if isSearching, shownGroups(overview).isEmpty {
                    ContentUnavailableView(
                        "No Modules Match", systemImage: "magnifyingglass",
                        description: Text("No module matches \u{201C}\(searchText.trimmingCharacters(in: .whitespacesAndNewlines))\u{201D}."))
                }
            }
            .refreshable { await model.load() }
        } else if let message = model.errorMessage {
            ContentUnavailableView {
                Label("Couldn't Load Server", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await model.load() } }
            }
        } else {
            ProgressView()
        }
    }

    private func startSelecting() {
        picked = []
        isSelecting = true
    }

    private func stopSelecting() {
        isSelecting = false
        picked = []
    }

    private func togglePicked(_ id: String) {
        if picked.contains(id) { picked.remove(id) } else { picked.insert(id) }
    }

    /// Switches the picked modules in one call, then leaves select mode unless it went wrong.
    private func applyBulk(enabled: Bool) {
        guard let task = model.setModules(Array(picked), enabled: enabled) else { return }
        Task {
            await task.value
            if model.toggleError == nil { stopSelecting() }
        }
    }

    private var isSearching: Bool { !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The groups to list: the search applied, and the "Settings" card (its own tab) left out, so
    /// a group that only had that card does not show up empty.
    private func shownGroups(_ overview: ServerOverview) -> [OverviewGroup] {
        overview.groups(matching: searchText).compactMap { group in
            let cards = group.cards.filter { $0.id != Self.settingsCardID }
            return cards.isEmpty ? nil : OverviewGroup(title: group.title, cards: cards)
        }
    }

    /// The "Settings" card: the Settings tab instead.
    private static let settingsCardID = "general"

    private func moduleRow(_ card: OverviewCard) -> some View {
        ModuleRow(card: card, isPending: model.isPending(card.id)) { enabled in
            model.setModule(card.id, enabled: enabled)
        }
    }

    private var isShowingBulkNotice: Binding<Bool> {
        Binding(
            get: { model.bulkNotice != nil },
            set: { if !$0 { model.bulkNotice = nil } })
    }

    private var isShowingToggleError: Binding<Bool> {
        Binding(
            get: { model.toggleError != nil },
            set: { if !$0 { model.toggleError = nil } })
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
