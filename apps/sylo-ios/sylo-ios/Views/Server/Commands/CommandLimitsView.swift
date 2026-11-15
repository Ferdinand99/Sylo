import SwiftUI
import SyloKit

/// One command: a switch, and optional limits to channels and roles. Nothing is sent until Save;
/// empty limits mean everywhere and everyone. A refusal from the server shows in the server's words.
struct CommandLimitsView: View {
    let model: CommandsModel
    let name: String

    @State private var enabled: Bool
    @State private var channels: [String]
    @State private var roles: [String]
    @State private var isConfirmingDiscard = false
    @State private var isVisible = false

    init(model: CommandsModel, name: String) {
        self.model = model
        self.name = name
        let command = model.command(named: name)
        _enabled = State(initialValue: command?.enabled ?? true)
        _channels = State(initialValue: command?.allowedChannels ?? [])
        _roles = State(initialValue: command?.allowedRoles ?? [])
    }

    private var command: ManagedCommand? { model.command(named: name) }

    private var hasChanges: Bool {
        guard let command else { return false }
        return enabled != command.enabled || channels != command.allowedChannels || roles != command.allowedRoles
    }

    private var isSaving: Bool { model.saving.contains(name) }

    var body: some View {
        List {
            if let command {
                Section {
                    Toggle("Enabled", isOn: $enabled)
                } header: {
                    if !command.description.isEmpty { Text(verbatim: command.description) }
                } footer: {
                    Text("A command that is off does nothing in this server.")
                }

                Section {
                    MultiPicker(title: "Only in these channels", selection: $channels, options: model.channels, prefix: "#")
                    MultiPicker(title: "Only for these roles", selection: $roles, options: model.roles, prefix: "@")
                } header: {
                    Text("Limits")
                } footer: {
                    Text("Leave channels empty to allow the command in every channel, and roles empty to allow everyone. Members who are not allowed get no response.")
                }
            }
        }
        .overlay {
            if command == nil {
                ContentUnavailableView(
                    "Command Not Found", systemImage: "terminal",
                    description: Text("This command is no longer in the list."))
            }
        }
        .navigationTitle(model.displayName(name))
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(hasChanges)
        .tracksUnsavedChanges(hasChanges)
        .toolbar {
            if hasChanges {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Discard") { isConfirmingDiscard = true }
                        .disabled(isSaving)
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                if isSaving {
                    ProgressView()
                } else {
                    Button("Save") {
                        Task { await model.save(name, enabled: enabled, channels: channels, roles: roles) }
                    }
                    .toolbarSaveStyle()
                    .disabled(!hasChanges)
                }
            }
        }
        .confirmationDialog("Discard your changes?", isPresented: $isConfirmingDiscard, titleVisibility: .visible) {
            Button("Discard Changes", role: .destructive) { reset() }
        }
        .alert("Couldn't Save", isPresented: isShowingError, presenting: model.actionError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false }
        .sensoryFeedback(.success, trigger: model.saveCount)
    }

    private func reset() {
        guard let command else { return }
        enabled = command.enabled
        channels = command.allowedChannels
        roles = command.allowedRoles
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { model.actionError != nil && isVisible }, set: { if !$0 { model.actionError = nil } })
    }
}
