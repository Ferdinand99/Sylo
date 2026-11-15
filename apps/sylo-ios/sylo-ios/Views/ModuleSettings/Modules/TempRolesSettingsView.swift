import SwiftUI
import SyloKit

/// Temporary roles: the staff roles, DMs to the member and the default duration, then giving a role
/// for a time, and the list of active temporary roles (filter it, take one back early). Mirrors
/// web-v2/src/moduleForms/TempRoles.jsx.
struct TempRolesSettingsView: View {
    @State private var model: ModuleSettingsModel<TempRolesPage>
    @State private var note: ModulePlatformNoteModel
    @State private var tempRoles: TempRolesModel
    // The give form
    @State private var member: MemberChoice?
    @State private var roleID = ""
    /// What was typed for the duration; nil until then, so the form follows the default duration.
    @State private var typedDuration: String?
    @State private var reason = ""
    @State private var removing: TempRoleRow?
    private let server: ServerID
    private let session: AppSession

    init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: TempRolesPage.moduleID, session: session))
        _tempRoles = State(initialValue: TempRolesModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Temporary Roles", model: model, problem: model.draft?.durationProblem) { $settings, page in
            ModuleIntro("Give a member a role for a set time; Sylo takes it back by itself. Adding the same member and role again replaces the end time. Each removal is written to the mod log.")
            PlatformNoteSection(model: note)

            Section {
                MultiPicker(title: "Staff roles", selection: $settings.staffRoles, options: page.roles, prefix: "@")
            } footer: {
                Text("May use the commands without Manage Roles. They still cannot hand out a role above their own highest role.")
            }

            Section {
                Toggle("Send the member a DM", isOn: $settings.dmMember)
            } footer: {
                Text("When they get the role, when it is taken back early and when it ends. Members with DMs closed are skipped quietly.")
            }

            Section {
                LabeledContent("Default duration") {
                    LimitedTextField(title: "7d", text: $settings.defaultDuration,
                                     limit: TempRolesSettings.maxDurationLength)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            } footer: {
                if let problem = settings.durationProblem {
                    Text(verbatim: problem)
                        .foregroundStyle(.red)
                } else {
                    Text("What the form below starts with. Like 30m, 12h, 7d, 2w or 1d12h; from 1 minute to 365 days.")
                }
            }

            giveSection(page: page, defaultDuration: settings.defaultDuration)

            listSection(page: page)
        }
        .task { await note.load() }
        // The page was read again (pull to refresh): the list on screen starts from it again.
        .onChange(of: model.page?.list) { Task { await tempRoles.pageReloaded() } }
        // The filter is applied a moment after the person stops typing.
        .task(id: tempRoles.filter) {
            guard tempRoles.filter.isActive || tempRoles.list != nil else { return }
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            await tempRoles.applyFilter()
        }
        .confirmationDialog(
            removing.map { "Take \($0.role) back from \($0.member)?" } ?? "Take the role back?",
            isPresented: isConfirmingRemoval, titleVisibility: .visible, presenting: removing
        ) { row in
            Button("Take Back Now", role: .destructive) {
                Task { _ = await tempRoles.remove(row) }
            }
        } message: { _ in
            Text("Sylo removes the role now instead of at the end time.")
        }
        .alert("Couldn't Update", isPresented: isShowingError, presenting: tempRoles.errorMessage) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(trigger: tempRoles.lastGiven) { _, new in new == nil ? nil : .success }
    }

    // MARK: - Give a role

    private func giveSection(page: TempRolesPage, defaultDuration: String) -> some View {
        let duration = typedDuration ?? defaultDuration
        let problem = TempRolesModel.problem(member: member, roleID: roleID, duration: duration)
        let durationProblem = TempRolesSettings.durationProblem(duration)
        return Section {
            MemberPicker("Member", server: server, session: session, selection: $member)
            Picker("Role", selection: $roleID) {
                Text("Choose a role").tag("")
                ForEach(page.roles) { role in
                    Text(verbatim: "@\(role.name)").tag(role.id)
                }
            }
            LabeledContent("For how long") {
                TextField("7d", text: Binding(get: { duration }, set: { typedDuration = $0 }))
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            LimitedTextField(title: "Reason (optional, kept in the mod log)", text: $reason,
                             limit: MemberActionLimits.tempRoleReasonLength)
            Button("Give Role") { give(page: page, duration: duration) }
                .disabled(problem != nil || tempRoles.isWorking)
            if let given = tempRoles.lastGiven {
                StatusMessage(Self.givenText(given), kind: .notice)
            }
        } header: {
            Text("Give a temporary role")
        } footer: {
            if let durationProblem {
                Text(verbatim: durationProblem)
                    .foregroundStyle(.red)
            } else {
                Text("Adding the same member and role again replaces the end time.")
            }
        }
    }

    private func give(page: TempRolesPage, duration: String) {
        guard let member else { return }
        let roleName = page.roles.first { $0.id == roleID }?.name ?? ""
        let chosenRole = roleID
        let text = reason
        Task {
            if await tempRoles.give(member: member, roleID: chosenRole, roleName: roleName, duration: duration,
                                    reason: text) {
                self.member = nil
                reason = ""
            }
        }
    }

    /// "Alex has Trial until Nov 14, 3:00 PM (replaced the earlier time)."
    static func givenText(_ given: TempRolesModel.Given) -> String {
        let until = given.expires.formatted(date: .abbreviated, time: .shortened)
        let replaced = given.replaced ? " (replaced the earlier time)" : ""
        return "\(given.memberName) has \(given.roleName) until \(until)\(replaced)."
    }

    // MARK: - The list

    private func listSection(page: TempRolesPage) -> some View {
        let list = tempRoles.list ?? page.list
        return Section {
            TextField("Search member, role or reason", text: $tempRoles.filter.text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Picker("Role", selection: $tempRoles.filter.roleID) {
                Text("All roles").tag("")
                ForEach(page.roles) { role in
                    Text(verbatim: "@\(role.name)").tag(role.id)
                }
            }
            // What happened when a role was taken back (the record is gone, the role may not be).
            if let warning = tempRoles.removalWarning {
                StatusMessage(warning, kind: .notice)
            }
            if list.rows.isEmpty {
                Text("Nothing here.").foregroundStyle(.secondary)
            }
            ForEach(list.rows) { row in
                ListLine(title: "\(row.member) — \(row.role)", details: Self.details(of: row))
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Take Back") { removing = row }
                            .tint(.red)
                    }
                    .contextMenu {
                        Button("Take Back Now", systemImage: "arrow.uturn.backward", role: .destructive) {
                            removing = row
                        }
                    }
            }
        } header: {
            if list.matching == list.total {
                Text("Active temporary roles (\(list.total))")
            } else {
                Text("Active temporary roles (\(list.matching) of \(list.total))")
            }
        } footer: {
            if list.matching > list.rows.count {
                Text("Showing the first \(list.rows.count) of \(list.matching). Narrow the search to see the rest.")
            } else if !list.rows.isEmpty {
                Text("Swipe a row, or press and hold, to take the role back early.")
            }
        }
    }

    /// "Ends in 2 days · set by Alex · Trial period"; "Ending now" once the time has passed.
    static func details(of row: TempRoleRow) -> String {
        var parts = [row.endsText()]
        if let by = row.addedByName { parts.append("set by \(by)") }
        if !row.reason.isEmpty { parts.append(row.reason) }
        return parts.joined(separator: " · ")
    }

    private var isConfirmingRemoval: Binding<Bool> {
        Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { tempRoles.errorMessage != nil }, set: { if !$0 { tempRoles.errorMessage = nil } })
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        if endpoint is Endpoints.LoadPlatformInfo { return PlatformInfo(platform: .discord) }
        guard endpoint is Endpoints.LoadModuleSettings<TempRolesPage> else { return nil }
        return TempRolesPage(
            settings: TempRolesSettings(staffRoles: ["r1"], dmMember: true, defaultDuration: "7d"),
            roles: [RoleOption(id: "r1", name: "Moderators")],
            list: TempRoleList(total: 1, matching: 1, rows: [
                TempRoleRow(userId: "1", roleId: "r1", member: "Alex", role: "Trial",
                            expiresAt: Date().addingTimeInterval(86_400 * 2).timeIntervalSince1970 * 1000,
                            addedByName: "Sam", reason: "Trial period"),
            ]))
    }
    NavigationStack {
        TempRolesSettingsView(server: "1", session: session)
    }
    .environment(session)
}
