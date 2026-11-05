import SwiftUI
import SyloKit

// Pieces several module screens share: the explanation at the top, the platform note, and the link
// to the web dashboard for what the app leaves there.

/// The explanation at the top of a module screen. Plain secondary text on the screen's own
/// background, so it reads as help and not as a (disabled looking) field.
struct ModuleIntro: View {
    let text: LocalizedStringKey

    init(_ text: LocalizedStringKey) { self.text = text }

    var body: some View {
        Section {
            Text(text)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
        }
    }
}

/// What this platform does differently for the module (Fluxer has no threads or buttons yet), in
/// the server's own words. Nothing on Discord.
struct PlatformNoteSection: View {
    let model: ModulePlatformNoteModel

    var body: some View {
        if let note = model.note {
            Section {
                Label {
                    Text(verbatim: note)
                        .font(.subheadline)
                } icon: {
                    Image(systemName: "info.circle")
                        .foregroundStyle(.tint)
                }
            } header: {
                if let platform = model.platform {
                    Text(verbatim: platform.displayName)
                }
            }
        }
    }
}

/// A row that opens the module's page in the web dashboard, for what the app does not do itself.
struct DashboardLinkSection: View {
    let server: ServerID
    let module: ModuleID
    let footer: LocalizedStringKey

    @Environment(AppSession.self) private var session

    var body: some View {
        if let base = session.server {
            Section {
                Link(destination: base.dashboardURL(server: server, module: module)) {
                    Label("Manage in the web dashboard", systemImage: "safari")
                }
            } footer: {
                Text(footer)
            }
        }
    }
}

/// One line of a list under the settings: a title, then a quieter line of details.
struct ListLine: View {
    let title: String
    let details: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: title)
            if !details.isEmpty {
                Text(verbatim: details)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

extension View {
    /// Room under the last row of a tab's list, so it scrolls fully clear of the floating tab bar.
    /// Only where that bar floats over the content: iOS 26 and later, in a narrow window (iPhone).
    /// An iPad has its tabs at the top, and earlier systems inset the list themselves. Screens
    /// pushed from a tab cover the bar, so they need none.
    func tabBarClearance() -> some View {
        modifier(TabBarClearance())
    }
}

private struct TabBarClearance: ViewModifier {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    func body(content: Content) -> some View {
        if #available(iOS 26, *), horizontalSizeClass == .compact {
            content.contentMargins(.bottom, 64, for: .scrollContent)
        } else {
            content
        }
    }
}
