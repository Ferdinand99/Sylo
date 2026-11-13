import SwiftUI
import SyloKit

/// Infractions: cases, bans and the lockdown, with a way to warn a member or clear their warnings.
/// The same calls as the dashboard's Moderation page. Everything that changes something asks first,
/// and shows the server's own words when it refuses.
struct ModerationView: View {
    @State private var model: ModerationModel
    @State private var segment: Segment = .cases
    @State private var isWarning = false
    @State private var caseState = CaseActionState()
    @State private var banToLift: PendingUnban?
    @State private var lockToLift: ChannelLock?
    @State private var isConfirmingLockAll = false
    @State private var isConfirmingEndLockdown = false
    @State private var isVisible = false

    private let server: ServerID
    private let session: AppSession

    enum Segment: Hashable {
        case cases, bans, lockdown
    }

    init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
        _model = State(initialValue: ModerationModel(server: server, session: session))
    }

    var body: some View {
        List {
            if let message = model.errorMessage, model.hasLoaded {
                Section { StatusMessage(message, kind: .error) }
            }
            if let notice = model.notice {
                Section {
                    HStack(alignment: .top) {
                        StatusMessage(notice, kind: .notice)
                        Spacer(minLength: 8)
                        Button("Dismiss", systemImage: "xmark.circle.fill") { model.notice = nil }
                            .labelStyle(.iconOnly)
                            .buttonStyle(.borderless)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section {
                Button("Warn a Member", systemImage: "exclamationmark.bubble") { isWarning = true }
            } footer: {
                Text("A warning is saved as a case, sent to the member by DM, and counted toward the warning thresholds in the moderation settings.")
            }

            Section {
                Picker("Show", selection: $segment) {
                    Text("Cases").tag(Segment.cases)
                    Text("Bans").tag(Segment.bans)
                    Text("Lockdown").tag(Segment.lockdown)
                }
                .pickerStyle(.segmented)
            }

            if let overview = model.overview {
                switch segment {
                case .cases: casesSection(overview)
                case .bans: bansSections(overview)
                case .lockdown: lockdownSections(overview)
                }
            }
        }
        .tabBarClearance()
        .overlay {
            if !model.hasLoaded {
                if let message = model.errorMessage {
                    ContentUnavailableView {
                        Label("Couldn't Load Moderation", systemImage: "exclamationmark.triangle")
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
        .moderationActions($caseState, model: model, isAlertSuppressed: !isVisible || isWarning)
        .sheet(isPresented: $isWarning) {
            WarnSheet(model: model, server: server, session: session)
        }
        .confirmationDialog(
            "Unban \(banToLift?.name ?? "")?", isPresented: isLiftingBan, titleVisibility: .visible,
            presenting: banToLift
        ) { ban in
            Button("Unban") { Task { await model.unban(userId: ban.userId, name: ban.name) } }
        } message: { _ in
            Text("They can join the server again. Sylo does not tell them.")
        }
        .confirmationDialog(
            "Lock every text channel?", isPresented: $isConfirmingLockAll, titleVisibility: .visible
        ) {
            Button("Lock All Channels", role: .destructive) { Task { await model.lockAllChannels() } }
        } message: {
            Text("Members can't send messages in any text channel until you end the lockdown.")
        }
        .confirmationDialog(
            "End the lockdown?", isPresented: $isConfirmingEndLockdown, titleVisibility: .visible
        ) {
            Button("End Lockdown") { Task { await model.endLockdown() } }
        } message: {
            Text("Every channel locked by the lockdown opens again.")
        }
        .confirmationDialog(
            "Unlock #\(lockToLift?.name ?? String(localized: "deleted channel"))?", isPresented: isLiftingLock,
            titleVisibility: .visible, presenting: lockToLift
        ) { lock in
            Button("Unlock") { Task { await model.unlockChannel(lock) } }
        } message: { _ in
            Text("Members can send messages in it again.")
        }
        .sensoryFeedback(.success, trigger: model.actionCount)
    }

    // MARK: Cases

    @ViewBuilder
    private func casesSection(_ overview: ModerationOverview) -> some View {
        Section {
            ForEach(overview.cases) { moderationCase in
                NavigationLink {
                    CaseDetailView(model: model, caseNumber: moderationCase.caseNumber)
                } label: {
                    CaseRow(moderationCase: moderationCase)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(moderationCase.active ? "Delete" : "Restore",
                           systemImage: moderationCase.active ? "trash" : "arrow.uturn.backward") {
                        caseState.toggling = moderationCase
                    }
                    .tint(moderationCase.active ? .red : .green)
                    Button("Edit Reason", systemImage: "pencil") { caseState.editing = moderationCase }
                        .tint(.blue)
                }
            }
        } header: {
            if !overview.cases.isEmpty {
                Text("Newest \(DateText.count(overview.cases.count)) of \(DateText.count(overview.caseTotal))")
            }
        } footer: {
            if overview.cases.isEmpty { Text("No cases yet.") }
        }
    }

    // MARK: Bans

    @ViewBuilder
    private func bansSections(_ overview: ModerationOverview) -> some View {
        if let message = overview.bansError {
            Section { StatusMessage(message, kind: .notice) }
        }
        Section {
            ForEach(overview.bans) { ban in
                BanRow(name: ban.name, id: ban.id, detail: ban.reason)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Unban", systemImage: "person.badge.plus") {
                            banToLift = PendingUnban(userId: ban.id, name: ban.name)
                        }
                        .tint(.green)
                    }
            }
        } header: {
            Text("Banned (\(DateText.count(overview.bansTotal)))")
        } footer: {
            if overview.bans.isEmpty, overview.bansError == nil {
                Text("Nobody is banned.")
            } else if overview.bansTotal > overview.bans.count {
                Text("Showing the first \(DateText.count(overview.banLimit)) bans.")
            }
        }
        Section {
            ForEach(overview.tempBans) { ban in
                BanRow(name: ban.name, id: ban.userId,
                       detail: [String(localized: "unbanned in \(ban.remaining)"), ban.reason]
                           .filter { !$0.isEmpty }.joined(separator: " \u{00B7} "))
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Unban Now", systemImage: "person.badge.plus") {
                            banToLift = PendingUnban(userId: ban.userId, name: ban.name)
                        }
                        .tint(.green)
                    }
            }
        } header: {
            Text("Temporary bans (\(overview.tempBans.count))")
        } footer: {
            if overview.tempBans.isEmpty { Text("No scheduled unbans.") }
        }
    }

    // MARK: Lockdown

    @ViewBuilder
    private func lockdownSections(_ overview: ModerationOverview) -> some View {
        Section {
            Label(
                overview.lockdownActive ? "Lockdown active" : "No lockdown",
                systemImage: overview.lockdownActive ? "lock.fill" : "lock.open")
                .foregroundStyle(overview.lockdownActive ? Color.orange : Color.secondary)
            Button("Lock All Channels", systemImage: "lock", role: .destructive) { isConfirmingLockAll = true }
                .disabled(model.isWorking)
            Button("End Lockdown", systemImage: "lock.open") { isConfirmingEndLockdown = true }
                .disabled(model.isWorking || !overview.lockdownActive)
        } footer: {
            Text("A lockdown stops members from sending messages in every text channel. Channels that were already locked on their own stay as they are.")
        }
        Section {
            ForEach(overview.channelLocks) { lock in
                LockRow(lock: lock)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Unlock", systemImage: "lock.open") { lockToLift = lock }
                            .tint(.green)
                    }
            }
        } header: {
            Text("Locked channels (\(overview.channelLocks.count))")
        } footer: {
            if overview.channelLocks.isEmpty { Text("No channels are locked.") }
        }
    }

    private var isLiftingBan: Binding<Bool> {
        Binding(get: { banToLift != nil }, set: { if !$0 { banToLift = nil } })
    }

    private var isLiftingLock: Binding<Bool> {
        Binding(get: { lockToLift != nil }, set: { if !$0 { lockToLift = nil } })
    }
}

/// A ban waiting for the person to confirm lifting it.
private struct PendingUnban: Hashable {
    let userId: String
    let name: String
}

// MARK: Rows

/// One case: number, member, what was done, the reason, who and when.
struct CaseRow: View {
    let moderationCase: ModerationCase

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: "#\(moderationCase.caseNumber)")
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.secondary)
                Text(verbatim: moderationCase.memberName)
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(verbatim: moderationCase.actionTitle)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(moderationCase.actionColor)
            }
            Text(verbatim: moderationCase.reason.isEmpty ? String(localized: "No reason") : moderationCase.reason)
                .font(.subheadline)
                .lineLimit(2)
            Text(verbatim: moderationCase.summaryLine)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .opacity(moderationCase.active ? 1 : 0.55)
        .accessibilityElement(children: .combine)
    }
}

