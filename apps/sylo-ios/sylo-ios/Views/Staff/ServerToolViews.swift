import SwiftUI
import SyloKit
import UIKit

// The server tools of the web dashboard that sit beside the modules: command limits, the audit log,
// member data and the leaderboard.

// MARK: - Commands

/// Per command: switch it off for this server, or limit it to channels and roles. Mirrors
/// web-v2/src/pages/Commands.jsx.
struct CommandsView: View {
    let server: ServerID

    @State private var model: RecordListModel<CommandsPage>
    @State private var query = ""
    @State private var editing: CommandLimit?

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: RecordListModel(commands: server, session: session))
    }

    var body: some View {
        RecordScreen("Commands", model: model) { page in
            ModuleIntro("Turn a command off for this server, or limit it to certain channels and roles. Members who are not allowed get no response.")

            Section {
                let shown = page.commands(matching: query)
                if shown.isEmpty {
                    Text(query.isEmpty ? "This server has no commands to manage." : "No commands match your search.")
                        .foregroundStyle(Color.syloMuted)
                }
                ForEach(shown) { command in
                    CommandRow(
                        command: command, page: page,
                        setEnabled: { enabled in
                            var changed = command
                            changed.isEnabled = enabled
                            Task { _ = await model.save(changed) }
                        },
                        edit: { editing = command })
                }
            } header: {
                Text("Commands (\(page.commands.count))")
            }
        }
        .searchable(text: $query, prompt: "Search commands")
        .sheet(item: $editing) { command in
            if let page = model.page {
                CommandLimitsEditor(command: command, page: page, model: model)
            }
        }
    }
}

private struct CommandRow: View {
    let command: CommandLimit
    let page: CommandsPage
    let setEnabled: (Bool) -> Void
    let edit: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: SyloSpacing.m) {
            Button(action: edit) {
                VStack(alignment: .leading, spacing: SyloSpacing.xs) {
                    Text(verbatim: "/\(command.name)")
                        .font(.syloNumber(.body, weight: .semibold))
                        .foregroundStyle(Color.syloText)
                    if !command.description.isEmpty {
                        Text(verbatim: command.description)
                            .font(.footnote)
                            .foregroundStyle(Color.syloMuted)
                            .multilineTextAlignment(.leading)
                    }
                    Text(verbatim: limitSummary)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(command.isLimited ? Color.syloBrand : Color.syloMuted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Edits the limits")

            // The LED switch draws its label, so the name is an accessibility label only.
            Toggle(isOn: Binding(get: { command.isEnabled }, set: setEnabled)) {
                EmptyView()
            }
            .accessibilityLabel(Text(verbatim: command.name))
        }
        .accessibilityElement(children: .contain)
    }

    private var limitSummary: String {
        if !command.isEnabled { return String(localized: "Turned off") }
        var parts: [String] = []
        if !command.allowedChannels.isEmpty {
            parts.append(command.allowedChannels.count == 1 ? String(localized: "1 channel") : String(localized: "\(command.allowedChannels.count) channels"))
        }
        if !command.allowedRoles.isEmpty {
            parts.append(command.allowedRoles.count == 1 ? String(localized: "1 role") : String(localized: "\(command.allowedRoles.count) roles"))
        }
        return parts.isEmpty ? String(localized: "No limits") : String(localized: "Limited to ") + parts.joined(separator: ", ")
    }
}

private struct CommandLimitsEditor: View {
    @State var command: CommandLimit
    let page: CommandsPage
    let model: RecordListModel<CommandsPage>

    @State private var initial: CommandLimit?

    var body: some View {
        RecordEditor(
            title: "/\(command.name)", problem: nil, hasChanges: initial.map { $0 != command } ?? false,
            save: { await model.save(command) }, failure: { model.takeActionError() }
        ) {
            Section {
                Toggle("Allowed on this server", isOn: $command.isEnabled)
            } footer: {
                if !command.description.isEmpty { Text(verbatim: command.description) }
            }
            Section {
                MultiPicker(title: "Only in these channels", selection: $command.allowedChannels, options: page.channels, prefix: "#")
                MultiPicker(title: "Only for these roles", selection: $command.allowedRoles, options: page.roles, prefix: "@")
            } footer: {
                Text("Leave a list empty to allow every channel, or everyone.")
            }
        }
        .onAppear { if initial == nil { initial = command } }
    }
}

// MARK: - Audit log

/// The configuration change history. Mirrors web-v2/src/pages/AuditLog.jsx.
struct AuditLogView: View {
    let server: ServerID

    @Environment(AppSession.self) private var session
    @State private var model: RecordListModel<AuditPage>
    @State private var moduleNames: [String: String] = [:]

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: RecordListModel(audit: server, session: session))
    }

    var body: some View {
        RecordScreen("Audit Log", model: model) { page in
            ModuleIntro("Configuration changes made from the dashboard and the app. Keeps the most recent \(DateText.count(page.kept)) per server.")
            Section {
                if page.entries.isEmpty {
                    Text("Nothing recorded yet.").foregroundStyle(Color.syloMuted)
                }
                ForEach(page.entries) { entry in
                    VStack(alignment: .leading, spacing: SyloSpacing.xs) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(verbatim: entry.label(moduleNames: moduleNames))
                                .font(.headline)
                            Spacer(minLength: SyloSpacing.xs)
                            if let date = entry.at {
                                Text(verbatim: DateText.relative(date))
                                    .font(.footnote)
                                    .foregroundStyle(Color.syloMuted)
                            }
                        }
                        Text(verbatim: entry.detail.isEmpty ? entry.actor : "\(entry.actor) — \(entry.detail)")
                            .font(.footnote)
                            .foregroundStyle(Color.syloMuted)
                    }
                    .accessibilityElement(children: .combine)
                }
            } header: {
                Text("Newest first")
            }
        }
        .task {
            // The modules' names, so "module:starboard" reads as "Starboard".
            if let overview = try? await session.send(Endpoints.Overview(server: server)) {
                moduleNames = Dictionary(
                    overview.groups.flatMap(\.cards).map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
            }
        }
    }
}

