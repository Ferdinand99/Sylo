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
