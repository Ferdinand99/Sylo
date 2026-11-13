import SwiftUI
import SyloKit

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
            title: Text(title), message: Text(message), word: word, isPresented: isPresented,
            confirmTitle: confirmTitle, onConfirm: { _ in onConfirm() }))
    }

    /// The same alert for one of the operator's questions (``OperatorConfirmation``): its title and message
    /// are shown exactly as given, because they hold a backup's or a file's name, and what must be typed is
    /// the question's own word. A word with lowercase letters (a backup name) is typed without automatic
    /// capitals. `onConfirm` gets what was typed, for the model to check again.
    func typedConfirmation(
        _ confirmation: OperatorConfirmation, isPresented: Binding<Bool>, onConfirm: @escaping (_ typed: String) -> Void
    ) -> some View {
        modifier(TypedConfirmationModifier(
            title: Text(verbatim: confirmation.title), message: Text(verbatim: confirmation.message),
            word: confirmation.word, isPresented: isPresented,
            confirmTitle: LocalizedStringKey(confirmation.confirmTitle), onConfirm: onConfirm))
    }
}

private struct TypedConfirmationModifier: ViewModifier {
    let title: Text
    let message: Text
    let word: String
    @Binding var isPresented: Bool
    let confirmTitle: LocalizedStringKey
    let onConfirm: (String) -> Void

    @State private var typed = ""

    private var isConfirmed: Bool {
        !word.isEmpty && typed == word
    }

    private var capitalization: TextInputAutocapitalization {
        word == word.uppercased() ? .characters : .never
    }

    func body(content: Content) -> some View {
        content
            .alert(title, isPresented: $isPresented) {
                TextField(word, text: $typed)
                    .textInputAutocapitalization(capitalization)
                    .autocorrectionDisabled()
                // Checked again here: the action is irreversible, so it must not rely on the disabled
                // state of an alert button alone.
                Button(confirmTitle, role: .destructive) {
                    if isConfirmed { onConfirm(typed) }
                }
                .disabled(!isConfirmed)
                Button("Cancel", role: .cancel) {}
            } message: {
                message + Text(verbatim: "\n\n") + Text("Type \(word) to confirm.")
            }
            .onChange(of: isPresented) { _, shown in
                if shown { typed = "" }
            }
    }
}
