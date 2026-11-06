import SwiftUI
import SyloKit

/// The moderation hub: warn a member, the cases, the bans and the channel locks, and the moderation
/// settings (auto-moderation, warning actions, logging, commands) one tap away. Mirrors
/// web-v2/src/pages/ModerationHub.jsx.
struct ModerationView: View {
    let server: ServerID

    /// `nonisolated` so SwiftUI can hash and compare it as a picker tag on any thread.
    nonisolated enum Listing: Hashable {
        case cases, bans, locks
    }

    @State private var model: RecordListModel<ModerationPage>
    @State private var tab = Listing.cases
    @State private var isWarning = false
    @State private var isClearing = false
    @State private var editing: ModerationCase?
    @State private var pendingDelete: ModerationCase?
    @State private var pendingUnban: UnbanTarget?
    @State private var pendingUnlock: ChannelLock?
    @State private var isConfirmingLock = false
    @State private var notice: String?

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: RecordListModel(moderation: server, session: session))
    }

    var body: some View {
        RecordScreen("Moderation", model: model) { page in
            Section {
                Button("Warn a Member", systemImage: "exclamationmark.bubble") { isWarning = true }
                Button("Clear a Member's Warnings", systemImage: "eraser", role: .destructive) { isClearing = true }
            } header: {
                Text("Members")
            } footer: {
                Text("A warning is saved as a case, sent to the member by DM and counted toward the warning actions.")
            }

            Section {
                Picker("Show", selection: $tab) {
                    Text("Cases").tag(Listing.cases)
                    Text("Bans").tag(Listing.bans)
                    Text("Lockdown").tag(Listing.locks)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
            }

            switch tab {
            case .cases: casesSections(page)
            case .bans: bansSections(page)
            case .locks: locksSections(page)
            }

            Section("Moderation settings") {
                NavigationLink(value: ModuleRoute(moduleID: "automod")) {
                    Label("Auto-moderation", systemImage: "line.3.horizontal.decrease.circle")
                }
                NavigationLink(value: ModuleRoute(moduleID: "moderation")) {
                    Label("Warning actions", systemImage: "hammer")
                }
                NavigationLink(value: ModuleRoute(moduleID: "logging")) {
                    Label("Server logging", systemImage: "doc.text")
                }
                NavigationLink(value: ModuleRoute(moduleID: "commands")) {
                    Label("Commands", systemImage: "command")
                }
            }
        }
        .sheet(isPresented: $isWarning) {
            MemberReasonEditor(
                title: "Warn a Member", reasonTitle: "Reason", reasonFooter: "Sent to the member. At most \(ModerationInput.maxWarnReason) characters.",
                reasonLimit: ModerationInput.maxWarnReason, requiresReason: true, saveTitle: "Warn",
                confirmation: nil,
                save: { member, reason in
                    guard let result = await model.warn(userId: member, reason: reason) else { return false }
                    notice = result.summary
                    return true
                }, failure: { model.takeActionError() })
        }
        .sheet(isPresented: $isClearing) {
            MemberReasonEditor(
                title: "Clear Warnings", reasonTitle: nil, reasonFooter: "",
                reasonLimit: 0, requiresReason: false, saveTitle: "Clear Warnings",
                confirmation: String(localized: "Every warning on record for this member is removed, so they count from zero again. This can't be undone."),
                save: { member, _ in
                    guard let removed = await model.clearWarnings(userId: member) else { return false }
                    notice = removed == 1 ? String(localized: "Removed 1 warning.") : String(localized: "Removed \(removed) warnings.")
                    return true
                }, failure: { model.takeActionError() })
        }
        .sheet(item: $editing) { item in
            CaseReasonEditor(item: item, model: model)
        }
        .confirmationDialog(
            "Delete this case?", isPresented: isConfirmingDelete, titleVisibility: .visible, presenting: pendingDelete
        ) { item in
            Button("Delete Case", role: .destructive) {
                Task { _ = await model.setDeleted(true, caseNumber: item.caseNumber) }
            }
        } message: { item in
            Text("Case #\(item.caseNumber) is hidden from the member's record. You can restore it afterwards.")
        }
        .confirmationDialog(
            "Unban this member?", isPresented: isConfirmingUnban, titleVisibility: .visible, presenting: pendingUnban
        ) { target in
            Button("Unban \(target.name)") {
                Task {
                    if await model.unban(userId: target.id) { notice = String(localized: "\(target.name) unbanned.") }
                }
            }
        } message: { target in
            Text("\(target.name) can join the server again. It is logged in the mod-log channel.")
        }
        .confirmationDialog(
            "Lock every text channel?", isPresented: $isConfirmingLock, titleVisibility: .visible
        ) {
            Button("Lock All Channels", role: .destructive) {
                Task {
                    if let count = await model.lockAll() { notice = lockedNotice(count) }
                }
            }
        } message: {
            Text("Members can't send messages in any text channel until you end the lockdown.")
        }
        .confirmationDialog(
            "Unlock this channel?", isPresented: isConfirmingUnlock, titleVisibility: .visible, presenting: pendingUnlock
        ) { lock in
            Button("Unlock Channel") {
                Task {
                    if await model.unlock(channelId: lock.channelId) { notice = String(localized: "Channel unlocked.") }
                }
            }
        } message: { lock in
            Text(verbatim: unlockMessage(lock))
        }
        .alert("Done", isPresented: isShowingNotice, presenting: notice) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
    }

    // MARK: Cases

    @ViewBuilder
    private func casesSections(_ page: ModerationPage) -> some View {
        Section {
            if page.cases.isEmpty {
                Text("No cases yet.").foregroundStyle(Color.syloMuted)
            }
            ForEach(page.cases) { item in
                CaseRow(item: item) { editing = item }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if item.isActive {
                            Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = item }
                        } else {
                            Button("Restore", systemImage: "arrow.uturn.backward") {
                                Task { _ = await model.setDeleted(false, caseNumber: item.caseNumber) }
                            }
                            .tint(Color.syloCyan)
                        }
                        Button("Edit Reason", systemImage: "pencil") { editing = item }
                            .tint(Color.syloWarn)
                    }
                    .contextMenu {
                        Button("Edit Reason", systemImage: "pencil") { editing = item }
                        if item.isActive {
                            Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = item }
                        } else {
                            Button("Restore", systemImage: "arrow.uturn.backward") {
                                Task { _ = await model.setDeleted(false, caseNumber: item.caseNumber) }
                            }
                        }
                    }
                    .accessibilityAction(named: Text("Edit Reason")) { editing = item }
                    .accessibilityAction(named: Text(item.isActive ? "Delete" : "Restore")) {
                        if item.isActive { pendingDelete = item } else {
                            Task { _ = await model.setDeleted(false, caseNumber: item.caseNumber) }
                        }
                    }
            }
        } header: {
            Text("Cases")
        } footer: {
            if page.caseTotal > page.cases.count {
                Text("Showing the newest \(DateText.count(page.cases.count)) of \(DateText.count(page.caseTotal)).")
            }
        }
    }

    // MARK: Bans

    @ViewBuilder
    private func bansSections(_ page: ModerationPage) -> some View {
        Section {
            if let problem = page.bansError {
                Label(problem, systemImage: "info.circle").font(.subheadline).foregroundStyle(Color.syloMuted)
            } else if page.bans.isEmpty {
                Text("Nobody is banned.").foregroundStyle(Color.syloMuted)
            }
            ForEach(page.bans) { ban in
                ListLine(title: ban.tag, details: [ban.id, ban.reason].filter { !$0.isEmpty && $0 != "—" }.joined(separator: " · "))
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Unban", systemImage: "person.badge.plus") { pendingUnban = UnbanTarget(id: ban.id, name: ban.tag) }
                            .tint(Color.syloCyan)
                    }
                    .contextMenu {
                        Button("Unban", systemImage: "person.badge.plus") { pendingUnban = UnbanTarget(id: ban.id, name: ban.tag) }
                    }
                    .accessibilityAction(named: Text("Unban")) { pendingUnban = UnbanTarget(id: ban.id, name: ban.tag) }
            }
        } header: {
            Text("Banned (\(DateText.count(page.bansTotal)))")
        } footer: {
            if page.bansTotal > page.bans.count {
                Text("Showing the first \(page.banLimit) bans.")
            }
        }

        Section {
            if page.tempBans.isEmpty {
                Text("No scheduled unbans.").foregroundStyle(Color.syloMuted)
            }
            ForEach(page.tempBans) { ban in
                ListLine(
                    title: ban.tag,
                    details: [String(localized: "unbanned in \(ban.remaining)"), ban.reason].filter { !$0.isEmpty }.joined(separator: " · "))
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Unban Now", systemImage: "person.badge.plus") { pendingUnban = UnbanTarget(id: ban.userId, name: ban.tag) }
                            .tint(Color.syloCyan)
                    }
                    .contextMenu {
                        Button("Unban Now", systemImage: "person.badge.plus") { pendingUnban = UnbanTarget(id: ban.userId, name: ban.tag) }
                    }
                    .accessibilityAction(named: Text("Unban Now")) { pendingUnban = UnbanTarget(id: ban.userId, name: ban.tag) }
            }
        } header: {
            Text("Temporary bans (\(page.tempBans.count))")
        }
    }

    // MARK: Locks

    @ViewBuilder
    private func locksSections(_ page: ModerationPage) -> some View {
        Section {
            Button("Lock All Channels", systemImage: "lock.fill", role: .destructive) { isConfirmingLock = true }
            Button("End Lockdown", systemImage: "lock.open") {
                Task {
                    if let count = await model.unlockAll() {
                        notice = count == 1 ? String(localized: "Unlocked 1 channel.") : String(localized: "Unlocked \(count) channels.")
                    }
                }
            }
            .disabled(!page.lockdownActive)
        } footer: {
            Text("A lockdown locks every text channel at once. End lockdown unlocks the channels it locked.")
        }

        Section {
            if page.channelLocks.isEmpty {
                Text("No channels are locked.").foregroundStyle(Color.syloMuted)
            }
            ForEach(page.channelLocks) { lock in
                ListLine(title: "#\(lock.name ?? String(localized: "deleted channel"))", details: lockDetails(lock))
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Unlock", systemImage: "lock.open") { pendingUnlock = lock }
                            .tint(Color.syloCyan)
                    }
                    .contextMenu {
                        Button("Unlock", systemImage: "lock.open") { pendingUnlock = lock }
                    }
                    .accessibilityAction(named: Text("Unlock")) { pendingUnlock = lock }
            }
        } header: {
            Text("Locked channels (\(page.channelLocks.count))")
        }
    }

    private func lockDetails(_ lock: ChannelLock) -> String {
        var parts = [lock.isLockdown ? String(localized: "part of a lockdown") : String(localized: "locked on its own")]
        if !lock.lockedBy.isEmpty { parts.append(String(localized: "by \(lock.lockedBy)")) }
        if let date = lock.at { parts.append(DateText.relative(date)) }
        return parts.joined(separator: " · ")
    }

    private func unlockMessage(_ lock: ChannelLock) -> String {
        let name = lock.name.map { "#\($0)" } ?? String(localized: "this channel")
        return String(localized: "Members can send messages in \(name) again.")
    }

    private func lockedNotice(_ count: Int) -> String {
        count == 1 ? String(localized: "Locked 1 channel.") : String(localized: "Locked \(count) channels.")
    }

    // MARK: Bindings

    private struct UnbanTarget {
        let id: String
        let name: String
    }

    private var isConfirmingDelete: Binding<Bool> {
        Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
    }

    private var isConfirmingUnban: Binding<Bool> {
        Binding(get: { pendingUnban != nil }, set: { if !$0 { pendingUnban = nil } })
    }

    private var isConfirmingUnlock: Binding<Bool> {
        Binding(get: { pendingUnlock != nil }, set: { if !$0 { pendingUnlock = nil } })
    }

    private var isShowingNotice: Binding<Bool> {
        Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })
    }
}

