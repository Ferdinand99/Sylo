import SwiftUI
import SyloKit

// A native look-alike of how Discord shows a bot's message with embeds: the header line (avatar, the
// bot's name and its verified "APP" tag), the text, the embeds and the buttons. It is only a
// preview for the editors: colours, fields in rows of up to three, thumbnail and image, author and
// footer, and Discord's inline Markdown. No web view.

/// Discord's blurple.
private let blurple = Color(red: 0.345, green: 0.396, blue: 0.949)

/// A message's text as Discord shows it: inline Markdown (bold, italic, strike-through, code, links).
/// Text that is not valid Markdown shows as it is.
func discordText(_ text: String) -> Text {
    if let attributed = try? AttributedString(
        markdown: text, options: AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
        return Text(attributed)
    }
    return Text(verbatim: text)
}

/// The verified "✓ APP" tag next to a bot's name. Sylo is a verified app, never a "BOT".
struct VerifiedAppTag: View {
    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "checkmark")
                .font(.system(size: 8, weight: .heavy))
            Text(verbatim: "APP")
                .font(.caption2.bold())
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 5)
        .padding(.vertical, 1)
        .background(RoundedRectangle(cornerRadius: 4).fill(blurple))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Verified app")
    }
}

/// The first line of a message in Discord: avatar, name, the verified app tag and "Today".
struct BotMessageHeader: View {
    var botName = "Sylo"

