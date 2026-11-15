import SwiftUI
import SyloKit

/// The embeds of a message as form sections, one per embed: a row that opens its editor, and the
/// moves, duplicate and remove for it. The screen adds its own "add" control below, and decides what
/// opens (the shared ``EmbedEditorView``, or a banner's small editor).
///
/// ```swift
/// EmbedElementSections(items: $settings.embeds, limit: 10) { item in
///     EmbedEditorView(draft: item.draft)
/// }
/// ```
struct EmbedElementSections<Editor: View>: View {
    @Binding var items: [EmbedItem]
    /// The most embeds a message can hold; a copy is offered only below it.
    let limit: Int
    @ViewBuilder let editor: (Binding<EmbedItem>) -> Editor

    var body: some View {
        ForEach($items) { $item in
            Section {
                if item.isOpaque {
                    // Nothing to edit: the embed goes back unchanged.
                    EmbedItemSummary(item: item)
                } else {
                    NavigationLink {
                        editor($item)
                    } label: {
                        EmbedItemSummary(item: item)
                    }
                }
                if let index = items.firstIndex(where: { $0.id == item.id }) {
                    if index > 0 {
                        Button("Move Up", systemImage: "arrow.up") {
                            items.moveEmbed(at: index, by: -1)
                        }
                    }
                    if index < items.count - 1 {
                        Button("Move Down", systemImage: "arrow.down") {
                            items.moveEmbed(at: index, by: 1)
                        }
                    }
                    if items.count < limit {
                        Button("Duplicate", systemImage: "plus.square.on.square") {
                            items.duplicateEmbed(at: index, limit: limit)
                        }
                    }
                }
                Button("Remove", role: .destructive) {
                    items.removeAll { $0.id == item.id }
                }
            } header: {
                if item.isBanner {
                    Text("Banner")
                } else {
                    Text("Embed")
                }
            }
        }
    }
}

/// An embed's title (or kind) over the start of its text.
struct EmbedItemSummary: View {
    let item: EmbedItem

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if item.isOpaque {
                Text("Unsupported embed (kept as is)")
                Text("The app cannot edit it. It is sent back unchanged when you save.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if !item.draft.title.isEmpty {
                Text(verbatim: item.draft.title)
            } else if item.isBanner {
                if item.draft.image.isEmpty {
                    Text("Banner without an image")
                } else {
                    Text("Banner")
                }
            } else {
                Text("Untitled embed")
            }
            if !item.draft.description.isEmpty {
                Text(verbatim: item.draft.description)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }
}
