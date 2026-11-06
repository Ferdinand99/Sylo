import SwiftUI
import SyloKit

/// A ban appeal to push from the appeals list.
///
/// `nonisolated` so SwiftUI can hash and compare it as a navigation value on any thread; a
/// main-actor `Hashable` conformance (this app's default) would trap off the main thread.
nonisolated struct AppealRoute: Hashable {
    let id: Int
}

/// Ban appeals: the open ones first, then the decided ones. Mirrors web-v2/src/pages/AppealsReview.jsx.
struct AppealsView: View {
    let server: ServerID

    @Environment(AppSession.self) private var session
    @State private var model: RecordListModel<AppealsInboxPage>

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: RecordListModel(appeals: server, session: session))
    }

    var body: some View {
        RecordScreen("Appeals", model: model) { page in
            if !page.moduleEnabled || !page.configured {
                Section {
                    Label(setupNote(page), systemImage: "info.circle")
                        .font(.subheadline)
                        .foregroundStyle(Color.syloMuted)
                    NavigationLink(value: ModuleRoute(moduleID: "appeals")) {
                        Label("Appeal Settings", systemImage: "slider.horizontal.3")
                    }
                }
            }

            Section {
                if page.openAppeals.isEmpty {
                    Text("Nothing waiting for a decision.")
                        .foregroundStyle(Color.syloMuted)
                }
                ForEach(page.openAppeals) { appeal in
                    AppealRow(appeal: appeal)
                }
            } header: {
                Text("Open (\(page.openAppeals.count))")
            }

            if !page.decidedAppeals.isEmpty {
                Section("Decided") {
                    ForEach(page.decidedAppeals) { appeal in
                        AppealRow(appeal: appeal)
                    }
                }
            }
        }
        // A decision made on the detail screen reloads the list behind it.
        .onChange(of: session.modulesRevision) { Task { await model.load() } }
    }

    private func setupNote(_ page: AppealsInboxPage) -> String {
        var parts: [String] = []
        if !page.moduleEnabled { parts.append(String(localized: "The Appeals module is off.")) }
        if !page.configured { parts.append(String(localized: "No appeal questions are set up yet.")) }
        return parts.joined(separator: " ")
    }
}

/// One appeal in the list: who, the first answer's worth of context, and where it stands.
private struct AppealRow: View {
    let appeal: Appeal

    var body: some View {
        NavigationLink(value: AppealRoute(id: appeal.id)) {
            VStack(alignment: .leading, spacing: SyloSpacing.xs) {
                HStack(alignment: .firstTextBaseline, spacing: SyloSpacing.s) {
                    Text(verbatim: appeal.user)
                        .font(.headline)
                        .foregroundStyle(Color.syloText)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: SyloSpacing.xs)
                    AppealStatusPill(status: appeal.status)
                }
                Text(verbatim: details)
                    .font(.footnote)
                    .foregroundStyle(Color.syloMuted)
                    .multilineTextAlignment(.leading)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the appeal")
    }

    private var details: String {
        var parts: [String] = []
        if let date = appeal.submittedAt {
            parts.append(String(localized: "submitted \(DateText.relative(date))"))
        }
        if let reason = appeal.originalBanReason {
            parts.append(String(localized: "banned for: \(reason)"))
        }
        if appeal.status != .open, let by = appeal.decidedBy {
            parts.append(String(localized: "by \(by)"))
        }
        return parts.joined(separator: " · ")
    }
}

/// Open, Accepted or Denied: text and a symbol, never colour alone.
struct AppealStatusPill: View {
    let status: AppealStatus

    var body: some View {
        switch status {
        case .open: SyloPill("Open", systemImage: "clock", tint: .syloBrand)
        case .accepted: SyloPill("Accepted", systemImage: "checkmark", tint: .syloBrand)
        case .denied: SyloPill("Denied", systemImage: "xmark", tint: .syloMuted)
        case .other(let raw): SyloPill(verbatim: raw, tint: .syloMuted)
        }
    }
}

/// One appeal: who asked, the answers, the decision. For an open appeal, a note to the member and
/// Accept or Deny, each behind a confirmation.
struct AppealDetailView: View {
    let id: Int

    @State private var model: RecordListModel<AppealsInboxPage>
    @State private var reason = ""
    @State private var pending: AppealDecision?
    @State private var outcome: AppealDecisionResult?
    @FocusState private var isReasonFocused: Bool

    init(server: ServerID, id: Int, session: AppSession) {
        self.id = id
        _model = State(initialValue: RecordListModel(appeals: server, session: session))
    }

    var body: some View {
        Group {
            if let page = model.page {
                if let appeal = page.appeal(id: id) {
                    form(for: appeal)
                } else {
                    EmptyState(
                        "Appeal Not Found", systemImage: "questionmark.folder",
                        message: Text("This appeal is no longer in the list."))
                }
            } else if let message = model.errorMessage {
                EmptyState(
                    "Couldn't Load Appeal", systemImage: "exclamationmark.triangle", message: Text(message),
                    isError: true, actionTitle: "Try Again") {
                        Task { await model.load() }
                    }
            } else {
                SyloLoadingView()
            }
        }
        .background { SyloBackground() }
        .navigationTitle("Appeal")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Couldn't Complete", isPresented: isShowingActionError, presenting: model.actionError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .alert(outcomeTitle, isPresented: isShowingOutcome, presenting: outcome) { _ in
            Button("OK") {}
        } message: { outcome in
            Text(outcome.summary)
        }
        .sensoryFeedback(.success, trigger: model.changeCount)
        .task { if model.page == nil { await model.load() } }
    }