// MARK: - Member data

/// Look up what Sylo stores about a member and delete it on request. Mirrors
/// web-v2/src/pages/MemberData.jsx.
struct MemberDataView: View {
    @State private var model: MemberDataModel
    @State private var reference = ""
    @State private var isDeleting = false
    @FocusState private var isFocused: Bool

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: MemberDataModel(server: server, session: session))
    }

    var body: some View {
        Form {
            Group {
                ModuleIntro("Look up what Sylo has stored about a member in this server and delete it on request, for example a data erasure request. Deletion is permanent, and Sylo DMs the member a confirmation of exactly what was removed.")

                Section {
                    TextField("User ID or @mention", text: $reference)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                        .submitLabel(.search)
                        .focused($isFocused)
                        .onSubmit { look() }
                    Button("Look Up", systemImage: "magnifyingglass") { look() }
                        .disabled(reference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isWorking)
                } header: {
                    Text("Member")
                } footer: {
                    Text("Paste the member's user ID or an @mention.")
                }

                if let message = model.errorMessage {
                    Section { StatusMessage(message, kind: .error) }
                }

                if let lookup = model.lookup {
                    resultSections(lookup)
                }
            }
            .syloSectionCards()
        }
        .syloFormStyle()
        .scrollDismissesKeyboard(.interactively)
        .disabled(model.isWorking)
        .navigationTitle("Member Data")
        .navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.success, trigger: model.deleteCount)
        .alert("Done", isPresented: isShowingNotice, presenting: model.deletionNotice) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sheet(isPresented: $isDeleting) {
            if let lookup = model.lookup {
                ForgetMemberEditor(lookup: lookup, model: model)
            }
        }
    }

    @ViewBuilder
    private func resultSections(_ lookup: MemberLookup) -> some View {
        Section {
            HStack(spacing: SyloSpacing.m) {
                AsyncImage(url: lookup.profile.avatarURL) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Image(systemName: "person.crop.circle.fill").resizable().foregroundStyle(Color.syloMuted)
                }
                .frame(width: 44, height: 44)
                .clipShape(Circle())
                .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: lookup.profile.tag ?? String(localized: "Unknown user")).font(.headline)
                    Text(verbatim: lookup.profile.id).font(.footnote.monospaced()).foregroundStyle(Color.syloMuted)
                }
            }
            .accessibilityElement(children: .combine)
        }

        if lookup.total == 0 {
            Section {
                Text("Sylo has no stored data for this member in this server.").foregroundStyle(Color.syloMuted)
            }
        } else {
            Section {
                ForEach(lookup.shownItems) { item in
                    LabeledContent {
                        Text(verbatim: DateText.count(item.count)).font(.syloNumber(.body, weight: .medium))
                    } label: {
                        Text(verbatim: item.label)
                    }
                }
            } header: {
                Text("What Sylo stores")
            } footer: {
                Text(verbatim: model.unaffected)
            }

            Section {
                Button("Delete This Member's Data", systemImage: "trash", role: .destructive) { isDeleting = true }
            } footer: {
                Text("Everything above that is not a kept safety record is deleted for good. Cases can be deleted one by one under Moderation.")
            }
        }
    }

    private func look() {
        isFocused = false
        Task { await model.look(up: reference) }
    }

    private var isShowingNotice: Binding<Bool> {
        Binding(get: { model.deletionNotice != nil }, set: { if !$0 { model.deletionNotice = nil } })
    }
}

