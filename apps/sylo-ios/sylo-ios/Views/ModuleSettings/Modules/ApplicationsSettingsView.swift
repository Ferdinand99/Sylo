import SwiftUI
import SyloKit

/// Applications: the forms (created, edited, deleted and ordered here), a way in to the submissions
/// where staff read answers and accept or deny, how long decided applications are kept, and the panel
/// message with its Apply buttons (published and removed here). Mirrors
/// web-v2/src/moduleForms/Applications.jsx.
struct ApplicationsSettingsView: View {
    @State private var model: ModuleSettingsModel<ApplicationsPage>
    @State private var note: ModulePlatformNoteModel
    @State private var panel: ApplicationsPanelModel
    /// The channel picked for the panel; nil until the person picks one, so it follows the stored one.
    @State private var pickedPanelChannel: String?
    @State private var isConfirmingRemove = false
    /// Owned here so the Edit button inside the forms section can switch the whole list to reordering.
    @State private var editMode = EditMode.inactive
    private let server: ServerID
    private let session: AppSession

    init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: ApplicationsPage.moduleID, session: session))
        _panel = State(initialValue: ApplicationsPanelModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Applications", model: model) { $settings, page in
            ModuleIntro("Members apply with forms you write, in a direct message or on the web. Staff read each application and accept or deny it, and Sylo can give or take roles and tell the applicant.")
            PlatformNoteSection(model: note)

            Section {
                NavigationLink {
                    ApplicationSubmissionsView(server: server, session: session, forms: page.forms)
                } label: {
                    LabeledContent {
                        if page.pending > 0 {
                            Text("\(page.pending) waiting")
                        }
                    } label: {
                        Label("Applications", systemImage: "tray.full")
                    }
                }
            } footer: {
                Text("Read what members sent in, then accept or deny with an optional reason. Answers can be exported, retried and deleted there.")
            }

            ApplicationFormsSection(
                server: server, session: session, page: page, onChanged: { await model.load() })

            Section {
                NumberField(title: "Keep decided applications", value: $settings.retentionDays,
                            range: ApplicationsSettings.retentionRange, unit: "days")
            } header: {
                Text("Retention")
            } footer: {
                Text("Accepted, denied and withdrawn applications, with their answers, are deleted after this long. Pending ones are kept.")
            }

            Section {
                LimitedTextField(title: "Panel text", text: $settings.panelText,
                                 limit: ApplicationsSettings.maxPanelTextLength, lines: 2...6)
                ChannelPicker(title: "Channel", selection: panelChannel(page: page), channels: page.channels,
                              noneTitle: "Choose a channel")
                LabeledContent("Message") {
                    Text(panelStatus(page: page))
                }
                Button(page.settings.isPanelPublished ? "Republish Panel" : "Publish Panel",
                       systemImage: "paperplane") {
                    publish(text: settings.panelText, page: page)
                }
                .disabled(panelChannel(page: page).wrappedValue.isEmpty || panel.isBusy)
                if page.settings.isPanelPublished {
                    Button("Remove Panel", systemImage: "trash", role: .destructive) {
                        isConfirmingRemove = true
                    }
                    .disabled(panel.isBusy)
                }
                if let message = panel.errorMessage {
                    StatusMessage(message, kind: .error)
                }
                if let notice = panel.notice {
                    StatusMessage(notice, kind: .notice)
                }
            } header: {
                Text("Panel message")
            } footer: {
                Text(Self.panelFooter(defaultText: page.defaultPanelText))
            }
        }
        .environment(\.editMode, $editMode)
        .task { await note.load() }
        .confirmationDialog("Remove the panel message?", isPresented: $isConfirmingRemove, titleVisibility: .visible) {
            Button("Remove Message", role: .destructive) { remove() }
        } message: {
            Text("The message is deleted from the channel. Members can still use /apply.")
        }
        .sensoryFeedback(.success, trigger: panel.successCount)
    }

    // MARK: - The panel

    /// The channel the panel is published in, or the one picked for it.
    private func panelChannel(page: ApplicationsPage) -> Binding<String> {
        Binding(
            get: { pickedPanelChannel ?? page.settings.panelChannelId },
            set: { pickedPanelChannel = $0 })
    }

    private func panelStatus(page: ApplicationsPage) -> String {
        guard page.settings.isPanelPublished else { return String(localized: "Not published") }
        if let channel = page.channels.first(where: { $0.id == page.settings.panelChannelId }) {
            return String(localized: "Published in #\(channel.name)")
        }
        return String(localized: "Published")
    }

    /// Posts the panel with the text as typed (it is saved with it) and loads the page again, so the
    /// status is the server's.
    private func publish(text: String, page: ApplicationsPage) {
        let channel = panelChannel(page: page).wrappedValue
        Task {
            if await panel.publish(channelId: channel, text: text) != nil {
                pickedPanelChannel = nil
                await model.load()
            }
        }
    }

    private func remove() {
        Task {
            if await panel.unpublish() != nil {
                pickedPanelChannel = nil
                await model.load()
            }
        }
    }

    private static func panelFooter(defaultText: String) -> String {
        var text = String(localized: "A message with Apply buttons, pinned in a channel. Leave the text empty for Sylo's own. Publishing again sends a new panel and deletes the old one.")
        if !defaultText.isEmpty { text += " " + String(localized: "Default: \(defaultText)") }
        return text
    }
}

