import SwiftUI
import SyloKit

/// The setup wizard (Sylo 5.2): four steps, the same as the dashboard's. Sylo looks at the server's channels and
/// roles, the person picks goals, reviews what Sylo proposes, and applies. Nothing is created or changed unless
/// it was ticked, and the result of every item is shown as the server returns it. Mirrors
/// web-v2/src/pages/SetupWizard.jsx.
struct SetupWizardView: View {
    let model: SetupWizardModel

    @Environment(\.dismiss) private var dismiss
    @State private var isConfirming = false

    var body: some View {
        Group {
            if !model.isAvailable {
                ContentUnavailableView(
                    "Not Available", systemImage: "wand.and.stars",
                    description: Text("This Sylo server does not have the setup wizard yet."))
            } else if let draft = model.draft {
                steps(draft)
            } else if let message = model.errorMessage {
                ContentUnavailableView {
                    Label("Couldn't Look at the Server", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await model.load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Set Up Sylo")
        .navigationBarTitleDisplayMode(.inline)
        // The proposal can be read with View access, but applying changes the server: Edit.
        .lockedBelow()
        .task { if model.draft == nil, model.isAvailable { await model.load() } }
    }

    @ViewBuilder
    private func steps(_ draft: SetupDraft) -> some View {
        switch model.step {
        case .look: look(draft.proposal)
        case .goals: goals(draft)
        case .review: review(draft)
        case .done: done
        }
    }

    // MARK: Step 1: look

    private func look(_ proposal: SetupProposal) -> some View {
        List {
            Section {
                Label("^[\(proposal.channelCount) channel](inflect: true) and ^[\(proposal.roleCount) role](inflect: true)", systemImage: "number")
                Label("^[\(proposal.memberCount) member](inflect: true)", systemImage: "person.2")
            } header: {
                Text("What Sylo found")
            } footer: {
                Text("Sylo matches channels by name, for example welcome, rules, mod-log or tickets. If it finds none, it offers to create one, but only when you tick Create.")
            }
            if proposal.canCreateChannels == false || proposal.canCreateRoles == false {
                Section {
                    if proposal.canCreateChannels == false {
                        StatusMessage("Sylo can't create channels here: it needs the Manage Channels permission. You can still pick channels that exist.", kind: .notice)
                    }
                    if proposal.canCreateRoles == false {
                        StatusMessage("Sylo can't create roles here: it needs the Manage Roles permission. You can still pick roles that exist.", kind: .notice)
                    }
                }
            }
            Section {
                Button("Choose What to Set Up") { model.goToGoals() }
            }
        }
    }

    // MARK: Step 2: goals

    private func goals(_ draft: SetupDraft) -> some View {
        List {
            Section {
                ForEach(draft.proposal.goals) { goal in
                    Toggle(isOn: Binding(
                        get: { draft.goals.contains(goal.id) },
                        set: { model.setGoal(goal.id, on: $0) })
                    ) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: goal.label)
                            Text(verbatim: goal.description)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            if draft.isDone(goal: goal.id) {
                                Text("Already set up")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(.green)
                            }
                        }
                    }
                }
            } header: {
                Text("Goals")
            } footer: {
                Text("Pick what you want Sylo to help with. You see everything it proposes before anything is saved.")
            }
            Section {
                Button("Review") { model.goToReview() }
                    .disabled(draft.goals.isEmpty)
                Button("Back") { model.back() }
            }
        }
    }

    // MARK: Step 3: review

    private func review(_ draft: SetupDraft) -> some View {
        let items = draft.proposal.items.filter { draft.goals.contains($0.goal) }
        let summary = draft.review
        return List {
            ForEach(items) { item in
                itemSection(item, draft)
            }
            Section {
                if !draft.missingCreates.isEmpty {
                    Button("Tick Create for All of Them", systemImage: "plus.circle") {
                        model.update { $0.tickAllCreates() }
                    }
                }
                if let message = model.errorMessage {
                    StatusMessage(message, kind: .error)
                }
                Button {
                    isConfirming = true
                } label: {
                    if model.isApplying {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Setting Up")
                        }
                    } else {
                        Text("Apply")
                    }
                }
                .disabled(!model.canApply)
                Button("Back") { model.back() }
                    .disabled(model.isApplying)
            } footer: {
                Text(summaryText(summary))
            }
        }
        .confirmationDialog("Set Up These Items?", isPresented: $isConfirming, titleVisibility: .visible) {
            Button("Apply") { Task { await model.apply() } }
        } message: {
            Text(confirmText(summary))
        }
    }

