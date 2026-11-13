import SwiftUI
import SyloKit

/// The form for one shop item, in a sheet: a new item, or one to change. A collectible also has its
/// rarity, an "announce purchases" switch and its picture. The picture goes up after the item is saved
/// (it belongs to an item); when the upload is refused the item stays saved and the form stays open on it,
/// so the picture can be tried again. Mirrors web-v2/src/components/EconomyShopAdmin.jsx.
struct ShopItemEditorView: View {
    let model: ShopItemsModel

    @State private var draft: ShopItemDraft
    @State private var staged: PreparedPicture?
    @Environment(\.dismiss) private var dismiss

    init(model: ShopItemsModel, target: ShopEditorTarget) {
        self.model = model
        switch target {
        case .new: _draft = State(initialValue: ShopItemDraft())
        case .edit(let item): _draft = State(initialValue: ShopItemDraft(item: item))
        }
    }

    /// Whether the form offers collectibles: the server has them, or this item already is one.
    private var offersCollectibles: Bool { model.supportsCollectibles || draft.type.isCollectible }

    private var kinds: [ShopItemType] {
        ShopItemType.editable.filter { $0 != .collectible || offersCollectibles }
    }

    /// The picture on the server now. Read from the model so it follows an upload or a removal.
    private var currentPicture: String? {
        guard let id = draft.id else { return nil }
        return model.item(id: id)?.imagePath
    }

    /// Takes the picture off the item; nil for a new item, which has none.
    private var removeAction: (() -> Void)? {
        guard let id = draft.id else { return nil }
        return { Task { await model.removePicture(from: id) } }
    }

    var body: some View {
        Form {
            if !draft.type.isKnown {
                Section {
                    StatusMessage("This item is a kind the app does not know (\(draft.type.title)). It can be paused, moved or deleted here, but not edited.", kind: .notice)
                }
            }
            Group {
                Section {
                    LimitedTextField(title: "Name", text: $draft.name, limit: ShopItemLimits.nameLength,
                                     showsCounter: true)
                    LimitedTextField(title: "Emoji (optional)", text: $draft.emoji, limit: ShopItemLimits.emojiLength,
                                     showsCounter: true)
                        .textInputAutocapitalization(.never)
                    LimitedTextField(title: "Description", text: $draft.description,
                                     limit: ShopItemLimits.descriptionLength, lines: 2...5)
                } footer: {
                    if let problem = draft.problem, draft.type.isKnown { Text(verbatim: problem) }
                }

                Section {
                    kindPicker
                    if draft.type.isRole {
                        RolePicker(title: "Role", selection: $draft.roleId, roles: model.roles, noneTitle: "Pick a role")
                    }
                    if draft.type == .tempRole {
                        NumberField(title: "Lasts", value: $draft.durationHours,
                                    range: ShopItemLimits.durationHours, unit: "hours")
                    }
                } header: {
                    Text("What it is")
                } footer: {
                    Text(verbatim: draft.type.summary + ".")
                }

                Section {
                    NumberField(title: "Price", value: $draft.price, range: ShopItemLimits.price)
                    Toggle("Limited stock", isOn: limitedStock)
                    if draft.stock != nil {
                        NumberField(title: "In stock", value: stock, range: ShopItemLimits.stock)
                    }
                    Toggle("Limit per member", isOn: limitedPerMember)
                    if draft.perMemberLimit != nil {
                        NumberField(title: "Most per member", value: perMemberLimit,
                                    range: ShopItemLimits.perMemberLimit)
                    }
                } header: {
                    Text("Price and stock")
                } footer: {
                    Text("Without a stock limit the item never runs out. With one, a collectible is a limited edition.")
                }

                if draft.type.isCollectible {
                    Section {
                        Picker("Rarity", selection: $draft.rarity) {
                            Text("None").tag("")
                            ForEach(model.rarities) { tier in
                                Text(verbatim: tier.label).tag(tier.key)
                            }
                            if !draft.rarity.isEmpty, !model.rarities.contains(where: { $0.key == draft.rarity }) {
                                Text(verbatim: ShopRarity.label(for: draft.rarity)).tag(draft.rarity)
                            }
                        }
                        Toggle("Announce purchases", isOn: $draft.announce)
                    } header: {
                        Text("Collectible")
                    } footer: {
                        Text("Announcements need the announcement channel in the Economy settings. Only the buyer is mentioned.")
                    }

                    CollectiblePicturePicker(
                        currentPath: currentPicture, staged: $staged, problem: model.pictureProblem,
                        isBusy: model.isBusy, canRetry: draft.id != nil,
                        onRetry: { Task { await retryUpload() } },
                        onRemove: removeAction)
                }

                Section {
                    MultiPicker(title: "Required roles", selection: $draft.requiredRoles, options: model.roles,
                                prefix: "@", limit: ShopItemLimits.requiredRoles)
                } footer: {
                    Text("A member needs any one of these roles to buy. None means everybody.")
                }

                Section {
                    Toggle("For sale", isOn: $draft.enabled)
                } footer: {
                    Text("Turn this off to pause the item. Members don't see it until you turn it on again.")
                }
            }
            .disabled(!draft.type.isKnown)

            if let message = model.actionError {
                Section { StatusMessage(message, kind: .error) }
            }
        }
        .navigationTitle(draft.id == nil ? "New Item" : "Edit Item")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
                    .disabled(model.isBusy)
            }
            ToolbarItem(placement: .confirmationAction) {
                if model.isBusy {
                    ProgressView()
                } else {
                    Button("Save") { Task { await save() } }
                        // After a create the server did not name, saving again would add the item twice.
                        .disabled(draft.problem != nil || model.savedWithoutID)
                }
            }
        }
        .interactiveDismissDisabled(model.isBusy)
        .onAppear { model.actionError = nil; model.clearPictureProblem() }
    }

    // MARK: Pieces

    @ViewBuilder
    private var kindPicker: some View {
        if draft.type.isKnown {
            Picker("Kind", selection: $draft.type) {
                ForEach(kinds, id: \.self) { kind in
                    Text(verbatim: kind.title).tag(kind)
                }
            }
        } else {
            LabeledContent("Kind", value: draft.type.title)
        }
    }

    private var limitedStock: Binding<Bool> {
        Binding(get: { draft.stock != nil }, set: { draft.stock = $0 ? (draft.stock ?? 10) : nil })
    }

    private var stock: Binding<Int> {
        Binding(get: { draft.stock ?? 0 }, set: { draft.stock = $0 })
    }

    private var limitedPerMember: Binding<Bool> {
        Binding(get: { draft.perMemberLimit != nil }, set: { draft.perMemberLimit = $0 ? (draft.perMemberLimit ?? 1) : nil })
    }

    private var perMemberLimit: Binding<Int> {
        Binding(get: { draft.perMemberLimit ?? 1 }, set: { draft.perMemberLimit = $0 })
    }

    // MARK: Actions

    /// Saves the item, then uploads the chosen picture. The form closes when both went through.
    private func save() async {
        guard let id = await model.save(draft) else { return }
        // From here on it is an existing item: a second Save changes it instead of adding another.
        draft.id = id
        guard draft.type.isCollectible, model.supportsCollectibles, let picture = staged else {
            dismiss()
            return
        }
        if await model.uploadPicture(picture, for: id) {
            staged = nil
            dismiss()
        }
    }

    /// Tries the same picture again, after the person tapped Try Again.
    private func retryUpload() async {
        guard let id = draft.id, let picture = staged else { return }
        if await model.uploadPicture(picture, for: id) {
            staged = nil
            dismiss()
        }
    }
}
