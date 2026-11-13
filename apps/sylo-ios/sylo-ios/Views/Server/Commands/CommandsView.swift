import SwiftUI
import SyloKit

/// Every command of the bot, searchable. A row opens the command, where staff turn it off for the
/// server or limit it to some channels and roles. Mirrors the dashboard's Commands tab.
struct CommandsView: View {
    @State private var model: CommandsModel
    @State private var isVisible = false

    /// Embedded in the Moderation tab: leaves the title to the tab and clears the floating tab bar.
    private let isEmbedded: Bool

    init(server: ServerID, session: AppSession, isEmbedded: Bool = false) {
        self.isEmbedded = isEmbedded
        _model = State(initialValue: CommandsModel(server: server, session: session))
    }

    var body: some View {
        List {
            if let message = model.errorMessage, model.hasLoaded {
                Section { StatusMessage(message, kind: .error) }
            }
            Section {
                ForEach(model.shown) { command in
                    NavigationLink {
                        CommandLimitsView(model: model, name: command.name)
                    } label: {
                        CommandRow(command: command)
                    }
                }
            } footer: {
                if model.hasLoaded {
                    if model.shown.isEmpty {
                        Text(model.searchText.trimmingCharacters(in: .whitespaces).isEmpty
                             ? "This server has no commands to manage."
                             : "No commands match your search.")
                    } else {
                        Text("Turn a command off for this server, or limit it to certain channels and roles. Members who are not allowed get no response.")
                    }
                }
            }
        }
        .modifier(CommandsChrome(isEmbedded: isEmbedded))
        .searchable(text: $model.searchText, prompt: "Search commands")
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .overlay {
            if !model.hasLoaded {
                if let message = model.errorMessage {
                    ContentUnavailableView {
                        Label("Couldn't Load Commands", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try Again") { Task { await model.load() } }
                    }
                } else {
                    ProgressView()
                }
            }
        }
        // Comes back from a command fresh.
        .task { await model.load() }
        .refreshable { await model.load() }
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false }
    }
}

private struct CommandsChrome: ViewModifier {
    let isEmbedded: Bool

    func body(content: Content) -> some View {
        if isEmbedded {
            content.tabBarClearance()
        } else {
            content.navigationTitle("Commands").navigationBarTitleDisplayMode(.inline)
        }
    }
}

/// A command: name and description, and in a quieter line whether it is off or limited.
private struct CommandRow: View {
    let command: ManagedCommand

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: command.name)
                    .font(.headline.monospaced())
                    .lineLimit(1)
                Spacer(minLength: 8)
                if !command.enabled {
                    Text("Off")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
            if !command.description.isEmpty {
                Text(verbatim: command.description)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if let limits = limitSummary {
                Text(verbatim: limits)
                    .font(.footnote)
                    .foregroundStyle(.tint)
            }
        }
        .opacity(command.enabled ? 1 : 0.6)
        .accessibilityElement(children: .combine)
    }

    /// "Limits: 2 channels, 1 role".
    private var limitSummary: String? {
        var parts: [String] = []
        if !command.allowedChannels.isEmpty {
            let count = command.allowedChannels.count
            parts.append(count == 1 ? String(localized: "1 channel") : String(localized: "\(count) channels"))
        }
        if !command.allowedRoles.isEmpty {
            let count = command.allowedRoles.count
            parts.append(count == 1 ? String(localized: "1 role") : String(localized: "\(count) roles"))
        }
        guard !parts.isEmpty else { return nil }
        return String(localized: "Limits: \(ListFormatter.localizedString(byJoining: parts))")
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadCommands else { return nil }
        return CommandsPage(
            commands: [
                ManagedCommand(name: "afk", description: "Set yourself as away"),
                ManagedCommand(name: "ban", description: "Ban a member", enabled: false, allowedRoles: ["r1"]),
                ManagedCommand(name: "warn", description: "Warn a member", allowedChannels: ["c1", "c2"]),
            ],
            channels: [ChannelOption(id: "c1", name: "mods"), ChannelOption(id: "c2", name: "staff")],
            roles: [RoleOption(id: "r1", name: "Moderator")])
    }
    NavigationStack {
        CommandsView(server: "1", session: session)
    }
    .environment(session)
}
