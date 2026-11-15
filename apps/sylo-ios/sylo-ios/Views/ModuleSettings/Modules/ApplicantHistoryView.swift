import SwiftUI
import SyloKit

/// Everything one member has sent in, newest first. A row opens that application with its answers.
struct ApplicantHistoryView: View {
    @State private var model: ApplicantHistoryModel
    private let server: ServerID
    private let session: AppSession
    private let name: String

    init(server: ServerID, session: AppSession, userID: String, name: String) {
        self.server = server
        self.session = session
        self.name = name
        _model = State(initialValue: ApplicantHistoryModel(server: server, userID: userID, session: session))
    }

    var body: some View {
        List {
            if let message = model.errorMessage, model.history != nil {
                Section { StatusMessage(message, kind: .error) }
            }
            if let history = model.history {
                Section {
                    ForEach(history.submissions) { submission in
                        NavigationLink {
                            ApplicationSubmissionView(
                                server: server, session: session, submissionID: submission.id,
                                applicant: submission.applicantName)
                        } label: {
                            ApplicationSubmissionRow(submission: submission, showsApplicant: false)
                        }
                    }
                } header: {
                    Text(history.submissions.count == 1 ? "1 application" : "\(history.submissions.count) applications")
                } footer: {
                    if history.submissions.isEmpty {
                        Text("This member has not sent in an application.")
                    }
                }
            }
        }
        .overlay {
            if model.history == nil {
                if let message = model.errorMessage {
                    ContentUnavailableView {
                        Label("Couldn't Load History", systemImage: "exclamationmark.triangle")
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
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.ApplicantHistoryOf else { return nil }
        return ApplicantHistory(
            userId: "810000000000000001", userName: "Alex",
            submissions: [
                ApplicationSubmission(id: 12, formName: "Staff", userName: "Alex", createdAt: 1_794_000_000_000),
                ApplicationSubmission(id: 7, formName: "Builder", userName: "Alex", status: .denied),
            ])
    }
    NavigationStack {
        ApplicantHistoryView(server: "1", session: session, userID: "810000000000000001", name: "Alex")
    }
    .environment(session)
}
