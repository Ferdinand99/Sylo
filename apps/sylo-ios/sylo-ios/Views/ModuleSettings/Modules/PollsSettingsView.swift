import SwiftUI
import SyloKit

/// Polls: who can vote, and the poll and results messages. Mirrors
/// web-v2/src/moduleForms/Polls.jsx (without its live embed preview).
struct PollsSettingsView: View {
    @State private var model: ModuleSettingsModel<PollsPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Polls", model: model) { $settings, page in
            Section {
                Text("Members create polls with /poll and vote by reacting with the letter of their choice. A poll closes on its timer, when it hits its vote cap, or when someone runs /poll-end.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Section {
                Picker("Voters", selection: $settings.voteRoleMode) {
                    ForEach(PollsVoteRoleMode.allCases, id: \.self) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                MultiPicker(title: "Roles", selection: $settings.voteRoles, options: page.roles, prefix: "@")
            } header: {
                Text("Who can vote")
            } footer: {
                Text("Leave the roles empty to let everyone vote. Disallowed reactions are removed automatically.")
            }

            PollsMessageSections(
                title: "Poll message",
                footer: "How a live poll looks. Sylo adds the question and the choices to it.",
                message: $settings.pollMessage,
                placeholders: page.pollPlaceholders)

            PollsMessageSections(
                title: "Results message",
                footer: "Posted when a poll closes. Sylo adds the results to it.",
                message: $settings.resultsMessage,
                placeholders: page.resultsPlaceholders)
        }
    }
}

/// The editable parts of a poll or results embed: text above it, title, colour, footer, image.
private struct PollsMessageSections: View {
    let title: LocalizedStringKey
    let footer: LocalizedStringKey
    @Binding var message: PollsMessage
    let placeholders: [String]

    var body: some View {
        Section {
            TextArea(title: "Text above the embed", text: $message.content,
                     limit: PollsMessage.maxContentLength, lines: 2...6)
            TextField("Title", text: $message.title)
            ColorPicker("Colour", selection: colour, supportsOpacity: false)
            TextField("Footer", text: $message.footer)
            TextField("Image URL", text: $message.image)
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        } header: {
            Text(title)
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                Text(footer)
                if !placeholders.isEmpty {
                    Text("Placeholders: \(placeholders.joined(separator: " "))")
                }
            }
        }
    }

    private var colour: Binding<Color> {
        Binding(
            get: {
                let rgb = message.rgb
                return Color(.sRGB, red: rgb.red, green: rgb.green, blue: rgb.blue)
            },
            set: { newValue in
                let resolved = newValue.resolve(in: EnvironmentValues())
                message.setRGB(red: Double(resolved.red), green: Double(resolved.green), blue: Double(resolved.blue))
            })
    }
}

extension PollsVoteRoleMode {
    var title: LocalizedStringKey {
        switch self {
        case .allow: "Everyone except the roles"
        case .deny: "Only members with a role"
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<PollsPage> else { return nil }
        return PollsPage(
            settings: PollsSettings(
                voteRoles: ["r2"],
                pollMessage: PollsMessage(title: "📊 {question}", footer: "{ends} · {mode}"),
                resultsMessage: PollsMessage(title: "📊 Results — {question}", color: "#2ecc71",
                                             footer: "Winner: {winner} · {total} total votes")),
            roles: [RoleOption(id: "r1", name: "Members"), RoleOption(id: "r2", name: "Muted")],
            pollPlaceholders: ["{question}", "{choices}", "{ends}", "{mode}"],
            resultsPlaceholders: ["{question}", "{results}", "{total}", "{winner}", "{mode}"])
    }
    NavigationStack {
        PollsSettingsView(server: "1", session: session)
    }
    .environment(session)
}
