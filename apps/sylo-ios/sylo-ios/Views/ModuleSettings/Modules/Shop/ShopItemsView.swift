import SwiftUI
import SyloKit

/// The shop's items: members see the ones that are not paused, in this order. Staff add an item,
/// open one to change it, pause or delete it, and drag to reorder. Mirrors the Shop tab of the web
/// dashboard (web-v2/src/components/EconomyShopAdmin.jsx).
struct ShopItemsView: View {
    @State private var model: ShopItemsModel
    @State private var editing: ShopEditorTarget?
    @State private var itemToDelete: ShopItem?
    private let server: ServerID
    private let session: AppSession
    private let currencyEmoji: String
    private let currencyName: String

    init(server: ServerID, session: AppSession, currencyEmoji: String, currencyName: String) {
        self.server = server
        self.session = session
        self.currencyEmoji = currencyEmoji
        self.currencyName = currencyName
        _model = State(initialValue: ShopItemsModel(server: server, session: session))
    }

    var body: some View {
        List {
            if let message = model.errorMessage, model.hasLoaded {
                Section { StatusMessage(message, kind: .error) }
            }
            Section {
                ForEach(model.items) { item in
                    Button {
                        editing = .edit(item)
                    } label: {
                        ShopItemRow(item: item, tiers: model.rarities, roles: model.roles,
                                    currencyEmoji: currencyEmoji, currencyName: currencyName)
                    }
                    .buttonStyle(.plain)
                    // Pause is one tap; delete asks first, so neither completes with a single swipe.
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Delete", systemImage: "trash", role: .destructive) { itemToDelete = item }
                        Button(item.enabled ? "Pause" : "Resume",
                               systemImage: item.enabled ? "pause.circle" : "play.circle") {
                            Task { await model.setEnabled(item, !item.enabled) }
                        }
                        .tint(.orange)
                    }
                    .contextMenu {
                        Button("Edit", systemImage: "pencil") { editing = .edit(item) }
                        Button(item.enabled ? "Pause" : "Resume",
                               systemImage: item.enabled ? "pause.circle" : "play.circle") {
                            Task { await model.setEnabled(item, !item.enabled) }
                        }
                        Button("Delete", systemImage: "trash", role: .destructive) { itemToDelete = item }
                    }
                }
                .onMove { source, destination in
                    Task { await model.move(from: source, to: destination) }
                }
            } header: {
                if model.hasLoaded {
                    Text("Items (\(model.items.count))")
                }
            } footer: {
                if model.hasLoaded {
                    if model.items.isEmpty {
                        Text("No items yet. Add the first one with the + button.")
                    } else {
                        Text("Members see the items that are not paused, in this order. Tap Edit, then drag to change the order. Buying a temporary role again while it runs adds the new time to what is left.")
                    }
                }
            }
        }
        .overlay {
            if !model.hasLoaded {
                if let message = model.errorMessage {
                    ContentUnavailableView {
                        Label("Couldn't Load the Shop", systemImage: "exclamationmark.triangle")
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
        .navigationTitle("Shop Items")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                EditButton().disabled(!model.hasLoaded)
            }
            ToolbarItem(placement: .primaryAction) {
                Button("Add Item", systemImage: "plus") { editing = .new }
                    .disabled(!model.hasLoaded || !model.canAddItem)
            }
        }
        .task { await model.load() }
        .refreshable { await model.load() }
        .sheet(item: $editing, onDismiss: {
            // What went wrong inside the form was shown there; it is not shown again out here.
            model.actionError = nil
            model.clearPictureProblem()
        }) { target in
            NavigationStack {
                ShopItemEditorView(model: model, target: target)
            }
        }
        .confirmationDialog(
            itemToDelete.map { "Delete \($0.name)?" } ?? "Delete Item?", isPresented: isDeleting,
            titleVisibility: .visible, presenting: itemToDelete
        ) { item in
            Button("Delete Item", role: .destructive) { Task { await model.delete(item) } }
        } message: { _ in
            Text("It leaves the shop. What members already own is kept: their inventory shows it as \"item removed\", and a role they hold stays until you revoke it or it runs out.")
        }
        .alert("Couldn't Change the Shop", isPresented: isShowingActionError, presenting: model.actionError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: model.changeCount)
    }

    private var isDeleting: Binding<Bool> {
        Binding(get: { itemToDelete != nil }, set: { if !$0 { itemToDelete = nil } })
    }

    private var isShowingActionError: Binding<Bool> {
        Binding(
            get: { model.actionError != nil && editing == nil },
            set: { if !$0 { model.actionError = nil } })
    }
}

/// What the item sheet opens on: a new item, or one to change.
enum ShopEditorTarget: Identifiable {
    case new
    case edit(ShopItem)

    var id: String {
        switch self {
        case .new: "new"
        case .edit(let item): "item-\(item.id)"
        }
    }
}

/// One item: its picture, name and the facts staff look at (price, kind, rarity, stock, sales).
private struct ShopItemRow: View {
    let item: ShopItem
    let tiers: [ShopRarity]
    let roles: [RoleOption]
    let currencyEmoji: String
    let currencyName: String

    var body: some View {
        HStack(spacing: 12) {
            if item.type.isCollectible {
                CollectibleThumbnail(path: item.imagePath)
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(verbatim: title)
                        .font(.headline)
                        .lineLimit(2)
                    if let rarity = item.rarity, item.type.isCollectible {
                        RarityBadge(key: rarity, tiers: tiers)
                    }
                }
                Text(verbatim: details)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let warning {
                    Label(warning, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the item")
    }

    private var title: String {
        item.emoji.isEmpty ? item.name : item.emoji + " " + item.name
    }

    private var warning: String? {
        if !item.enabled { return String(localized: "Paused") }
        if item.needsPicture { return String(localized: "Needs a picture: hidden from members until it has one") }
        if !item.type.isKnown { return String(localized: "A kind of item this app can't edit") }
        return nil
    }

    private func money(_ amount: Int) -> String {
        EconomyMoney.format(amount, emoji: currencyEmoji, name: currencyName)
    }

    /// "🪙 100 coins · Temporary role · 24 h · @VIP · 3 of 10 left · 7 sold".
    private var details: String {
        var parts = [money(item.price), item.type.title]
        if item.type == .tempRole, let hours = item.durationHours {
            parts.append(String(localized: "\(hours) h"))
        }
        if item.type.isRole {
            parts.append(roles.first { $0.id == item.roleId }.map { "@" + $0.name } ?? String(localized: "role missing"))
        }
        if item.type.isCollectible, item.announce { parts.append(String(localized: "announced")) }
        if let left = item.left, let stock = item.stock {
            parts.append(String(localized: "\(left) of \(stock) left"))
        } else {
            parts.append(String(localized: "unlimited stock"))
        }
        parts.append(String(localized: "\(item.purchases) sold"))
        return parts.joined(separator: " · ")
    }
}
