import SwiftUI

/// A one-line explanation under a form or above the main action. Always a symbol and text, so
/// the kind of message never depends on colour alone.
struct StatusMessage: View {
    enum Kind {
        /// Something the person tried did not work.
        case error
        /// Something happened that the person should know about (signed out elsewhere).
        case notice
    }

    let text: String
    let kind: Kind

    init(_ text: String, kind: Kind) {
        self.text = text
        self.kind = kind
    }

    var body: some View {
        Label {
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: kind == .error ? "exclamationmark.triangle.fill" : "info.circle.fill")
                .symbolRenderingMode(kind == .error ? .multicolor : .hierarchical)
                .foregroundStyle(kind == .error ? AnyShapeStyle(.primary) : AnyShapeStyle(.tint))
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    VStack(alignment: .leading, spacing: 16) {
        StatusMessage("Can't reach this server. Check the address and your connection.", kind: .error)
        StatusMessage("You've been signed out. Sign in again to continue.", kind: .notice)
    }
    .padding()
}
