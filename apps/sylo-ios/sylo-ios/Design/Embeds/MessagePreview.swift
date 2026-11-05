import SwiftUI
import SyloKit

/// A chat message as Sylo would post it, for the embed editors' live preview: the bot's avatar and
/// name with its tag (APP on Discord, BOT on Fluxer, the way the dashboard shows it), the text, the
/// embeds and the link buttons. Drawn in the app's own style, not Discord's.
struct MessagePreview: View {
    var content = ""
    var embeds: [EmbedSpec] = []
    var links: [LinkButton] = []
    var isFluxer = false

    @ScaledMetric(relativeTo: .body) private var avatarSize: CGFloat = 36

    var body: some View {
        HStack(alignment: .top, spacing: SyloSpacing.m) {
            avatar
            VStack(alignment: .leading, spacing: SyloSpacing.s) {
                header
                if !trimmedContent.isEmpty {
                    Text(MessagePreview.markdown(content))
                        .font(.subheadline)
                        .foregroundStyle(Color.syloText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                ForEach(embeds) { embed in
                    EmbedPreviewCard(embed: embed)
                }
                if !readyLinks.isEmpty {
                    FlowLayout(spacing: SyloSpacing.s) {
                        ForEach(readyLinks) { link in
                            LinkButtonPreview(link: link)
                        }
                    }
                }
                if trimmedContent.isEmpty, embeds.isEmpty, readyLinks.isEmpty {
                    Text("Nothing to show yet. Write some text or add an embed.")
                        .font(.footnote)
                        .foregroundStyle(Color.syloMuted)
                }
            }
        }
        .padding(SyloSpacing.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .syloCard(radius: SyloRadius.row)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Message preview"))
    }

    private var trimmedContent: String { content.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Link buttons the server would post: a link, and a label or an emoji.
    private var readyLinks: [LinkButton] {
        links.filter { link in
            !link.url.trimmingCharacters(in: .whitespaces).isEmpty
                && !(link.label.trimmingCharacters(in: .whitespaces).isEmpty
                    && link.emoji.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    private var avatar: some View {
        ZStack {
            Circle().fill(Color.syloCyan.opacity(0.16))
            Circle().strokeBorder(Color.syloCyan.opacity(0.5), lineWidth: 1)
            SyloMark(size: avatarSize * 0.55)
        }
        .frame(width: avatarSize, height: avatarSize)
        .accessibilityHidden(true)
    }

    private var header: some View {
        HStack(spacing: SyloSpacing.s) {
            Text("Sylo")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.syloText)
            SyloPill(verbatim: isFluxer ? "BOT" : "APP", tint: isFluxer ? .syloFluxer : .syloDiscord, filled: false)
            Text("Today")
                .font(.caption)
                .foregroundStyle(Color.syloMuted)
        }
        .lineLimit(1)
    }

    /// Discord's inline markdown (bold, italic, links, code) as styled text; text that is not
    /// valid markdown stays as typed.
    static func markdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

/// One embed in the preview: the colour bar, author, title, text, fields, pictures and footer.
struct EmbedPreviewCard: View {
    let embed: EmbedSpec

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: SyloSpacing.s) {
                HStack(alignment: .top, spacing: SyloSpacing.m) {
                    VStack(alignment: .leading, spacing: SyloSpacing.s) {
                        if !embed.authorName.isEmpty {
                            HStack(spacing: SyloSpacing.s) {
                                EmbedImage(link: embed.authorIcon, size: 20, isRound: true)
                                Text(verbatim: embed.authorName)
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(Color.syloText)
                            }
                        }
                        if !embed.title.isEmpty {
                            Text(MessagePreview.markdown(embed.title))
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Color.syloText)
                        }
                        if !embed.description.isEmpty {
                            Text(MessagePreview.markdown(embed.description))
                                .font(.footnote)
                                .foregroundStyle(Color.syloText)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if EmbedSpec.isWebLink(embed.thumbnail) {
                        EmbedImage(link: embed.thumbnail, size: 56, isRound: false)
                    }
                }
                fieldRows
                if EmbedSpec.isWebLink(embed.image) {
                    EmbedImage(link: embed.image, size: nil, isRound: false)
                }
                if !embed.footerText.isEmpty || embed.timestamp {
                    HStack(spacing: SyloSpacing.xs + 2) {
                        EmbedImage(link: embed.footerIcon, size: 16, isRound: true)
                        Text(verbatim: footerText)
                            .font(.caption)
                            .foregroundStyle(Color.syloMuted)
                    }
                }
            }
        .padding(SyloSpacing.m)
        .padding(.leading, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(barColor)
                .frame(width: 4)
                .accessibilityHidden(true)
        }
        .background(Color.syloBackground.opacity(0.55))
        .clipShape(RoundedRectangle(cornerRadius: SyloRadius.chip, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: SyloRadius.chip, style: .continuous)
                .strokeBorder(Color.syloLine, lineWidth: 1)
        }
    }

    private var footerText: String {
        let time = String(localized: "Today")
        if embed.footerText.isEmpty { return time }
        return embed.timestamp ? "\(embed.footerText) · \(time)" : embed.footerText
    }

    private var barColor: Color {
        let rgb = embed.withDefaultColor("#99aab5").rgb
        return Color(.sRGB, red: rgb.red, green: rgb.green, blue: rgb.blue)
    }

    /// Fields in Discord's layout: inline fields share a row, up to three; the others take a row.
    @ViewBuilder
    private var fieldRows: some View {
        let rows = EmbedPreviewCard.rows(of: embed.fields, perRow: dynamicTypeSize.isAccessibilitySize ? 1 : 3)
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: SyloSpacing.s) {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    HStack(alignment: .top, spacing: SyloSpacing.m) {
                        ForEach(row) { field in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: field.name)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Color.syloText)
                                Text(MessagePreview.markdown(field.value))
                                    .font(.caption)
                                    .foregroundStyle(Color.syloMuted)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
        }
    }

    /// The fields that have both a name and a value, grouped into rows.
    static func rows(of fields: [EmbedSpec.Field], perRow: Int) -> [[EmbedSpec.Field]] {
        var rows: [[EmbedSpec.Field]] = []
        var current: [EmbedSpec.Field] = []
        for field in fields where !field.name.isEmpty && !field.value.isEmpty {
            if field.inline, perRow > 1 {
                current.append(field)
                if current.count == perRow {
                    rows.append(current)
                    current = []
                }
            } else {
                if !current.isEmpty {
                    rows.append(current)
                    current = []
                }
                rows.append([field])
            }
        }
        if !current.isEmpty { rows.append(current) }
        return rows
    }
}

/// A picture in the preview, loaded from its link. A link that is not http(s), or does not load,
/// leaves a quiet placeholder (or nothing for a small icon), never a broken picture.
struct EmbedImage: View {
    let link: String
    /// The side of a square picture; nil for a wide one that fills the width.
    let size: CGFloat?
    let isRound: Bool

    var body: some View {
        if EmbedSpec.isWebLink(link), let url = URL(string: link) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill()
                case .failure:
                    placeholder(systemImage: "photo")
                default:
                    placeholder(systemImage: nil)
                }
            }
            .frame(width: size, height: size ?? 140)
            .frame(maxWidth: size == nil ? .infinity : nil)
            .clipShape(RoundedRectangle(cornerRadius: isRound ? (size ?? 0) / 2 : SyloRadius.chip, style: .continuous))
            .accessibilityHidden(true)
        }
    }

    private func placeholder(systemImage: String?) -> some View {
        ZStack {
            Color.syloCard2
            if let systemImage {
                Image(systemName: systemImage)
                    .foregroundStyle(Color.syloMuted)
            }
        }
    }
}

/// A link button under the message in the preview.
struct LinkButtonPreview: View {
    let link: LinkButton

    var body: some View {
        HStack(spacing: SyloSpacing.xs + 2) {
            if !link.emoji.trimmingCharacters(in: .whitespaces).isEmpty {
                Text(verbatim: link.emoji)
            }
            Text(verbatim: link.label)
                .lineLimit(1)
            Image(systemName: "arrow.up.forward.square")
                .font(.caption)
                .accessibilityHidden(true)
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(Color.syloText)
        .padding(.horizontal, SyloSpacing.m)
        .padding(.vertical, SyloSpacing.s)
        .background(Color.syloCard2, in: RoundedRectangle(cornerRadius: SyloRadius.chip, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: SyloRadius.chip, style: .continuous)
                .strokeBorder(Color.syloLineStrong, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isLink)
    }
}