/// The forms: each opens its editor, new ones are added here, and edit mode reorders them.
private struct ApplicationFormsSection: View {
    @State private var order: ApplicationFormOrderModel
    private let server: ServerID
    private let session: AppSession
    private let page: ApplicationsPage
    private let onChanged: () async -> Void

    init(server: ServerID, session: AppSession, page: ApplicationsPage, onChanged: @escaping () async -> Void) {
        self.server = server
        self.session = session
        self.page = page
        self.onChanged = onChanged
        _order = State(initialValue: ApplicationFormOrderModel(server: server, forms: page.forms, session: session))
    }

    var body: some View {
        Section {
            if order.forms.isEmpty {
                Text("No forms yet.").foregroundStyle(.secondary)
            }
            ForEach(order.forms) { form in
                NavigationLink {
                    ApplicationFormEditorView(
                        server: server, session: session, form: form, page: page, onChanged: onChanged)
                } label: {
                    FormLine(form: form)
                }
            }
            .onMove { source, destination in
                Task { await order.move(fromOffsets: source, toOffset: destination) }
            }
            NavigationLink {
                ApplicationFormEditorView(
                    server: server, session: session, form: .blank(messages: page.defaultMessages), page: page,
                    onChanged: onChanged)
            } label: {
                Label("New Form", systemImage: "plus")
            }
            .disabled(order.forms.count >= page.maxForms)
            if let message = order.errorMessage {
                StatusMessage(message, kind: .error)
            }
        } header: {
            HStack {
                Text("Forms")
                Spacer()
                if order.forms.count > 1 {
                    EditButton().textCase(nil)
                }
            }
        } footer: {
            if order.forms.count >= page.maxForms {
                Text("A server can have at most \(page.maxForms) forms.")
            } else {
                Text("Each form has its own questions, requirements, channels and roles.")
            }
        }
        .onChange(of: page.forms) {
            order.sync(page.forms)
        }
    }
}

/// One form: its name, whether it takes applications, and what still stops it.
private struct FormLine: View {
    let form: ApplicationForm

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: form.name)
            Text(verbatim: details)
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let problem = form.setupProblem {
                Label(problem, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .symbolRenderingMode(.multicolor)
            }
            if let problem = form.rolesProblem {
                Label(problem, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .symbolRenderingMode(.multicolor)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// "Open · 5 questions · DM and web".
    private var details: String {
        let state = form.isEnabled ? String(localized: "Open") : String(localized: "Closed")
        let questions = form.questionCount == 1 ? String(localized: "1 question") : String(localized: "\(form.questionCount) questions")
        return [state, questions, form.fillMode.title].joined(separator: " · ")
    }
}

extension ApplicationFillMode {
    /// Where members can fill the form in.
    var title: String {
        switch self {
        case .discord: String(localized: "in DMs")
        case .web: String(localized: "on the web")
        case .both: String(localized: "in DMs and on the web")
        case .other(let raw): raw
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        if endpoint is Endpoints.LoadPlatformInfo { return PlatformInfo(platform: .discord) }
        guard endpoint is Endpoints.LoadModuleSettings<ApplicationsPage> else { return nil }
        return ApplicationsPage(
            settings: ApplicationsSettings(retentionDays: 90, panelText: "Apply here"),
            forms: [
                ApplicationForm(id: 1, name: "Staff", enabled: true,
                                questions: [ApplicationQuestion(id: "q1", label: "Why?")]),
                ApplicationForm(id: 2, name: "Builder", enabled: false, fillMode: .web,
                                setupProblem: "The form has no questions."),
            ],
            channels: [ChannelOption(id: "c1", name: "applications")],
            pending: 3, defaultPanelText: "Press a button to apply.")
    }
    NavigationStack {
        ApplicationsSettingsView(server: "1", session: session)
    }
    .environment(session)
}
