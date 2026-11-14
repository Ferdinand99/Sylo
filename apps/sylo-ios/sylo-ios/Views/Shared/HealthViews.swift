import SwiftUI
import SyloKit

// The permission and role-hierarchy health check in the views (Sylo 5.2, `health`): a note under a role or
// channel picker when Sylo cannot use the pick, and the module screen's own list of problems with "Check again".
// All of it reads the server screen's ``ServerHealthModel``; without one (a preview, or an older server that has
// no health check) nothing is shown.

/// The warning under a picker: Sylo cannot give this role, or cannot post in this channel.
struct HealthNote: View {
    enum Subject {
        case role(String)
        case channel(String)
        case roles([String], names: [String: String])
        case channels([String], names: [String: String])
    }

    let subject: Subject
    @Environment(ServerHealthModel.self) private var health: ServerHealthModel?

    var body: some View {
        ForEach(notes, id: \.self) { note in
            Label {
                Text(verbatim: note)
                    .font(.footnote)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var notes: [String] {
        guard let targets = health?.targets else { return [] }
        switch subject {
        case .role(let id): return targets.roleWarning(id).map { [$0] } ?? []
        case .channel(let id): return targets.channelWarning(id).map { [$0] } ?? []
        case .roles(let ids, let names): return targets.warnings(forRoles: ids, names: names)
        case .channels(let ids, let names): return targets.warnings(forChannels: ids, names: names)
        }
    }
}

/// A module screen's problems from the health check, at the top of the screen: what Sylo cannot do, what to do
/// about it, and "Check again" for after the fix. Nothing while all is well, while the module is off (the server
/// does not check it) or on a server without the check.
struct ModuleHealthBanner: View {
    let moduleID: String

    @Environment(ServerHealthModel.self) private var health: ServerHealthModel?
    @State private var isExpanded = false

    var body: some View {
        if let health, health.isSupported {
            let checks = health.checks(forModule: moduleID)
            if !checks.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Button {
                        withAnimation { isExpanded.toggle() }
                    } label: {
                        HStack(alignment: .firstTextBaseline) {
                            Label {
                                Text("Sylo can't do everything this module needs")
                                    .font(.subheadline.weight(.semibold))
                                    .multilineTextAlignment(.leading)
                            } icon: {
                                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(isExpanded ? "Hides the problems" : "Shows the problems")
                    if isExpanded {
                        ForEach(checks) { check in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: check.message)
                                    .font(.footnote.weight(.semibold))
                                if !check.fix.isEmpty {
                                    Text(verbatim: check.fix)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        CheckAgainButton(health: health)
                    } else {
                        Text(verbatim: checks.count == 1 ? checks[0].message : "\(checks[0].message) And \(checks.count - 1) more.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.bar)
            }
        }
    }
}

/// "Check again": asks the server to look now, and says when it was too soon.
struct CheckAgainButton: View {
    let health: ServerHealthModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                Task { await health.recheck() }
            } label: {
                if health.isRechecking {
                    HStack(spacing: 6) {
                        ProgressView()
                        Text("Checking\u{2026}")
                    }
                } else {
                    Label("Check Again", systemImage: "arrow.clockwise")
                }
            }
            .font(.footnote.weight(.semibold))
            .disabled(health.isRechecking)
            // Always there, so VoiceOver announces the notice when it appears.
            Text(verbatim: health.notice ?? "")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityAddTraits(.updatesFrequently)
        }
    }
}

extension View {
    /// The module's health problems above the screen.
    func moduleHealth(_ moduleID: String) -> some View {
        safeAreaInset(edge: .top, spacing: 0) { ModuleHealthBanner(moduleID: moduleID) }
    }
}
