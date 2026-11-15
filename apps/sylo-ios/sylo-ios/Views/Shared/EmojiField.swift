import SwiftUI
import SyloKit

/// A text field for one emoji, with a button that opens a picker of the server's own emojis and a
/// set of common ones. Type or paste any emoji, or switch to the emoji keyboard; a custom emoji is
/// kept as `<:name:id>`, which is what the server stores and posts.
struct EmojiField: View {
    let title: LocalizedStringKey
    @Binding var text: String
    /// The server's custom emojis, from the server's emoji list. Empty when it has none.
    var customEmojis: [GuildEmoji] = []

    @State private var isPicking = false

    var body: some View {
        HStack(spacing: 8) {
            TextField(title, text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if let custom = customEmoji {
                EmojiImage(url: custom.url, size: 22)
                    .accessibilityLabel(Text(verbatim: ":\(custom.name):"))
            }
            Button {
                isPicking = true
            } label: {
                Image(systemName: "face.smiling")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Pick an Emoji")
        }
        .sheet(isPresented: $isPicking) {
            EmojiPickerView(customEmojis: customEmojis) { picked in
                text = picked
                isPicking = false
            }
        }
    }

    /// The server emoji the text names, to show next to the field.
    private var customEmoji: GuildEmoji? {
        switch EmojiToken.parse(text) {
        case .custom(_, let id, _): customEmojis.first { $0.display.contains(":\(id)>") }
        case .shortcode(let name): customEmojis.first { $0.name == name }
        default: nil
        }
    }
}

/// A small picture of a custom emoji, fetched without the Sylo token and only over https.
struct EmojiImage: View {
    let url: String
    let size: CGFloat

    var body: some View {
        Group {
            if let url = Self.safeURL(url) {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFit()
                } placeholder: {
                    Color.clear
                }
            } else {
                Color.clear
            }
        }
        .frame(width: size, height: size)
    }

    private static func safeURL(_ text: String) -> URL? {
        guard let url = URL(string: text), url.scheme?.lowercased() == "https", url.host != nil else { return nil }
        return url
    }
}

/// The emoji picker: the server's emojis, then a set of common ones.
struct EmojiPickerView: View {
    let customEmojis: [GuildEmoji]
    let onPick: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    private static let common: [String] = (
        "😀 😂 😍 😎 🤔 😴 🥳 😢 😡 👍 👎 👌 🙏 👏 🙌 💪 🔥 ✨ ⭐ 🌟 💯 ✅ ❌ ⚠️ ❗ ❓ 💡 🔔 📌 📢 "
            + "🎮 🕹️ 🎧 🎵 🎬 📷 💻 📱 🖥️ ⌨️ 🛠️ ⚙️ 🔧 🔒 🔑 🚀 🛰️ 🌍 🗺️ 🏆 🥇 🎯 🎲 ♠️ ♥️ ♦️ ♣️ "
            + "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💖 💗 🎉 🎊 🎁 🍕 🍔 🍟 🌮 🍺 🍻 ☕ 🧊 🐶 🐱 🦊 🐸 🐼 🦁 🐢 🐧"
    ).split(separator: " ").map(String.init)

    private let columns = [GridItem(.adaptive(minimum: 44), spacing: 4)]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if !customEmojis.isEmpty {
                        Text("Server")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                        LazyVGrid(columns: columns, spacing: 4) {
                            ForEach(customEmojis) { emoji in
                                Button {
                                    onPick(emoji.display)
                                } label: {
                                    EmojiImage(url: emoji.url, size: 28)
                                        .frame(width: 44, height: 44)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(Text(verbatim: ":\(emoji.name):"))
                            }
                        }
                    }
                    Text("Emoji")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                    LazyVGrid(columns: columns, spacing: 4) {
                        ForEach(Self.common, id: \.self) { emoji in
                            Button {
                                onPick(emoji)
                            } label: {
                                Text(verbatim: emoji)
                                    .font(.title2)
                                    .frame(width: 44, height: 44)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text(verbatim: emoji))
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("Pick an Emoji")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

#Preview {
    @Previewable @State var text = ""
    Form {
        EmojiField(
            title: "👋", text: $text,
            customEmojis: [GuildEmoji(name: "wave", display: "<:wave:123456789012345678>")])
    }
}
