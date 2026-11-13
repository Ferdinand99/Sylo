import SwiftUI
import SyloKit

/// The shop's purchases, newest first, a page at a time. Staff can narrow the list to one member or one
/// item. Mirrors the Activity tab of the web dashboard (web-v2/src/components/EconomyActivity.jsx).
struct ShopActivityView: View {
    @State private var model: ShopActivityModel
    @State private var member: MemberChoice?
    private let server: ServerID
    private let session: AppSession
    private let currencyEmoji: String
    private let currencyName: String

    init(server: ServerID, session: AppSession, currencyEmoji: String, currencyName: String) {
        self.server = server
        self.session = session
        self.currencyEmoji = currencyEmoji
        self.currencyName = currencyName
        _model = State(initialValue: ShopActivityModel(server: server, session: session))
    }

    var body: some View {
        List {
            if let message = model.errorMessage, model.hasLoaded {
                Section { StatusMessage(message, kind: .error) }
            }
            Section {
                MemberPicker("Member", server: server, session: session, selection: $member)
                if member != nil {
                    Button("Show Everybody") { member = nil }
                }
                if !model.items.isEmpty {
                    Picker("Item", selection: $model.itemID) {
                        Text("All items").tag(Int?.none)
                        ForEach(model.items) { item in
                            Text(verbatim: item.emoji.isEmpty ? item.name : item.emoji + " " + item.name)
                                .tag(Int?.some(item.id))
                        }
                    }
                }
            } header: {
                Text("Filter")
            }

            Section {
                ForEach(model.rows) { row in
                    ActivityRow(row: row, currencyEmoji: currencyEmoji, currencyName: currencyName)
                }
                if model.canLoadMore {
                    Button("Show More") { Task { await model.loadMore() } }
                        .disabled(model.isLoading)
                }
            } header: {
                if model.hasLoaded { Text("Purchases (\(model.total.formatted()))") }
            } footer: {
                if model.hasLoaded, model.rows.isEmpty { Text("No purchases match.") }
            }
        }
        .overlay {
            if !model.hasLoaded {
                if let message = model.errorMessage {
                    ContentUnavailableView {
                        Label("Couldn't Load the Activity", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try Again") { Task { await model.load() } }
                    }
                } else {
                    ProgressView()
                }
            }
        }
        .navigationTitle("Shop Activity")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.loadItems() }
        // Loads at once, and again whenever the member or the item changes.
        .task(id: filterKey) {
            model.userID = member?.id
            await model.load()
        }
        .refreshable { await model.load() }
    }

    private var filterKey: String {
        "\(member?.id ?? "")|\(model.itemID.map(String.init) ?? "")"
    }
}

/// One purchase: who bought what, for how much, and where it stands.
private struct ActivityRow: View {
    let row: InventoryRow
    let currencyEmoji: String
    let currencyName: String

    var body: some View {
        HStack(spacing: 12) {
            if row.itemType.isCollectible {
                CollectibleThumbnail(path: row.imagePath, size: 36)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: String(localized: "\(row.member?.name ?? row.userId) bought \(row.itemName)"))
                    .lineLimit(3)
                Text(verbatim: details)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if row.itemRemoved {
                    Text("Item removed from the shop")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// "🪙 500 coins · Active · waiting for staff · 5 min. ago".
    private var details: String {
        var parts = [EconomyMoney.format(row.pricePaid, emoji: currencyEmoji, name: currencyName), row.status.title]
        if row.itemType == .custom, row.status == .active {
            parts.append(row.isFulfilled ? String(localized: "fulfilled") : String(localized: "waiting for staff"))
        }
        if let created = row.createdDate { parts.append(DateText.relative(created)) }
        return parts.joined(separator: " · ")
    }
}
