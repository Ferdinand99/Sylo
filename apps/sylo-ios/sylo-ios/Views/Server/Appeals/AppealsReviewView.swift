import SwiftUI
import SyloKit

/// The ban appeals inbox: open appeals first, then the ones already decided. A row opens the
/// appeal with the member's answers, where staff accept (which unbans) or deny with a note the
/// member sees. Mirrors the dashboard's Appeals page.
struct AppealsReviewView: View {
    @State private var model: AppealsReviewModel
    @State private var isVisible = false

    private let server: ServerID
    private let session: AppSession
    /// Embedded in a tab: leaves the title to the tab and clears the floating tab bar.
    private let isEmbedded: Bool

    init(
        server: ServerID, session: AppSession, isEmbedded: Bool = false,
        onOpenCount: (@MainActor (Int) -> Void)? = nil
    ) {
        self.server = server
        self.session = session
        self.isEmbedded = isEmbedded
        let model = AppealsReviewModel(server: server, session: session)
        model.onOpenCount = onOpenCount
        _model = State(initialValue: model)
    }

    var body: some View {
        List {
            if let message = model.errorMessage, model.hasLoaded {
                Section { StatusMessage(message, kind: .error) }
            }
            if let review = model.review {
                if !review.moduleEnabled || !review.configured {
                    Section {
                        if !review.moduleEnabled {
                            StatusMessage("The Ban Appeals module is off.", kind: .notice)
                        }
                        if !review.configured {
                            StatusMessage("No appeal questions are set up yet, so members can't appeal.", kind: .notice)
                        }
                    }
                }
                Section {
                    NavigationLink {
                        AppealsSettingsView(server: server, session: session)
                    } label: {
                        Label("Appeal Settings", systemImage: "slider.horizontal.3")
                    }
                }
                openSection
                decidedSection
            }
        }
        .modifier(EmbeddedClearance(isEmbedded: isEmbedded))
        .overlay {
            if !model.hasLoaded {
                if let message = model.errorMessage {
                    ContentUnavailableView {
                        Label("Couldn't Load Appeals", systemImage: "exclamationmark.triangle")
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
        .task { await model.load() }
        .refreshable { await model.load() }
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false }
        .alert("Couldn't Decide", isPresented: isShowingError(visible: isVisible), presenting: model.actionError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
    }

    @ViewBuilder
    private var openSection: some View {
        Section {
            ForEach(model.open) { appeal in
                NavigationLink {
                    AppealView(model: model, appealID: appeal.id)
                } label: {
                    AppealRow(appeal: appeal)
                }
            }
        } header: {
            Text("Open (\(model.open.count))")
        } footer: {
            if model.open.isEmpty { Text("Nothing waiting for a decision.") }
        }
    }

    @ViewBuilder
    private var decidedSection: some View {
        if !model.decided.isEmpty {
            Section("Decided") {
                ForEach(model.decided) { appeal in
                    NavigationLink {
                        AppealView(model: model, appealID: appeal.id)
                    } label: {
                        AppealRow(appeal: appeal)
                    }
                }
            }
        }
    }

    private func isShowingError(visible: Bool) -> Binding<Bool> {
        Binding(get: { model.actionError != nil && visible }, set: { if !$0 { model.actionError = nil } })
    }
}

/// The tab's list needs room under it; a pushed screen does not.
private struct EmbeddedClearance: ViewModifier {
    let isEmbedded: Bool

    func body(content: Content) -> some View {
        if isEmbedded {
            content.tabBarClearance()
        } else {
            content.navigationTitle("Appeals").navigationBarTitleDisplayMode(.inline)
        }
    }
}

/// One appeal: who, how it stands, the ban reason and when it came in.
private struct AppealRow: View {
    let appeal: Appeal

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: appeal.memberName)
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(verbatim: appeal.status.title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(appeal.status.color)
            }
            Text(verbatim: details)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .accessibilityElement(children: .combine)
    }

    private var details: String {
        var parts: [String] = []
        if let date = appeal.date { parts.append(String(localized: "sent \(DateText.relative(date))")) }
        parts.append(
            appeal.banReason.isEmpty
                ? String(localized: "no ban reason recorded")
                : String(localized: "ban reason: \(appeal.banReason)"))
        return parts.joined(separator: " \u{00B7} ")
    }
}

/// One appeal with the member's answers. An open one is accepted or denied here.
struct AppealView: View {
    let model: AppealsReviewModel
    let appealID: Int

    @State private var decision: AppealDecision = .accept
    @State private var isAsking = false
    @State private var isVisible = false

    var body: some View {
        List {
            if let appeal = model.review?.appeals.first(where: { $0.id == appealID }) {
                content(appeal)
            }
        }
        .overlay {
            if model.review?.appeals.contains(where: { $0.id == appealID }) != true {
                ContentUnavailableView(
                    "Appeal Not Found", systemImage: "tray",
                    description: Text("This appeal is no longer in the list."))
            }
        }
        .navigationTitle(model.review?.appeals.first { $0.id == appealID }?.memberName ?? String(localized: "Appeal"))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load() }
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false }
        .reasonPrompt(
            decision == .accept ? "Accept and Unban?" : "Deny This Appeal?",
            message: decision == .accept
                ? "The member is unbanned and told by direct message. Your note is added to it."
                : "The member is told by direct message. Your note is added to it.",
            isPresented: $isAsking,
            confirmTitle: decision == .accept ? "Accept and Unban" : "Deny",
            confirmRole: decision == .deny ? .destructive : nil,
            reasonLabel: "Note to the member (optional)"
        ) { reason in
            guard let appeal = model.review?.appeals.first(where: { $0.id == appealID }) else { return }
            let chosen = decision
            Task { await model.decide(appeal, chosen, reason: reason) }
        }
        .alert("Couldn't Decide", isPresented: isShowingError, presenting: model.actionError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: model.decisionCount)
    }

