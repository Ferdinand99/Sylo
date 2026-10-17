import SwiftUI
import SyloKit

/// Auto-moderation: each check's action and settings, native Discord AutoMod, the timeout length
/// and exempt channels. The immunity roles are shown but saved in the web dashboard. Mirrors
/// web-v2/src/moduleForms/Automod.jsx.
struct AutomodSettingsView: View {
    @State private var model: ModuleSettingsModel<AutomodPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Auto-moderation", model: model) { $settings, page in
            Section {
                Text("Each check scans new and edited messages and acts on the first match. Administrators are always skipped, and Sylo never acts on other bots.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if page.modlogChannelId.isEmpty {
                    Label("No mod-log channel is set, so actions aren't logged. Set one in the server's general settings.",
                          systemImage: "exclamationmark.triangle")
                        .font(.subheadline)
                        .foregroundStyle(.orange)
                }
            }

            // The ten checks, in the server's order (grouped to keep the builder small).
            Group {
                Section {
                    AutomodModePicker(mode: $settings.rules.words.mode)
                    if settings.rules.words.enabled {
                        TextArea(title: "Words and phrases", text: $settings.rules.words.listText, lines: 2...8)
                    }
                } header: {
                    Text("Bad words")
                } footer: {
                    Text("Blocks messages containing any listed word or phrase. Separate them with commas or new lines.")
                }

                Section {
                    AutomodModePicker(mode: $settings.rules.repeat.mode)
                } header: {
                    Text("Repeated text")
                } footer: {
                    Text("Blocks messages that are mostly one repeated word or character.")
                }

                Section {
                    AutomodModePicker(mode: $settings.rules.invites.mode)
                } header: {
                    Text("Server invites")
                } footer: {
                    Text("Blocks messages containing an invite link.")
                }

                Section {
                    AutomodModePicker(mode: $settings.rules.links.mode)
                    if settings.rules.links.enabled {
                        TextArea(title: "Allowed domains", text: $settings.rules.links.allowedText, lines: 2...6)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                } header: {
                    Text("External links")
                } footer: {
                    Text("Blocks links. List allowed domains (such as youtube.com, twitch.tv) to permit only those; leave it empty to block every link.")
                }

                Section {
                    AutomodModePicker(mode: $settings.rules.caps.mode)
                    if settings.rules.caps.enabled {
                        NumberField(title: "At least", value: $settings.rules.caps.minLength,
                                    range: AutomodSettings.CapsRule.minLengthRange, unit: "letters")
                        NumberField(title: "Uppercase", value: $settings.rules.caps.percent,
                                    range: AutomodSettings.CapsRule.percentRange, unit: "%")
                    }
                } header: {
                    Text("Excessive caps")
                } footer: {
                    Text("Messages that are mostly uppercase.")
                }

                Section {
                    AutomodModePicker(mode: $settings.rules.emojis.mode)
                    if settings.rules.emojis.enabled {
                        NumberField(title: "Max emoji", value: $settings.rules.emojis.max,
                                    range: AutomodSettings.Rules.emojisRange)
                    }
                } header: {
                    Text("Excessive emoji")
                } footer: {
                    Text("More than this many emoji in one message.")
                }

                Section {
                    AutomodModePicker(mode: $settings.rules.spoilers.mode)
                    if settings.rules.spoilers.enabled {
                        NumberField(title: "Max spoiler tags", value: $settings.rules.spoilers.max,
                                    range: AutomodSettings.Rules.spoilersRange)
                    }
                } header: {
                    Text("Excessive spoilers")
                } footer: {
                    Text("More than this many spoiler tags in one message.")
                }

                Section {
                    AutomodModePicker(mode: $settings.rules.mentions.mode)
                    if settings.rules.mentions.enabled {
                        NumberField(title: "Max mentions", value: $settings.rules.mentions.max,
                                    range: AutomodSettings.Rules.mentionsRange)
                    }
                } header: {
                    Text("Excessive mentions")
                } footer: {
                    Text("More than this many user or role mentions in one message.")
                }

                Section {
                    AutomodModePicker(mode: $settings.rules.zalgo.mode)
                } header: {
                    Text("Zalgo")
                } footer: {
                    Text("Corrupted text made of stacked combining characters.")
                }

                Section {
                    AutomodModePicker(mode: $settings.rules.spam.mode)
                    if settings.rules.spam.enabled {
                        NumberField(title: "Max messages", value: $settings.rules.spam.max,
                                    range: AutomodSettings.SpamRule.maxRange)
                        NumberField(title: "Per", value: $settings.rules.spam.seconds,
                                    range: AutomodSettings.SpamRule.secondsRange, unit: "sec")
                    }
                } header: {
                    Text("Anti-spam")
                } footer: {
                    Text("One member sending too many messages in a short time.")
                }
            }

            if page.supportsNativeAutomod {
                Section {
                    Toggle("Enforce natively", isOn: $settings.native.enabled)
                    if settings.native.enabled {
                        Toggle("Bad words", isOn: $settings.native.words)
                            .disabled(!settings.rules.words.enabled)
                        Toggle("Excessive mentions", isOn: $settings.native.mentions)
                            .disabled(!settings.rules.mentions.enabled)
                        Toggle("Anti-spam", isOn: $settings.native.spam)
                            .disabled(!settings.rules.spam.enabled)
                    }
                } header: {
                    Text("Native Discord AutoMod")
                } footer: {
                    Text("Pushes these checks onto Discord's built-in AutoMod, so they apply before a message is posted and keep working while Sylo is offline. A check must be on above first. Needs the Manage Server permission. Edit the rules named \"Sylo: …\" here, not in Server Settings.")
                }

                if settings.native.enabled {
                    Section {
                        ForEach(page.presetKeys, id: \.self) { key in
                            Toggle(isOn: $settings.native[preset: key]) {
                                AutomodPresetLabel(key: key)
                            }
                        }
                    } header: {
                        Text("Discord keyword presets")
                    } footer: {
                        Text("Word lists maintained by Discord.")
                    }
                }
            }

            Section {
                NumberField(title: "Timeout length", value: $settings.timeoutMinutes,
                            range: AutomodSettings.timeoutRange, unit: "min")
            } footer: {
                Text("How long the Delete + Timeout action times members out.")
            }

            Section {
                MultiPicker(title: "Exempt channels", selection: $settings.exemptChannels, options: page.channels,
                            prefix: "#")
            } footer: {
                Text("Auto-moderation never acts in these channels.")
            }

            Section {
                if settings.exemptRoles.isEmpty {
                    Text("None")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(settings.exemptRoles, id: \.self) { id in
                        if let role = page.roles.first(where: { $0.id == id }) {
                            Text(verbatim: "@\(role.name)")
                        } else {
                            Text("Deleted role")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                Text("Immunity roles")
            } footer: {
                Text("Members with one of these roles are never touched by auto-moderation or the warning auto-actions. Change them in the web dashboard.")
            }
        }
    }
}

/// Off, or the action a check takes.
private struct AutomodModePicker: View {
    @Binding var mode: AutomodMode

    var body: some View {
        Picker("Action", selection: $mode) {
            ForEach(AutomodMode.allCases, id: \.self) { mode in
                AutomodModeLabel(mode: mode).tag(mode)
            }
        }
    }
}

private struct AutomodModeLabel: View {
    let mode: AutomodMode

    var body: some View {
        switch mode {
        case .off: Text("Off")
        case .delete: Text("Delete message")
        case .warn: Text("Delete + Warn")
        case .timeout: Text("Delete + Timeout")
        }
    }
}

/// A Discord keyword preset's name; an unknown one as the server sends it.
private struct AutomodPresetLabel: View {
    let key: String

    var body: some View {
        switch key {
        case "profanity": Text("Profanity")
        case "sexual": Text("Sexual content")
        case "slurs": Text("Slurs")
        default: Text(verbatim: key)
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<AutomodPage> else { return nil }
        return AutomodPage(
            settings: AutomodSettings(
                exemptChannels: ["c2"], exemptRoles: ["r1"],
                native: AutomodSettings.Native(enabled: true, words: true, presets: ["slurs"]),
                rules: AutomodSettings.Rules(
                    words: AutomodSettings.WordsRule(enabled: true, action: .warn, listText: "badword, another phrase"),
                    invites: AutomodSettings.BasicRule(enabled: true),
                    spam: AutomodSettings.SpamRule(enabled: true, action: .timeout))),
            channels: [ChannelOption(id: "c1", name: "general"), ChannelOption(id: "c2", name: "memes")],
            roles: [RoleOption(id: "r1", name: "Trusted")],
            modlogChannelId: "c1")
    }
    NavigationStack {
        AutomodSettingsView(server: "1", session: session)
    }
    .environment(session)
}
