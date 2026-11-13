import SwiftUI
import SyloKit

/// Warn a member, or clear all of a member's warnings. The member is picked from a search (or
/// pasted as an id or @mention); the dashboard only takes a pasted id. Both actions ask first.
/// A refusal from the server (not a member of this server, the member's rank is too high) shows in
/// the form in the server's words. A good outcome closes the sheet and shows in the list behind it.
struct WarnSheet: View {
    let model: ModerationModel
    let server: ServerID
    let session: AppSession

    @State private var member: MemberChoice?
    @State private var reason = ""
    @State private var isConfirmingWarn = false
    @State private var isConfirmingClear = false
    @Environment(\.dismiss) private var dismiss

    private var trimmed: String { reason.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    MemberPicker("Member", server: server, session: session, selection: $member)
                } footer: {
                    Text("Only members of this server can be warned.")
                }

                Section {
                    LimitedTextField(title: "Why they are being warned", text: $reason,
                                     limit: ModerationModel.maxWarnReasonLength, lines: 2...6)
                } header: {
                    Text("Reason")
                } footer: {
                    Text("Required, and shown to the member in the DM. Up to \(ModerationModel.maxWarnReasonLength) characters.")
                }

                if let message = model.actionError {
                    Section { StatusMessage(message, kind: .error) }
                }

                Section {
                    Button("Warn", systemImage: "exclamationmark.bubble") { isConfirmingWarn = true }
                        .disabled(member == nil || trimmed.isEmpty || model.isWorking)
                }

                Section {
                    Button("Clear Their Warnings", systemImage: "eraser", role: .destructive) {
                        isConfirmingClear = true
                    }
                    .disabled(member == nil || model.isWorking)
                } footer: {
                    Text("Removes every warning on record for the member, so they count from zero again.")
                }
            }
            .navigationTitle("Warn a Member")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                if model.isWorking {
                    ToolbarItem(placement: .confirmationAction) { ProgressView() }
                }
            }
            .onAppear { model.actionError = nil }
            // Cancelled or swiped away after a refusal: the refusal is not shown again behind it.
            .onDisappear { model.actionError = nil }
            .confirmationDialog(
                "Warn \(member?.name ?? "")?", isPresented: $isConfirmingWarn, titleVisibility: .visible
            ) {
                Button("Warn") {
                    guard let member else { return }
                    let text = reason
                    Task { if await model.warn(member, reason: text) { dismiss() } }
                }
            } message: {
                Text("The member gets your reason by direct message, and the warning counts toward the warning thresholds.")
            }
            .confirmationDialog(
                "Clear \(member?.name ?? "")'s warnings?", isPresented: $isConfirmingClear, titleVisibility: .visible
            ) {
                Button("Clear Warnings", role: .destructive) {
                    guard let member else { return }
                    Task { if await model.clearWarnings(of: member) { dismiss() } }
                }
            } message: {
                Text("Every warning on record for this member is removed. This can't be undone.")
            }
        }
        .presentationDetents([.large])
    }
}
