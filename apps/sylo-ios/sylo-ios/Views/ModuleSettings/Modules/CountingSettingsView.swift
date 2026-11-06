import SwiftUI
import SyloKit

/// Counting: the counting channel, its rules, the penalty role, and (read only) the current game
/// and who is benched. Mirrors web-v2/src/moduleForms/Counting.jsx.
struct CountingSettingsView: View {
    @State private var model: ModuleSettingsModel<CountingPage>
    @State private var runner: ActionRunner
    @State private var isSettingCount = false
    @State private var isConfirmingReset = false
    @State private var pendingRelease: CountingPenalty?
    private let server: ServerID

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _runner = State(initialValue: ActionRunner(session: session))
    }

    var body: some View {
        ModuleSettingsForm("Counting", model: model) { $settings, page in
            Section {
                ChannelPicker(title: "Counting channel", selection: $settings.channelId, channels: page.channels)
            } footer: {
                if settings.resetOnFail {
                    Text("Members count upward in this channel, one number per message. A wrong number breaks the streak and it starts over from 1.")
                } else {
                    Text("Members count upward in this channel, one number per message. A wrong number is rejected and deleted.")
                }
            }

            Section {
                Toggle("React on a correct count", isOn: $settings.react)
                Toggle("Let one person count twice in a row", isOn: $settings.allowSameUser)
                Toggle("Reset when someone posts the wrong number", isOn: $settings.resetOnFail)
            } footer: {
                Text("Reactions are ✅ on a correct count and 🎉 on a new record. With repeats off, counters must take turns.")
            }

            Section {
                RolePicker(title: "Penalty role", selection: $settings.penaltyRoleId, roles: page.roles,
                           noneTitle: "None (no penalty)")
                if !settings.penaltyRoleId.isEmpty {
                    NumberField(title: "Bench for", value: $settings.penaltyMinutes,
                                range: CountingSettings.penaltyRange, unit: "min")
                }
            } header: {
                Text("Penalty")
            } footer: {
                Text("When someone breaks the streak, Sylo takes this role away and gives it back later. Point it at the role that lets people type in the counting channel; Sylo's top role must be above it. This is not a ban or a timeout.")
            }

            if !page.penalties.isEmpty {
                Section("Currently benched") {
                    ForEach(page.penalties) { penalty in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: penalty.label)
                            Text(verbatim: "@\(penalty.roleName)")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            if let restoreAt = penalty.restoreAt {
                                Text("Back \(restoreAt, format: .relative(presentation: .named))")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .accessibilityElement(children: .combine)
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button("Release", systemImage: "person.badge.key") { pendingRelease = penalty }
                                .tint(Color.syloCyan)
                        }
                        .contextMenu {
                            Button("Release", systemImage: "person.badge.key") { pendingRelease = penalty }
                        }
                        .accessibilityAction(named: Text("Release")) { pendingRelease = penalty }
                    }
                }
            }

            Section {
                LabeledContent("Count") {
                    Text(page.state.current, format: .number)
                }
                LabeledContent("Best streak") {
                    Text(page.state.record, format: .number)
                }
                Button("Set the Count", systemImage: "number") { isSettingCount = true }
                Button("Reset the Count to 0", systemImage: "arrow.counterclockwise", role: .destructive) {
                    isConfirmingReset = true
                }
            } header: {
                Text("Current game")
            } footer: {
                Text("Set or reset the count. Swipe a benched member to give their access back early.")
            }
        }
        .sheet(isPresented: $isSettingCount) {
            MemberNumberEditor(
                title: "Set the Count", asksForMember: false, valueTitle: "Count", range: 0...1_000_000_000_000,
                initial: model.page?.state.current ?? 0, footer: "The next number to post is one more than this.",
                save: { _, count in
                    guard await runner.run(Endpoints.SetCount(server: server, count: count)) != nil else { return false }
                    await model.load()
                    return true
                }, failure: { runner.errorMessage })
        }
        .confirmationDialog("Reset the count to 0?", isPresented: $isConfirmingReset, titleVisibility: .visible) {
            Button("Reset the Count", role: .destructive) {
                Task { if await runner.run(Endpoints.SetCount.reset(server: server)) != nil { await model.load() } }
            }
        } message: {
            Text("The next number to post is 1. The best streak is kept.")
        }
        .confirmationDialog(
            "Give their access back?", isPresented: isConfirmingRelease, titleVisibility: .visible, presenting: pendingRelease
        ) { penalty in
            Button("Release \(penalty.label)") {
                Task {
                    if await runner.run(Endpoints.ReleaseCountingPenalty(server: server, userId: penalty.userId)) != nil {
                        await model.load()
                    }
                }
            }
        } message: { penalty in
            Text("\(penalty.label) gets the penalty role back and can count again.")
        }
        .alert("Couldn't Complete", isPresented: isShowingError, presenting: runner.errorMessage) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: runner.successCount)
    }

    private var isConfirmingRelease: Binding<Bool> {
        Binding(get: { pendingRelease != nil }, set: { if !$0 { pendingRelease = nil } })
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { runner.errorMessage != nil && !isSettingCount }, set: { if !$0 { runner.errorMessage = nil } })
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<CountingPage> else { return nil }
        return CountingPage(
            settings: CountingSettings(channelId: "c1", penaltyRoleId: "r1", penaltyMinutes: 30),
            channels: [ChannelOption(id: "c1", name: "counting"), ChannelOption(id: "c2", name: "general")],
            roles: [RoleOption(id: "r1", name: "Counter")],
            state: CountingState(current: 41, record: 120, lastUserId: "u1"),
            penalties: [CountingPenalty(userId: "u2", label: "oops", roleName: "Counter",
                                        restoreAt: Date().addingTimeInterval(600))])
    }
    NavigationStack {
        CountingSettingsView(server: "1", session: session)
    }
    .environment(session)
}
