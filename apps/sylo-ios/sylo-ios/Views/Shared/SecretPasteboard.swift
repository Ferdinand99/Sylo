import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The clipboard, for a value that is a secret (a webhook secret). The copy stays on this device (no
/// Universal Clipboard) and the system removes it after two minutes, so it does not sit there until
/// something else is copied over it.
enum SecretPasteboard {
    /// How long a copy stays on the clipboard, in seconds.
    static let lifetime: TimeInterval = 120

    static func copy(_ text: String) {
        UIPasteboard.general.setItems(
            [[UTType.plainText.identifier: text]],
            options: [
                .localOnly: true,
                .expirationDate: Date().addingTimeInterval(lifetime),
            ])
    }
}

/// A button that puts `value` on the clipboard (see ``SecretPasteboard``) and says "Copied" for a
/// moment.
struct CopyValueButton: View {
    let title: LocalizedStringKey
    let value: String

    @State private var copied = false
    @State private var copyCount = 0

    var body: some View {
        Button {
            SecretPasteboard.copy(value)
            copied = true
            copyCount += 1
        } label: {
            if copied {
                Label("Copied", systemImage: "checkmark")
            } else {
                Label(title, systemImage: "doc.on.doc")
            }
        }
        .sensoryFeedback(.success, trigger: copyCount)
        .task(id: copyCount) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }
}
