import SwiftUI
import SyloKit

/// The one text field with a limit, for a line or for several lines. It stops at `limit` UTF-16
/// units, the way the server counts and cuts (a flag emoji is four), and cuts between characters, so
/// an emoji is never split. Several lines (`lines`) come with a counter that appears near the limit;
/// `showsCounter` turns it on for one line too, or off for several.
struct LimitedTextField: View {
    let title: LocalizedStringKey
    @Binding var text: String
    let limit: Int
    var prompt: Text?
    /// nil: one line.
    var lines: ClosedRange<Int>?
    /// nil: a counter for several lines and none for one.
    var showsCounter: Bool?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let lines {
                TextField(title, text: $text, prompt: prompt, axis: .vertical)
                    .lineLimit(lines)
            } else {
                TextField(title, text: $text, prompt: prompt)
            }
            if showsCounter ?? (lines != nil) {
                LimitCounter(text: text, limit: limit)
            }
        }
        .onChange(of: text) {
            if text.utf16.count > limit { text = UTF16Limit.truncated(text, to: limit) }
        }
    }
}

/// "12 of 15 characters", shown once the text is three quarters of the way to the limit and red when
/// over it. Counted in UTF-16 units, like the server.
struct LimitCounter: View {
    let text: String
    let limit: Int

    var body: some View {
        let count = text.utf16.count
        if count > limit * 3 / 4 {
            Text("\(count) of \(limit) characters")
                .font(.caption)
                .foregroundStyle(count > limit ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
        }
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