    private func itemSection(_ item: SetupItem, _ draft: SetupDraft) -> some View {
        let choice = draft.choices[item.id] ?? SetupItemChoice()
        return Section {
            Toggle(isOn: Binding(
                get: { choice.isOn },
                set: { value in model.update { $0.choices[item.id]?.isOn = value } })
            ) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: item.name)
                    if !item.does.isEmpty {
                        Text(verbatim: item.does)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    if item.configured {
                        Text("Already set up. Switch on to replace it.")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.orange)
                    }
                }
            }
            .disabled(!item.isUsable)
            if !item.isUsable {
                StatusMessage("This module can't run yet: \(item.blocked.joined(separator: ", ")). Only the bot owner can allow it.", kind: .notice)
            }
            ForEach(item.warnings, id: \.self) { warning in
                StatusMessage(warning, kind: .notice)
            }
            if choice.isOn {
                ForEach(item.fields) { field in
                    fieldRows(field, in: item, draft)
                }
                ForEach(draft.problems(for: item), id: \.self) { problem in
                    Label(problem, systemImage: "exclamationmark.circle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
        }
    }

    @ViewBuilder
    private func fieldRows(_ field: SetupField, in item: SetupItem, _ draft: SetupDraft) -> some View {
        let pick = draft.choices[item.id]?.fields[field.key] ?? SetupFieldChoice()
        let viewerOn = draft.viewerActive(item)
        if field.viewerOnly && !viewerOn {
            // Used only when Sylo makes the channel or the person ticks the permission change.
            Text("\(field.label) is used when Sylo makes the channel or changes its permissions.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else {
            Picker(field.label, selection: Binding(
                get: { pick.id },
                set: { value in
                    model.update {
                        $0.choices[item.id]?.fields[field.key]?.id = value
                        $0.choices[item.id]?.fields[field.key]?.mode = .pick
                    }
                })
            ) {
                Text(field.isOptional ? "None" : "Choose\u{2026}").tag("")
                if field.kind == .channel {
                    ForEach(draft.proposal.channels) { channel in
                        Text(verbatim: "#\(channel.name)").tag(channel.id)
                    }
                } else {
                    ForEach(draft.proposal.roles) { role in
                        Text(verbatim: "@\(role.name)").tag(role.id)
                    }
                }
            }
            .pickerStyle(.navigationLink)
            .disabled(pick.mode == .create)
            if let create = field.create {
                if let existing = create.existing {
                    // "Create" would use what is already there; it says how it differs from the promise.
                    Text("A \(field.kind == .channel ? "channel" : "role") named \(existing.name) is already here and is used instead of making another.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    Toggle(isOn: Binding(
                        get: { pick.mode == .create },
                        set: { value in model.update { $0.choices[item.id]?.fields[field.key]?.mode = value ? .create : .pick } })
                    ) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Create \(field.kind == .channel ? "#" : "@")\(create.name)")
                            Text(createNote(create, kind: field.kind))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if field.kind == .channel, !pick.id.isEmpty,
               let fixable = draft.fixableChannel(item: item, field: field, channelID: pick.id) {
                Toggle(isOn: Binding(
                    get: { pick.fix },
                    set: { value in model.update { $0.choices[item.id]?.fields[field.key]?.fix = value } })
                ) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Change its permissions")
                        Text(verbatim: (fixable.gap ?? "It is not what this setup promises.") + " Sylo makes it private, for staff only.")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
            }
        }
    }

    private func createNote(_ create: SetupCreate, kind: SetupField.Kind) -> LocalizedStringKey {
        guard kind == .channel else { return "A new role Sylo can give." }
        if create.isPrivate { return "Private: members can't see it." }
        if create.everyoneCanView { return "Everyone can see it, but only Sylo and staff can post." }
        if create.readOnly { return "Members can read it, but only Sylo and staff can post." }
        return "A new channel."
    }

    private func summaryText(_ summary: SetupReview) -> String {
        var parts = ["\(summary.itemCount) \(summary.itemCount == 1 ? "item" : "items") to set up."]
        if summary.replacedCount > 0 { parts.append("\(summary.replacedCount) already set up and will be replaced.") }
        if !summary.channelsToCreate.isEmpty { parts.append("New channels: \(summary.channelsToCreate.map { "#\($0)" }.joined(separator: ", ")).") }
        if !summary.rolesToCreate.isEmpty { parts.append("New roles: \(summary.rolesToCreate.map { "@\($0)" }.joined(separator: ", ")).") }
        if !summary.channelsToChange.isEmpty { parts.append("Permissions change on: \(summary.channelsToChange.map { "#\($0)" }.joined(separator: ", ")).") }
        if summary.problemCount > 0 { parts.append("Fix \(summary.problemCount) \(summary.problemCount == 1 ? "problem" : "problems") above first.") }
        return parts.joined(separator: " ")
    }

    private func confirmText(_ summary: SetupReview) -> String {
        var parts: [String] = []
        if !summary.channelsToCreate.isEmpty { parts.append("Sylo creates the channels \(summary.channelsToCreate.map { "#\($0)" }.joined(separator: ", ")).") }
        if !summary.rolesToCreate.isEmpty { parts.append("Sylo creates the roles \(summary.rolesToCreate.map { "@\($0)" }.joined(separator: ", ")).") }
        if !summary.channelsToChange.isEmpty { parts.append("Sylo changes who can see \(summary.channelsToChange.map { "#\($0)" }.joined(separator: ", ")).") }
        if summary.replacedCount > 0 { parts.append("\(summary.replacedCount) module settings that are already set up are replaced.") }
        parts.append("Each item is saved on its own and written to the audit log.")
        return parts.joined(separator: " ")
    }

    // MARK: Step 4: done

    private var done: some View {
        List {
            Section {
                ForEach(model.results) { result in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(verbatim: result.name).font(.headline)
                            Spacer()
                            StatusTag(LocalizedStringKey(result.status.label),
                                      tint: result.status == .applied ? .green : (result.status == .failed ? .red : .secondary))
                        }
                        if !result.message.isEmpty {
                            Text(verbatim: result.message).font(.subheadline)
                        }
                        touched("Created", result.created)
                        touched("Used the existing", result.reused)
                        touched("Changed the permissions of", result.changed)
                        ForEach(result.warnings, id: \.self) { warning in
                            Label(warning, systemImage: "exclamationmark.triangle")
                                .font(.footnote)
                                .foregroundStyle(.orange)
                        }
                    }
                    .padding(.vertical, 2)
                    .accessibilityElement(children: .combine)
                }
            } header: {
                Text("Result")
            } footer: {
                Text("A channel or role that was made is listed here so you can remove it yourself if you change your mind. Sylo never deletes channels.")
            }
            Section {
                Button("Set Up More") { Task { await model.restart() } }
                Button("Done") { dismiss() }
            }
        }
    }

    @ViewBuilder
    private func touched(_ title: String, _ list: [SetupTouched]) -> some View {
        if !list.isEmpty {
            let names = list.map { ($0.kind == "role" ? "@" : "#") + $0.name }.joined(separator: ", ")
            Text(verbatim: "\(title): \(names)")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}
