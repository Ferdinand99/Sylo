import SwiftUI
import SyloKit

/// Every slash command Sylo has, searchable by name or by what it does. Mirrors
/// web-v2/src/pages/CommandList.jsx. Turning commands off for a server is the Commands page of
/// that server, not this one.
struct CommandListView: View {
    @State private var model: CommandListModel

    init(session: AppSession) {
        _model = State(initialValue: CommandListModel(session: session))
    }

    var body: some View {
        List {
            if let message = model.errorMessage, model.hasLoaded {
                Section { StatusMessage(message, kind: .error) }
            }
            if model.hasLoaded {
                ForEach(model.filtered) { command in
                    NavigationLink {
                        CommandDetailView(command: command)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: command.signature)
                                .font(.body.monospaced())
                                .lineLimit(2)
                            if !command.description.isEmpty {
                                Text(verbatim: command.description)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                    }
                }
            }
        }
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
            } else if model.filtered.isEmpty {
                if model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    ContentUnavailableView("No Commands Yet", systemImage: "slash.circle")
                } else {
                    ContentUnavailableView.search(text: model.query)
                }
            }
        }
        .navigationTitle("Command List")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $model.query, prompt: "Search commands")
        .task { if !model.hasLoaded { await model.load() } }
        .refreshable { await model.load() }
    }
}

/// One command: what it does, what it needs, and its options.
private struct CommandDetailView: View {
    let command: CommandReference

    var body: some View {
        List {
            Section {
                Text(verbatim: command.signature)
                    .font(.body.monospaced())
                    .textSelection(.enabled)
                if !command.description.isEmpty {
                    Text(verbatim: command.description)
                }
            }
            if let permissions = command.permissions {
                Section("Requires") {
                    ForEach(permissions, id: \.self) { permission in
                        Text(verbatim: permission)
                    }
                }
            }
            if !command.options.isEmpty {
                Section("Options") {
                    ForEach(command.options) { option in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(verbatim: option.name)
                                    .font(.body.monospaced())
                                Text(option.isRequired ? "required" : "optional")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            if !option.description.isEmpty {
                                Text(verbatim: option.description)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            if !option.choices.isEmpty {
                                Text("Choices: \(ListFormatter.localizedString(byJoining: option.choices))")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
        .navigationTitle(command.signature.split(separator: " ").first.map(String.init) ?? "Command")
        .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.CommandList else { return nil }
        return CommandListPage(commands: [
            CommandReference(
                signature: "/ban <user> [reason]", description: "Ban a member.", permissions: ["Ban Members"],
                options: [
                    CommandOption(name: "user", isRequired: true, description: "Who to ban"),
                    CommandOption(name: "reason", description: "Why", choices: ["Spam", "Raid"]),
                ]),
            CommandReference(signature: "/ping", description: "Check that Sylo is awake."),
        ])
    }
    NavigationStack {
        CommandListView(session: session)
    }
    .environment(session)
}
