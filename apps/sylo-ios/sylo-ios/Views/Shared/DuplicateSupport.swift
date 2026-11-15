import SwiftUI
import SyloKit

// "Duplicate" in the item menus (Sylo 5.2, P6): reminders, embed messages, reaction-role sets, custom commands and
// shop items. The copy is made by the server and respects its limits. The server announces `duplicate`; without it a
// list has no Duplicate item. Duplicating changes the server, so it needs Edit.

private struct DuplicateSupport: ViewModifier {
    let model: DuplicateModel
    let onCopied: () async -> Void

    @State private var showsNote = false

    func body(content: Content) -> some View {
        content
            .onChange(of: model.copyCount) {
                showsNote = true
                Task { await onCopied() }
            }
            .alert("Couldn't Duplicate", isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } })
            ) {
                Button("OK") {}
            } message: {
                Text(verbatim: model.errorMessage ?? "")
            }
            .alert("Duplicated", isPresented: $showsNote) {
                Button("OK") {}
            } message: {
                Text(verbatim: model.lastNote ?? "")
            }
    }
}

extension View {
    /// Shows what a copy made or why it could not be made, and calls `onCopied` so the list reads again.
    func duplicating(_ model: DuplicateModel, onCopied: @escaping () async -> Void) -> some View {
        modifier(DuplicateSupport(model: model, onCopied: onCopied))
    }
}

/// The "Duplicate" item of a menu, shown only where the server announces `duplicate` and the person may edit.
struct DuplicateButton: View {
    let model: DuplicateModel
    let kind: DuplicateKind
    let id: String

    @Environment(AppSession.self) private var session
    @Environment(\.dashboardAccess) private var access

    var body: some View {
        if session.has(.duplicate), access.canEdit {
            Button("Duplicate", systemImage: "plus.square.on.square") {
                Task { await model.duplicate(kind, id: id) }
            }
            .disabled(model.isWorking)
        }
    }
}
