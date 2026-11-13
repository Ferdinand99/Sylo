import SwiftUI
import SyloKit

/// One member's inventory: what they own, with the staff actions. Give an item for free, revoke an entry
/// (a temporary role ends, a permanent role comes off, no money moves), refund a purchase (the price goes
/// back and the item is revoked), and mark a custom item as handed over. Each action asks first, with an
/// optional reason or note that is kept in the ledger. Mirrors web-v2/src/components/EconomyInventory.jsx.
struct InventoryView: View {
    @State private var model: MemberInventoryModel
    @State private var pending: PendingAction?
    @State private var isAsking = false
    @State private var giveItemID: Int?
    private let name: String
    private let currencyEmoji: String
    private let currencyName: String
    /// Called after an action went through, so the member's page can refresh its numbers.
    private let onChange: () -> Void

    init(server: ServerID, session: AppSession, userID: String, name: String, currencyEmoji: String,
         currencyName: String, onChange: @escaping () -> Void = {}) {
        self.name = name
        self.currencyEmoji = currencyEmoji
        self.currencyName = currencyName
        self.onChange = onChange
        _model = State(initialValue: MemberInventoryModel(server: server, userID: userID, session: session))
    }

    var body: some View {
        List {
            if let message = model.errorMessage, model.hasLoaded {
                Section { StatusMessage(message, kind: .error) }
            }
            if let notice = model.notice {
                Section { StatusMessage(notice, kind: .notice) }
            }
            Section {
                ForEach(model.rows) { row in
                    InventoryRowView(row: row, details: InventoryText.details(of: row))
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            actions(for: row)
                        }
                        .contextMenu {
                            actions(for: row)
                        }
                }
            } header: {
                if model.hasLoaded { Text("Inventory (\(model.rows.count))") }
            } footer: {
                if model.hasLoaded, model.rows.isEmpty {
                    Text("Nothing here yet.")
                } else if model.hasLoaded {
                    Text("Swipe an entry, or touch and hold it, for the actions.")
                }
            }

            if model.hasLoaded, !model.items.isEmpty {
                Section {
                    Picker("Item", selection: $giveItemID) {
                        Text("Pick an item").tag(Int?.none)
                        ForEach(model.items) { item in
                            Text(verbatim: item.emoji.isEmpty ? item.name : item.emoji + " " + item.name)
                                .tag(Int?.some(item.id))
                        }
                    }
                    Button("Give Item", systemImage: "gift") {
                        if let item = model.items.first(where: { $0.id == giveItemID }) { ask(.grant(item)) }
                    }
                    .disabled(giveItemID == nil || model.isWorking)
                } header: {
                    Text("Give an item for free")
                } footer: {
                    Text("A role item puts the role on \(name). It is in their ledger with your name.")
                }
            }
        }
        .overlay {
            if !model.hasLoaded {
                if let message = model.errorMessage {
                    ContentUnavailableView {
                        Label("Couldn't Load the Inventory", systemImage: "exclamationmark.triangle")
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
        .navigationTitle("Inventory")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
        .reasonPrompt(
            LocalizedStringKey(pending?.title ?? ""), message: LocalizedStringKey(message(of: pending)),
            isPresented: $isAsking, confirmTitle: LocalizedStringKey(pending?.confirmTitle ?? "OK"),
            confirmRole: pending?.isDestructive == true ? .destructive : nil,
            reasonLabel: pending?.isNote == true ? "Note (optional)" : "Reason (optional)"
        ) { reason in
            guard let action = pending else { return }
            Task {
                await run(action, reason: reason)
                pending = nil
            }
        }
        .alert("Couldn't Do That", isPresented: isShowingActionError, presenting: model.actionError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: model.changeCount)
        .onChange(of: model.changeCount) { onChange() }
    }

    // MARK: Actions

    /// The actions an entry allows, as buttons for the swipe and the context menu.
    @ViewBuilder
    private func actions(for row: InventoryRow) -> some View {
        if row.canRefund {
            Button("Refund", systemImage: "arrow.uturn.backward.circle", role: .destructive) { ask(.refund(row)) }
        }
        if row.canRevoke {
            Button("Revoke", systemImage: "minus.circle", role: .destructive) { ask(.revoke(row)) }
        }
        if row.canFulfil {
            Button(row.isFulfilled ? "Reopen" : "Mark Fulfilled",
                   systemImage: row.isFulfilled ? "arrow.uturn.left.circle" : "checkmark.circle") {
                ask(.fulfil(row, !row.isFulfilled))
            }
            .tint(.green)
        }
    }

    private func ask(_ action: PendingAction) {
        pending = action
        isAsking = true
    }

    private func run(_ action: PendingAction, reason: String) async {
        switch action {
        case .grant(let item): await model.grant(item, reason: reason)
        case .revoke(let row): await model.end(row, as: .revoke, reason: reason)
        case .refund(let row): await model.end(row, as: .refund, reason: reason)
        case .fulfil(let row, let done): await model.setFulfilled(row, done, note: reason)
        }
    }

    private func message(of action: PendingAction?) -> String {
        guard let action else { return "" }
        switch action {
        case .grant:
            return String(localized: "\(name) gets the item for free. A role item puts the role on them.")
        case .revoke:
            return String(localized: "The item is taken away: a temporary role ends and a permanent role comes off. No money moves.")
        case .refund(let row):
            let price = EconomyMoney.format(row.pricePaid, emoji: currencyEmoji, name: currencyName)
            return String(localized: "\(name) gets \(price) back and the item is revoked.")
        case .fulfil(_, let done):
            return done
                ? String(localized: "Marks the item as handed over. You can reopen it later.")
                : String(localized: "Puts the item back on the list of things waiting for staff.")
        }
    }

    private var isShowingActionError: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
    }
}

/// What the confirmation alert is about.
private enum PendingAction {
    case grant(ShopItem)
    case revoke(InventoryRow)
    case refund(InventoryRow)
    case fulfil(InventoryRow, Bool)

    var title: String {
        switch self {
        case .grant(let item): String(localized: "Give \(item.name)?")
        case .revoke(let row): String(localized: "Revoke \(row.itemName)?")
        case .refund(let row): String(localized: "Refund \(row.itemName)?")
        case .fulfil(let row, let done):
            done ? String(localized: "Mark \(row.itemName) as fulfilled?") : String(localized: "Reopen \(row.itemName)?")
        }
    }

    var confirmTitle: String {
        switch self {
        case .grant: String(localized: "Give")
        case .revoke: String(localized: "Revoke")
        case .refund: String(localized: "Refund")
        case .fulfil(_, let done): done ? String(localized: "Mark Fulfilled") : String(localized: "Reopen")
        }
    }

    var isDestructive: Bool {
        switch self {
        case .revoke, .refund: true
        default: false
        }
    }

    /// Fulfilling takes a note; the other actions take a reason.
    var isNote: Bool {
        if case .fulfil = self { return true }
        return false
    }
}

/// One inventory entry: its picture (a collectible), name, rarity and the facts about it.
private struct InventoryRowView: View {
    let row: InventoryRow
    let details: String

    var body: some View {
        HStack(spacing: 12) {
            if row.itemType.isCollectible {
                CollectibleThumbnail(path: row.imagePath)
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(verbatim: row.itemName)
                        .font(.headline)
                        .lineLimit(2)
                    if let rarity = row.rarity, row.itemType.isCollectible {
                        RarityBadge(key: rarity)
                    }
                }
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
}