/// The deletion's confirmation: type DELETE, add an optional note for the member, then confirm.
private struct ForgetMemberEditor: View {
    let lookup: MemberLookup
    let model: MemberDataModel

    @State private var typed = ""
    @State private var note = ""

    var body: some View {
        RecordEditor(
            title: "Delete Data", problem: typed == "DELETE" ? nil : String(localized: "Type DELETE to confirm."),
            hasChanges: !typed.isEmpty || !note.isEmpty,
            save: {
                await model.forget(note: note)
                return model.errorMessage == nil
            }, failure: { model.errorMessage },
            saveTitle: "Delete Data",
            confirmation: String(localized: "Everything Sylo stores about \(lookup.profile.displayName) in this server is permanently deleted, and Sylo DMs them a confirmation. Moderation cases and other safety records are kept.")
        ) {
            Section {
                TextField("DELETE", text: $typed)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
            } header: {
                Text("Type DELETE")
            } footer: {
                Text("Deleting \(lookup.profile.displayName)'s data can't be undone.")
            }
            Section {
                TextField("e.g. Processed at your request.", text: $note, axis: .vertical)
                    .lineLimit(2...5)
                    .onChange(of: note) {
                        if note.count > Endpoints.ForgetMember.maxReasonLength {
                            note = String(note.prefix(Endpoints.ForgetMember.maxReasonLength))
                        }
                    }
            } header: {
                Text("Note to the member")
            } footer: {
                Text("Optional, added to the DM.")
            }
        }
    }
}

// MARK: - Leaderboard

