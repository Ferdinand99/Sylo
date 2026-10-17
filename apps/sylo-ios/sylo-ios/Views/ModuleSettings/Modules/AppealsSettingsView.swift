import SwiftUI
import SyloKit

/// Ban appeals: the appeal form's questions, auto-unban on accept, the staff review channel,
/// the cooldown after a denial, an extra line in the ban DM, and an appeals server invite.
/// Mirrors web-v2/src/moduleForms/Appeals.jsx.
struct AppealsSettingsView: View {
    @State private var model: ModuleSettingsModel<AppealsPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Ban Appeals", model: model) { $settings, page in
            Section {
                Text("When a member is banned, Sylo DMs them a private link to an appeal form. Their answers show up on the dashboard's Appeals tab, and the decision (with a single-use rejoin invite on accept) is shown on that same link when they reopen it.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if !page.dashboardUrlSet {
                    Label("The Sylo server has no public dashboard URL (DASHBOARD_URL), so appeal links can't be built.",
                          systemImage: "exclamationmark.triangle")
                        .font(.subheadline)
                        .foregroundStyle(.orange)
                }
            }

            Section {
                ForEach(settings.questions.indices, id: \.self) { index in
                    if index == 0 {
                        AppealsLimitedField(title: "Question 1 (required)", text: $settings.questions[index],
                                            limit: AppealsSettings.maxQuestionLength)
                    } else {
                        AppealsLimitedField(title: "Question \(index + 1) (optional)", text: $settings.questions[index],
                                            limit: AppealsSettings.maxQuestionLength)
                    }
                }
            } header: {
                Text("Appeal form questions")
            } footer: {
                Text("1 to 5 questions; empty ones are dropped.")
            }

            Section {
                Toggle("Unban when an appeal is accepted", isOn: $settings.autoUnbanOnAccept)
                ChannelPicker(title: "Review channel", selection: $settings.reviewChannelId, channels: page.channels)
                NumberField(title: "Cooldown after a denial", value: $settings.cooldownDays,
                            range: AppealsSettings.cooldownRange, unit: "days")
            } footer: {
                Text("The review channel is optional and gets new-appeal and decision notices, always with the appeal link. A cooldown of 0 allows a new appeal at once.")
            }

            Section {
                TextArea(title: "e.g. Appeals are reviewed within 48 hours.", text: $settings.appealMessage,
                         limit: AppealsSettings.maxMessageLength, lines: 2...6)
            } header: {
                Text("Extra line in the ban DM")
            } footer: {
                Text("Optional.")
            }

            Section {
                AppealsLimitedField(title: "https://discord.gg/…", text: $settings.appealServerInvite,
                                    limit: AppealsSettings.maxInviteLength)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("Appeals server invite")
            } footer: {
                Text("Optional. A permanent invite to another server Sylo is in. If the banned member joins it, Sylo can also DM them the decision.")
            }

            Section {
                Text("Sylo needs the Ban Members permission to read ban reasons and unban on accept, and Create Invite to make the rejoin link.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// A one-line text field cut to a character limit.
private struct AppealsLimitedField: View {
    let title: LocalizedStringKey
    @Binding var text: String
    let limit: Int

    var body: some View {
        TextField(title, text: $text)
            .onChange(of: text) {
                if text.count > limit { text = String(text.prefix(limit)) }
            }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<AppealsPage> else { return nil }
        return AppealsPage(
            settings: AppealsSettings(reviewChannelId: "c1", appealMessage: "Appeals are reviewed within 48 hours."),
            channels: [ChannelOption(id: "c1", name: "appeals")],
            dashboardUrlSet: false)
    }
    NavigationStack {
        AppealsSettingsView(server: "1", session: session)
    }
    .environment(session)
}