    var body: some View {
        HStack(spacing: 8) {
            Text(verbatim: String(botName.prefix(1)))
                .font(.subheadline.bold())
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(Circle().fill(blurple))
                .accessibilityHidden(true)
            Text(verbatim: botName)
                .font(.subheadline.weight(.semibold))
            VerifiedAppTag()
            Text("Today")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A picture at a link the person typed. The link is only fetched a moment after typing stops, so a
/// half-typed address does not start a request per key. Shown only for an `http(s)` link.
struct PreviewImage: View {
    let urlString: String
    var contentMode: ContentMode = .fit

    @State private var shown: URL?

    init(_ urlString: String, contentMode: ContentMode = .fit) {
        self.urlString = urlString
        self.contentMode = contentMode
        _shown = State(initialValue: Self.url(from: urlString))
    }

    var body: some View {
        Group {
            if let shown {
                AuthenticatedImage(url: shown, contentMode: contentMode)
            } else {
                Color.clear
            }
        }
        .task(id: urlString) {
            let candidate = Self.url(from: urlString)
            guard candidate != shown else { return }
            guard candidate != nil else {
                shown = nil
                return
            }
            try? await Task.sleep(for: .milliseconds(600))
            if !Task.isCancelled { shown = candidate }
        }
    }

    /// The link when it is an `http(s)` address without spaces.
    static func url(from text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = trimmed.lowercased()
        guard lower.hasPrefix("http://") || lower.hasPrefix("https://"),
              !trimmed.contains(where: \.isWhitespace), trimmed.count > 8 else { return nil }
        return URL(string: trimmed)
    }
}

/// One embed as Discord draws it: a coloured bar on the left, then author, title, text, fields,
/// image and footer. What the editor's options hide is left out, like the server does.
struct EmbedPreviewCard: View {
    let draft: EmbedDraft
    var options = EmbedOptions()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if draft.isEmpty(options) {
                Text("Nothing in this embed yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                author
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        if !draft.title.isEmpty {
                            discordText(draft.title)
                                .font(.subheadline.weight(.semibold))
                        }
                        if options.description, !draft.description.isEmpty {
                            discordText(draft.description)
                                .font(.footnote)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if options.thumbnail, PreviewImage.url(from: draft.thumbnail) != nil {
                        PreviewImage(draft.thumbnail, contentMode: .fill)
                            .frame(width: 64, height: 64)
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                            .accessibilityHidden(true)
                    }
                }
                fieldRows
                if PreviewImage.url(from: draft.image) != nil {
                    PreviewImage(draft.image)
                        .frame(maxWidth: .infinity, maxHeight: 220)
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                        .accessibilityHidden(true)
                }
                footer
            }
        }
        .padding(.vertical, 12)
        .padding(.leading, 16)
        .padding(.trailing, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The coloured bar down the left edge, as tall as the card.
        .overlay(alignment: .leading) {
            accent.frame(width: 4)
        }
        .background(Color.secondary.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .accessibilityElement(children: .combine)
    }

    private var accent: Color {
        let rgb = draft.rgb(options)
        return Color(.sRGB, red: rgb.red, green: rgb.green, blue: rgb.blue)
    }

    // MARK: Author

    @ViewBuilder
    private var author: some View {
        if options.author, !draft.authorName.isEmpty {
            HStack(spacing: 6) {
                if PreviewImage.url(from: draft.authorIcon) != nil {
                    PreviewImage(draft.authorIcon, contentMode: .fill)
                        .frame(width: 20, height: 20)
                        .clipShape(Circle())
                        .accessibilityHidden(true)
                }
                Text(verbatim: draft.authorName)
                    .font(.caption.weight(.semibold))
            }
        }
    }

    // MARK: Fields

    /// The fields in rows: up to three inline fields side by side, any other field on its own row.
    static func rows(of fields: [EmbedDraft.Field]) -> [[EmbedDraft.Field]] {
        var rows: [[EmbedDraft.Field]] = []
        for field in fields where !field.name.isEmpty || !field.value.isEmpty {
            if field.inline, let last = rows.last, last.allSatisfy(\.inline), last.count < 3 {
                rows[rows.count - 1].append(field)
            } else {
                rows.append([field])
            }
        }
        return rows
    }

    @ViewBuilder
    private var fieldRows: some View {
        if options.fields {
            let rows = Self.rows(of: draft.fields)
            ForEach(rows.indices, id: \.self) { index in
                HStack(alignment: .top, spacing: 12) {
                    ForEach(rows[index]) { field in
                        VStack(alignment: .leading, spacing: 2) {
                            if !field.name.isEmpty {
                                discordText(field.name)
                                    .font(.caption.weight(.semibold))
                            }
                            if !field.value.isEmpty {
                                discordText(field.value)
                                    .font(.caption)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    // MARK: Footer

    @ViewBuilder
    private var footer: some View {
        let showsTime = options.timestamp && draft.timestamp
        if !draft.footerText.isEmpty || showsTime {
            HStack(spacing: 6) {
                if options.footerIcon, !draft.footerText.isEmpty, PreviewImage.url(from: draft.footerIcon) != nil {
                    PreviewImage(draft.footerIcon, contentMode: .fill)
                        .frame(width: 16, height: 16)
                        .clipShape(Circle())
                        .accessibilityHidden(true)
                }
                Text(verbatim: footerLine(showsTime: showsTime))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func footerLine(showsTime: Bool) -> String {
        guard showsTime else { return draft.footerText }
        let time = String(localized: "Today at \(Date.now.formatted(date: .omitted, time: .shortened))")
        return draft.footerText.isEmpty ? time : draft.footerText + " \u{2022} " + time
    }
}

#Preview {
    let session = AppSession.preview(.signedIn)
    VStack(alignment: .leading, spacing: 12) {
        BotMessageHeader()
        EmbedPreviewCard(
            draft: EmbedDraft(
                color: "#57f287", authorName: "Staff", title: "Welcome to **Sylo**",
                description: "Read the rules, then say hi.", footerText: "Be nice", timestamp: true,
                fields: [
                    EmbedDraft.Field(name: "One", value: "a", inline: true),
                    EmbedDraft.Field(name: "Two", value: "b", inline: true),
                    EmbedDraft.Field(name: "Three", value: "c"),
                ]),
            options: EmbedOptions(timestamp: true))
    }
    .padding()
    .environment(session)
}
