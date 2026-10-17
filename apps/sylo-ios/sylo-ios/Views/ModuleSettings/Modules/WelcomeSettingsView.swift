import SwiftUI
import SyloKit

/// Welcome & leave: the join message (with an optional embed and welcome image), a private
/// message to new members, the leave message, and roles given on join. Mirrors
/// web-v2/src/moduleForms/Welcome.jsx.
struct WelcomeSettingsView: View {
    @State private var model: ModuleSettingsModel<WelcomePage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Welcome & Leave", model: model) { $settings, page in
            if !page.placeholders.isEmpty {
                Section {
                    Text(verbatim: page.placeholders.joined(separator: "  "))
                        .font(.footnote.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                } header: {
                    Text("Placeholders")
                } footer: {
                    Text("Use these in the messages below; Sylo fills them in for each member.")
                }
            }

            Section {
                Toggle("Message when a member joins", isOn: $settings.joinEnabled)
                if settings.joinEnabled {
                    ChannelPicker(title: "Channel", selection: $settings.joinChannel, channels: page.channels,
                                  noneTitle: "Choose a channel")
                    TextArea(title: "Message", text: $settings.joinMessage,
                             limit: WelcomeSettings.maxMessageLength)
                    Toggle("Send as an embed", isOn: $settings.useEmbed)
                }
            } header: {
                Text("Join message")
            } footer: {
                if settings.joinEnabled {
                    Text("The embed uses the server's default embed colour.")
                }
            }

            Section {
                Toggle("Attach a welcome image", isOn: $settings.card)
                if settings.card {
                    TextField("Background image URL (optional)", text: $settings.cardBackground)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            } header: {
                Text("Welcome image")
            } footer: {
                Text("A generated banner with the member's avatar, name and member number, posted with the join message. The join message must be on for it to show. The background must be an https link to a PNG or JPG.")
            }

            Section {
                Toggle("Private message to new members", isOn: $settings.dmEnabled)
                if settings.dmEnabled {
                    TextArea(title: "DM text", text: $settings.dmMessage,
                             limit: WelcomeSettings.maxMessageLength)
                }
            } header: {
                Text("Direct message")
            }

            Section {
                Toggle("Message when a member leaves", isOn: $settings.leaveEnabled)
                if settings.leaveEnabled {
                    ChannelPicker(title: "Channel", selection: $settings.leaveChannel, channels: page.channels,
                                  noneTitle: "Choose a channel")
                    TextArea(title: "Message", text: $settings.leaveMessage,
                             limit: WelcomeSettings.maxMessageLength)
                }
            } header: {
                Text("Leave message")
            }

            Section {
                Toggle("Give roles to new members", isOn: $settings.autoroleEnabled)
                if settings.autoroleEnabled {
                    MultiPicker(title: "Roles", selection: $settings.autoroles, options: page.roles, prefix: "@")
                }
            } header: {
                Text("Roles on join")
            } footer: {
                Text("Assigned automatically on join. Shared with the Reaction roles & autoroles module.")
            }

            Section {
                LabeledContent("Verification") {
                    if page.verificationEnabled {
                        Text("On")
                    } else {
                        Text("Off")
                    }
                }
            } footer: {
                Text("Captcha verification for new members has its own module.")
            }
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<WelcomePage> else { return nil }
        return WelcomePage(
            settings: WelcomeSettings(
                joinEnabled: true, joinChannel: "c1", joinMessage: "Welcome {user} to {server}!",
                card: true, leaveEnabled: true, leaveChannel: "c2", leaveMessage: "{user.tag} left the server.",
                autoroleEnabled: true, autoroles: ["r1"]),
            channels: [ChannelOption(id: "c1", name: "welcome"), ChannelOption(id: "c2", name: "goodbye")],
            roles: [RoleOption(id: "r1", name: "Member")],
            verificationEnabled: true,
            placeholders: ["{user}", "{user.tag}", "{user.name}", "{user.id}", "{server}", "{memberCount}"])
    }
    NavigationStack {
        WelcomeSettingsView(server: "1", session: session)
    }
    .environment(session)
}
