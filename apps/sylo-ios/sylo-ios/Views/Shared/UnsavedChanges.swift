import SwiftUI
import SyloKit

extension EnvironmentValues {
    /// Where editors report unsaved edits; set by ``MainView``. nil in previews, which then
    /// report nothing.
    @Entry var unsavedEdits: UnsavedEdits?
}

extension View {
    /// Reports whether this screen holds unsaved edits, so the navigation owner can ask before a
    /// tapped notification or another server in the sidebar replaces the path and drops them. Use
    /// it next to `navigationBarBackButtonHidden(_:)` on every editor that guards its own back.
    ///
    /// ```swift
    /// .navigationBarBackButtonHidden(model.hasChanges)
    /// .tracksUnsavedChanges(model.hasChanges)
    /// ```
    ///
    /// A server screen's own draft passes `.server`: it survives a path reset on the same server.
    func tracksUnsavedChanges(_ isDirty: Bool, scope: UnsavedEdits.Scope = .screen) -> some View {
        modifier(TracksUnsavedChanges(isDirty: isDirty, scope: scope))
    }
}

/// Holds the screen's identity in the registry. Its entry is released when SwiftUI frees the
/// screen's state, so a covered screen (something pushed on top) still counts.
private final class UnsavedToken {
    let id = UUID()
    var edits: UnsavedEdits?

    deinit { edits?.remove(id) }
}

private struct TracksUnsavedChanges: ViewModifier {
    let isDirty: Bool
    let scope: UnsavedEdits.Scope

    @Environment(\.unsavedEdits) private var edits
    @State private var token = UnsavedToken()

    func body(content: Content) -> some View {
        content.onChange(of: isDirty, initial: true) { report() }
    }

    private func report() {
        token.edits = edits
        edits?.set(token.id, dirty: isDirty, scope: scope)
    }
}