private struct BanRow: View {
    let name: String
    let id: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: name).font(.headline).lineLimit(1)
            Text(verbatim: [id, detail].filter { !$0.isEmpty }.joined(separator: " \u{00B7} "))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct LockRow: View {
    let lock: ChannelLock

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: "#\(lock.name ?? String(localized: "deleted channel"))").font(.headline)
            Text(verbatim: details)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private var details: String {
        var parts = [lock.lockdown ? String(localized: "part of a lockdown") : String(localized: "locked on its own")]
        if !lock.lockedBy.isEmpty { parts.append(String(localized: "by \(lock.lockedBy)")) }
        if let date = lock.date { parts.append(DateText.relative(date)) }
        return parts.joined(separator: " \u{00B7} ")
    }
}

extension ModerationCase {
    /// The action as a word to read ("Warn", "Ban").
    var actionTitle: String { action.isEmpty ? String(localized: "Case") : action.capitalized }

    /// Colour backs up the word, never replaces it.
    var actionColor: Color {
        switch action.lowercased() {
        case "ban", "tempban", "kick": .red
        case "warn", "mute", "timeout": .orange
        default: .secondary
        }
    }

    /// "by Mod · 3 min. ago", with the detail (a duration, say) first when there is one.
    var summaryLine: String {
        var parts: [String] = []
        if !detail.isEmpty { parts.append(detail) }
        if !moderator.isEmpty { parts.append(String(localized: "by \(moderator)")) }
        if let date { parts.append(DateText.relative(date)) }
        return parts.joined(separator: " \u{00B7} ")
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModeration else { return nil }
        return ModerationOverview(
            cases: [
                ModerationCase(caseNumber: 12, action: "warn", user: "Alex", moderator: "Mod", reason: "Spam in #general",
                               at: 1_794_000_000_000),
                ModerationCase(caseNumber: 11, action: "ban", active: false, user: "Sam", reason: "Raid"),
            ],
            bans: [ModerationBan(id: "222222222222222222", tag: "troll", reason: "Raid")])
    }
    NavigationStack {
        ModerationView(server: "1", session: session)
    }
    .environment(session)
}
