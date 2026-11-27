import SwiftUI
import SyloKit

// Dashboard access levels in the views (Sylo 5.2). The server screen puts the person's level in the environment;
// a screen reads it and switches off what the level may not use. The server enforces the level on every route, so
// this only saves the person from a button that would be refused. A server without levels sends none: that is
// Edit, so nothing is hidden on a Sylo 5.1.

private struct DashboardAccessKey: EnvironmentKey {
    static let defaultValue: DashboardAccess = .edit
}

private struct ServerPlatformKey: EnvironmentKey {
    static let defaultValue: Platform? = nil
}

private struct ServerOverviewKey: EnvironmentKey {
    static let defaultValue: ServerOverview? = nil
}

extension EnvironmentValues {
    /// The signed-in person's level in the server being shown.
    var dashboardAccess: DashboardAccess {
        get { self[DashboardAccessKey.self] }
        set { self[DashboardAccessKey.self] = newValue }
    }

    /// The overview of the server being shown, once loaded (for the server's Beta flags); nil when not known.
    var serverOverview: ServerOverview? {
        get { self[ServerOverviewKey.self] }
        set { self[ServerOverviewKey.self] = newValue }
    }

    /// The platform of the server being shown (Discord or Fluxer); nil outside a server screen.
    var serverPlatform: Platform? {
        get { self[ServerPlatformKey.self] }
        set { self[ServerPlatformKey.self] = newValue }
    }
}

/// The sentence at the top of a screen the level has switched off.
struct AccessNotice: View {
    let access: DashboardAccess

    var body: some View {
        if let note = access.limitNote {
            Label {
                Text(verbatim: note)
                    .font(.footnote)
            } icon: {
                Image(systemName: "lock.fill")
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.bar)
            .accessibilityElement(children: .combine)
        }
    }
}

/// "View only" or "Inbox only" beside a server's name; nothing for Edit.
struct AccessBadge: View {
    let access: DashboardAccess

    var body: some View {
        if let title = access.badgeTitle {
            Label {
                Text(verbatim: title)
            } icon: {
                Image(systemName: "lock.fill")
            }
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Color.secondary.opacity(0.18), in: Capsule())
            .accessibilityLabel(Text(verbatim: title))
        }
    }
}

private struct AccessLock: ViewModifier {
    let required: DashboardAccess
    /// Show the sentence on top of the screen.
    let notice: Bool
    /// Switch the whole screen off (a screen that has parts for lower levels switches those on itself).
    let disables: Bool

    @Environment(\.dashboardAccess) private var access

    func body(content: Content) -> some View {
        if access.allows(required) {
            content
        } else {
            content
                .disabled(disables)
                .safeAreaInset(edge: .top, spacing: 0) {
                    if notice { AccessNotice(access: access) }
                }
        }
    }
}

/// For a screen that shows what an inbox holds (a ticket's messages, an application's answers): a person with
/// View access gets the lists without their content, and the server refuses the detail, so the app says so
/// instead of asking.
private struct InboxOnly: ViewModifier {
    @Environment(\.dashboardAccess) private var access

    func body(content: Content) -> some View {
        if access.seesInboxContent {
            content
        } else {
            ContentUnavailableView {
                Label("Needs Inbox Access", systemImage: "lock")
            } description: {
                Text("You have view-only access to this server. What members wrote in tickets, appeals and applications is only shown with Inbox access.")
            }
        }
    }
}

extension View {
    /// Shows this screen only to a person who may read what the inboxes contain (Inbox or Edit).
    func inboxOnly() -> some View { modifier(InboxOnly()) }

    /// Switches the screen off for a person below `level` (Edit unless said) and says why at the top.
    func lockedBelow(_ level: DashboardAccess = .edit) -> some View {
        modifier(AccessLock(required: level, notice: true, disables: true))
    }

    /// Only the sentence at the top, for a screen that switches its own parts off.
    func accessNotice(below level: DashboardAccess = .edit) -> some View {
        modifier(AccessLock(required: level, notice: true, disables: false))
    }

    /// Switches this part off for a person below `level`, without a sentence.
    func disabledBelow(_ level: DashboardAccess = .edit) -> some View {
        modifier(AccessLock(required: level, notice: false, disables: true))
    }
}

/// The line at the top of a Beta module's screen (Sylo 5.3: the bridge and the server mirror), as in the dashboard.
/// Shown when the server's overview marks the module Beta, or, when the overview does not say, by the app's list
/// (``ModuleBeta``).
struct BetaNote: View {
    let moduleID: String
    @Environment(\.serverOverview) private var overview

    var body: some View {
        if ModuleBeta.isBeta(moduleID, in: overview) {
            Section {
                // Not a Label: its icon slot is a fixed width and squeezed the pill into "B / et / a".
                // The pill keeps its own size on one line; only the sentence wraps, at any Dynamic Type size.
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    BetaBadge()
                        .lineLimit(1)
                        .fixedSize()
                    Text(verbatim: ModuleBeta.note)
                        .font(.footnote)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}
