import SwiftUI
import SyloKit

/// Welcome & leave: the join message (with an optional embed and welcome image), a private
/// message to new members, the leave message, and roles given on join. Mirrors
/// web-v2/src/moduleForms/Welcome.jsx.
struct WelcomeSettingsView: View {
    @State private var model: ModuleSettingsModel<WelcomePage>
    @State private var test: ModuleTestModel
    /// Goes up when the person asks for a new preview; a save also gets a new one.
    @State private var previewRefreshes = 0
    /// Starts the preview's version at a number no earlier visit used, so a picture cached for an
    /// older background is never shown for this screen.
    @State private var previewSeed = Int(Date.now.timeIntervalSince1970)
    private let server: ServerID

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _test = State(initialValue: ModuleTestModel(server: server, module: "welcome", session: session))
    }

    /// `trigger` is nil on a server before Sylo 5.2; the picker is only shown when it is not.
    private func triggerBinding(_ settings: Binding<WelcomeSettings>) -> Binding<WelcomeTrigger> {
        Binding(get: { settings.wrappedValue.trigger ?? .join }, set: { settings.wrappedValue.trigger = $0 })
    }

    private func triggerRolesBinding(_ settings: Binding<WelcomeSettings>) -> Binding<[String]> {
        Binding(
            get: { settings.wrappedValue.triggerRoleSelection },
            set: { settings.wrappedValue.setTriggerRoleSelection($0) })
    }

    private func joinToggleTitle(_ settings: WelcomeSettings) -> LocalizedStringKey {
        settings.trigger == .role ? "Message when a member gets the role" : "Message when a member joins"
    }

    private func dmToggleTitle(_ settings: WelcomeSettings) -> LocalizedStringKey {
        settings.trigger == .role ? "Private message to welcomed members" : "Private message to new members"
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
                    if settings.supportsTrigger {
                        Text("Use these in the messages below; Sylo fills them in for each member. {role} is the role that started the welcome; it is empty when members are welcomed on joining, and in the leave message.")
                    } else {
                        Text("Use these in the messages below; Sylo fills them in for each member.")
                    }
                }
            }

            // Sylo 5.2 and later. An older server does not send the setting, so none of this shows.
            if settings.supportsTrigger {
                Section {
                    Picker("When to welcome", selection: triggerBinding($settings)) {
                        Text("When a member joins").tag(WelcomeTrigger.join)
                        Text("When a member gets a role").tag(WelcomeTrigger.role)
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    if settings.trigger == .role {
                        MultiPicker(title: "Roles", selection: triggerRolesBinding($settings), options: page.roles,
                                    prefix: "@", limit: WelcomeSettings.maxTriggerRoles)
                    }
                } header: {
                    Text("When to welcome")
                } footer: {
                    if settings.trigger == .role {
                        Text("The welcome is sent the first time a member gets any of these roles, once per member. Joining sends nothing, unless the member already has one of the roles. Verification and Applications are typical sources of the role. Only role gains after you switch are welcomed: members who already have a role are not welcomed.")
                    }
                }

                if settings.hasNoTriggerRole {
                    Section {
                        Label("No role is picked, so no welcome is sent. You can save, but pick at least one role for this to work.",
                              systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline)
                            .symbolRenderingMode(.multicolor)
                    }
                }
            }

            Section {
                Toggle(joinToggleTitle(settings), isOn: $settings.joinEnabled)
                if settings.joinEnabled {
                    ChannelPicker(title: "Channel", selection: $settings.joinChannel, channels: page.channels,
                                  noneTitle: "Choose a channel")
                    LimitedTextField(title: "Message", text: $settings.joinMessage,
                                     limit: WelcomeSettings.maxMessageLength, lines: 3...8)
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
                    AuthenticatedImage(
                        path: WelcomeCardPreview.path(server: server),
                        query: WelcomeCardPreview.query(version: previewSeed + model.saveCount + previewRefreshes))
                        .frame(maxWidth: .infinity, minHeight: 80, maxHeight: 220)
                        .accessibilityLabel("Welcome image preview")
                    Button("Refresh Preview", systemImage: "arrow.clockwise") { previewRefreshes += 1 }
                }
            } header: {
                Text("Welcome image")
            } footer: {
                Text("A generated banner with the member's avatar, name and member number, posted with the join message. The join message must be on for it to show. The background must be an https link to a PNG or JPG. The preview uses a sample member and the saved background: save to see a new one.")
            }

            Section {
                Toggle(dmToggleTitle(settings), isOn: $settings.dmEnabled)
                if settings.dmEnabled {
                    LimitedTextField(title: "DM text", text: $settings.dmMessage,
                                     limit: WelcomeSettings.maxMessageLength, lines: 3...8)
                }
            } header: {
                Text("Direct message")
            }

            Section {
                Toggle("Message when a member leaves", isOn: $settings.leaveEnabled)
                if settings.leaveEnabled {
                    ChannelPicker(title: "Channel", selection: $settings.leaveChannel, channels: page.channels,
                                  noneTitle: "Choose a channel")
                    LimitedTextField(title: "Message", text: $settings.leaveMessage,
                                     limit: WelcomeSettings.maxMessageLength, lines: 3...8)
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

            SendTestButton(model: test, hasUnsavedChanges: model.hasChanges,
                           sample: "a sample join message (not your own text)",
                           channelName: page.channels.first { $0.id == settings.joinChannel }?.name)
        }
        // The server saved the settings but says they will not do what was meant. An alert, so it is
        // seen wherever the person was in the form when they saved.
        .alert("Saved, with a Note", isPresented: isShowingWarning, presenting: model.saveWarning) { _ in
            Button("OK") {}
        } message: { warning in
            Text(verbatim: warning)
        }
    }

    private var isShowingWarning: Binding<Bool> {
        Binding(get: { model.saveWarning != nil }, set: { if !$0 { model.saveWarning = nil } })
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<WelcomePage> else { return nil }
        return WelcomePage(
            settings: WelcomeSettings(
                joinEnabled: true, joinChannel: "c1", joinMessage: "Welcome {user} to {server}!",
                card: true, leaveEnabled: true, leaveChannel: "c2", leaveMessage: "{user.tag} left the server.",
                autoroleEnabled: true, autoroles: ["r1"], trigger: .role, triggerRoleIds: ["r1"]),
            channels: [ChannelOption(id: "c1", name: "welcome"), ChannelOption(id: "c2", name: "goodbye")],
            roles: [RoleOption(id: "r1", name: "Member")],
            verificationEnabled: true,
            placeholders: ["{user}", "{user.tag}", "{user.name}", "{user.id}", "{server}", "{memberCount}", "{role}"])
    }
    NavigationStack {
        WelcomeSettingsView(server: "1", session: session)
    }
    .environment(session)
}
