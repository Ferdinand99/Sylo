import SwiftUI
import SyloKit

/// One application form: its settings, questions (a screen each, reordered in edit mode),
/// requirements, where the applications go, the roles it gives and takes, and the messages to the
/// applicant. Saving and deleting are the server's, one form at a time, as in the web dashboard
/// (web-v2/src/components/ApplicationsFormEditor.jsx). Back stays hidden while there are unsaved
/// changes, so they cannot be lost by accident.
struct ApplicationFormEditorView: View {
    @State private var model: ApplicationFormEditorModel
    @State private var isConfirmingDiscard = false
    @State private var isConfirmingDelete = false
    /// Owned here so the Edit button in the questions header can switch the list to reordering.
    @State private var editMode = EditMode.inactive
    @Environment(\.dismiss) private var dismiss
    private let page: ApplicationsPage
    /// Called after a save or a delete, so the list of forms behind this screen is loaded again.
    private let onChanged: () async -> Void

    init(server: ServerID, session: AppSession, form: ApplicationForm, page: ApplicationsPage,
         onChanged: @escaping () async -> Void) {
        self.page = page
        self.onChanged = onChanged
        _model = State(initialValue: ApplicationFormEditorModel(server: server, form: form, session: session))
    }

    var body: some View {
        Form {
            problems
            generalSection
            questionsSection
            requirementsSection
            destinationSection
            rolesSection
            messagesSection
            leaveSection
            if !model.isNew {
                Section {
                    Button("Delete Form", systemImage: "trash", role: .destructive) { isConfirmingDelete = true }
                } footer: {
                    Text("Applications already received stay and can still be decided. The panel message has to be published again.")
                }
            }
        }
        .environment(\.editMode, $editMode)
        .disabled(model.isBusy)
        .navigationTitle(model.draft.name.isEmpty ? String(localized: "New Form") : model.draft.name)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(model.hasChanges)
        .toolbar {
            if model.hasChanges {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Discard") { isConfirmingDiscard = true }
                        .disabled(model.isBusy)
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                if model.isSaving {
                    ProgressView()
                } else {
                    Button("Save") { save() }
                        .toolbarSaveStyle()
                        .disabled(!model.hasChanges || model.problem != nil || model.isBusy)
                }
            }
        }
        .confirmationDialog("Discard your changes?", isPresented: $isConfirmingDiscard, titleVisibility: .visible) {
            Button("Discard Changes", role: .destructive) { model.discardChanges() }
        }
        .confirmationDialog("Delete This Form?", isPresented: $isConfirmingDelete, titleVisibility: .visible) {
            Button("Delete Form", role: .destructive) { delete() }
        } message: {
            Text("Applications already received stay. Members can no longer apply with this form.")
        }
        .alert("Something Went Wrong", isPresented: isShowingError, presenting: model.errorMessage) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: model.saveCount)
    }

    private func save() {
        Task {
            if await model.save() { await onChanged() }
        }
    }

    private func delete() {
        Task {
            if await model.delete() {
                await onChanged()
                dismiss()
            }
        }
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })
    }

    // MARK: - Sections

    @ViewBuilder
    private var problems: some View {
        let setup = model.draft.setupProblem
        let roles = model.draft.rolesProblem
        let blocking = (model.hasChanges || !model.isNew) ? model.problem : nil
        if setup != nil || roles != nil || blocking != nil {
            Section {
                if let blocking {
                    StatusMessage(blocking, kind: .notice)
                }
                if let setup {
                    Label(setup, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .symbolRenderingMode(.multicolor)
                }
                if let roles {
                    Label(roles, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .symbolRenderingMode(.multicolor)
                }
            }
        }
    }

    private var generalSection: some View {
        Section {
            TextField("Name", text: $model.draft.name)
            TextArea(title: "Description (optional)", text: $model.draft.description,
                     limit: ApplicationForm.maxDescriptionLength, lines: 2...5)
            Toggle("Open for applications", isOn: $model.draft.enabled)
            Picker("Where members fill it in", selection: $model.draft.fillMode) {
                ForEach(ApplicationFillMode.choices, id: \.self) { mode in
                    Text(mode.pickerTitle).tag(mode)
                }
                if case .other(let raw) = model.draft.fillMode {
                    Text(verbatim: raw).tag(model.draft.fillMode)
                }
            }
            NumberField(title: "Time to answer in a DM", value: $model.draft.timeoutMinutes,
                        range: ApplicationForm.timeoutRange, unit: "min")
        } footer: {
            Text("An open form needs at least one question and a channel for new applications. Members can fill a form in on the web only when this server has a public web address.")
        }
    }

    private var questionsSection: some View {
        Section {
            ForEach($model.draft.questions) { $question in
                NavigationLink {
                    ApplicationQuestionEditorView(
                        question: $question, roles: page.roles, shortTextMax: page.shortTextMax)
                } label: {
                    ListLine(title: question.label.isEmpty ? String(localized: "New question") : question.label,
                             details: question.summary)
                }
            }
            .onMove { source, destination in
                model.draft.moveQuestions(fromOffsets: source, toOffset: destination)
            }
            .onDelete { offsets in
                model.draft.questions.remove(atOffsets: offsets)
            }
            if model.draft.questions.isEmpty {
                Text("No questions yet.").foregroundStyle(.secondary)
            }
            Button("Add Question", systemImage: "plus") {
                model.draft.addQuestion()
            }
            .disabled(model.draft.questions.count >= ApplicationForm.maxQuestions)
        } header: {
            HStack {
                Text("Questions")
                Spacer()
                if model.draft.questions.count > 1 {
                    EditButton().textCase(nil)
                }
            }
        } footer: {
            Text("Tap Edit to reorder the questions or swipe one to remove it. A question without text is not kept.")
        }
    }

    @ViewBuilder
    private var requirementsSection: some View {
        Section {
            MultiPicker(title: "Required roles", selection: $model.draft.requiredRoleIds, options: page.roles,
                        prefix: "@", limit: ApplicationForm.maxRoles)
            Picker("The member needs", selection: $model.draft.requiredRolesMode) {
                Text("All of the required roles").tag(ApplicationRolesMode.all)
                Text("Any one of them").tag(ApplicationRolesMode.any)
                if case .other(let raw) = model.draft.requiredRolesMode {
                    Text(verbatim: raw).tag(model.draft.requiredRolesMode)
                }
            }
            MultiPicker(title: "Restricted roles", selection: $model.draft.restrictedRoleIds, options: page.roles,
                        prefix: "@", limit: ApplicationForm.maxRoles)
            Picker("Turned away with", selection: $model.draft.restrictedRolesMode) {
                Text("Any one of the restricted roles").tag(ApplicationRolesMode.any)
                Text("All of the restricted roles").tag(ApplicationRolesMode.all)
                if case .other(let raw) = model.draft.restrictedRolesMode {
                    Text(verbatim: raw).tag(model.draft.restrictedRolesMode)
                }
            }
            NumberField(title: "Account age", value: $model.draft.minAccountDays,
                        range: ApplicationForm.ageDaysRange, unit: "days")
            NumberField(title: "Time in this server", value: $model.draft.minServerDays,
                        range: ApplicationForm.ageDaysRange, unit: "days")
            NumberField(title: "Cooldown after a denial", value: $model.draft.cooldownHours,
                        range: ApplicationForm.cooldownHoursRange, unit: "hours")
        } header: {
            Text("Who may apply")
        } footer: {
            Text("0 means no requirement. Only one application per form can wait for a decision at a time.")
        }
    }

    @ViewBuilder
    private var destinationSection: some View {
        Section {
            ChannelPicker(title: "New applications", selection: $model.draft.pendingChannelId,
                          channels: page.channels, noneTitle: "Choose a channel")
            ChannelPicker(title: "Accepted applications", selection: $model.draft.acceptedChannelId,
                          channels: page.channels)
            ChannelPicker(title: "Denied applications", selection: $model.draft.deniedChannelId,
                          channels: page.channels)
            Picker("A decided application is", selection: $model.draft.decidedPost) {
                Text("Moved to that channel").tag(ApplicationDecidedPost.move)
                Text("Copied there").tag(ApplicationDecidedPost.copy)
                if case .other(let raw) = model.draft.decidedPost {
                    Text(verbatim: raw).tag(model.draft.decidedPost)
                }
            }
            MultiPicker(title: "Ping for a new application", selection: $model.draft.pingRoleIds,
                        options: page.roles, prefix: "@", limit: ApplicationForm.maxPingRoles)
            MultiPicker(title: "Roles that may decide", selection: $model.draft.managerRoleIds,
                        options: page.roles, prefix: "@", limit: ApplicationForm.maxRoles)
            if page.supportsThreads != false {
                Toggle("Open a staff thread", isOn: $model.draft.staffThread)
            }
        } header: {
            Text("Where the applications go")
        } footer: {
            Text("The channel for new applications is required. Sylo needs View Channel, Read Message History, Send Messages and Embed Links there. Members with Manage Server can always decide. Staff threads are Discord only.")
        }
    }

    private var rolesSection: some View {
        Section {
            RolePicker(title: "While waiting for a decision", selection: $model.draft.pendingRoleId,
                       roles: page.roles)
            MultiPicker(title: "Taken away on submit", selection: $model.draft.removeOnSubmitRoleIds,
                        options: page.roles, prefix: "@", limit: ApplicationForm.maxRoles)
            MultiPicker(title: "Given on accept", selection: $model.draft.acceptAddRoleIds,
                        options: page.roles, prefix: "@", limit: ApplicationForm.maxRoles)
            MultiPicker(title: "Taken away on accept", selection: $model.draft.acceptRemoveRoleIds,
                        options: page.roles, prefix: "@", limit: ApplicationForm.maxRoles)
            MultiPicker(title: "Given on deny", selection: $model.draft.denyAddRoleIds,
                        options: page.roles, prefix: "@", limit: ApplicationForm.maxRoles)
            MultiPicker(title: "Taken away on deny", selection: $model.draft.denyRemoveRoleIds,
                        options: page.roles, prefix: "@", limit: ApplicationForm.maxRoles)
        } header: {
            Text("Roles")
        } footer: {
            Text("Sylo checks that it can manage these roles before a member starts. If a role change fails later, the decision still stands and you can retry it from the application.")
        }
    }

    private var messagesSection: some View {
        Section {
            TextArea(title: "When they start", text: $model.draft.messages.start,
                     limit: ApplicationFormMessages.maxLength, lines: 2...6)
            TextArea(title: "When they have submitted", text: $model.draft.messages.completed,
                     limit: ApplicationFormMessages.maxLength, lines: 2...6)
            TextArea(title: "When accepted", text: $model.draft.messages.accepted,
                     limit: ApplicationFormMessages.maxLength, lines: 2...6)
            TextArea(title: "When denied", text: $model.draft.messages.denied,
                     limit: ApplicationFormMessages.maxLength, lines: 2...6)
        } header: {
            Text("Messages to the applicant")
        } footer: {
            Text(Self.messagesFooter(page.placeholders))
        }
    }

    private var leaveSection: some View {
        Section {
            Picker("When a member leaves", selection: $model.draft.onLeave) {
                Text("Keep the application").tag(ApplicationOnLeave.keep)
                Text("Deny it").tag(ApplicationOnLeave.deny)
                if case .other(let raw) = model.draft.onLeave {
                    Text(verbatim: raw).tag(model.draft.onLeave)
                }
            }
        } header: {
            Text("While waiting")
        } footer: {
            Text("What happens to an application that is still waiting when the applicant leaves the server. A denial gets the reason \"Left the server\".")
        }
    }

    private static func messagesFooter(_ placeholders: [String]) -> LocalizedStringKey {
        guard !placeholders.isEmpty else {
            return "Sent by direct message. Leave one empty to send nothing."
        }
        return "Sent by direct message. Leave one empty to send nothing. Placeholders: \(placeholders.joined(separator: ", "))"
    }
}

extension ApplicationFillMode {
    /// The choice as the form's picker words it.
    var pickerTitle: String {
        switch self {
        case .both: String(localized: "In a DM or on the web")
        case .discord: String(localized: "In a DM only")
        case .web: String(localized: "On the web only")
        case .other(let raw): raw
        }
    }
}

extension ApplicationQuestionType {
    /// The type as the question screen words it.
    var title: String {
        switch self {
        case .text: String(localized: "Text")
        case .choice: String(localized: "Choice")
        case .role: String(localized: "Role")
        case .yesno: String(localized: "Yes or no")
        case .other(let raw): raw
        }
    }
}

extension ApplicationQuestion {
    /// "Text · required", "Choice · 3 options".
    var summary: String {
        var parts = [type.title]
        if type.hasOptions {
            parts.append(options.count == 1 ? String(localized: "1 option") : String(localized: "\(options.count) options"))
        }
        if required { parts.append(String(localized: "required")) }
        return parts.joined(separator: " · ")
    }
}

#Preview {
    let form = ApplicationForm(
        id: 3, name: "Staff", enabled: true,
        questions: [
            ApplicationQuestion(id: "q1", label: "Why do you want to join?", required: true, long: true),
            ApplicationQuestion(id: "q2", type: .choice, label: "Timezone",
                                options: [.init(id: "a", label: "Europe"), .init(id: "b", label: "America")]),
        ],
        pendingChannelId: "c1", messages: ApplicationFormMessages(start: "Hi {user}", completed: "Thanks"))
    let page = ApplicationsPage(
        settings: ApplicationsSettings(), forms: [form],
        channels: [ChannelOption(id: "c1", name: "applications")], roles: [RoleOption(id: "r1", name: "Staff")],
        placeholders: ["{user}", "{server}"])
    NavigationStack {
        ApplicationFormEditorView(server: "1", session: .preview(.signedIn), form: form, page: page, onChanged: {})
    }
}
