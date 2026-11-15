import SwiftUI
import SyloKit

/// Auto threads: one rule per channel that gives every new post its own thread, with the thread
/// name, when it archives, which posts count, an optional first message and slowmode. Discord
/// only: on a Fluxer server the screen says so. Mirrors web-v2/src/moduleForms/AutoThreads.jsx.
struct AutoThreadsSettingsView: View {
    @State private var model: ModuleSettingsModel<AutoThreadsPage>
    @State private var note: ModulePlatformNoteModel

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: AutoThreadsPage.moduleID, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Auto Threads", model: model) { $settings, page in
            ModuleIntro("Every new post in a channel below gets its own thread. The first rule for a channel that fits the post is used. Forum channels are not listed: they already make a thread for every post. Sylo needs Create Public Threads and Send Messages in Threads in the channel.")
            PlatformNoteSection(model: note)

            if settings.rules.isEmpty {
                Section {
                    Text("No rules yet. Add a channel below.").foregroundStyle(.secondary)
                }
            }

            ForEach($settings.rules) { $rule in
                Section {
                    ChannelPicker(title: "Channel", selection: $rule.channelId, channels: page.channels,
                                  noneTitle: "Choose a channel")
                    LimitedTextField(title: "Thread name", text: $rule.nameTemplate,
                                     limit: AutoThreadsSettings.maxNameTemplateLength, lines: 1...3)
                    Picker("Archive after", selection: $rule.archive) {
                        ForEach(AutoThreadsSettings.Archive.allCases, id: \.self) { archive in
                            Text(verbatim: archive.title).tag(archive)
                        }
                    }
                    Toggle("Only posts with an attachment", isOn: $rule.onlyWithAttachments)
                    Toggle("Only posts with a link", isOn: $rule.onlyWithLinks)
                    Toggle("Skip bots and webhooks", isOn: $rule.skipBots)
                    Toggle("Skip staff", isOn: $rule.skipStaff)
                    if rule.skipStaff {
                        MultiPicker(title: "Staff roles", selection: $rule.staffRoleIds, options: page.roles, prefix: "@")
                    }
                    LimitedTextField(title: "First message in the thread (optional)", text: $rule.firstMessage,
                                     limit: AutoThreadsSettings.maxFirstMessageLength, lines: 2...6)
                    NumberField(title: "Slowmode", value: $rule.slowmodeSeconds,
                                range: AutoThreadsSettings.slowmodeRange, unit: "seconds")
                    Button("Remove Rule", role: .destructive) {
                        settings.rules.removeAll { $0.uid == rule.uid }
                    }
                } header: {
                    Text(verbatim: Self.title(of: rule, channels: page.channels))
                } footer: {
                    Text("{words} is the first words of the post, or the poster's name if it has none. {author} and {date} also work. With both post filters on, a post needs one of the two; Sylo finds links by reading the post's text, which only works when the bot owner has allowed Sylo to read message text. {author} in the first message becomes a mention. Slowmode 0 is off.")
                }
            }

            Section {
                if settings.rules.count < AutoThreadsSettings.maxRules {
                    Button("Add Rule", systemImage: "plus") {
                        settings.rules.append(AutoThreadsSettings.Rule())
                    }
                }
            } footer: {
                Text("A rule without a channel is not saved.")
            }
        }
        .task { await note.load() }
    }

    /// The rule's channel, or "Rule 2" while it has none.
    static func title(of rule: AutoThreadsSettings.Rule, channels: [ChannelOption]) -> String {
        if let channel = channels.first(where: { $0.id == rule.channelId }) { return "#\(channel.name)" }
        return String(localized: "New rule")
    }
}

extension AutoThreadsSettings.Archive {
    var title: String {
        switch self {
        case .hour: String(localized: "1 hour without activity")
        case .day: String(localized: "24 hours without activity")
        case .threeDays: String(localized: "3 days without activity")
        case .week: String(localized: "7 days without activity")
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        if endpoint is Endpoints.LoadPlatformInfo {
            return PlatformInfo(platform: .fluxer, notes: ["auto-threads": "Fluxer has no threads yet, so this module does nothing on a Fluxer server."])
        }
        guard endpoint is Endpoints.LoadModuleSettings<AutoThreadsPage> else { return nil }
        return AutoThreadsPage(
            settings: AutoThreadsSettings(rules: [AutoThreadsSettings.Rule(ruleId: "r1", channelId: "c1")]),
            channels: [ChannelOption(id: "c1", name: "screenshots")],
            roles: [RoleOption(id: "r1", name: "Moderators")])
    }
    NavigationStack {
        AutoThreadsSettingsView(server: "1", session: session)
    }
    .environment(session)
}
