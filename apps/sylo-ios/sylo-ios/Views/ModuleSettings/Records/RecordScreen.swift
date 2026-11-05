import SwiftUI
import SyloKit

/// The frame of a module whose data is a list of records (reaction roles, custom commands,
/// reminders, channel cleanup, GitHub alerts): loading and error states, the module's platform note,
/// and a form for the module's own sections. There is no screen-wide Save; each record is saved
/// from its own editor.
struct RecordScreen<Page: Sendable, Content: View>: View {
    let title: LocalizedStringKey
    let model: RecordListModel<Page>
    let note: ModulePlatformNoteModel?
    @ViewBuilder let content: (Page) -> Content

    init(
        _ title: LocalizedStringKey, model: RecordListModel<Page>, note: ModulePlatformNoteModel? = nil,
        @ViewBuilder content: @escaping (Page) -> Content
    ) {
        self.title = title
        self.model = model
        self.note = note
        self.content = content
    }

    var body: some View {
        Group {
            if let page = model.page {
                Form {
                    Group {
                        if let note {
                            PlatformNoteSection(model: note)
                        }
                        content(page)
                    }
                    .syloSectionCards()
                }
                .syloFormStyle()
                .disabled(model.isWorking)
                .refreshable { await model.load() }
            } else if let message = model.errorMessage {
                EmptyState(
                    "Couldn't Load Settings", systemImage: "exclamationmark.triangle", message: Text(message),
                    isError: true, actionTitle: "Try Again") {
                        Task { await model.load() }
                    }
            } else {
                SyloLoadingView()
            }
        }
        .background { SyloBackground() }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .alert("Couldn't Complete", isPresented: isShowingActionError, presenting: model.actionError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: model.changeCount)
        .task {
            if model.page == nil { await model.load() }
            await note?.load()
        }
    }

    private var isShowingActionError: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
    }
}

/// One record in a list: a title, a line of details and a small status label. A button, so the
/// whole row opens the record.
struct RecordRow: View {
    let title: String
    let details: String
    var status: LocalizedStringKey?
    var isActive = true
    var warning: String?
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: SyloSpacing.xs) {
                HStack(alignment: .firstTextBaseline, spacing: SyloSpacing.s) {
                    Text(verbatim: title)
                        .font(.headline)
                        .foregroundStyle(Color.syloText)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: SyloSpacing.xs)
                    if let status {
                        SyloPill(status, tint: isActive ? .syloBrand : .syloMuted)
                    }
                }
                if !details.isEmpty {
                    Text(verbatim: details)
                        .font(.footnote)
                        .foregroundStyle(Color.syloMuted)
                        .multilineTextAlignment(.leading)
                }
                if let warning {
                    Label(warning, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(Color.syloWarn)
                        .multilineTextAlignment(.leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens it for editing")
    }
}

/// The editor of one record, in a sheet: Cancel and Save in the toolbar. Cancel asks first when
/// something was changed, and the sheet cannot be swiped away with unsaved changes. Save runs
/// `save`, which says whether it went through; the sheet closes then, and shows the reason when
/// not.
struct RecordEditor<Content: View>: View {
    let title: LocalizedStringKey
    /// Why the record cannot be saved yet; Save stays off while this is set.
    let problem: String?
    let hasChanges: Bool
    /// Saves and returns whether it went through. A failure's reason is read from `failure`.
    let save: () async -> Bool
    /// Where the reason for a failed save is kept after it ran.
    let failure: () -> String?
    @ViewBuilder let content: Content

    @Environment(\.dismiss) private var dismiss
    @State private var isConfirmingDiscard = false
    @State private var isSaving = false
    @State private var saveError: String?

    var body: some View {
        NavigationStack {
            Form {
                Group {
                    content
                    if let problem {
                        Section {
                            Label(problem, systemImage: "info.circle")
                                .font(.footnote)
                                .foregroundStyle(Color.syloMuted)
                                .listRowBackground(Color.clear)
                        }
                    }
                }
                .syloSectionCards()
            }
            .syloFormStyle()
            .disabled(isSaving)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        if hasChanges { isConfirmingDiscard = true } else { dismiss() }
                    }
                    .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { run() }
                            .toolbarSaveStyle()
                            .disabled(problem != nil)
                    }
                }
            }
            .confirmationDialog("Discard your changes?", isPresented: $isConfirmingDiscard, titleVisibility: .visible) {
                Button("Discard Changes", role: .destructive) { dismiss() }
            }
            .alert("Couldn't Save", isPresented: isShowingError, presenting: saveError) { _ in
                Button("OK") {}
            } message: { message in
                Text(message)
            }
        }
        .interactiveDismissDisabled(hasChanges)
        .presentationDragIndicator(.visible)
    }

    private func run() {
        isSaving = true
        Task {
            let ok = await save()
            isSaving = false
            if ok {
                dismiss()
            } else {
                saveError = failure()
            }
        }
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { saveError != nil }, set: { if !$0 { saveError = nil } })
    }
}
