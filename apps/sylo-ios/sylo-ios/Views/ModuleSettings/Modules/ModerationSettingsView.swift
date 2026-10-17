import SwiftUI
import SyloKit

/// Moderation: DMs on punishment, warning thresholds (automatic actions at a warning count),
/// and how long closed cases are kept. Mirrors web-v2/src/moduleForms/Moderation.jsx.
struct ModerationSettingsView: View {
    @State private var model: ModuleSettingsModel<ModerationPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Moderation", model: model) { $settings, _ in
            Section {
                Toggle("DM members when they are punished", isOn: $settings.dmOnPunish)
            }

            // One section per rule, so each control gets its own row.
            ForEach($settings.warnThresholds) { $rule in
                Section {
                    NumberField(title: "At warning", value: $rule.count,
                                range: ModerationSettings.WarnThreshold.countRange)
                    Picker("Action", selection: $rule.action) {
                        ForEach(ModerationThresholdAction.allCases, id: \.self) { action in
                            Text(verbatim: action.title).tag(action)
                        }
                    }
                    if rule.action == .timeout {
                        NumberField(title: "Timeout", value: $rule.durationMinutes,
                                    range: ModerationSettings.WarnThreshold.durationRange, unit: "min")
                    }
                    Button("Remove Rule", role: .destructive) {
                        settings.warnThresholds.removeAll { $0.id == rule.id }
                    }
                } header: {
                    Text("Warning threshold")
                }
            }
            Section {
                Button("Add Rule", systemImage: "plus") {
                    settings.warnThresholds.append(ModerationSettings.WarnThreshold())
                }
            } footer: {
                if settings.warnThresholds.isEmpty {
                    Text("No rules yet, so warnings alone have no effect. A rule acts automatically once a member reaches its warning count.")
                } else {
                    Text("A rule acts automatically once a member reaches its warning count. The strictest matching rule wins.")
                }
            }

            Section {
                NumberField(title: "Delete inactive cases after", value: $settings.infractionRetentionDays,
                            range: ModerationSettings.retentionRange, unit: "days")
            } footer: {
                Text("0 keeps them forever. A daily job removes cases that were deleted or resolved (an unban or untimeout) once they are older than this. Active warnings and the visible history are never removed automatically.")
            }
        }
    }
}

extension ModerationThresholdAction {
    var title: String {
        switch self {
        case .timeout: "Timeout"
        case .kick: "Kick"
        case .ban: "Ban"
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<ModerationPage> else { return nil }
        return ModerationPage(
            settings: ModerationSettings(
                warnThresholds: [
                    ModerationSettings.WarnThreshold(count: 3, action: .timeout, durationMinutes: 120),
                    ModerationSettings.WarnThreshold(count: 5, action: .ban),
                ],
                infractionRetentionDays: 90))
    }
    NavigationStack {
        ModerationSettingsView(server: "1", session: session)
    }
    .environment(session)
}
