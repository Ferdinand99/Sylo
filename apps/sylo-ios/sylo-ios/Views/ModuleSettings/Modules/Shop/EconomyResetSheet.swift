import SwiftUI
import SyloKit

/// The danger zone: every account of the server goes back to a new start. It needs the word RESET typed,
/// as the web dashboard asks, and is never a single tap. The ledger keeps one "Reset" row per member
/// showing what they had, so the money can be traced, but the reset cannot be undone.
struct EconomyResetSheet: View {
    @State private var model: EconomyResetModel
    @State private var typed = ""
    @Environment(\.dismiss) private var dismiss
    @FocusState private var isFocused: Bool

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: EconomyResetModel(server: server, session: session))
    }

    var body: some View {
        NavigationStack {
            Form {
                if let accounts = model.accountsReset {
                    Section {
                        StatusMessage("The economy was reset: \(accounts.formatted()) accounts.", kind: .notice)
                    }
                    Section {
                        Button("Done") { dismiss() }
                    }
                } else {
                    Section {
                        Text("Every member goes back to a new start: cash to the starting balance, an empty bank, no streak and no cooldowns. The ledger keeps one \"Reset\" row per member showing what they had. This cannot be undone.")
                    }
                    Section {
                        TextField("RESET", text: $typed)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .focused($isFocused)
                    } header: {
                        Text("Type RESET to confirm")
                    }
                    if let message = model.errorMessage {
                        Section { StatusMessage(message, kind: .error) }
                    }
                    Section {
                        Button("Reset the Whole Economy", role: .destructive) {
                            Task { await model.reset(typed: typed) }
                        }
                        .disabled(!EconomyReset.accepts(typed) || model.isResetting)
                    } footer: {
                        if model.isResetting { Text("Resetting…") }
                    }
                }
            }
            .navigationTitle("Reset Economy")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if model.accountsReset == nil {
                        Button("Cancel") { dismiss() }
                            .disabled(model.isResetting)
                    }
                }
            }
            .interactiveDismissDisabled(model.isResetting)
            .sensoryFeedback(.warning, trigger: model.accountsReset)
            .onAppear { isFocused = true }
        }
    }
}
