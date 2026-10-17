import SwiftUI
import SyloKit

/// Starboard: boards that re-post messages with enough of a reaction into a highlights channel,
/// each with its emoji, threshold, behaviour, anti-abuse rules and restrictions. Mirrors
/// web-v2/src/moduleForms/Starboard.jsx.
struct StarboardSettingsView: View {
    @State private var model: ModuleSettingsModel<StarboardPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Starboard", model: model) { $settings, page in
            Section {
                Text("When a message gets enough of a reaction, Sylo re-posts it into a highlights channel, like a community pin board. Each board has its own emoji, threshold and rules.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            // A board has many settings, so it gets a few sections; each control has its own row.
            ForEach($settings.boards) { $board in
                Section {
                    TextField("Name", text: $board.name, prompt: Text("Starboard"))
                    ChannelPicker(title: "Starboard channel", selection: $board.channelId, channels: page.channels,
                                  noneTitle: "Choose a channel")
                    TextField("Emoji", text: $board.emojiText, prompt: Text(verbatim: "⭐"))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    NumberField(title: "Reactions needed", value: $board.threshold,
                                range: StarboardSettings.thresholdRange)
                    Toggle("Count every matching emoji from a member", isOn: $board.multiPerUser)
                } header: {
                    Text(verbatim: board.name.isEmpty ? "Starboard" : board.name)
                } footer: {
                    Text("The name (at most 60 characters) is shown on the dashboard only. Separate emoji with spaces; the first one is shown on the post.")
                }

                Section("Behaviour") {
                    Toggle("React to the post with the board emoji", isOn: $board.autoReact)
                    if board.autoReact {
                        Toggle("Only with the first emoji", isOn: $board.autoReactFirstOnly)
                    }
                    Toggle("Delete the post when the original is deleted", isOn: $board.removeOnDelete)
                    Toggle("Remove the post when it drops below the threshold", isOn: $board.removeOnUnstar)
                    Toggle("Wait a minute before a removed post can return", isOn: $board.repostCooldown)
                }

                Section {
                    Toggle("Don't count the author's own reaction", isOn: $board.ignoreSelfStars)
                    if board.ignoreSelfStars {
                        Toggle("Remove the author's own reaction", isOn: $board.removeSelfStarReactions)
                    }
                    Toggle("Ignore messages from bots", isOn: $board.ignoreBotMessages)
                    if board.ignoreBotMessages {
                        Toggle("Clear reactions on bot messages", isOn: $board.removeBotReactions)
                    }
                    NumberField(title: "Ignore younger than", value: $board.minAgeMinutes,
                                range: StarboardSettings.ageRange, unit: "min")
                    NumberField(title: "Ignore older than", value: $board.maxAgeMinutes,
                                range: StarboardSettings.ageRange, unit: "min")
                } header: {
                    Text("Anti-abuse")
                } footer: {
                    Text("An age of 0 means no limit.")
                }

                Section("Restrictions") {
                    Picker("Whose reactions count", selection: $board.roleMode) {
                        Text("Everyone except these roles").tag(StarboardListMode.allow)
                        Text("Only these roles").tag(StarboardListMode.deny)
                    }
                    MultiPicker(title: "Roles", selection: $board.roleList, options: page.roles, prefix: "@")
                    Picker("Channels watched", selection: $board.channelMode) {
                        Text("Every channel except these").tag(StarboardListMode.allow)
                        Text("Only these channels").tag(StarboardListMode.deny)
                    }
                    MultiPicker(title: "Channels", selection: $board.channelList, options: page.channels,
                                prefix: "#")
                    Button("Remove Board", role: .destructive) {
                        settings.boards.removeAll { $0.id == board.id }
                    }
                }
            }

            Section {
                if settings.boards.count < StarboardSettings.maxBoards {
                    Button("Add Board", systemImage: "plus") {
                        settings.boards.append(StarboardSettings.Board())
                    }
                }
            } footer: {
                if settings.boards.isEmpty {
                    Text("No boards yet.")
                }
            }
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<StarboardPage> else { return nil }
        return StarboardPage(
            settings: StarboardSettings(boards: [
                StarboardSettings.Board(boardId: "0", name: "Hall of fame", channelId: "c1", threshold: 5,
                                        roleList: ["r1"]),
            ]),
            channels: [ChannelOption(id: "c1", name: "highlights"), ChannelOption(id: "c2", name: "general")],
            roles: [RoleOption(id: "r1", name: "Muted")])
    }
    NavigationStack {
        StarboardSettingsView(server: "1", session: session)
    }
    .environment(session)
}
