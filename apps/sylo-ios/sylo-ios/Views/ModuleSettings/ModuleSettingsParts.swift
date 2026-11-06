import SwiftUI
import SyloKit

// Pieces several module screens share: the explanation at the top and the platform note.

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
                // Inset enough that the section's rounded corner never clips the first and last line.
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
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
    /// Room under the last row of a tab's content, so it scrolls fully clear of the floating tab
    /// bar (``CapsuleTabBar``). Screens pushed from a tab cover the bar, so they need none.
    func tabBarClearance() -> some View {
        contentMargins(.bottom, CapsuleTabBar.clearance, for: .scrollContent)
    }
}
