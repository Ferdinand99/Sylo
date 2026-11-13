import Foundation

/// Which screens hold edits that are not saved yet. An editor reports in while it is on screen;
/// the navigation owner asks before it replaces the path (a tapped notification, another server
/// in the sidebar), so those edits are never dropped without a prompt.
///
/// Reading and writing are locked and never touch the main actor, so a screen's token can release
/// its entry from `deinit`, whatever thread SwiftUI frees it on.
public final class UnsavedEdits: @unchecked Sendable {
    /// What replacing the navigation loses.
    public enum Scope: Sendable {
        /// A pushed screen or a sheet: gone whenever the path is replaced.
        case screen
        /// A server screen's own draft: it survives a path reset on the same server and is lost
        /// only when another server is shown.
        case server
    }

    private let lock = NSLock()
    private var entries: [UUID: Scope] = [:]

    public init() {}

    /// Marks the screen `id` as holding unsaved edits, or as clean again.
    public func set(_ id: UUID, dirty: Bool, scope: Scope = .screen) {
        lock.lock()
        defer { lock.unlock() }
        if dirty { entries[id] = scope } else { entries[id] = nil }
    }

    /// The screen is gone (closed, or its state released).
    public func remove(_ id: UUID) {
        set(id, dirty: false)
    }

    /// Whether the edits would be lost by replacing the path on the same server, or, with
    /// `changingServer`, by showing another one.
    public func wouldLoseEdits(changingServer: Bool) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return entries.values.contains { scope in
            switch scope {
            case .screen: true
            case .server: changingServer
            }
        }
    }
}