/// The leaderboard: the top members of a period, the public link and its vanity address. Mirrors
/// web-v2/src/pages/Leaderboard.jsx.
struct LeaderboardView: View {
    @Environment(AppSession.self) private var session
    @State private var model: LeaderboardModel
    @State private var slug = ""
    @State private var isEditingSlug = false
    @FocusState private var isSlugFocused: Bool

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: LeaderboardModel(server: server, session: session))
    }

    var body: some View {
        Group {
            if let page = model.page {
                form(page)
            } else if let message = model.errorMessage {
                EmptyState(
                    "Couldn't Load Leaderboard", systemImage: "exclamationmark.triangle", message: Text(message),
                    isError: true, actionTitle: "Try Again") {
                        Task { await model.load() }
                    }
            } else {
                SyloLoadingView()
            }
        }
        .background { SyloBackground() }
        .navigationTitle("Leaderboard")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Couldn't Complete", isPresented: isShowingError, presenting: model.actionError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: model.changeCount)
        .task { if model.page == nil { await model.load() } }
    }

    private func form(_ page: LeaderboardPage) -> some View {
        Form {
            Group {
                if !page.levelingEnabled {
                    Section {
                        Label("The Leveling module is off. Turn it on to start ranking members.", systemImage: "info.circle")
                            .font(.subheadline)
                            .foregroundStyle(Color.syloMuted)
                    }
                }

                Section {
                    Toggle("Public leaderboard", isOn: Binding(
                        get: { page.isPublic },
                        set: { value in Task { _ = await model.setPublic(value) } }))
                    if page.isPublic {
                        HStack {
                            TextField("my-server", text: $slug)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .focused($isSlugFocused)
                                .submitLabel(.done)
                                .onSubmit { saveSlug() }
                            Button("Save") { saveSlug() }
                                .disabled(slug == (page.vanitySlug ?? ""))
                        }
                        if let path = page.publicPath, let server = session.server {
                            ShareLink(item: server.url(for: path)) {
                                Label("Share the Public Page", systemImage: "square.and.arrow.up")
                            }
                        }
                    }
                } header: {
                    Text("Sharing")
                } footer: {
                    Text(page.isPublic
                        ? "Anyone with the link can view the leaderboard without signing in. The vanity link is /lb/ followed by the name above; leave it empty for none."
                        : "Anyone with the link can view it, without signing in, once it is public.")
                }

                Section {
                    Picker("Period", selection: Binding(
                        get: { model.period },
                        set: { period in Task { await model.select(period) } })) {
                        Text("All time").tag(LeaderboardPeriod.all)
                        Text("This week").tag(LeaderboardPeriod.week)
                        Text("This month").tag(LeaderboardPeriod.month)
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                }

                Section {
                    if page.rows.isEmpty {
                        Text("No ranked members yet for this period.").foregroundStyle(Color.syloMuted)
                    }
                    ForEach(page.rows) { row in
                        HStack(alignment: .firstTextBaseline, spacing: SyloSpacing.m) {
                            Text(verbatim: "#\(row.rank)")
                                .font(.syloNumber(.footnote, weight: .medium))
                                .foregroundStyle(Color.syloMuted)
                                .frame(minWidth: 32, alignment: .leading)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: row.name).font(.headline)
                                Text(verbatim: details(row)).font(.footnote).foregroundStyle(Color.syloMuted)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                } header: {
                    Text("Top members")
                } footer: {
                    Text("\(DateText.count(page.total)) ranked in all.")
                }
            }
            .syloSectionCards()
        }
        .syloFormStyle()
        .scrollDismissesKeyboard(.interactively)
        .disabled(model.isWorking)
        .refreshable { await model.load() }
        .onAppear { slug = page.vanitySlug ?? "" }
        .onChange(of: page.vanitySlug) { slug = page.vanitySlug ?? "" }
    }

    private func details(_ row: LeaderboardRow) -> String {
        var parts: [String] = []
        if let level = row.level { parts.append(String(localized: "Level \(level)")) }
        parts.append(String(localized: "\(DateText.count(row.xp)) XP"))
        parts.append(row.messages == 1 ? String(localized: "1 message") : String(localized: "\(DateText.count(row.messages)) messages"))
        return parts.joined(separator: " · ")
    }

    private func saveSlug() {
        isSlugFocused = false
        Task { _ = await model.setVanity(slug) }
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
    }
}

// MARK: - Export

/// A row in the server settings that exports the module configuration as a JSON file.
struct ConfigExportRow: View {
    @State private var model: ConfigExportModel
    @State private var isSharing = false

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ConfigExportModel(server: server, session: session))
    }

    var body: some View {
        Section {
            Button {
                Task {
                    await model.export()
                    if model.fileURL != nil, model.errorMessage == nil { isSharing = true }
                }
            } label: {
                HStack {
                    Label("Export Configuration", systemImage: "square.and.arrow.up")
                    if model.isWorking {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(model.isWorking)
            if let message = model.errorMessage {
                StatusMessage(message, kind: .error)
            }
        } header: {
            Text("Export")
        } footer: {
            Text("Saves this server's module configuration as a JSON file. Member data (warnings, XP, tickets) is not included.")
        }
        .sheet(isPresented: $isSharing) {
            if let url = model.fileURL {
                ShareSheet(url: url)
            }
        }
    }
}

/// The system share sheet for one file.
struct ShareSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
