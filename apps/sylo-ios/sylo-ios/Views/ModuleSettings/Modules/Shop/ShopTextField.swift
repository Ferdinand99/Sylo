import SwiftUI
import SyloKit

/// A text field with a limit counted the way the server counts it, in UTF-16 units (a flag emoji is four),
/// with a counter near the limit and a stop at it. The text is cut between characters, so an emoji is never
/// split. The shop's name, emoji and description use it (`TextArea` counts characters, which would let
/// 64 flags through a limit of 64 units).
struct ShopTextField: View {
    let title: LocalizedStringKey
    @Binding var text: String
    let limit: Int
    /// nil: one line.
    var lines: ClosedRange<Int>?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let lines {
                TextField(title, text: $text, axis: .vertical)
                    .lineLimit(lines)
            } else {
                TextField(title, text: $text)
            }
            if text.utf16.count > limit * 3 / 4 {
                Text("\(text.utf16.count) of \(limit) characters")
                    .font(.caption)
                    .foregroundStyle(text.utf16.count > limit ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
            }
        }
        .onChange(of: text) {
            if text.utf16.count > limit { text = UTF16Limit.truncated(text, to: limit) }
        }
    }
}
