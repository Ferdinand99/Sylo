import SwiftUI
import SyloKit

/// Applications: how long decided applications are kept and the text of the panel message, the
/// forms listed read only, and a way in to the submissions, where staff read answers and accept or
/// deny. Writing and changing forms (questions, requirements, roles, messages), publishing the
/// panel and the export stay in the web dashboard. Mirrors web-v2/src/moduleForms/Applications.jsx.
struct ApplicationsSettingsView: View {
    @State private var model: ModuleSettingsModel<ApplicationsPage>
    @State private var note: ModulePlatformNoteModel
    private let server: ServerID
    private let session: AppSession

    init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: ApplicationsPage.moduleID, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Applications", model: model) { $settings, page in
            ModuleIntro("Members apply with forms you write, in a direct message or on the web. Staff read each application and accept or deny it, and Sylo can give or take roles and tell the applicant.")
            PlatformNoteSection(model: note)

            Section {
                NavigationLink {
                    ApplicationSubmissionsView(server: server, session: session)
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
                Text("Read what members sent in, then accept or deny with an optional reason.")
            }

            Section {
                NumberField(title: "Keep decided applications", value: $settings.retentionDays,
                            range: ApplicationsSettings.retentionRange, unit: "days")
            } header: {
                Text("Retention")
            } footer: {
                Text("Accepted, denied and withdrawn applications, with their answers, are deleted after this long. Pending ones are kept.")
            }

            Section {
                TextArea(title: "Panel text", text: $settings.panelText,
                         limit: ApplicationsSettings.maxPanelTextLength, lines: 2...6)
                LabeledContent("Message") {
                    Text(settings.isPanelPublished ? "Published" : "Not published")
                }
            } header: {
                Text("Panel message")
            } footer: {
                Text(Self.panelFooter(settings: settings, defaultText: page.defaultPanelText))
            }

            Section {
                if page.forms.isEmpty {
                    Text("No forms yet.").foregroundStyle(.secondary)
                }
                ForEach(page.forms) { form in
                    FormLine(form: form)
                }
            } header: {
                Text("Forms")
            } footer: {
                Text("Create and edit forms in the web dashboard.")
            }

            DashboardLinkSection(
                server: server, module: ApplicationsPage.moduleID,
                footer: "Forms, the panel message and the export of answers are managed in the web dashboard.")
        }
        .task { await note.load() }
    }

    private static func panelFooter(settings: ApplicationsSettings, defaultText: String) -> String {
        var text = String(localized: "A message with Apply buttons, pinned in a channel. Leave the text empty for Sylo's own.")
        if !defaultText.isEmpty { text += " " + String(localized: "Default: \(defaultText)") }
        text += " " + String(localized: "Publish or remove the message in the web dashboard.")
        return text
    }
}

/// One form: its name, whether it takes applications, and what still stops it.
private struct FormLine: View {
    let form: ApplicationFormSummary

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
                ApplicationFormSummary(id: 1, name: "Staff", isEnabled: true, questionCount: 5),
                ApplicationFormSummary(id: 2, name: "Builder", isEnabled: false, fillMode: .web,
                                       setupProblem: "The form has no questions."),
            ],
            pending: 3, defaultPanelText: "Press a button to apply.")
    }
    NavigationStack {
        ApplicationsSettingsView(server: "1", session: session)
    }
    .environment(session)
}
