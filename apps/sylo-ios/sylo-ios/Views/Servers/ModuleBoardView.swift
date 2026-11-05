import SwiftUI
import SyloKit

/// The Modules tab of a server: the modules as tiles, one group per category like the web
/// overview, each with an LED switch. Tap a tile for its settings; press and hold to switch it on or
/// off. The search field stays pinned above the board. A module with a settings screen in the app
/// opens it (``ModuleRoute``, handled by ``ServerView``); cards without a switch (Commands, Embed
/// messages) open in the web dashboard. The server's general settings are their own tab, so that
/// card is left out here.
struct ModuleBoardView: View {
    let summary: ServerSummary
    let model: OverviewModel
    @Binding var searchText: String
    let openModule: (String) -> Void

    @Environment(AppSession.self) private var session
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

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
            let groups = shownGroups(overview)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: SyloSpacing.l) {
                    // A refresh that failed: the board below is the one loaded before.
                    if let message = model.errorMessage {
                        StatusMessage(message, kind: .error)
                            .padding(SyloSpacing.m)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .syloCard(radius: SyloRadius.row)
                    }
                    ForEach(groups) { group in
                        CategorySection(group: group, columns: columns) { card in
                            tile(for: card)
                        }
                    }
                }
                .padding(.horizontal, SyloSpacing.screen)
                .padding(.top, SyloSpacing.s)
            }
            .tabBarClearance()
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .top, spacing: 0) {
                ModuleSearchField(text: $searchText)
            }
            .overlay {
                if isSearching, groups.isEmpty {
                    EmptyState(
                        "No Modules Match", systemImage: "magnifyingglass",
                        message: Text("No module matches \u{201C}\(searchText.trimmingCharacters(in: .whitespacesAndNewlines))\u{201D}."))
                        .allowsHitTesting(false)
                }
            }
            .refreshable { await model.load() }
        } else if let message = model.errorMessage {
            EmptyState(
                "Couldn't Load Server", systemImage: "exclamationmark.triangle", message: Text(message),
                isError: true, actionTitle: "Try Again") {
                    Task { await model.load() }
                }
        } else {
            SyloLoadingView()
        }
    }

    /// Two tiles side by side; one at accessibility text sizes, where a tile needs the width.
    private var columns: [GridItem] {
        let count = dynamicTypeSize.isAccessibilitySize ? 1 : 2
        return Array(repeating: GridItem(.flexible(), spacing: SyloSpacing.tileGap, alignment: .top), count: count)
    }

    private var isSearching: Bool { !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The groups to show: the search applied, and the "Settings" card (its own tab) left out, so
    /// a group that only had that card does not show up empty.
    private func shownGroups(_ overview: ServerOverview) -> [OverviewGroup] {
        overview.groups(matching: searchText).compactMap { group in
            let cards = group.cards.filter { $0.id != Self.settingsCardID }
            return cards.isEmpty ? nil : OverviewGroup(title: group.title, cards: cards)
        }
    }

    /// The "Settings" card: the Settings tab instead.
    private static let settingsCardID = "general"

    @ViewBuilder
    private func tile(for card: OverviewCard) -> some View {
        if card.hasToggle {
            ModuleTile(
                card: card, isPending: model.isPending(card.id), hasScreen: ModuleScreens.hasScreen(card.id),
                open: { openModule(card.id) },
                setEnabled: { enabled in model.setModule(card.id, enabled: enabled) })
        } else if let url = webURL(for: card) {
            LinkTile(card: card, url: url)
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

/// One category: its name with how many of its modules are on, then its tiles.
private struct CategorySection<Tile: View>: View {
    let group: OverviewGroup
    let columns: [GridItem]
    @ViewBuilder let tile: (OverviewCard) -> Tile

    var body: some View {
        VStack(alignment: .leading, spacing: SyloSpacing.s) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: group.title)
                    .font(.headline)
                    .foregroundStyle(Color.syloText)
                Spacer(minLength: SyloSpacing.s)
                if total > 0 {
                    Text(verbatim: "\(enabled)/\(total)")
                        .font(.syloNumber(.footnote, weight: .medium))
                        .foregroundStyle(Color.syloMuted)
                        .accessibilityLabel(Text("\(enabled) of \(total) on"))
                }
            }
            .padding(.horizontal, SyloSpacing.xs)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)

            LazyVGrid(columns: columns, spacing: SyloSpacing.tileGap) {
                ForEach(Array(group.cards.enumerated()), id: \.element.id) { index, card in
                    tile(card)
                        .syloArrival(index: index)
                }
            }
        }
    }

    private var total: Int { group.cards.count(where: \.hasToggle) }
    private var enabled: Int { group.cards.count(where: { $0.isEnabled == true }) }
}

/// The search field, pinned under the navigation bar: a glass capsule on iOS 26, a material before.
private struct ModuleSearchField: View {
    @Binding var text: String
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: SyloSpacing.s) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Color.syloMuted)
                .accessibilityHidden(true)
            TextField("Search modules", text: $text)
                .focused($isFocused)
                .submitLabel(.search)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Color.syloMuted)
                        .frame(minWidth: 32, minHeight: 32)
                }
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, SyloSpacing.m + 2)
        .padding(.vertical, 6)
        .frame(minHeight: 44)
        .background { fieldBackground }
        .padding(.horizontal, SyloSpacing.screen)
        .padding(.vertical, SyloSpacing.s)
    }

    @ViewBuilder
    private var fieldBackground: some View {
        if #available(iOS 26, *) {
            Capsule().fill(Color.clear)
                .glassEffect(.regular, in: .capsule)
                .overlay { Capsule().strokeBorder(Color.syloLine, lineWidth: 1) }
        } else {
            Capsule().fill(.ultraThinMaterial)
                .overlay { Capsule().strokeBorder(Color.syloLine, lineWidth: 1) }
        }
    }
}
