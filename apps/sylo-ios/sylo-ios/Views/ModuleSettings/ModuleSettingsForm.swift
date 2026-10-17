import SwiftUI
import SyloKit

/// The frame every module's settings screen uses: loading and error states, a `Form` with the
/// module's own sections, Save in the toolbar, and Discard (with a confirmation) while there are
/// unsaved changes. The back button is hidden while there are changes, so they can't be lost by
/// accident.
///
/// A module's screen only writes its sections:
/// ```swift
/// ModuleSettingsForm("Honeypot", model: model) { $settings, page in
///     Section { … }
/// }
/// ```
struct ModuleSettingsForm<Page: ModuleSettingsPage, Content: View>: View {
    let title: LocalizedStringKey
    let model: ModuleSettingsModel<Page>
    @ViewBuilder let content: (Binding<Page.Settings>, Page) -> Content

    @State private var isConfirmingDiscard = false

    init(
        _ title: LocalizedStringKey, model: ModuleSettingsModel<Page>,
        @ViewBuilder content: @escaping (Binding<Page.Settings>, Page) -> Content
    ) {
        self.title = title
        self.model = model
        self.content = content
    }

    var body: some View {
        Group {
            if let page = model.page {
                Form {
                    content(draft(fallback: page.settings), page)
                }
                .disabled(model.isSaving)
                .refreshable { await model.load() }
            } else if let message = model.errorMessage {
                ContentUnavailableView {
                    Label("Can't Load Settings", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await model.load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(model.hasChanges)
        .toolbar {
            if model.hasChanges {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Discard") { isConfirmingDiscard = true }
                        .disabled(model.isSaving)
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                if model.isSaving {
                    ProgressView()
                } else {
                    Button("Save") { Task { await model.save() } }
                        .disabled(!model.hasChanges)
                }
            }
        }
        .confirmationDialog("Discard your changes?", isPresented: $isConfirmingDiscard, titleVisibility: .visible) {
            Button("Discard Changes", role: .destructive) { model.discardChanges() }
        }
        .alert("Couldn't Save", isPresented: isShowingSaveError, presenting: model.saveError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: model.saveCount)
        .task {
            if model.page == nil { await model.load() }
        }
    }

    private func draft(fallback: Page.Settings) -> Binding<Page.Settings> {
        Binding(get: { model.draft ?? fallback }, set: { model.draft = $0 })
    }

    private var isShowingSaveError: Binding<Bool> {
        Binding(get: { model.saveError != nil }, set: { if !$0 { model.saveError = nil } })
    }
}
