import SwiftUI
import SyloKit

/// Counting: the counting channel, its rules, the penalty role, who is benched (release them early),
/// and the current game (set or reset the count). Mirrors web-v2/src/moduleForms/Counting.jsx.
struct CountingSettingsView: View {
    @State private var model: ModuleSettingsModel<CountingPage>
    @State private var actions: MemberActionModel
    @State private var countText = ""
    @State private var isConfirmingReset = false

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _actions = State(initialValue: MemberActionModel(server: server, session: session))
    }

    /// What was typed as a count, nil when it is not a whole number.
    private var typedCount: Int? { Int(countText.trimmingCharacters(in: .whitespacesAndNewlines)) }

    /// Runs a tool, then reads the page again so the numbers are the server's.
    private func perform(_ action: @MainActor @escaping () async -> Bool) {
        Task {
            if await action() { await model.load() }
        }
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
                Section {
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
                            Button("Release") { release(penalty) }
                                .tint(.accentColor)
                        }
                        .contextMenu {
                            Button("Release Now", systemImage: "lock.open") { release(penalty) }
                        }
                    }
                } header: {
                    Text("Currently benched")
                } footer: {
                    Text("Swipe a member, or press and hold, to give them the penalty role back now.")
                }
            }

            Section {
                LabeledContent("Count") {
                    Text(page.state.current, format: .number)
                }
                LabeledContent("Best streak") {
                    Text(page.state.record, format: .number)
                }
                LabeledContent("Set the count to") {
                    TextField("Count", text: $countText)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                        .autocorrectionDisabled()
                }
                Button("Update Count") {
                    if let count = typedCount { perform { await actions.setCount(count) } }
                }
                .disabled(typedCount == nil || actions.isWorking)
                Button("Reset to 0", role: .destructive) { isConfirmingReset = true }
                    .disabled(actions.isWorking)
                if let notice = actions.notice {
                    StatusMessage(notice, kind: .notice)
                }
            } header: {
                Text("Current game")
            } footer: {
                Text("The next number posted in the channel must be one higher than this. The last-counter lock is cleared, so anyone may post it. The best streak is kept.")
            }
        }
        .onChange(of: model.page?.state.current, initial: true) { _, current in
            if let current { countText = String(current) }
        }
        .confirmationDialog("Reset the count to 0?", isPresented: $isConfirmingReset, titleVisibility: .visible) {
            Button("Reset to 0", role: .destructive) { perform { await actions.resetCount() } }
        } message: {
            Text("The current count is cleared and the next number posted must be 1. The best streak is kept.")
        }
        .alert("Couldn't Update", isPresented: isShowingActionError, presenting: actions.errorMessage) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: actions.doneCount)
    }

    private func release(_ penalty: CountingPenalty) {
        perform { await actions.releasePenalty(userID: penalty.userId, name: penalty.label) }
    }

    private var isShowingActionError: Binding<Bool> {
        Binding(get: { actions.errorMessage != nil }, set: { if !$0 { actions.errorMessage = nil } })
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