    private func form(for appeal: Appeal) -> some View {
        Form {
            Group {
                Section {
                    LabeledContent("Member") { Text(verbatim: appeal.user).textSelection(.enabled) }
                    if !appeal.userId.isEmpty, appeal.userId != appeal.user {
                        LabeledContent("User ID") {
                            Text(verbatim: appeal.userId)
                                .font(.footnote.monospaced())
                                .textSelection(.enabled)
                        }
                    }
                    LabeledContent("Status") { AppealStatusPill(status: appeal.status) }
                    if let date = appeal.submittedAt {
                        LabeledContent("Submitted") { Text(verbatim: DateText.dayAndTime(date)) }
                    }
                    LabeledContent("Banned for") {
                        Text(verbatim: appeal.originalBanReason ?? String(localized: "No reason recorded"))
                            .multilineTextAlignment(.trailing)
                    }
                }

                Section("Their answers") {
                    if appeal.answers.isEmpty {
                        Text("No answers were given.").foregroundStyle(Color.syloMuted)
                    }
                    ForEach(Array(appeal.answers.enumerated()), id: \.offset) { _, qa in
                        VStack(alignment: .leading, spacing: SyloSpacing.xs) {
                            Text(verbatim: qa.question)
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Color.syloMuted)
                            Text(verbatim: qa.answer.isEmpty ? "—" : qa.answer)
                                .textSelection(.enabled)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }

                if appeal.status == .open {
                    decisionSection(for: appeal)
                } else {
                    decidedSection(for: appeal)
                }
            }
            .syloSectionCards()
        }
        .syloFormStyle()
        .disabled(model.isWorking)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await model.load() }
        .confirmationDialog(dialogTitle, isPresented: isConfirming, titleVisibility: .visible, presenting: pending) { decision in
            if decision == .accept {
                Button("Accept and Unban") { run(decision, on: appeal) }
            } else {
                Button("Deny Appeal", role: .destructive) { run(decision, on: appeal) }
            }
        } message: { decision in
            Text(confirmation(for: decision, appeal: appeal))
        }
    }

    private func decisionSection(for appeal: Appeal) -> some View {
        Section {
            TextField(
                "Explain the decision. The member sees this.", text: $reason, axis: .vertical)
                .lineLimit(2...6)
                .focused($isReasonFocused)
                .onChange(of: reason) {
                    if reason.count > Endpoints.DecideAppeal.maxReasonLength {
                        reason = String(reason.prefix(Endpoints.DecideAppeal.maxReasonLength))
                    }
                }
            Button {
                isReasonFocused = false
                pending = .accept
            } label: {
                Label("Accept and Unban", systemImage: "checkmark.circle")
            }
            Button(role: .destructive) {
                isReasonFocused = false
                pending = .deny
            } label: {
                Label("Deny", systemImage: "xmark.circle")
            }
        } header: {
            Text("Decision")
        } footer: {
            Text("Your note is sent to the member by DM with the decision. Leave it empty to send \u{201C}No reason given\u{201D}.")
        }
    }

    @ViewBuilder
    private func decidedSection(for appeal: Appeal) -> some View {
        Section("Decision") {
            LabeledContent("Decided by") { Text(verbatim: appeal.decidedBy ?? String(localized: "a moderator")) }
            if let date = appeal.decidedAt {
                LabeledContent("Decided") { Text(verbatim: DateText.dayAndTime(date)) }
            }
            if let note = appeal.decisionReason, !note.isEmpty {
                VStack(alignment: .leading, spacing: SyloSpacing.xs) {
                    Text("Note to the member")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Color.syloMuted)
                    Text(verbatim: note).textSelection(.enabled)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func confirmation(for decision: AppealDecision, appeal: Appeal) -> String {
        switch decision {
        case .accept:
            String(localized: "\(appeal.user) is unbanned (when the module is set to) and gets your decision with a one-time invite to rejoin, by DM. This can't be undone.")
        case .deny:
            String(localized: "\(appeal.user) stays banned and gets your decision by DM. They can't appeal again until the cooldown has passed. This can't be undone.")
        }
    }

    private func run(_ decision: AppealDecision, on appeal: Appeal) {
        Task {
            if let result = await model.decide(appeal, decision, reason: reason) {
                outcome = result
                reason = ""
            }
        }
    }

    private var dialogTitle: LocalizedStringKey {
        pending == .accept ? "Accept this appeal?" : "Deny this appeal?"
    }

    private var outcomeTitle: LocalizedStringKey {
        outcome?.status == .accepted ? "Appeal Accepted" : "Appeal Denied"
    }

    private var isConfirming: Binding<Bool> {
        Binding(get: { pending != nil }, set: { if !$0 { pending = nil } })
    }

    private var isShowingOutcome: Binding<Bool> {
        Binding(get: { outcome != nil }, set: { if !$0 { outcome = nil } })
    }

    private var isShowingActionError: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
    }
}
