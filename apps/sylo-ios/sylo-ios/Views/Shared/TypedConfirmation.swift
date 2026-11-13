import SwiftUI

extension View {
    /// An alert for an action that cannot be undone: the person has to type a word (`RESET`) before
    /// the confirming button turns on, as the web dashboard asks. The field starts empty every time.
    ///
    /// ```swift
    /// .typedConfirmation("Wipe All Leveling Data?", message: "Every member's XP is deleted.",
    ///                    word: "RESET", isPresented: $isAsking, confirmTitle: "Wipe") { … }
    /// ```
    /// - Parameters:
    ///   - word: What must be typed, exactly (the dashboard compares the same way).
    ///   - confirmTitle: The destructive button.
    func typedConfirmation(
        _ title: LocalizedStringKey, message: LocalizedStringKey, word: String, isPresented: Binding<Bool>,
        confirmTitle: LocalizedStringKey, onConfirm: @escaping () -> Void
    ) -> some View {
        modifier(TypedConfirmationModifier(
            title: title, message: message, word: word, isPresented: isPresented, confirmTitle: confirmTitle,
            onConfirm: onConfirm))
    }
}

private struct TypedConfirmationModifier: ViewModifier {
    let title: LocalizedStringKey
    let message: LocalizedStringKey
    let word: String
    @Binding var isPresented: Bool
    let confirmTitle: LocalizedStringKey
    let onConfirm: () -> Void

    @State private var typed = ""

    private var isConfirmed: Bool {
        typed == word
    }

    func body(content: Content) -> some View {
        content
            .alert(title, isPresented: $isPresented) {
                TextField(word, text: $typed)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                // Checked again here: the action is irreversible, so it must not rely on the disabled
                // state of an alert button alone.
                Button(confirmTitle, role: .destructive) {
                    if isConfirmed { onConfirm() }
                }
                .disabled(!isConfirmed)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(message) + Text(verbatim: "\n\n") + Text("Type \(word) to confirm.")
            }
            .onChange(of: isPresented) { _, shown in
                if shown { typed = "" }
            }
    }
}
