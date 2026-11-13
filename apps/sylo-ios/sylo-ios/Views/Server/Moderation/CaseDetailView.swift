import SwiftUI
import SyloKit

/// One case with everything the server knows, and the two things staff can do to it: rewrite its
/// reason, and delete it or bring it back (it stays on record either way).
struct CaseDetailView: View {
    let model: ModerationModel
    let caseNumber: Int

    @State private var state = CaseActionState()
    @State private var isVisible = false

    var body: some View {
        List {
            if let moderationCase = model.moderationCase(caseNumber) {
                content(moderationCase)
            }
        }
        .overlay {
            if model.moderationCase(caseNumber) == nil {
                ContentUnavailableView(
                    "Case Not Found", systemImage: "doc.text.magnifyingglass",
                    description: Text("This case is no longer in the newest cases."))
            }
        }
        .navigationTitle("Case #\(caseNumber)")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false }
        .moderationActions($state, model: model, isAlertSuppressed: !isVisible)
        .refreshable { await model.load() }
    }

    @ViewBuilder
    private func content(_ moderationCase: ModerationCase) -> some View {
        Section {
            LabeledContent("Member", value: moderationCase.memberName)
            if !moderationCase.userId.isEmpty, moderationCase.userId != moderationCase.memberName {
                LabeledContent("Member ID") {
                    Text(verbatim: moderationCase.userId)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                }
            }
            LabeledContent("Action") {
                Text(verbatim: moderationCase.actionTitle)
                    .foregroundStyle(moderationCase.actionColor)
            }
            if !moderationCase.active {
                LabeledContent("Status") {
                    Text("Deleted").foregroundStyle(.secondary)
                }
            }
            if !moderationCase.moderator.isEmpty {
                LabeledContent("By", value: moderationCase.moderator)
            }
            if let date = moderationCase.date {
                LabeledContent("When", value: DateText.dayAndTime(date))
            }
            if !moderationCase.detail.isEmpty {
                LabeledContent("Detail", value: moderationCase.detail)
            }
        }

        Section("Reason") {
            if moderationCase.reason.isEmpty {
                Text("No reason").foregroundStyle(.secondary)
            } else {
                Text(verbatim: moderationCase.reason).textSelection(.enabled)
            }
        }

        Section {
            Button("Edit Reason", systemImage: "pencil") { state.editing = moderationCase }
                .disabled(model.isWorking)
            if moderationCase.active {
                Button("Delete Case", systemImage: "trash", role: .destructive) { state.toggling = moderationCase }
                    .disabled(model.isWorking)
            } else {
                Button("Restore Case", systemImage: "arrow.uturn.backward") { state.toggling = moderationCase }
                    .disabled(model.isWorking)
            }
        } footer: {
            Text("A deleted case stays on record, marked as deleted, and can be restored. Both changes go to the server's mod log.")
        }
    }
}

/// The case the person is editing or about to delete or restore. Shared by the case list and the
/// case screen, which show the same sheet and dialog.
struct CaseActionState {
    var editing: ModerationCase?
    var toggling: ModerationCase?
}

extension View {
    /// The reason sheet and the delete or restore confirmation for ``CaseActionState``, and the
    /// alert for what the server refused. The alert is held back while `isAlertSuppressed` (the
    /// screen is covered, or another sheet shows its own error).
    func moderationActions(_ state: Binding<CaseActionState>, model: ModerationModel, isAlertSuppressed: Bool) -> some View {
        modifier(ModerationActionsModifier(state: state, model: model, isAlertSuppressed: isAlertSuppressed))
    }
}

private struct ModerationActionsModifier: ViewModifier {
    @Binding var state: CaseActionState
    let model: ModerationModel
    let isAlertSuppressed: Bool

    func body(content: Content) -> some View {
        content
            .sheet(item: $state.editing) { moderationCase in
                CaseReasonSheet(model: model, moderationCase: moderationCase)
            }
            .confirmationDialog(
                title, isPresented: isConfirming, titleVisibility: .visible, presenting: state.toggling
            ) { moderationCase in
                if moderationCase.active {
                    Button("Delete Case", role: .destructive) {
                        Task { await model.setActive(false, for: moderationCase) }
                    }
                } else {
                    Button("Restore Case") {
                        Task { await model.setActive(true, for: moderationCase) }
                    }
                }
            } message: { moderationCase in
                if moderationCase.active {
                    Text("The case stays on record, marked as deleted. You can restore it later.")
                } else {
                    Text("The case counts again.")
                }
            }
            .alert("Couldn't Do That", isPresented: isShowingError, presenting: model.actionError) { _ in
                Button("OK") {}
            } message: { message in
                Text(message)
            }
    }

    private var title: LocalizedStringKey {
        guard let moderationCase = state.toggling else { return "" }
        if moderationCase.active { return "Delete case #\(moderationCase.caseNumber)?" }
        return "Restore case #\(moderationCase.caseNumber)?"
    }

    private var isConfirming: Binding<Bool> {
        Binding(get: { state.toggling != nil }, set: { if !$0 { state.toggling = nil } })
    }

    private var isShowingError: Binding<Bool> {
        Binding(
            get: { model.actionError != nil && !isAlertSuppressed && state.editing == nil },
            set: { if !$0 { model.actionError = nil } })
    }
}

/// Rewrites a case's reason. The reason is required, as on the dashboard, and the server keeps at
/// most 1000 characters. A refusal shows in the form, so it never hides behind the sheet.
private struct CaseReasonSheet: View {
    let model: ModerationModel
    let moderationCase: ModerationCase

    @State private var reason: String
    @Environment(\.dismiss) private var dismiss

    init(model: ModerationModel, moderationCase: ModerationCase) {
        self.model = model
        self.moderationCase = moderationCase
        _reason = State(initialValue: moderationCase.reason)
    }

    private var trimmed: String { reason.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Reason", text: $reason, axis: .vertical)
                        .lineLimit(3...10)
                        .onChange(of: reason) {
                            if reason.count > ModerationModel.maxCaseReasonLength {
                                reason = String(reason.prefix(ModerationModel.maxCaseReasonLength))
                            }
                        }
                } header: {
                    Text("Reason for case #\(moderationCase.caseNumber)")
                } footer: {
                    Text("Up to \(ModerationModel.maxCaseReasonLength) characters.")
                }
                if let message = model.actionError {
                    Section { StatusMessage(message, kind: .error) }
                }
            }
            .navigationTitle("Edit Reason")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.isWorking {
                        ProgressView()
                    } else {
                        Button("Save") {
                            Task {
                                if await model.editReason(of: moderationCase, to: reason) { dismiss() }
                            }
                        }
                        .toolbarSaveStyle()
                        .disabled(trimmed.isEmpty || trimmed == moderationCase.reason)
                    }
                }
            }
            .onAppear { model.actionError = nil }
            // Cancelled or swiped away after a refusal: the refusal is not shown again behind it.
            .onDisappear { model.actionError = nil }
        }
        .presentationDetents([.medium, .large])
    }
}
