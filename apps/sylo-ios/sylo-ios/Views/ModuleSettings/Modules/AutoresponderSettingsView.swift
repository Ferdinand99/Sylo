import SwiftUI
import SyloKit

/// Autoresponder: a per-channel cooldown, responders (trigger, match, reply) and ignored channels
/// and roles. Mirrors web-v2/src/moduleForms/Autoresponder.jsx.
struct AutoresponderSettingsView: View {
    @State private var model: ModuleSettingsModel<AutoresponderPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Autoresponder", model: model) { $settings, page in
            Section {
                Text("Replies automatically when a message matches a trigger, with no prefix. The first matching responder wins.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if !page.placeholders.isEmpty {
                    LabeledContent("Placeholders") {
                        Text(verbatim: page.placeholders.joined(separator: " "))
                            .font(.footnote.monospaced())
                    }
                }
            }

            Section {
                NumberField(title: "Per-channel cooldown", value: $settings.cooldownSeconds,
                            range: AutoresponderSettings.cooldownRange, unit: "sec")
            }

            // One section per responder, so each control gets its own row.
            ForEach($settings.responders) { $responder in
                Section {
                    TextField("Trigger", text: $responder.trigger)
                        .autocorrectionDisabled()
                    Picker("Match", selection: $responder.match) {
                        ForEach(AutoresponderMatch.allCases, id: \.self) { match in
                            Text(match.title).tag(match)
                        }
                    }
                    TextArea(title: "Reply", text: $responder.response,
                             limit: AutoresponderSettings.Responder.maxResponseLength, lines: 2...8)
                    Toggle("Send as an embed", isOn: $responder.embed)
                    Toggle("Delete the trigger message", isOn: $responder.deleteTrigger)
                    Button("Remove Responder", role: .destructive) {
                        settings.responders.removeAll { $0.id == responder.id }
                    }
                } header: {
                    Text("Responder")
                }
            }
            Section {
                if settings.responders.count < AutoresponderSettings.maxResponders {
                    Button("Add Responder", systemImage: "plus") {
                        settings.responders.append(AutoresponderSettings.Responder())
                    }
                }
            } footer: {
                Text("A responder without a trigger or a reply is dropped when you save. Deleting the trigger needs the Manage Messages permission.")
            }

            Section {
                MultiPicker(title: "Ignore channels", selection: $settings.ignoreChannels, options: page.channels,
                            prefix: "#")
                MultiPicker(title: "Ignore roles", selection: $settings.ignoreRoles, options: page.roles, prefix: "@")
            } footer: {
                Text("No replies in these channels, or to members with these roles.")
            }
        }
    }
}

extension AutoresponderMatch {
    var title: LocalizedStringKey {
        switch self {
        case .contains: "Contains"
        case .exact: "Is exactly"
        case .startswith: "Starts with"
        case .wholeword: "Whole word"
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<AutoresponderPage> else { return nil }
        return AutoresponderPage(
            settings: AutoresponderSettings(
                ignoreChannels: ["c2"],
                responders: [AutoresponderSettings.Responder(trigger: "hello", match: .wholeword,
                                                             response: "Hi {user}!")]),
            channels: [ChannelOption(id: "c1", name: "general"), ChannelOption(id: "c2", name: "staff")],
            roles: [RoleOption(id: "r1", name: "Bots")],
            placeholders: ["{user}", "{username}", "{server}", "{channel}"])
    }
    NavigationStack {
        AutoresponderSettingsView(server: "1", session: session)
    }
    .environment(session)
}
