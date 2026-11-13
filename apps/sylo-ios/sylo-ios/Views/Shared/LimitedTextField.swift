import SwiftUI

/// One line of text that stops at `limit` UTF-16 units (the way the server counts), cut between
/// characters.
struct LimitedTextField: View {
    let title: LocalizedStringKey
    @Binding var text: String
    let limit: Int
    var prompt: Text?

    var body: some View {
        TextField(title, text: $text, prompt: prompt)
            .onChange(of: text) {
                if text.utf16.count > limit { text = Self.truncated(text, toUTF16: limit) }
            }
    }

    /// The longest start of `text` that fits `limit` UTF-16 units.
    static func truncated(_ text: String, toUTF16 limit: Int) -> String {
        var units = 0
        var result = ""
        for character in text {
            units += character.utf16.count
            if units > limit { break }
            result.append(character)
        }
        return result
    }
}

/// A text field for a link (`https://…`).
struct LinkTextField: View {
    let title: LocalizedStringKey
    @Binding var text: String

    var body: some View {
        TextField(title, text: $text, prompt: Text(verbatim: "https://"))
            .keyboardType(.URL)
            .textContentType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
    }
}

/// Several lines of text with a counter near the limit and a hard stop at it, counted in UTF-16
/// units like the server (and the embed editor), so text heavy with emoji is not cut afterwards.
struct UTF16TextArea: View {
    let title: LocalizedStringKey
    @Binding var text: String
    let limit: Int
    var lines: ClosedRange<Int> = 3...8

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            TextField(title, text: $text, axis: .vertical)
                .lineLimit(lines)
            if text.utf16.count > limit * 3 / 4 {
                Text("\(text.utf16.count) of \(limit) characters")
                    .font(.caption)
                    .foregroundStyle(text.utf16.count > limit ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
            }
        }
        .onChange(of: text) {
            if text.utf16.count > limit { text = LimitedTextField.truncated(text, toUTF16: limit) }
        }
    }
}
