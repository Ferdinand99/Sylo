import SwiftUI
import SyloKit

/// Suggestions: where they are posted and logged, anonymous posts, DMs to the author, turning
/// messages into suggestions, the cooldown and the staff roles, with the latest suggestions listed
/// with their own screen to decide on or delete a suggestion. Mirrors
/// web-v2/src/moduleForms/Suggestions.jsx.
struct SuggestionsSettingsView: View {
    @State private var model: ModuleSettingsModel<SuggestionsPage>
    @State private var note: ModulePlatformNoteModel
    private let server: ServerID

    @Environment(AppSession.self) private var session

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: SuggestionsPage.moduleID, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Suggestions", model: model) { $settings, page in
            ModuleIntro("Members post ideas and everyone votes with thumbs up and down. Staff approve, deny or mark a suggestion as implemented, in chat or in the app.")
            PlatformNoteSection(model: note)

            Section {
                ChannelPicker(title: "Suggestions channel", selection: $settings.channel, channels: page.channels,
                              noneTitle: "Where the command is used")
            }

            Section {
                ChannelPicker(title: "Log channel", selection: $settings.logChannel, channels: page.channels,
                              noneTitle: "Decided ones stay")
            } footer: {
                Text("A suggestion that is approved, denied or implemented is reposted here and the original is deleted.")
            }

            Section {
                Toggle("Anonymous suggestions", isOn: $settings.anonymous)
            } footer: {
                Text("New posts do not show who wrote them. Staff still see the author in the app.")
            }

            Section {
                Toggle("DM the author when staff decide", isOn: $settings.dmAuthor)
            } footer: {
                Text("Members with DMs closed are skipped quietly.")
            }

            Section {
                Toggle("Turn messages into suggestions", isOn: $settings.messagesToSuggestions)
            } footer: {
                Text("Sylo deletes a message in the suggestions channel and posts it as a suggestion. Needs the suggestions channel above and the Manage Messages permission. It also has to be allowed to read message text, which only the bot owner can switch on. Messages with attachments are left alone.")
            }

            Section {
                NumberField(title: "Cooldown", value: $settings.cooldownSeconds,
                            range: SuggestionsSettings.cooldownRange, unit: "seconds")
            } footer: {
                Text("Per member between two suggestions. 0 turns it off.")
            }

            Section {
                MultiPicker(title: "Staff roles", selection: $settings.staffRoles, options: page.roles, prefix: "@")
            } footer: {
                Text("May decide on suggestions without Manage Server.")
            }

            Section {
                NavigationLink {
                    SuggestionsManageView(server: server, session: session)
                } label: {
                    Label("Suggestions", systemImage: "lightbulb")
                }
            } footer: {
                Text("Filter the suggestions, set a status with a reason, or delete one.")
            }
        }
        .task { await note.load() }
    }
}

private struct SuggestionLine: View {
    let item: SuggestionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: "#\(item.number)" + (item.title.isEmpty ? "" : " · \(item.title)"))
                .font(.headline)
            Text(verbatim: Self.statusLabel(item.status))
                .font(.footnote.weight(.semibold))
            Text(verbatim: item.text)
                .lineLimit(3)
            Text(verbatim: details)
                .font(.footnote)
                .foregroundStyle(.secondary)
            if !item.reason.isEmpty {
                Text(verbatim: "Reason: \(item.reason)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// "👍 12 · 👎 1 · 3 min. ago · by Alex (hidden from members)".
    private var details: String {
        var parts = ["👍 \(item.up)", "👎 \(item.down)"]
        if let date = item.createdDate { parts.append(DateText.relative(date)) }
        if let author = item.author {
            parts.append("by \(author)" + (item.isAnonymous ? " (hidden from members)" : ""))
        } else {
            parts.append("author removed")
        }
        return parts.joined(separator: " · ")
    }

    static func statusLabel(_ status: SuggestionStatus) -> String {
        switch status {
        case .open: "⏳ Open"
        case .considering: "🤔 Considering"
        case .approved: "✅ Approved"
        case .denied: "❌ Denied"
        case .implemented: "🚀 Implemented"
        case .other(let raw): raw
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        if endpoint is Endpoints.LoadPlatformInfo { return PlatformInfo(platform: .discord) }
        guard endpoint is Endpoints.LoadModuleSettings<SuggestionsPage> else { return nil }
        return SuggestionsPage(
            settings: SuggestionsSettings(channel: "c1", cooldownSeconds: 60, staffRoles: ["r1"]),
            channels: [ChannelOption(id: "c1", name: "suggestions")],
            roles: [RoleOption(id: "r1", name: "Moderators")],
            suggestions: [SuggestionSummary(id: 1, number: 12, text: "Add a movie night", status: .approved,
                                            reason: "Starting next week", up: 8, down: 1, author: "Alex")])
    }
    NavigationStack {
        SuggestionsSettingsView(server: "1", session: session)
    }
    .environment(session)
}
