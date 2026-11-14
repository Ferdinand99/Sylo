import SwiftUI
import SyloKit

// "Duplicate" in the item menus (Sylo 5.2, P6): reminders, embed messages, reaction-role sets, custom commands and
// shop items. The copy is made by the server and respects its limits. Sylo 5.2 announces no feature string for it, so
// a list offers Duplicate once the server has answered that it has the P6 routes (`hasImportRoutes`).

private struct DuplicateSupport: ViewModifier {
    let model: DuplicateModel
    let session: AppSession
    @Binding var isAvailable: Bool
    let onCopied: () async -> Void

    @State private var showsNote = false

    func body(content: Content) -> some View {
        content
            .task {
                isAvailable = await session.hasImportRoutes(server: model.server)
            }
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
    /// Sets up Duplicate for a list: asks whether the server has it (`isAvailable`), shows what a copy made or why
    /// it could not be made, and calls `onCopied` so the list reads again.
    func duplicating(
        _ model: DuplicateModel, session: AppSession, isAvailable: Binding<Bool>,
        onCopied: @escaping () async -> Void
    ) -> some View {
        modifier(DuplicateSupport(model: model, session: session, isAvailable: isAvailable, onCopied: onCopied))
    }
}

/// The "Duplicate" item of a menu, shown only where the server has it and the person may edit.
struct DuplicateButton: View {
    let model: DuplicateModel
    let isAvailable: Bool
    let kind: DuplicateKind
    let id: String

    @Environment(\.dashboardAccess) private var access

    var body: some View {
        if isAvailable, model.isAvailable, access.canEdit {
            Button("Duplicate", systemImage: "plus.square.on.square") {
                Task { await model.duplicate(kind, id: id) }
            }
            .disabled(model.isWorking)
        }
    }
}
