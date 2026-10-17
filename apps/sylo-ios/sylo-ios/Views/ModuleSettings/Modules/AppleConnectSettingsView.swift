import SwiftUI
import SyloKit

/// App Store Connect: the main channel, ping role, which apps, and each alert kind with its own
/// channel. Mirrors web-v2/src/moduleForms/AppleConnect.jsx. Owner-only: for anyone else the
/// server answers 403, which shows as the load error.
struct AppleConnectSettingsView: View {
    @State private var model: ModuleSettingsModel<AppleConnectPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("App Store Connect", model: model) { $settings, page in
            Section {
                Text("Alerts from your Apple Developer account: app versions moving through review, builds and TestFlight, new reviews, tester feedback, and certificates about to expire. Checked about every 5 minutes. Only the Sylo owner can see this module.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            if !page.appleEnabled {
                Section {
                    Label("The bot has no App Store Connect API key (APPLE_KEY_ID and APPLE_PRIVATE_KEY, plus APPLE_ISSUER_ID for a team key), so no alert fires yet. You can still set them up here.",
                          systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
            }

            Section {
                ChannelPicker(title: "Main channel", selection: $settings.channelId, channels: page.channels,
                              noneTitle: "Choose a channel")
                RolePicker(title: "Ping role", selection: $settings.roleId, roles: page.roles)
            } footer: {
                Text("The main channel is used by every alert without its own.")
            }

            Section {
                TextArea(title: "App ids", text: $settings.appsText, lines: 2...6)
            } header: {
                Text("Apps")
            } footer: {
                Text("App Store Connect app ids, one per line. Leave empty for all apps (at most 20).")
            }

            Section {
                AppleConnectAlertRows(title: "Version State Changes", enabled: $settings.events.versionState.enabled,
                                      channelId: $settings.events.versionState.channelId, channels: page.channels)
            } footer: {
                Text("Waiting for review, in review, rejected, ready for sale, and so on.")
            }

            Section {
                AppleConnectAlertRows(title: "Builds", enabled: $settings.events.build.enabled,
                                      channelId: $settings.events.build.channelId, channels: page.channels)
            } footer: {
                Text("Builds that finished or failed processing.")
            }

            Section {
                AppleConnectAlertRows(title: "TestFlight Review", enabled: $settings.events.betaReview.enabled,
                                      channelId: $settings.events.betaReview.channelId, channels: page.channels)
            } footer: {
                Text("TestFlight review started, approved or rejected.")
            }

            Section {
                AppleConnectAlertRows(title: "TestFlight Feedback", enabled: $settings.events.feedback.enabled,
                                      channelId: $settings.events.feedback.channelId, channels: page.channels)
            } footer: {
                Text("Feedback and crash reports from testers.")
            }

            Section {
                AppleConnectAlertRows(title: "Customer Reviews", enabled: $settings.events.reviews.enabled,
                                      channelId: $settings.events.reviews.channelId, channels: page.channels)
                if settings.events.reviews.enabled {
                    Stepper(value: $settings.events.reviews.maxStars, in: AppleConnectReviewsAlert.starsRange) {
                        Text("Up to \(settings.events.reviews.maxStars) stars")
                    }
                }
            } footer: {
                Text("New customer reviews with at most this many stars.")
            }

            Section {
                AppleConnectAlertRows(title: "Expiring Certificates", enabled: $settings.events.expiry.enabled,
                                      channelId: $settings.events.expiry.channelId, channels: page.channels)
                if settings.events.expiry.enabled {
                    NumberField(title: "Warn from", value: $settings.events.expiry.days,
                                range: AppleConnectExpiryAlert.daysRange, unit: "days before")
                }
            } footer: {
                Text("Certificates and profiles about to expire, from this many days before and again at 7 and 1 days. Needs a team API key.")
            }
        }
    }
}

/// An alert kind's switch, and its own channel while it's on.
private struct AppleConnectAlertRows: View {
    let title: LocalizedStringKey
    @Binding var enabled: Bool
    @Binding var channelId: String
    let channels: [ChannelOption]

    var body: some View {
        Toggle(title, isOn: $enabled)
        if enabled {
            ChannelPicker(title: "Channel", selection: $channelId, channels: channels, noneTitle: "Main channel")
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<AppleConnectPage> else { return nil }
        return AppleConnectPage(
            settings: AppleConnectSettings(
                channelId: "c1",
                apps: ["1234567890"],
                events: AppleConnectSettings.Events(
                    build: AppleConnectAlert(channelId: "c2"),
                    reviews: AppleConnectReviewsAlert(maxStars: 3))),
            channels: [ChannelOption(id: "c1", name: "app-store"), ChannelOption(id: "c2", name: "builds")],
            roles: [RoleOption(id: "r1", name: "Developers")],
            appleEnabled: false)
    }
    NavigationStack {
        AppleConnectSettingsView(server: "1", session: session)
    }
    .environment(session)
}
