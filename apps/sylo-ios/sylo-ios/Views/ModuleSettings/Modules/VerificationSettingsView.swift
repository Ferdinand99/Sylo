import SwiftUI
import SyloKit

/// Verification: the mode, the verified role, where the Verify message goes and what it says,
/// a log channel, and kicking members who never verify. Mirrors
/// web-v2/src/moduleForms/Verification.jsx.
struct VerificationSettingsView: View {
    @State private var model: ModuleSettingsModel<VerificationPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Verification", model: model) { $settings, page in
            Section {
                Text("Sylo posts a message with a Verify button in the chosen channel. New members tap it to get the verified role. In captcha mode the button first sends them a private link to a Cloudflare Turnstile check.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Section {
                Picker("Mode", selection: $settings.mode) {
                    ForEach(VerificationMode.allCases, id: \.self) { mode in
                        Text(verbatim: mode.title).tag(mode)
                    }
                }
            } footer: {
                if !page.turnstileEnabled {
                    Text("Captcha mode needs Turnstile keys on the Sylo server. Until they are set, it works like button mode.")
                }
            }

            Section {
                RolePicker(title: "Verified role", selection: $settings.verifiedRoleId, roles: page.roles,
                           noneTitle: "Choose a role")
                ChannelPicker(title: "Verify channel", selection: $settings.channelId, channels: page.channels,
                              noneTitle: "Choose a channel")
            } footer: {
                Text("The role is granted on success. Sylo's own role must be above it.")
            }

            Section("Message title") {
                TextField("Title", text: $settings.title)
                    .onChange(of: settings.title) {
                        if settings.title.count > VerificationSettings.maxTitleLength {
                            settings.title = String(settings.title.prefix(VerificationSettings.maxTitleLength))
                        }
                    }
            }

            Section("Message body") {
                TextArea(title: "Message", text: $settings.message,
                         limit: VerificationSettings.maxMessageLength, lines: 2...8)
            }

            Section("Reply after verifying") {
                TextArea(title: "Reply", text: $settings.successMessage,
                         limit: VerificationSettings.maxSuccessMessageLength, lines: 1...4)
            }

            Section {
                ChannelPicker(title: "Log channel", selection: $settings.logChannelId, channels: page.channels)
            } footer: {
                Text("Optional.")
            }

            Section {
                NumberField(title: "Kick unverified after", value: $settings.kickAfterMinutes,
                            range: VerificationSettings.kickAfterRange, unit: "min")
            } footer: {
                Text("0 never kicks. At most 10080 minutes (7 days). Kicking needs the Kick Members permission.")
            }

            Section {
                Text("Saving posts the verify message again. Sylo needs the Manage Roles permission.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

extension VerificationMode {
    var title: String {
        switch self {
        case .button: "Button only"
        case .captcha: "Captcha (button + Turnstile)"
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<VerificationPage> else { return nil }
        return VerificationPage(
            settings: VerificationSettings(mode: .captcha, verifiedRoleId: "r1", channelId: "c1",
                                           kickAfterMinutes: 60),
            channels: [ChannelOption(id: "c1", name: "verify"), ChannelOption(id: "c2", name: "mod-log")],
            roles: [RoleOption(id: "r1", name: "Verified")],
            turnstileEnabled: false)
    }
    NavigationStack {
        VerificationSettingsView(server: "1", session: session)
    }
    .environment(session)
}
