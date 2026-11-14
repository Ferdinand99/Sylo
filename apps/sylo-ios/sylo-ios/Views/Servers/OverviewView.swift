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
    /// The setup wizard of this server, offered here while few modules are set up (Sylo 5.2).
    let wizard: SetupWizardModel
    /// Moves the server screen to a tab (the Needs attention rows for tickets and appeals).
    let openTab: (ServerView.ServerTab) -> Void

    @Environment(AppSession.self) private var session
    @Environment(\.dashboardAccess) private var access
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var showsAllAttention = false
    /// "Not now" on the setup offer, kept per server.
    @State private var offerDismissed = false
    @State private var searchText = ""
    /// Select mode: pick modules, then switch them all on or off with one call.
    @State private var isSelecting = false
    @State private var picked: Set<String> = []

    var body: some View {
        content
            .task { if model.overview == nil { await model.load() } }
            .task { offerDismissed = UserDefaults.standard.bool(forKey: offerKey) }
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
                    attentionSection(overview)
                    setupOffer(overview)
                    // Switching several modules at once is Edit work.
                    ServerToolsSection(server: summary.id, selectModules: access.canEdit ? { startSelecting() } : nil)
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
                            } else if card.hasToggle, ServerPages.hasScreen(card.id) {
                                // A module with a switch whose screen is a server page (Insights).
                                NavigationLink(value: ServerPageRoute(cardID: card.id)) {
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
        // A person below Edit sees the switch but cannot use it.
        ModuleRow(card: card, isPending: model.isPending(card.id) || !access.canEdit) { enabled in
            model.setModule(card.id, enabled: enabled)
        }
    }

    // MARK: - Needs attention

    /// The most rows shown on a phone before "Show all".
    private static let phoneAttentionLimit = 3

    /// What needs attention: waiting work, modules that are on but not set up, what Sylo cannot do in the channels
    /// and roles a module uses (the health check), and the permissions Sylo lacks. Three rows on a phone, with
    /// "Show all".
    @ViewBuilder
    private func attentionSection(_ overview: ServerOverview) -> some View {
        let items = overview.attentionItems
        if !items.isEmpty {
            let limited = horizontalSizeClass == .compact && !showsAllAttention && items.count > Self.phoneAttentionLimit
            let shown = limited ? Array(items.prefix(Self.phoneAttentionLimit)) : items
            Section {
                ForEach(shown) { item in
                    attentionRow(item)
                }
                if limited {
                    Button("Show All (\(items.count))") { showsAllAttention = true }
                } else if showsAllAttention, items.count > Self.phoneAttentionLimit, horizontalSizeClass == .compact {
                    Button("Show Fewer") { showsAllAttention = false }
                }
            } header: {
                Text("Needs attention")
            }
        }
    }

    @ViewBuilder
    private func attentionRow(_ item: AttentionItem) -> some View {
        switch item.destination {
        case .module(let id):
            if ModuleScreens.hasScreen(id) {
                NavigationLink(value: ModuleRoute(moduleID: id)) { AttentionRowView(item: item) }
            } else if ServerPages.hasScreen(id) {
                NavigationLink(value: ServerPageRoute(cardID: id)) { AttentionRowView(item: item) }
            } else {
                AttentionRowView(item: item)
            }
        case .tickets:
            Button { openTab(.tickets) } label: { AttentionRowView(item: item) }
                .foregroundStyle(.primary)
        case .appeals:
            Button { openTab(.moderation) } label: { AttentionRowView(item: item) }
                .foregroundStyle(.primary)
        case .none:
            AttentionRowView(item: item)
        }
    }

    // MARK: - Setup offer

    private var offerKey: String { "setupOfferDismissed.\(summary.id.rawValue)" }

    /// "Set up Sylo" on a server with fewer than three modules set up, on a Sylo that announces `setup-wizard`. The
    /// proposal is read when the wizard opens, not for the offer. "Not now" is remembered.
    @ViewBuilder
    private func setupOffer(_ overview: ServerOverview) -> some View {
        if access.canEdit, !offerDismissed, session.has(.setupWizard), SetupDraft.shouldOffer(overview: overview) {
            Section {
                NavigationLink {
                    SetupWizardView(model: wizard)
                } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Set Up Sylo")
                            Text("Sylo can look at your channels and roles and propose a setup. You choose what happens.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "wand.and.stars").foregroundStyle(.tint)
                    }
                }
                Button("Not Now") {
                    offerDismissed = true
                    UserDefaults.standard.set(true, forKey: offerKey)
                }
                .font(.footnote)
            }
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

/// One row of Needs attention: an icon for how serious it is, the title, what is wrong and, for a health check,
/// what to do about it.
private struct AttentionRowView: View {
    let item: AttentionItem

    @ScaledMetric(relativeTo: .body) private var iconWidth = 28

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: item.title)
                Text(verbatim: item.detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if item.kind == .health, let fix = item.lines.first?.fix, !fix.isEmpty {
                    Text(verbatim: fix)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        } icon: {
            Image(systemName: symbol)
                .symbolRenderingMode(.multicolor)
                .foregroundStyle(tint)
                .frame(width: iconWidth)
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint(item.destination == .none ? "" : "Opens it")
    }

    private var symbol: String {
        switch item.kind {
        case .waiting: "tray.full"
        case .setup: "wrench.and.screwdriver"
        case .health: item.severity == .error ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill"
        case .info: "info.circle"
        case .blocked: "lock.trianglebadge.exclamationmark"
        case .permissions: "key"
        }
    }

    private var tint: Color {
        switch item.kind {
        case .health: item.severity == .error ? .red : .orange
        case .waiting, .info: .accentColor
        case .setup, .blocked, .permissions: .orange
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn)
    NavigationStack {
        OverviewView(
            summary: PreviewData.servers[0], model: OverviewModel(server: PreviewData.servers[0].id, session: session),
            wizard: SetupWizardModel(server: PreviewData.servers[0].id, session: session), openTab: { _ in })
    }
    .environment(session)
}

#Preview("Largest text, dark") {
    let session = AppSession.preview(.signedIn)
    NavigationStack {
        OverviewView(
            summary: PreviewData.servers[0], model: OverviewModel(server: PreviewData.servers[0].id, session: session),
            wizard: SetupWizardModel(server: PreviewData.servers[0].id, session: session), openTab: { _ in })
    }
    .environment(session)
    .dynamicTypeSize(.accessibility3)
    .preferredColorScheme(.dark)
}