    @ViewBuilder
    private func content(_ appeal: Appeal) -> some View {
        Section {
            LabeledContent("Member", value: appeal.memberName)
            LabeledContent("Status") {
                Text(verbatim: appeal.status.title).foregroundStyle(appeal.status.color)
            }
            if let date = appeal.date {
                LabeledContent("Sent", value: DateText.dayAndTime(date))
            }
            LabeledContent("Ban reason", value: appeal.banReason.isEmpty ? String(localized: "None recorded") : appeal.banReason)
            if !appeal.isOpen {
                LabeledContent("Decided by", value: appeal.decidedBy ?? String(localized: "A moderator"))
                if let date = appeal.decidedDate {
                    LabeledContent("Decided", value: DateText.dayAndTime(date))
                }
            }
        }

        if let summary = model.decisionSummary, model.decisionAppealID == appeal.id, !appeal.isOpen {
            Section("Your decision") {
                StatusMessage(summary, kind: .notice)
                ForEach(model.decisionNotes, id: \.self) { note in
                    StatusMessage(note, kind: .notice)
                }
            }
        }

        Section("Answers") {
            if appeal.answers.isEmpty {
                Text("No answers.").foregroundStyle(.secondary)
            }
            ForEach(Array(appeal.answers.enumerated()), id: \.offset) { _, answer in
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: answer.question)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if answer.answer.isEmpty {
                        Text("No answer").foregroundStyle(.secondary)
                    } else {
                        Text(verbatim: answer.answer).textSelection(.enabled)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }

        if appeal.isOpen {
            Section {
                Button("Accept and Unban", systemImage: "checkmark.circle") { ask(.accept) }
                    .disabled(model.isDeciding)
                Button("Deny", systemImage: "xmark.circle", role: .destructive) { ask(.deny) }
                    .disabled(model.isDeciding)
            } footer: {
                Text("The member is told by direct message, with your note if you add one.")
            }
        } else if !appeal.decisionReason.isEmpty {
            Section("Note to the member") {
                Text(verbatim: appeal.decisionReason).textSelection(.enabled)
            }
        }
    }

    private func ask(_ chosen: AppealDecision) {
        decision = chosen
        isAsking = true
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { model.actionError != nil && isVisible }, set: { if !$0 { model.actionError = nil } })
    }
}

extension AppealStatus {
    var title: String {
        switch self {
        case .open: String(localized: "Open")
        case .accepted: String(localized: "Accepted")
        case .denied: String(localized: "Denied")
        case .other(let raw): raw
        }
    }

    /// Colour backs up the word, never replaces it.
    var color: Color {
        switch self {
        case .open: .orange
        case .accepted: .green
        case .denied: .red
        case .other: .secondary
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadAppeals else { return nil }
        return AppealsReview(appeals: [
            Appeal(id: 3, user: "Alex", banReason: "Spam", answers: [AppealAnswer(question: "Why should we unban you?", answer: "It was a mistake.")],
                   at: 1_794_000_000_000),
            Appeal(id: 2, user: "Sam", status: .denied, decidedBy: "Mod", decisionReason: "Not this time"),
        ])
    }
    NavigationStack {
        AppealsReviewView(server: "1", session: session)
    }
    .environment(session)
}
