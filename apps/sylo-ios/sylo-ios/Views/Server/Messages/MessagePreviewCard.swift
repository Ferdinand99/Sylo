import SwiftUI
import SyloKit

/// A live preview of a whole message as Discord shows it: Sylo's header with the verified "APP" tag,
/// the text, the embeds in order, and the link buttons under them. Native SwiftUI, only for looking
/// at (the editors are the other screens).
struct MessagePreviewCard: View {
    let content: String
    let embeds: [EmbedItem]
    var links: [ComposedLinkButton] = []

    private var shownLinks: [ComposedLinkButton] { links.filter(\.isComplete) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            BotMessageHeader()
            if content.isEmpty, embeds.isEmpty, shownLinks.isEmpty {
                Text("Nothing in this message yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if !content.isEmpty {
                discordText(content)
                    .font(.footnote)
            }
            ForEach(embeds) { embed in
                EmbedPreviewCard(draft: embed.draft, options: EmbedItem.options)
            }
            if !shownLinks.isEmpty {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 6, alignment: .leading)],
                          alignment: .leading, spacing: 6) {
                    ForEach(shownLinks) { link in
                        LinkButtonPreview(link: link)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
    }
}

/// A grey Discord link button: emoji and label, then the "opens a link" arrow.
private struct LinkButtonPreview: View {
    let link: ComposedLinkButton

    var body: some View {
        HStack(spacing: 4) {
            if !link.emojiText.isEmpty {
                Text(verbatim: link.emojiText)
            }
            if !link.label.isEmpty {
                Text(verbatim: link.label)
                    .lineLimit(1)
            }
            Image(systemName: "arrow.up.right.square")
                .imageScale(.small)
                .accessibilityHidden(true)
        }
        .font(.footnote.weight(.medium))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color.secondary.opacity(0.2), in: RoundedRectangle(cornerRadius: 6))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isLink)
    }
}

#Preview {
    let session = AppSession.preview(.signedIn)
    Form {
        Section("Preview") {
            MessagePreviewCard(
                content: "Read the **rules** first.",
                embeds: [EmbedItem(EmbedDraft(color: "#ed4245", title: "Rules", description: "Be kind."))],
                links: [ComposedLinkButton(label: "Website", emoji: "🌐", url: "https://example.com")])
        }
    }
    .environment(session)
}
