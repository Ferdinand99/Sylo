import SwiftUI
import SyloKit

/// The application inbox: pending ones first, filtered by status and form, newest first. A row opens
/// the application with its answers.
struct ApplicationSubmissionsView: View {
    @State private var model: ApplicationSubmissionsModel
    private let server: ServerID
    private let session: AppSession
    private let forms: [ApplicationForm]

    /// What the list shows; a change loads it again.
    private struct Filter: Hashable {
        let status: ApplicationStatus?
        let form: Int?
    }

    init(server: ServerID, session: AppSession, forms: [ApplicationForm] = []) {
        self.server = server
        self.session = session
        self.forms = forms
        _model = State(initialValue: ApplicationSubmissionsModel(server: server, session: session))
    }

    var body: some View {
        List {
            if let message = model.errorMessage, model.hasLoaded {
                Section { StatusMessage(message, kind: .error) }
            }
            Section {
                Picker("Show", selection: $model.filter) {
                    Text("Pending").tag(ApplicationStatus?.some(.pending))
                    Text("Accepted").tag(ApplicationStatus?.some(.accepted))
                    Text("Denied").tag(ApplicationStatus?.some(.denied))
                    Text("Withdrawn").tag(ApplicationStatus?.some(.withdrawn))
                    Text("All").tag(ApplicationStatus?.none)
                }
                if forms.count > 1 {
                    Picker("Form", selection: $model.formFilter) {
                        Text("All forms").tag(Int?.none)
                        ForEach(forms) { form in
                            Text(verbatim: form.name).tag(form.id)
                        }
                    }
                }
            }
            Section {
                ForEach(model.submissions) { submission in
                    NavigationLink {
                        ApplicationSubmissionView(server: server, session: session, submissionID: submission.id,
                                                  applicant: submission.applicantName)
                    } label: {
                        ApplicationSubmissionRow(submission: submission)
                    }
                }
                if model.canLoadMore {
                    Button("Show More") { Task { await model.loadMore() } }
                        .disabled(model.isLoading)
                }
            } header: {
                if model.hasLoaded {
                    Text("\(model.total) applications")
                }
            } footer: {
                if model.hasLoaded, model.submissions.isEmpty {
                    Text("No applications match.")
                }
            }
        }
        .overlay {
            if !model.hasLoaded {
                if let message = model.errorMessage {
                    ContentUnavailableView {
                        Label("Couldn't Load Applications", systemImage: "exclamationmark.triangle")
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
        .navigationTitle("Applications")
        .navigationBarTitleDisplayMode(.inline)
        // Comes back from an application fresh, and reloads when the filter changes.
        .task(id: Filter(status: model.filter, form: model.formFilter)) { await model.load() }
        .refreshable { await model.load() }
    }
}

/// One application: who, for which form, how it stands and when it came in.
struct ApplicationSubmissionRow: View {
    let submission: ApplicationSubmission
    /// False where the list is one member's, so their name is not repeated on every row.
    var showsApplicant = true

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: showsApplicant ? submission.applicantName : submission.formName)
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(verbatim: submission.status.title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(submission.status.color)
            }
            Text(verbatim: details)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    /// "Staff · 3 min. ago".
    private var details: String {
        var parts = showsApplicant ? [submission.formName] : []
        if let date = submission.createdDate { parts.append(DateText.relative(date)) }
        return parts.joined(separator: " · ")
    }
}

/// One application with its answers and history; staff accept or deny it here.
struct ApplicationSubmissionView: View {
    @State private var model: ApplicationSubmissionModel
    @State private var action: ApplicationDecisionAction = .accept
    @State private var isAsking = false
    @State private var isConfirmingDelete = false
    @State private var reason = ""
    @Environment(\.dismiss) private var dismiss
    private let server: ServerID
    private let session: AppSession
    private let applicant: String

    init(server: ServerID, session: AppSession, submissionID: Int, applicant: String) {
        self.server = server
        self.session = session
        self.applicant = applicant
        _model = State(initialValue: ApplicationSubmissionModel(
            server: server, submissionID: submissionID, session: session))
    }

    var body: some View {
        List {
            if let submission = model.submission {
                content(submission)
            }
        }
        .overlay {
            if model.submission == nil {
                if let message = model.errorMessage {
                    ContentUnavailableView {
                        Label("Couldn't Load Application", systemImage: "exclamationmark.triangle")
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
        .navigationTitle(applicant)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
        .alert(alertTitle, isPresented: $isAsking) {
            TextField("Reason (optional)", text: $reason)
            Button(alertButton) {
                let decision = action
                let text = reason
                Task { await model.decide(decision, reason: text) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The applicant is told by direct message. The reason is added to it.")
        }
        .confirmationDialog("Delete This Application?", isPresented: $isConfirmingDelete, titleVisibility: .visible) {
            Button("Delete Application", role: .destructive) {
                Task { await model.deleteSubmission() }
            }
        } message: {
            Text("The answers and the posts in the channels are deleted. This cannot be undone.")
        }
        .alert("Something Went Wrong", isPresented: isShowingActionError, presenting: model.actionError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .onChange(of: model.wasDeleted) {
            if model.wasDeleted { dismiss() }
        }
        .sensoryFeedback(.success, trigger: model.decisionCount)
    }

    @ViewBuilder
    private func content(_ submission: ApplicationSubmission) -> some View {
        Section {
            LabeledContent("Applicant", value: submission.applicantName)
            LabeledContent("Form", value: submission.formName)
            LabeledContent("Status") {
                Text(verbatim: submission.status.title)
                    .foregroundStyle(submission.status.color)
            }
            if let date = submission.createdDate {
                LabeledContent("Sent", value: DateText.dayAndTime(date))
            }
            LabeledContent("Filled in", value: submission.source == "web" ? String(localized: "On the web") : String(localized: "In a DM"))
            if let date = submission.decidedDate, submission.status != .pending {
                LabeledContent("Decided", value: DateText.dayAndTime(date))
            }
            if let by = submission.decidedByName {
                LabeledContent("Decided by", value: by)
            }
            if !submission.reason.isEmpty {
                LabeledContent("Reason", value: submission.reason)
            }
        }

        if !model.decisionNotes.isEmpty {
            Section("Heads up") {
                ForEach(model.decisionNotes, id: \.self) { note in
                    StatusMessage(note, kind: .notice)
                }
            }
        }

        if submission.status == .pending {
            Section {
                Button("Accept", systemImage: "checkmark.circle") { ask(.accept) }
                    .disabled(model.isDeciding)
                Button("Deny", systemImage: "xmark.circle", role: .destructive) { ask(.deny) }
                    .disabled(model.isDeciding)
            } footer: {
                Text("Sylo gives or takes the roles the form is set up for and tells the applicant by direct message.")
            }
        }

        if !submission.rolesPending.isEmpty {
            Section {
                ForEach(Array(submission.rolesPending.enumerated()), id: \.offset) { _, change in
                    Label(Self.title(of: change), systemImage: "person.crop.circle.badge.exclamationmark")
                }
                Button("Retry the Roles", systemImage: "arrow.clockwise") {
                    Task { await model.retryRoles() }
                }
                .disabled(model.isWorking)
            } header: {
                Text("Roles waiting")
            } footer: {
                Text("These role changes did not go through. Check that Sylo can manage the roles, then retry.")
            }
        }

        if !submission.dmNote.isEmpty {
            Section("Direct message") {
                StatusMessage(
                    "The applicant could not be told by direct message. They may have DMs turned off or have left the server.",
                    kind: .notice)
            }
        }

        Section {
            if submission.cleared {
                Text("The answers were removed at the member's request.").foregroundStyle(.secondary)
            } else if submission.answers.isEmpty {
                Text("No answers.").foregroundStyle(.secondary)
            }
            ForEach(submission.answers) { answer in
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: answer.label)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if answer.answer.isEmpty {
                        Text("No answer").foregroundStyle(.secondary)
                    } else {
                        Text(verbatim: answer.answer)
                            .textSelection(.enabled)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("Answers")
        }

        if !submission.history.isEmpty {
            Section("History") {
                ForEach(Array(submission.history.enumerated()), id: \.offset) { _, entry in
                    ListLine(title: Self.actionTitle(entry.action), details: Self.details(of: entry))
                }
            }
        }

        Section {
            NavigationLink {
                ApplicantHistoryView(
                    server: server, session: session, userID: submission.userId, name: submission.applicantName)
            } label: {
                Label("Everything From This Member", systemImage: "person.text.rectangle")
            }
            Button("Delete Application", systemImage: "trash", role: .destructive) {
                isConfirmingDelete = true
            }
            .disabled(model.isWorking || model.isDeciding)
        } footer: {
            Text("Deleting removes the answers and the posts. It cannot be undone.")
        }
    }

    private func ask(_ decision: ApplicationDecisionAction) {
        reason = ""
        action = decision
        isAsking = true
    }

    private var isShowingActionError: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
    }

    private var alertTitle: LocalizedStringKey {
        action == .deny ? "Deny This Application?" : "Accept This Application?"
    }

    private var alertButton: LocalizedStringKey {
        action == .deny ? "Deny" : "Accept"
    }

    private static func title(of change: ApplicationRoleChange) -> String {
        let role = change.roleName.map { "@" + $0 } ?? String(localized: "a role")
        return change.op == "remove" ? String(localized: "Remove \(role)") : String(localized: "Add \(role)")
    }

    private static func actionTitle(_ action: String) -> String {
        switch action {
        case "submitted": String(localized: "Submitted")
        case "accepted": String(localized: "Accepted")
        case "denied": String(localized: "Denied")
        case "withdrawn": String(localized: "Withdrawn")
        case "roles_failed": String(localized: "Some roles could not be changed")
        case "roles_skipped": String(localized: "Some roles were skipped")
        case "roles_retried": String(localized: "Roles tried again")
        default: action
        }
    }

    /// "3 min. ago · by Mod · with a reason".
    private static func details(of entry: ApplicationHistoryEntry) -> String {
        var parts: [String] = []
        if let date = entry.date { parts.append(DateText.relative(date)) }
        if let by = entry.byName { parts.append(String(localized: "by \(by)")) }
        if !entry.note.isEmpty { parts.append(entry.note) }
        return parts.joined(separator: " · ")
    }
}

extension ApplicationStatus {
    var title: String {
        switch self {
        case .pending: String(localized: "Pending")
        case .accepted: String(localized: "Accepted")
        case .denied: String(localized: "Denied")
        case .withdrawn: String(localized: "Withdrawn")
        case .other(let raw): raw
        }
    }

    /// Colour backs up the word, never replaces it.
    var color: Color {
        switch self {
        case .pending: .orange
        case .accepted: .green
        case .denied: .red
        case .withdrawn, .other: .secondary
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        if endpoint is Endpoints.ApplicationSubmissions {
            return ApplicationSubmissionList(submissions: [
                ApplicationSubmission(id: 12, formName: "Staff", userName: "Alex", createdAt: 1_794_000_000_000),
                ApplicationSubmission(id: 11, formName: "Staff", userName: "Sam", status: .denied),
            ])
        }
        return nil
    }
    NavigationStack {
        ApplicationSubmissionsView(server: "1", session: session)
    }
    .environment(session)
}
