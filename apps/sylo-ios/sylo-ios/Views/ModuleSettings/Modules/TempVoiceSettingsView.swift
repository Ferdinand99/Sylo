import SwiftUI
import SyloKit

/// Temporary voice: "Join to create" hubs, each with its channel, naming, limits, permissions,
/// owner permissions and paired text channel. Mirrors web-v2/src/moduleForms/TempVoice.jsx.
struct TempVoiceSettingsView: View {
    @State private var model: ModuleSettingsModel<TempVoicePage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Temporary Voice", model: model) { $settings, page in
            Section {
                Text("A hub is a \"Join to create\" voice channel. When a member joins it, Sylo makes them a personal voice channel, moves them in, and cleans it up after everyone leaves. Needs the Manage Channels and Move Members permissions.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            // A hub has many settings, so it gets a few sections; each control has its own row.
            ForEach($settings.hubs) { $hub in
                Section {
                    TempVoiceOptionPicker(title: "Join to create channel", selection: $hub.hubChannelId,
                                          options: page.voiceChannels, prefix: "🔊 ",
                                          noneTitle: "Choose a voice channel")
                    TempVoiceOptionPicker(title: "Category", selection: $hub.categoryId, options: page.categories,
                                          prefix: "", noneTitle: "Same as the hub")
                    TextField("Channel name", text: $hub.nameTemplate,
                              prompt: Text(verbatim: TempVoiceSettings.defaultNameTemplate))
                        .autocorrectionDisabled()
                    LabeledContent("Preview") {
                        Text(verbatim: TempVoiceSettings.previewName(hub.nameTemplate))
                    }
                } header: {
                    Text("Hub")
                } footer: {
                    Text("Name tokens: {index} (the Nth channel), {username}. At most 95 characters. A hub without a channel is dropped when you save.")
                }

                Section {
                    NumberField(title: "User limit", value: $hub.userLimit, range: TempVoiceSettings.userLimitRange)
                    NumberField(title: "Bitrate", value: $hub.bitrate, range: TempVoiceSettings.bitrateRange,
                                unit: "kbps")
                    Picker("Keep alive after empty", selection: $hub.keepAliveMinutes) {
                        ForEach(TempVoiceSettings.keepAliveOptions, id: \.self) { minutes in
                            TempVoiceKeepAliveLabel(minutes: minutes).tag(minutes)
                        }
                    }
                    Toggle("Ownership lock", isOn: $hub.ownershipLock)
                } header: {
                    Text("Channel")
                } footer: {
                    Text("A user limit of 0 means no limit, a bitrate of 0 the server's default. With the ownership lock on, the channel isn't handed to someone else when the owner leaves; they can /voice-claim it back.")
                }

                Section {
                    Toggle("Sync with the hub's category", isOn: $hub.syncCategory)
                    Toggle("Sync with the hub channel", isOn: $hub.syncChannel)
                    Picker("Who can join", selection: $hub.roleMode) {
                        Text("Everyone except these roles").tag(TempVoiceRoleMode.allow)
                        Text("Only these roles").tag(TempVoiceRoleMode.deny)
                    }
                    MultiPicker(title: "Roles", selection: $hub.roleList, options: page.roles, prefix: "@")
                    Toggle("Also gate the temporary channels", isOn: $hub.useRolesForAccess)
                    MultiPicker(title: "Ignored roles", selection: $hub.ignoredRoles, options: page.roles, prefix: "@")
                    MultiPicker(title: "Moderator roles", selection: $hub.moderatorRoles, options: page.roles,
                                prefix: "@")
                } header: {
                    Text("Permissions")
                } footer: {
                    Text("Ignored roles are not affected by /voice-* commands. Moderator roles can run them on any temporary channel.")
                }

                Section("Owner permissions") {
                    Toggle("Manage Channel", isOn: $hub.ownerPerms.manageChannels)
                    Toggle("Manage Permissions", isOn: $hub.ownerPerms.managePermissions)
                    Toggle("Priority Speaker", isOn: $hub.ownerPerms.prioritySpeaker)
                    Toggle("Move Members", isOn: $hub.ownerPerms.moveMembers)
                }

                Section("Text channel") {
                    Toggle("Create a paired text channel", isOn: $hub.textChannel.enabled)
                    if hub.textChannel.enabled {
                        Toggle("Only connected members can read it", isOn: $hub.textChannel.restrict)
                        Toggle("Pin the /voice-* commands", isOn: $hub.textChannel.pinUsages)
                        Toggle("Only allow /voice-* there", isOn: $hub.textChannel.restrictCommands)
                    }
                    Button("Remove Hub", role: .destructive) {
                        settings.hubs.removeAll { $0.id == hub.id }
                    }
                }
            }

            Section {
                if settings.hubs.count < TempVoiceSettings.maxHubs {
                    Button("Add Hub", systemImage: "plus") {
                        settings.hubs.append(TempVoiceSettings.Hub())
                    }
                }
            } footer: {
                if settings.hubs.isEmpty {
                    Text("No hubs yet.")
                }
            }
        }
    }
}

/// Picks one voice channel or category (or none). One that no longer exists stays selectable so
/// opening the screen never changes the setting by itself.
private struct TempVoiceOptionPicker: View {
    let title: LocalizedStringKey
    @Binding var selection: String
    let options: [ChannelOption]
    let prefix: String
    let noneTitle: LocalizedStringKey

    var body: some View {
        Picker(title, selection: $selection) {
            Text(noneTitle).tag("")
            ForEach(options) { option in
                Text(verbatim: prefix + option.name).tag(option.id)
            }
            if !selection.isEmpty, !options.contains(where: { $0.id == selection }) {
                Text("Deleted channel").tag(selection)
            }
        }
        .pickerStyle(.navigationLink)
    }
}

/// "Never delete", "Delete immediately" or "5 min".
private struct TempVoiceKeepAliveLabel: View {
    let minutes: Int

    var body: some View {
        if minutes < 0 {
            Text("Never delete")
        } else if minutes == 0 {
            Text("Delete immediately")
        } else {
            Text("\(minutes) min")
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<TempVoicePage> else { return nil }
        return TempVoicePage(
            settings: TempVoiceSettings(hubs: [
                TempVoiceSettings.Hub(hubId: "0", hubChannelId: "v1", categoryId: "k1", userLimit: 5,
                                      keepAliveMinutes: 2),
            ]),
            voiceChannels: [ChannelOption(id: "v1", name: "Join to create")],
            categories: [ChannelOption(id: "k1", name: "Voice")],
            roles: [RoleOption(id: "r1", name: "Members")])
    }
    NavigationStack {
        TempVoiceSettingsView(server: "1", session: session)
    }
    .environment(session)
}