/// One case: the number, the member, what was done, and the reason. Opens the reason for editing.
private struct CaseRow: View {
    let item: ModerationCase
    let edit: () -> Void

    var body: some View {
        Button(action: edit) {
            VStack(alignment: .leading, spacing: SyloSpacing.xs) {
                HStack(alignment: .firstTextBaseline, spacing: SyloSpacing.s) {
                    Text(verbatim: "#\(item.caseNumber)")
                        .font(.syloNumber(.footnote, weight: .medium))
                        .foregroundStyle(Color.syloMuted)
                    Text(verbatim: item.user)
                        .font(.headline)
                        .foregroundStyle(Color.syloText)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: SyloSpacing.xs)
                    SyloPill(verbatim: item.action, tint: item.isActive ? .syloBrand : .syloMuted)
                    if !item.isActive {
                        SyloPill("Deleted", systemImage: "trash", tint: .syloMuted)
                    }
                }
                Text(verbatim: details)
                    .font(.footnote)
                    .foregroundStyle(Color.syloMuted)
                    .multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Edits the reason")
    }

    private var details: String {
        var parts = [item.reason.isEmpty ? String(localized: "No reason") : item.reason]
        if !item.detail.isEmpty { parts.append(item.detail) }
        if !item.moderator.isEmpty { parts.append(String(localized: "by \(item.moderator)")) }
        if let date = item.at { parts.append(DateText.relative(date)) }
        return parts.joined(separator: " · ")
    }
}

/// Edits a case's reason in a sheet.
private struct CaseReasonEditor: View {
    let item: ModerationCase
    let model: RecordListModel<ModerationPage>

