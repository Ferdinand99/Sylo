import SwiftUI
import SyloKit

/// Temporary roles: the staff roles, DMs to the member and the default duration, with the active
/// temporary roles listed read only. Giving and removing one stays in the web dashboard. Mirrors
/// web-v2/src/moduleForms/TempRoles.jsx.
struct TempRolesSettingsView: View {
    @State private var model: ModuleSettingsModel<TempRolesPage>
    @State private var note: ModulePlatformNoteModel
    private let server: ServerID

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: TempRolesPage.moduleID, session: session))
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
                    TextField("7d", text: $settings.defaultDuration)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: settings.defaultDuration) {
                            if settings.defaultDuration.count > TempRolesSettings.maxDurationLength {
                                settings.defaultDuration = String(settings.defaultDuration.prefix(TempRolesSettings.maxDurationLength))
                            }
                        }
                }
            } footer: {
                if let problem = settings.durationProblem {
                    Text(verbatim: problem)
                        .foregroundStyle(.red)
                } else {
                    Text("What the Add form in the web dashboard starts with. Like 30m, 12h, 7d, 2w or 1d12h; from 1 minute to 365 days.")
                }
            }

            Section {
                if page.list.rows.isEmpty {
                    Text("Nothing here.").foregroundStyle(.secondary)
                }
                ForEach(page.list.rows) { row in
                    ListLine(title: "\(row.member) — \(row.role)", details: Self.details(of: row))
                }
            } header: {
                Text("Active temporary roles (\(page.list.total))")
            } footer: {
                if page.list.matching > page.list.rows.count {
                    Text("Showing the first \(page.list.rows.count) of \(page.list.matching).")
                }
            }

            DashboardLinkSection(
                server: server, module: TempRolesPage.moduleID,
                footer: "Give a temporary role or take one back early in the web dashboard.")
        }
        .task { await note.load() }
    }

    /// "Ends in 2 days · set by Alex · Trial period".
    static func details(of row: TempRoleRow) -> String {
        var parts = ["Ends " + DateText.relative(row.expiresDate)]
        if let by = row.addedByName { parts.append("set by \(by)") }
        if !row.reason.isEmpty { parts.append(row.reason) }
        return parts.joined(separator: " · ")
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
