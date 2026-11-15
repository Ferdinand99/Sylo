import SwiftUI

/// An alert that asks the person to confirm an action and, in the same box, to give a reason. The
/// reason is optional where the dashboard makes it optional (deny an application, reject a
/// suggestion) and required where it must be given (forget a member's data).
///
/// ```swift
/// .reasonPrompt("Deny This Application?", message: "The applicant is told by direct message.",
///               isPresented: $isAsking, confirmTitle: "Deny", confirmRole: .destructive) { reason in
///     Task { await model.decide(.deny, reason: reason) }
/// }
/// ```
extension View {
    /// - Parameters:
    ///   - title: The alert's question.
    ///   - message: What will happen; say who is told.
    ///   - isPresented: Shows the alert. The reason field starts empty every time.
    ///   - confirmTitle: The confirming button (the action in one word).
    ///   - confirmRole: `.destructive` for deletes and removals.
    ///   - reasonLabel: The field's placeholder.
    ///   - reasonRequired: Disables the confirming button until a reason is typed.
    ///   - onConfirm: Called with the reason, trimmed; empty when none was typed.
    func reasonPrompt(
        _ title: LocalizedStringKey, message: LocalizedStringKey, isPresented: Binding<Bool>,
        confirmTitle: LocalizedStringKey, confirmRole: ButtonRole? = nil,
        reasonLabel: LocalizedStringKey = "Reason (optional)", reasonRequired: Bool = false,
        onConfirm: @escaping (String) -> Void
    ) -> some View {
        modifier(ReasonPromptModifier(
            title: Text(title), message: Text(message), isPresented: isPresented, confirmTitle: confirmTitle,
            confirmRole: confirmRole, reasonLabel: reasonLabel, reasonRequired: reasonRequired,
            onConfirm: onConfirm))
    }

    /// The same alert with a title and message that are shown exactly as given. Use it when the text holds
    /// a name a member or a server chose: a `LocalizedStringKey` would read `*`, `_` and `[x](y)` in it as
    /// Markdown.
    func reasonPrompt(
        verbatimTitle title: String, message: String, isPresented: Binding<Bool>,
        confirmTitle: LocalizedStringKey, confirmRole: ButtonRole? = nil,
        reasonLabel: LocalizedStringKey = "Reason (optional)", reasonRequired: Bool = false,
        onConfirm: @escaping (String) -> Void
    ) -> some View {
        modifier(ReasonPromptModifier(
            title: Text(verbatim: title), message: Text(verbatim: message), isPresented: isPresented,
            confirmTitle: confirmTitle, confirmRole: confirmRole, reasonLabel: reasonLabel,
            reasonRequired: reasonRequired, onConfirm: onConfirm))
    }
}

private struct ReasonPromptModifier: ViewModifier {
    let title: Text
    let message: Text
    @Binding var isPresented: Bool
    let confirmTitle: LocalizedStringKey
    let confirmRole: ButtonRole?
    let reasonLabel: LocalizedStringKey
    let reasonRequired: Bool
    let onConfirm: (String) -> Void

    @State private var reason = ""

    private var trimmedReason: String {
        reason.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func body(content: Content) -> some View {
        content
            .alert(title, isPresented: $isPresented) {
                TextField(reasonLabel, text: $reason)
                Button(confirmTitle, role: confirmRole) {
                    onConfirm(trimmedReason)
                }
                .disabled(reasonRequired && trimmedReason.isEmpty)
                Button("Cancel", role: .cancel) {}
            } message: {
                message
            }
            // A fresh, empty field every time the alert comes up.
            .onChange(of: isPresented) { _, shown in
                if shown { reason = "" }
            }
    }
}