    @State private var reason: String

    init(item: ModerationCase, model: RecordListModel<ModerationPage>) {
        self.item = item
        self.model = model
        _reason = State(initialValue: item.reason)
    }

    var body: some View {
        RecordEditor(
            title: "Case #\(item.caseNumber)",
            problem: reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? String(localized: "Enter a reason.") : nil,
            hasChanges: reason != item.reason,
            save: { await model.editReason(of: item.caseNumber, to: reason) },
            failure: { model.takeActionError() }
        ) {
            Section {
                LabeledContent("Member") { Text(verbatim: item.user) }
                LabeledContent("Action") { Text(verbatim: item.action) }
            }
            Section {
                TextField("Reason", text: $reason, axis: .vertical)
                    .lineLimit(2...8)
                    .onChange(of: reason) {
                        if reason.count > ModerationInput.maxCaseReason {
                            reason = String(reason.prefix(ModerationInput.maxCaseReason))
                        }
                    }
            } header: {
                Text("Reason")
            } footer: {
                Text("At most \(ModerationInput.maxCaseReason) characters.")
            }
        }
    }
}

/// A sheet that asks for a member (user id or mention) and, for a warning, a reason.
private struct MemberReasonEditor: View {
    let title: LocalizedStringKey
    let reasonTitle: LocalizedStringKey?
    let reasonFooter: String
    let reasonLimit: Int
    let requiresReason: Bool
    let saveTitle: LocalizedStringKey
    let confirmation: String?
    let save: (String, String) async -> Bool
    let failure: () -> String?

    @State private var member = ""
    @State private var reason = ""

    var body: some View {
        RecordEditor(
            title: title, problem: problem, hasChanges: !member.isEmpty || !reason.isEmpty,
            save: { await save(member, reason) }, failure: failure, saveTitle: saveTitle,
            confirmation: confirmation
        ) {
            Section {
                TextField("User ID or @mention", text: $member)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.body.monospaced())
            } header: {
                Text("Member")
            } footer: {
                Text("Paste the member's user ID or an @mention.")
            }
            if let reasonTitle {
                Section {
                    TextField(reasonTitle, text: $reason, axis: .vertical)
                        .lineLimit(2...6)
                        .onChange(of: reason) {
                            if reason.count > reasonLimit { reason = String(reason.prefix(reasonLimit)) }
                        }
                } footer: {
                    Text(verbatim: reasonFooter)
                }
            }
        }
    }

    private var problem: String? {
        if !ModerationInput.isUserReference(member) { return String(localized: "Enter a user ID or mention.") }
        if requiresReason, reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return String(localized: "Enter a reason.")
        }
        return nil
    }
}
